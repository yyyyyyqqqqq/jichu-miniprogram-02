const assert = require('assert');
const {
  createParticipantPair,
  buildMigrationPlan,
  messageSummary
} = require('./phase-24-pair-conversation-core');
const {
  parseJsonOutput
} = require('./schools/cloud-cli');
const {
  collectSnapshotPages
} = require('./migrate-phase-24-pair-conversations');
const {
  buildExpectedMutations,
  detectMigrationState,
  snapshotHashes,
  verifyMigration,
  verifyRollback
} = require('./phase-24-pair-migration-core');
const {
  CONFIG_ID,
  CONFIG_SCHEMA_VERSION,
  normalizeMaintenanceState
} = require('./phase-24-maintenance-core');

const USER_A = `u_${'1'.repeat(32)}`;
const USER_B = `u_${'2'.repeat(32)}`;
const OPENID_A = 'openid-a';
const OPENID_B = 'openid-b';
const PRODUCT_A = `p_${'a'.repeat(32)}`;
const PRODUCT_B = `p_${'b'.repeat(32)}`;

function legacyId(seed) {
  return `c_${seed.repeat(64).slice(0, 64)}`;
}

function messageId(seed) {
  return `m_${seed.repeat(64).slice(0, 64)}`;
}

function baseSnapshot() {
  const firstConversation = legacyId('a');
  const secondConversation = legacyId('b');
  return {
    users: [
      { _id: USER_A, openid: OPENID_A },
      { _id: USER_B, openid: OPENID_B }
    ],
    products: [
      { _id: PRODUCT_A, title: 'A', sellerId: USER_B, status: 'available', price: 10 },
      { _id: PRODUCT_B, title: 'B', sellerId: USER_A, status: 'available', price: 20 }
    ],
    conversations: [
      {
        _id: firstConversation,
        participantAOpenid: OPENID_A,
        participantAUserId: USER_A,
        participantBOpenid: OPENID_B,
        participantBUserId: USER_B,
        participantAUnreadCount: 2,
        participantBUnreadCount: 1,
        productId: PRODUCT_A,
        productSnapshot: { title: 'A' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:02:00.000Z'
      },
      {
        _id: secondConversation,
        participantAOpenid: OPENID_B,
        participantAUserId: USER_B,
        participantBOpenid: OPENID_A,
        participantBUserId: USER_A,
        participantAUnreadCount: 3,
        participantBUnreadCount: 4,
        productId: PRODUCT_B,
        productSnapshot: { title: 'B' },
        createdAt: '2026-01-01T00:01:00.000Z',
        updatedAt: '2026-01-01T00:04:00.000Z'
      }
    ],
    messages: [
      {
        _id: messageId('a'),
        conversationId: firstConversation,
        senderOpenid: OPENID_A,
        clientMessageId: 'client-a',
        type: 'text',
        content: '旧商品消息',
        createdAt: '2026-01-01T00:02:00.000Z'
      },
      {
        _id: messageId('b'),
        conversationId: secondConversation,
        senderOpenid: OPENID_B,
        clientMessageId: 'client-b',
        type: 'image',
        contextProductId: PRODUCT_B,
        createdAt: '2026-01-01T00:03:00.000Z'
      }
    ],
    appointments: [{
      _id: `a_${'c'.repeat(64)}`,
      conversationId: firstConversation,
      productId: PRODUCT_A
    }, {
      _id: `a_${'d'.repeat(64)}`,
      conversationId: secondConversation,
      productId: PRODUCT_B
    }]
  };
}

function applyExpectedMutations(snapshot, mutations, limit = Infinity) {
  const result = structuredClone(snapshot);
  const maps = Object.fromEntries(['conversations', 'messages', 'appointments'].map((name) => [
    name,
    new Map(result[name].map((item) => [item._id, item]))
  ]));
  mutations.slice(0, limit).forEach((mutation) => {
    const document = structuredClone(mutation.expectedAfter);
    maps[mutation.collection].set(mutation.documentId, document);
  });
  for (const name of Object.keys(maps)) {
    result[name] = [...maps[name].values()].sort((left, right) => left._id.localeCompare(right._id));
  }
  return result;
}

function run() {
  const pair = createParticipantPair(USER_A, USER_B);
  assert(pair, 'valid pair should be created');
  assert.strictEqual(
    createParticipantPair(USER_B, USER_A).conversationId,
    pair.conversationId,
    '01 direction must not affect identity'
  );
  assert.strictEqual(pair.conversationId, createParticipantPair(USER_A, USER_B).conversationId, '02 identity must be deterministic');
  assert.strictEqual(createParticipantPair(USER_A, USER_A), null, '03 self pair must be rejected');

  const plan = buildMigrationPlan(baseSnapshot(), { migrationId: 'test' });
  assert.strictEqual(plan.safeToApply, true, '04 valid history must be safe');
  assert.strictEqual(plan.summary.logicalPairs, 1, '05 two products must become one logical pair');
  assert.strictEqual(plan.summary.canonicalCreates, 1, '06 one canonical row must be created');
  assert.strictEqual(plan.summary.archivedAliases, 2, '07 every legacy row must remain as an alias');
  assert.strictEqual(new Set(plan.archives.map((item) => item.conversationId)).size, 2, '07 archived aliases must retain unique identities');
  assert.strictEqual(plan.summary.messageRepoints, 2, '08 all history must be repointed');
  assert.strictEqual(plan.messageUpdates[0].contextProductId, PRODUCT_A, '09 missing context must be inferred from source conversation');
  assert.strictEqual(plan.messageUpdates[1].contextProductId, PRODUCT_B, '10 explicit context must be preserved');
  assert.strictEqual(plan.summary.messageContextsBackfilled, 1, '11 only missing explicit contexts count as backfilled');
  assert.strictEqual(plan.appointmentUpdates[0].productId, PRODUCT_A, '12 appointment product semantics must be preserved');
  assert.strictEqual(plan.appointmentUpdates[0].canonicalConversationId, pair.conversationId, '13 appointment must follow canonical conversation');
  const canonical = plan.canonicalWrites[0].document;
  assert.strictEqual(canonical.participantAUnreadCount, 6, '14 unread counts must follow public user identity when direction reverses');
  assert.strictEqual(canonical.participantBUnreadCount, 4, '14 reverse unread aggregation must remain correct');
  assert.strictEqual(canonical.lastProductId, PRODUCT_B, '15 latest entry context must drive the header product');
  assert.strictEqual(canonical.lastMessage, '[图片]', '16 summary must be recomputed from the actual latest message');
  assert.strictEqual(messageSummary({ type: 'system', content: '预约已完成' }), '预约已完成', '17 system summary must preserve event text');

  const orphan = baseSnapshot();
  orphan.messages.push({
    _id: messageId('d'),
    conversationId: legacyId('d'),
    senderOpenid: OPENID_A,
    clientMessageId: 'orphan',
    type: 'text',
    content: 'orphan',
    createdAt: '2026-01-01T00:05:00.000Z'
  });
  assert.strictEqual(buildMigrationPlan(orphan).safeToApply, false, '18 orphan messages must block apply');

  const conflict = baseSnapshot();
  conflict.messages[1].senderOpenid = OPENID_A;
  conflict.messages[1].clientMessageId = 'client-a';
  assert.strictEqual(buildMigrationPlan(conflict).safeToApply, false, '19 merged unique-key conflicts must block apply');

  const rerun = baseSnapshot();
  rerun.conversations.push({
    ...plan.canonicalWrites[0].document
  });
  const rerunPlan = buildMigrationPlan(rerun);
  assert.strictEqual(rerunPlan.summary.canonicalCreates, 0, '20 rerun must update, not recreate, the canonical row');
  assert.strictEqual(rerunPlan.summary.canonicalUpdates, 1, '20 canonical rerun must be resumable');

  const empty = buildMigrationPlan({ users: [], products: [], conversations: [], messages: [], appointments: [] });
  assert.strictEqual(empty.safeToApply, true, '21 empty staging data must be a safe no-op');
  assert.strictEqual(empty.summary.logicalPairs, 0, '21 empty staging must not create rows');

  assert.deepStrictEqual(parseJsonOutput('{"data":{"results":[]}}'), { data: { results: [] } }, '22 single-line JSON must parse');
  assert.deepStrictEqual(parseJsonOutput('{\n  "data": {\n    "results": []\n  }\n}'), { data: { results: [] } }, '23 multi-line JSON must parse as one document');
  const large = { data: { results: [Array.from({ length: 75 }, (_, index) => ({ _id: `p_${index}`, title: `商品${index}` }))] } };
  assert.deepStrictEqual(parseJsonOutput(JSON.stringify(large, null, 2)), large, '24 large structured output must not collapse to a scalar line');
  assert.deepStrictEqual(parseJsonOutput('cloudbase diagnostic\n{not-json}\n{"data":{"results":[[]]}}\nfinished'), { data: { results: [[]] } }, '25 non-JSON logs may surround one structured response');
  assert.deepStrictEqual(parseJsonOutput('"宿舍"\n{"data":{"results":[[]]}}'), { data: { results: [[]] } }, '26 JSON string lines must never be accepted as the response');
  assert.throws(() => parseJsonOutput(''), /empty output/, '27 empty CLI output must fail closed');
  assert.throws(() => parseJsonOutput('not-json'), /0 structured JSON candidates/, '28 invalid CLI output must fail closed');
  assert.throws(() => parseJsonOutput('{"a":1}\n{"b":2}'), /2 structured JSON candidates/, '29 ambiguous CLI output must fail closed');

  const products = Array.from({ length: 75 }, (_, index) => ({ _id: `p_${String(index).padStart(3, '0')}` }));
  const paged = collectSnapshotPages('products', products.length, (skip, size) => products.slice(skip, skip + size), { pageSize: 16 });
  assert.strictEqual(paged.length, 75, '30 paginated 70+ products must be complete');
  assert.deepStrictEqual(collectSnapshotPages('products', 0, () => [], { pageSize: 16 }), [], '31 an empty collection must be explicitly validated');
  assert.throws(() => collectSnapshotPages('products', 76, (skip, size) => products.slice(skip, skip + size), { pageSize: 16 }), /differs from metadata/, '32 metadata/snapshot mismatch must fail closed');
  assert.throws(() => collectSnapshotPages('products', 2, () => [{ _id: 'same' }, { _id: 'same' }], { pageSize: 10 }), /duplicate id/, '33 duplicate pagination rows must fail closed');

  const firstSnapshot = baseSnapshot();
  const firstPlan = buildMigrationPlan(firstSnapshot, { migrationId: 'phase24_pair_20260813000000000' });
  const expected = buildExpectedMutations(firstPlan, firstSnapshot);
  const completed = applyExpectedMutations(firstSnapshot, expected);
  const migrationVerification = verifyMigration(firstPlan, firstSnapshot, completed, expected);
  assert.strictEqual(migrationVerification.passed, true, '34 a fully materialized migration must pass field/hash verification');
  assert.strictEqual(migrationVerification.hashes.businessEquivalent, true, '35 migration business invariant hash must remain equal');
  const secondPlan = buildMigrationPlan(completed, { migrationId: 'phase24_pair_20260813000000001' });
  assert.deepStrictEqual({
    canonicalCreates: secondPlan.summary.canonicalCreates,
    canonicalUpdates: secondPlan.summary.canonicalUpdates,
    archives: secondPlan.summary.archivedAliases,
    messages: secondPlan.messageUpdates.length,
    appointments: secondPlan.appointmentUpdates.length,
    issues: secondPlan.issues.length
  }, {
    canonicalCreates: 0,
    canonicalUpdates: 0,
    archives: 0,
    messages: 0,
    appointments: 0,
    issues: 0
  }, '36 completed-state second dry-run must be a true no-op');
  const thirdPlan = buildMigrationPlan(completed, { migrationId: 'phase24_pair_20260813000000002' });
  assert.strictEqual(thirdPlan.canonicalWrites.length + thirdPlan.archives.length + thirdPlan.messageUpdates.length + thirdPlan.appointmentUpdates.length, 0, '37 completed-state third dry-run must remain a true no-op');
  assert(!secondPlan.canonicalStates.some((item) => String(item.document.lastProductId).startsWith('merged_')), '38 merged aliases must not contaminate canonical context');
  assert.strictEqual(secondPlan.canonicalStates[0].document.lastProductId, firstPlan.canonicalStates[0].document.lastProductId, '39 lastProductId must be stable after completion');

  const stages = ['archives', 'canonicals', 'messages', 'appointments'];
  stages.forEach((stage, index) => {
    const firstStageMutation = expected.findIndex((item) => item.stage === stage);
    const partial = applyExpectedMutations(firstSnapshot, expected, firstStageMutation + 1);
    const state = detectMigrationState(expected, partial);
    assert.strictEqual(state.classification, 'partial', `${40 + index} ${stage} interruption must be detectable as partial`);
  });
  const completeState = detectMigrationState(expected, completed);
  assert.strictEqual(completeState.classification, 'after', '44 writes-complete/pre-validation state must be identifiable as after');
  const rolledBack = structuredClone(firstSnapshot);
  const rollbackVerification = verifyRollback(firstSnapshot, rolledBack);
  assert.strictEqual(rollbackVerification.passed, true, '45 rollback snapshot must match every normalized collection hash');
  assert.strictEqual(rollbackVerification.fullHashMatches, true, '46 rollback combined hash must match');
  assert.strictEqual(verifyRollback(firstSnapshot, structuredClone(rolledBack)).passed, true, '47 repeated rollback verification must remain idempotent');
  assert.notStrictEqual(snapshotHashes(firstSnapshot).combined, snapshotHashes(completed).combined, '48 full migration hash must record the allowed structural change');

  assert.deepStrictEqual(normalizeMaintenanceState({
    _id: CONFIG_ID,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: true,
    migrationRunId: 'phase24_pair_20260813000000000'
  }), {
    enabled: true,
    valid: true,
    failClosed: false,
    reason: 'configured-on',
    migrationRunId: 'phase24_pair_20260813000000000'
  }, '49 maintenance ON must be authoritative');
  assert.strictEqual(normalizeMaintenanceState({ _id: CONFIG_ID, schemaVersion: CONFIG_SCHEMA_VERSION, enabled: false }).enabled, false, '50 maintenance OFF must allow writes');
  assert.strictEqual(normalizeMaintenanceState(null).failClosed, true, '51 missing maintenance config must fail closed');
  assert.strictEqual(normalizeMaintenanceState(null, new Error('read failed')).enabled, true, '52 maintenance read errors must fail closed');

  process.stdout.write('Phase 24 pair-conversation verification passed (52 assertions/scenarios).\n');
}

if (require.main === module) run();

module.exports = { run };
