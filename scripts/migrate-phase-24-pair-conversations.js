const fs = require('fs');
const path = require('path');
const {
  runPreflight,
  publicSummary: publicEnvironmentSummary,
  maskIdentifier,
  assert
} = require('./environment-preflight');
const {
  runNoSql,
  extractCommandResults,
  extractDocuments,
  decodeExtendedJson
} = require('./schools/cloud-cli');
const {
  readTables,
  readIndexes
} = require('./phase-24-staging-core');
const {
  buildMigrationPlan,
  publicPlan
} = require('./phase-24-pair-conversation-core');
const {
  SNAPSHOT_COLLECTIONS,
  snapshotHashes,
  buildExpectedMutations,
  detectMigrationState,
  verifyMigration,
  verifyRollback
} = require('./phase-24-pair-migration-core');
const {
  CONFIG_COLLECTION,
  CONFIG_ID,
  normalizeMaintenanceState
} = require('./phase-24-maintenance-core');

const ROOT = path.resolve(__dirname, '..');
const OWNER_AUTHORIZATION = 'phase24-approved-by-project-owner';
const PAGE_SIZE = 100;
const WRITE_BATCH_SIZE = 20;
const WRITE_COMMAND_PAYLOAD_LIMIT = 1000;
const FAULT_POINTS = new Set([
  'after-archives',
  'during-canonicals',
  'during-messages',
  'during-appointments',
  'before-validation'
]);
const TARGET_INDEXES = Object.freeze({
  conversations: Object.freeze([
    'idx_participant_pair_unique',
    'idx_participantA_status_lastMessageAt_id',
    'idx_participantB_status_lastMessageAt_id'
  ]),
  appointments: Object.freeze([
    'idx_conversation_product_status_deleted_updatedAt_id'
  ])
});
const DATE_FIELDS = new Set([
  'createdAt', 'updatedAt', 'lastMessageAt', 'contextUpdatedAt',
  'scheduledAt', 'acceptedAt', 'rejectedAt', 'cancelledAt',
  'completedAt', 'schoolSelectedAt', 'schoolUpdatedAt', 'migratedAt'
]);

function parseArguments(argv) {
  const options = {
    environmentName: '',
    apply: false,
    resume: false,
    rollback: false,
    confirmTarget: '',
    ownerAuthorization: '',
    input: '',
    output: '',
    fault: '',
    dropTargetIndexes: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--apply') options.apply = true;
    else if (value === '--resume') options.resume = true;
    else if (value === '--rollback') options.rollback = true;
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--owner-authorization') options.ownerAuthorization = String(argv[++index] || '').trim();
    else if (value === '--input') options.input = path.resolve(String(argv[++index] || '').trim());
    else if (value === '--output') options.output = path.resolve(String(argv[++index] || '').trim());
    else if (value === '--fault') options.fault = String(argv[++index] || '').trim();
    else if (value === '--drop-target-indexes') options.dropTargetIndexes = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert([options.apply, options.resume, options.rollback].filter(Boolean).length <= 1, '--apply, --resume and --rollback are mutually exclusive', 'INVALID_ARGUMENT');
  assert(['production', 'staging'].includes(options.environmentName), 'explicit --env production|staging is required', 'ENVIRONMENT_ROLE_REQUIRED');
  assert(!options.fault || FAULT_POINTS.has(options.fault), 'unsupported fault injection point', 'INVALID_ARGUMENT');
  assert(!options.fault || options.environmentName === 'staging', 'fault injection is staging-only', 'FAULT_INJECTION_FORBIDDEN');
  assert(!options.dropTargetIndexes || options.rollback, '--drop-target-indexes requires --rollback', 'INVALID_ARGUMENT');
  return options;
}

function defaultOutput(environmentName) {
  return path.join(ROOT, 'tmp', `phase-24-pair-migration-${environmentName}-private.json`);
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

function loadManifest(filePath) {
  assert(filePath && fs.existsSync(filePath), 'an existing --input manifest is required', 'MIGRATION_MANIFEST_REQUIRED');
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert(manifest.schemaVersion === 2, 'migration manifest schema is unsupported', 'MIGRATION_MANIFEST_INVALID');
  assert(manifest.plan && manifest.beforeSnapshot && Array.isArray(manifest.expectedMutations), 'migration manifest is incomplete', 'MIGRATION_MANIFEST_INVALID');
  return manifest;
}

function encodeMongo(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => encodeMongo(item));
  if (!value || typeof value !== 'object') {
    if (
      DATE_FIELDS.has(key)
      && typeof value === 'string'
      && Number.isFinite(new Date(value).getTime())
    ) {
      return { $date: { $numberLong: String(new Date(value).getTime()) } };
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
    childKey,
    encodeMongo(item, childKey)
  ]));
}

function execute(environmentId, collectionName, commandType, command) {
  return runNoSql(environmentId, [{
    TableName: collectionName,
    CommandType: commandType,
    Command: JSON.stringify(command)
  }]);
}

function extractQueryPage(response, collectionName) {
  const results = extractCommandResults(response);
  const page = results.length > 0
    ? results.flatMap((item) => extractDocuments(item))
    : extractDocuments(response);
  assert(Array.isArray(page), `${collectionName} query returned an invalid page`, 'SNAPSHOT_STRUCTURE_INVALID');
  return page.map(decodeExtendedJson);
}

function collectSnapshotPages(collectionName, expectedCount, fetchPage, options = {}) {
  const pageSize = Math.min(Math.max(Number(options.pageSize) || PAGE_SIZE, 1), 1000);
  const maximum = Math.min(Math.max(Number(options.maximum) || 10000, 1), 100000);
  assert(Number.isInteger(expectedCount) && expectedCount >= 0, `${collectionName} metadata count is invalid`, 'SNAPSHOT_COUNT_INVALID');
  assert(expectedCount <= maximum, `${collectionName} exceeds snapshot safety limit`, 'COLLECTION_LIMIT_EXCEEDED');
  const records = [];
  const ids = new Set();
  for (let skip = 0; skip <= expectedCount; skip += pageSize) {
    const page = fetchPage(skip, pageSize);
    assert(Array.isArray(page), `${collectionName} page is not an array`, 'SNAPSHOT_STRUCTURE_INVALID');
    page.forEach((record) => {
      const id = String(record && record._id || '');
      assert(id && !ids.has(id), `${collectionName} pagination returned a duplicate id`, 'SNAPSHOT_PAGE_DUPLICATE');
      ids.add(id);
      records.push(record);
    });
    if (records.length > expectedCount) {
      throw Object.assign(new Error(`${collectionName} grew while snapshot was read`), { code: 'SNAPSHOT_COUNT_CHANGED' });
    }
    if (page.length < pageSize) break;
  }
  assert(records.length === expectedCount, `${collectionName} snapshot count ${records.length} differs from metadata ${expectedCount}`, 'SNAPSHOT_COUNT_MISMATCH');
  return records;
}

function readCollection(environmentId, collectionName, expectedCount, options = {}) {
  return collectSnapshotPages(collectionName, expectedCount, (skip, pageSize) => {
    const response = execute(environmentId, collectionName, 'QUERY', {
      find: collectionName,
      filter: {},
      sort: { _id: 1 },
      skip,
      limit: pageSize
    });
    return extractQueryPage(response, collectionName);
  }, options);
}

function tableCounts(tables) {
  return Object.fromEntries(SNAPSHOT_COLLECTIONS.map((name) => {
    const table = tables.find((item) => item.name === name);
    assert(table, `${name} collection is missing`, 'SNAPSHOT_COLLECTION_MISSING');
    return [name, Number(table.count)];
  }));
}

async function readSnapshot(environmentId, options = {}) {
  const beforeCounts = tableCounts(await readTables(environmentId));
  const snapshot = {};
  for (const name of SNAPSHOT_COLLECTIONS) {
    snapshot[name] = readCollection(environmentId, name, beforeCounts[name], options);
  }
  const afterCounts = tableCounts(await readTables(environmentId));
  for (const name of SNAPSHOT_COLLECTIONS) {
    assert(beforeCounts[name] === afterCounts[name], `${name} metadata changed during snapshot`, 'SNAPSHOT_COUNT_CHANGED');
    assert(snapshot[name].length === afterCounts[name], `${name} snapshot is incomplete`, 'SNAPSHOT_COUNT_MISMATCH');
  }
  return snapshot;
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function chunkByPayload(values, valueSelector = (item) => item) {
  const output = [];
  let current = [];
  let currentSize = 0;
  values.forEach((value) => {
    const size = Buffer.byteLength(JSON.stringify(valueSelector(value)), 'utf8');
    if (current.length > 0 && (current.length >= WRITE_BATCH_SIZE || currentSize + size > WRITE_COMMAND_PAYLOAD_LIMIT)) {
      output.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(value);
    currentSize += size;
  });
  if (current.length > 0) output.push(current);
  return output;
}

function applyMutationChunk(environmentId, mutations) {
  const inserts = mutations.filter((item) => item.operation === 'insert');
  const replacements = mutations.filter((item) => item.operation !== 'insert');
  if (inserts.length > 0) {
    const collection = inserts[0].collection;
    assert(inserts.every((item) => item.collection === collection), 'insert chunk spans collections', 'MIGRATION_INTERNAL_ERROR');
    execute(environmentId, collection, 'INSERT', {
      insert: collection,
      documents: inserts.map((item) => encodeMongo(item.expectedAfter)),
      ordered: true
    });
  }
  if (replacements.length > 0) {
    const collection = replacements[0].collection;
    assert(replacements.every((item) => item.collection === collection), 'replacement chunk spans collections', 'MIGRATION_INTERNAL_ERROR');
    execute(environmentId, collection, 'UPDATE', {
      update: collection,
      updates: replacements.map((item) => ({
        q: { _id: item.documentId },
        u: encodeMongo(item.expectedAfter),
        multi: false,
        upsert: false
      })),
      ordered: true
    });
  }
}

function updateCheckpoint(manifest, output, patch) {
  manifest.checkpoint = {
    ...manifest.checkpoint,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  writePrivateJson(output, manifest);
}

function injectFault(point) {
  const error = new Error(`staging fault injected at ${point}`);
  error.code = 'STAGING_FAULT_INJECTED';
  error.faultPoint = point;
  throw error;
}

function applyStages(environmentId, manifest, output, faultPoint, selectedMutations = manifest.expectedMutations) {
  const stages = ['archives', 'canonicals', 'messages', 'appointments'];
  for (const stage of stages) {
    const mutations = selectedMutations.filter((item) => item.stage === stage);
    updateCheckpoint(manifest, output, { stage, stageTotal: mutations.length, stageCompleted: 0 });
    const duringFault = faultPoint === `during-${stage}`;
    let completed = 0;
    const batches = duringFault
      ? chunk(mutations, 1)
      : chunkByPayload(mutations, (item) => item.expectedAfter);
    for (const values of batches) {
      applyMutationChunk(environmentId, values);
      completed += values.length;
      updateCheckpoint(manifest, output, {
        stage,
        stageTotal: mutations.length,
        stageCompleted: completed,
        completedMutationIds: [
          ...(manifest.checkpoint.completedMutationIds || []),
          ...values.map((item) => item.mutationId)
        ]
      });
      if (duringFault && completed > 0 && completed < mutations.length) {
        injectFault(faultPoint);
      }
    }
    if (faultPoint === 'after-archives' && stage === 'archives') injectFault(faultPoint);
  }
  if (faultPoint === 'before-validation') injectFault(faultPoint);
}

function replaceDocuments(environmentId, collectionName, documents) {
  for (const values of chunkByPayload(documents)) {
    if (values.length === 0) continue;
    execute(environmentId, collectionName, 'UPDATE', {
      update: collectionName,
      updates: values.map((document) => ({
        q: { _id: document._id },
        u: encodeMongo(document),
        multi: false,
        upsert: false
      })),
      ordered: true
    });
  }
}

function deleteDocuments(environmentId, collectionName, ids) {
  for (const values of chunk(ids, WRITE_BATCH_SIZE)) {
    if (values.length === 0) continue;
    execute(environmentId, collectionName, 'DELETE', {
      delete: collectionName,
      deletes: values.map((id) => ({ q: { _id: id }, limit: 1 }))
    });
  }
}

async function dropTargetIndexes(environmentId) {
  const dropped = [];
  for (const [collection, names] of Object.entries(TARGET_INDEXES)) {
    const actual = await readIndexes(environmentId, collection);
    for (const name of names) {
      if (!actual.some((item) => item.name === name)) continue;
      execute(environmentId, collection, 'COMMAND', {
        dropIndexes: collection,
        index: name
      });
      dropped.push(`${collection}.${name}`);
    }
  }
  for (const [collection, names] of Object.entries(TARGET_INDEXES)) {
    const actual = await readIndexes(environmentId, collection);
    assert(names.every((name) => !actual.some((item) => item.name === name)), `${collection} target indexes remain after rollback preparation`, 'ROLLBACK_INDEX_DROP_FAILED');
  }
  return dropped;
}

function readMaintenance(environmentId) {
  try {
    const response = execute(environmentId, CONFIG_COLLECTION, 'QUERY', {
      find: CONFIG_COLLECTION,
      filter: { _id: CONFIG_ID },
      limit: 2
    });
    const rows = extractQueryPage(response, CONFIG_COLLECTION);
    return normalizeMaintenanceState(rows.length === 1 ? rows[0] : null);
  } catch (error) {
    return normalizeMaintenanceState(null, error);
  }
}

function assertMaintenance(environmentId, migrationRunId) {
  const maintenance = readMaintenance(environmentId);
  assert(maintenance.valid && maintenance.enabled, 'authoritative maintenance mode is not enabled', 'MAINTENANCE_NOT_ENABLED');
  assert(maintenance.migrationRunId === migrationRunId, 'maintenance migrationRunId differs from manifest', 'MAINTENANCE_RUN_MISMATCH');
  return maintenance;
}

function assertManifestTarget(manifest, preflight) {
  assert(manifest.environmentName === preflight.environmentName, 'manifest environment role differs from target', 'MIGRATION_TARGET_MISMATCH');
  assert(manifest.environmentIdMasked === maskIdentifier(preflight.environmentId), 'manifest environment id differs from target', 'MIGRATION_TARGET_MISMATCH');
}

async function rollback(environmentId, manifest, output, options) {
  assertMaintenance(environmentId, manifest.migrationRunId);
  const current = await readSnapshot(environmentId);
  const state = detectMigrationState(manifest.expectedMutations, current);
  assert(state.counts.diverged === 0 && state.counts.missing === 0, 'live migration state diverged from before/expectedAfter evidence', 'ROLLBACK_STATE_DIVERGED');
  const droppedIndexes = options.dropTargetIndexes
    ? await dropTargetIndexes(environmentId)
    : [];
  updateCheckpoint(manifest, output, { stage: 'rollback', rollbackStateBefore: state.classification });
  const stateByMutationId = new Map(state.details.map((item) => [
    item.mutationId,
    item.state
  ]));
  for (const collection of ['messages', 'appointments', 'conversations']) {
    const documents = manifest.expectedMutations
      .filter((item) => (
        item.collection === collection
        && item.before
        && stateByMutationId.get(item.mutationId) === 'after'
      ))
      .map((item) => item.before);
    replaceDocuments(environmentId, collection, documents);
  }
  const createdCanonicalIds = manifest.expectedMutations
    .filter((item) => (
      item.collection === 'conversations'
      && item.operation === 'insert'
      && stateByMutationId.get(item.mutationId) === 'after'
    ))
    .map((item) => item.documentId);
  deleteDocuments(environmentId, 'conversations', createdCanonicalIds);
  const afterRollback = await readSnapshot(environmentId);
  const verification = verifyRollback(manifest.beforeSnapshot, afterRollback);
  manifest.mode = verification.passed ? 'rollback-complete' : 'rollback-verification-failed';
  manifest.rollback = {
    completedAt: new Date().toISOString(),
    stateBefore: state,
    droppedIndexes,
    verification
  };
  writePrivateJson(output, manifest);
  assert(verification.passed, 'rollback normalized hashes differ from before snapshot', 'ROLLBACK_VERIFICATION_FAILED');
  return { verification, droppedIndexes, stateBefore: state.classification };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const write = options.apply || options.resume || options.rollback;
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: write ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: write && options.environmentName === 'production',
    allowInactiveRead: !write
  });
  if (write) {
    assert(options.ownerAuthorization === OWNER_AUTHORIZATION, `write requires --owner-authorization ${OWNER_AUTHORIZATION}`, 'PROJECT_OWNER_AUTHORIZATION_REQUIRED');
  }
  if (options.apply || options.resume || options.rollback) {
    assert(options.input, '--apply/--resume/--rollback requires a prepared --input manifest', 'MIGRATION_MANIFEST_REQUIRED');
    const manifest = loadManifest(options.input);
    assertManifestTarget(manifest, preflight);
    const output = options.output || options.input;
    if (options.rollback) {
      try {
        const result = await rollback(preflight.environmentId, manifest, output, options);
        process.stdout.write(`${JSON.stringify({
          mode: 'rollback-complete',
          environment: publicEnvironmentSummary(preflight),
          migrationRunId: manifest.migrationRunId,
          ...result,
          privateManifest: path.relative(ROOT, output)
        }, null, 2)}\n`);
      } catch (error) {
        manifest.mode = 'rollback-interrupted';
        manifest.rollbackInterruption = {
          at: new Date().toISOString(),
          code: error.code || 'ROLLBACK_FAILED'
        };
        try {
          const observed = await readSnapshot(preflight.environmentId);
          manifest.rollbackObservedState = detectMigrationState(
            manifest.expectedMutations,
            observed
          );
        } catch (readError) {
          manifest.rollbackObservedState = {
            classification: 'unreadable',
            code: readError.code || 'SNAPSHOT_FAILED'
          };
        }
        writePrivateJson(output, manifest);
        throw error;
      }
      return;
    }
    assertMaintenance(preflight.environmentId, manifest.migrationRunId);
    const liveBefore = await readSnapshot(preflight.environmentId);
    assert(manifest.plan.safeToApply, 'migration plan contains blocking integrity issues', 'MIGRATION_PLAN_UNSAFE');
    let selectedMutations = manifest.expectedMutations;
    if (options.resume) {
      const liveState = detectMigrationState(manifest.expectedMutations, liveBefore);
      assert(liveState.counts.diverged === 0 && liveState.counts.missing === 0, 'live migration state cannot be resumed safely', 'MIGRATION_STATE_DIVERGED');
      const stateById = new Map(liveState.details.map((item) => [item.mutationId, item.state]));
      selectedMutations = manifest.expectedMutations.filter((item) => stateById.get(item.mutationId) === 'before');
      manifest.resume = {
        requestedAt: new Date().toISOString(),
        stateBefore: liveState,
        pendingMutations: selectedMutations.length
      };
    } else {
      const liveHashes = snapshotHashes(liveBefore);
      assert(liveHashes.combined === manifest.beforeHashes.combined, 'live snapshot differs from prepared dry-run', 'MIGRATION_SNAPSHOT_CHANGED');
    }
    manifest.mode = 'apply-in-progress';
    manifest.startedAt = new Date().toISOString();
    manifest.checkpoint = {
      stage: 'prepared',
      stageTotal: 0,
      stageCompleted: 0,
      completedMutationIds: [],
      updatedAt: manifest.startedAt
    };
    writePrivateJson(output, manifest);
    try {
      applyStages(preflight.environmentId, manifest, output, options.fault, selectedMutations);
      const afterSnapshot = await readSnapshot(preflight.environmentId);
      const verification = verifyMigration(
        manifest.plan,
        manifest.beforeSnapshot,
        afterSnapshot,
        manifest.expectedMutations
      );
      manifest.mode = verification.passed ? 'apply-complete' : 'apply-verification-failed';
      manifest.completedAt = new Date().toISOString();
      manifest.afterSnapshot = afterSnapshot;
      manifest.verification = verification;
      writePrivateJson(output, manifest);
      assert(verification.passed, 'post-migration field/hash verification failed', 'MIGRATION_VERIFICATION_FAILED');
      process.stdout.write(`${JSON.stringify({
        mode: 'apply-complete',
        environment: publicEnvironmentSummary(preflight),
        migrationRunId: manifest.migrationRunId,
        checkpoint: manifest.checkpoint,
        verification,
        privateManifest: path.relative(ROOT, output)
      }, null, 2)}\n`);
    } catch (error) {
      manifest.mode = 'apply-interrupted';
      manifest.interruption = {
        at: new Date().toISOString(),
        code: error.code || 'MIGRATION_APPLY_FAILED',
        faultPoint: error.faultPoint || ''
      };
      try {
        const observed = await readSnapshot(preflight.environmentId);
        manifest.observedState = detectMigrationState(manifest.expectedMutations, observed);
      } catch (readError) {
        manifest.observedState = { classification: 'unreadable', code: readError.code || 'SNAPSHOT_FAILED' };
      }
      writePrivateJson(output, manifest);
      throw error;
    }
    return;
  }

  const output = options.output || defaultOutput(options.environmentName);
  const beforeSnapshot = await readSnapshot(preflight.environmentId);
  const plan = buildMigrationPlan(beforeSnapshot);
  const expectedMutations = buildExpectedMutations(plan, beforeSnapshot);
  const beforeHashes = snapshotHashes(beforeSnapshot);
  const manifest = {
    schemaVersion: 2,
    environmentName: options.environmentName,
    environmentIdMasked: preflight.environmentIdMasked,
    mode: 'dry-run',
    migrationRunId: plan.migrationId,
    preparedAt: new Date().toISOString(),
    plan,
    expectedMutations,
    beforeSnapshot,
    beforeHashes
  };
  writePrivateJson(output, manifest);
  process.stdout.write(`${JSON.stringify({
    mode: 'dry-run',
    environment: publicEnvironmentSummary(preflight),
    migrationRunId: manifest.migrationRunId,
    plan: publicPlan(plan),
    snapshotCounts: Object.fromEntries(SNAPSHOT_COLLECTIONS.map((name) => [name, beforeSnapshot[name].length])),
    expectedMutations: expectedMutations.reduce((counts, item) => {
      counts[item.stage] = (counts[item.stage] || 0) + 1;
      return counts;
    }, {}),
    beforeHashes,
    applyCommandRequirements: {
      preparedManifestRequired: true,
      maintenanceRunIdMustMatch: true,
      confirmTarget: preflight.environmentIdMasked,
      ownerAuthorization: OWNER_AUTHORIZATION,
      productionApplyExecuted: false
    },
    privateManifest: path.relative(ROOT, output)
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'PHASE24_PAIR_MIGRATION_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  OWNER_AUTHORIZATION,
  PAGE_SIZE,
  FAULT_POINTS,
  TARGET_INDEXES,
  parseArguments,
  collectSnapshotPages,
  readCollection,
  readSnapshot,
  readMaintenance,
  assertMaintenance,
  dropTargetIndexes,
  rollback
};
