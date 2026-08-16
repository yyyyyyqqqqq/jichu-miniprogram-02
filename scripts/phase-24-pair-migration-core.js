const crypto = require('crypto');

const SNAPSHOT_COLLECTIONS = Object.freeze([
  'users', 'products', 'conversations', 'messages', 'appointments'
]);
const MUTATED_COLLECTIONS = Object.freeze([
  'conversations', 'messages', 'appointments'
]);

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    normalizeValue(value[key])
  ]));
}

function stableStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sortedDocuments(documents) {
  return [...(documents || [])].sort((left, right) => (
    String(left && left._id || '').localeCompare(String(right && right._id || ''))
  ));
}

function collectionHash(documents) {
  return sha256(stableStringify(sortedDocuments(documents)));
}

function snapshotHashes(snapshot) {
  const collections = Object.fromEntries(SNAPSHOT_COLLECTIONS.map((name) => [
    name,
    collectionHash(snapshot[name] || [])
  ]));
  return {
    collections,
    combined: sha256(stableStringify(collections))
  };
}

function omitFields(document, fields) {
  return Object.fromEntries(Object.entries(document || {}).filter(([key]) => (
    !fields.has(key)
  )));
}

function businessInvariant(snapshot, plan) {
  const sourceConversationIds = new Set(
    (plan.canonicalStates || plan.canonicalWrites || [])
      .flatMap((item) => item.sourceConversationIds || [])
  );
  const conversationMutable = new Set([
    'status', 'mergedInto', 'participantPairKey', 'legacyProductId',
    'productId', 'migrationId', 'migratedAt'
  ]);
  const messageMutable = new Set(['conversationId', 'contextProductId']);
  const appointmentMutable = new Set(['conversationId']);
  return {
    users: sortedDocuments(snapshot.users || []),
    products: sortedDocuments(snapshot.products || []),
    conversations: sortedDocuments((snapshot.conversations || [])
      .filter((item) => sourceConversationIds.has(item._id))
      .map((item) => omitFields(item, conversationMutable))),
    messages: sortedDocuments((snapshot.messages || [])
      .map((item) => omitFields(item, messageMutable))),
    appointments: sortedDocuments((snapshot.appointments || [])
      .map((item) => omitFields(item, appointmentMutable)))
  };
}

function businessHash(snapshot, plan) {
  return sha256(stableStringify(businessInvariant(snapshot, plan)));
}

function archiveAfter(item, plan) {
  return {
    ...item.before,
    status: 'merged',
    mergedInto: item.canonicalConversationId,
    participantPairKey: `archived:${item.conversationId}`,
    legacyProductId: item.before.productId || '',
    productId: `merged_${item.conversationId.slice(2)}`,
    migrationId: plan.migrationId,
    migratedAt: plan.generatedAt
  };
}

function buildExpectedMutations(plan, beforeSnapshot) {
  const messages = new Map((beforeSnapshot.messages || []).map((item) => [item._id, item]));
  const appointments = new Map((beforeSnapshot.appointments || []).map((item) => [item._id, item]));
  const mutations = [];
  plan.archives.forEach((item) => mutations.push({
    mutationId: `${plan.migrationId}:archive:${item.conversationId}`,
    stage: 'archives',
    collection: 'conversations',
    documentId: item.conversationId,
    operation: 'replace',
    before: item.before,
    expectedAfter: archiveAfter(item, plan)
  }));
  plan.canonicalWrites.forEach((item) => mutations.push({
    mutationId: `${plan.migrationId}:canonical:${item.document._id}`,
    stage: 'canonicals',
    collection: 'conversations',
    documentId: item.document._id,
    operation: item.exists ? 'replace' : 'insert',
    before: item.before,
    expectedAfter: item.exists
      ? { ...item.before, ...item.document }
      : item.document
  }));
  plan.messageUpdates.forEach((item) => {
    const before = messages.get(item.messageId);
    mutations.push({
      mutationId: `${plan.migrationId}:message:${item.messageId}`,
      stage: 'messages',
      collection: 'messages',
      documentId: item.messageId,
      operation: 'replace',
      before,
      expectedAfter: {
        ...before,
        conversationId: item.canonicalConversationId,
        contextProductId: item.contextProductId
      }
    });
  });
  plan.appointmentUpdates.forEach((item) => {
    const before = appointments.get(item.appointmentId);
    mutations.push({
      mutationId: `${plan.migrationId}:appointment:${item.appointmentId}`,
      stage: 'appointments',
      collection: 'appointments',
      documentId: item.appointmentId,
      operation: 'replace',
      before,
      expectedAfter: { ...before, conversationId: item.canonicalConversationId }
    });
  });
  return mutations;
}

function documentState(document, mutation) {
  if (!document) {
    return mutation.before ? 'missing' : 'before';
  }
  if (stableStringify(document) === stableStringify(mutation.expectedAfter)) return 'after';
  if (mutation.before && stableStringify(document) === stableStringify(mutation.before)) return 'before';
  return 'diverged';
}

function detectMigrationState(expectedMutations, snapshot) {
  const maps = Object.fromEntries(MUTATED_COLLECTIONS.map((name) => [
    name,
    new Map((snapshot[name] || []).map((item) => [item._id, item]))
  ]));
  const counts = { before: 0, after: 0, missing: 0, diverged: 0 };
  const byStage = {};
  const details = expectedMutations.map((mutation) => {
    const state = documentState(maps[mutation.collection].get(mutation.documentId), mutation);
    counts[state] = (counts[state] || 0) + 1;
    if (!byStage[mutation.stage]) byStage[mutation.stage] = { before: 0, after: 0, missing: 0, diverged: 0 };
    byStage[mutation.stage][state] += 1;
    return { mutationId: mutation.mutationId, state };
  });
  return {
    classification: counts.diverged > 0 || counts.missing > 0
      ? 'unknown'
      : counts.after === 0
        ? 'before'
        : counts.before === 0
          ? 'after'
          : 'partial',
    counts,
    byStage,
    details
  };
}

function uniqueMessageConflicts(messages) {
  const keys = new Set();
  const conflicts = [];
  (messages || []).forEach((message) => {
    const key = [message.conversationId, message.senderOpenid, message.clientMessageId].join(':');
    if (keys.has(key)) conflicts.push(message._id);
    keys.add(key);
  });
  return conflicts;
}

function verifyMigration(plan, beforeSnapshot, afterSnapshot, expectedMutations) {
  const failures = [];
  const expectedCreates = expectedMutations.filter((item) => (
    item.collection === 'conversations' && item.operation === 'insert'
  )).length;
  if ((afterSnapshot.conversations || []).length !== (beforeSnapshot.conversations || []).length + expectedCreates) {
    failures.push('conversation-count');
  }
  for (const name of ['messages', 'appointments', 'users', 'products']) {
    if ((afterSnapshot[name] || []).length !== (beforeSnapshot[name] || []).length) {
      failures.push(`${name}-count`);
    }
  }
  const state = detectMigrationState(expectedMutations, afterSnapshot);
  if (state.classification !== 'after') failures.push(`mutation-state:${state.classification}`);
  const conversations = new Map((afterSnapshot.conversations || []).map((item) => [item._id, item]));
  const conversationIds = new Set(conversations.keys());
  const pairKeys = new Set();
  (afterSnapshot.conversations || []).forEach((item) => {
    const pairKey = String(item.participantPairKey || '');
    if (!pairKey || pairKeys.has(pairKey)) failures.push(`pair-key:${item._id}`);
    pairKeys.add(pairKey);
  });
  (afterSnapshot.messages || []).forEach((item) => {
    if (!conversationIds.has(item.conversationId)) failures.push(`orphan-message:${item._id}`);
  });
  (afterSnapshot.appointments || []).forEach((item) => {
    if (!conversationIds.has(item.conversationId)) failures.push(`orphan-appointment:${item._id}`);
  });
  uniqueMessageConflicts(afterSnapshot.messages).forEach((id) => failures.push(`message-unique:${id}`));
  const beforeBusinessHash = businessHash(beforeSnapshot, plan);
  const afterBusinessHash = businessHash(afterSnapshot, plan);
  if (beforeBusinessHash !== afterBusinessHash) failures.push('business-hash');
  return {
    passed: failures.length === 0,
    failures,
    mutationState: state,
    hashes: {
      before: snapshotHashes(beforeSnapshot),
      after: snapshotHashes(afterSnapshot),
      beforeBusiness: beforeBusinessHash,
      afterBusiness: afterBusinessHash,
      businessEquivalent: beforeBusinessHash === afterBusinessHash
    }
  };
}

function verifyRollback(beforeSnapshot, rollbackSnapshot) {
  const before = snapshotHashes(beforeSnapshot);
  const rollback = snapshotHashes(rollbackSnapshot);
  const collectionMatches = Object.fromEntries(SNAPSHOT_COLLECTIONS.map((name) => [
    name,
    before.collections[name] === rollback.collections[name]
  ]));
  return {
    passed: Object.values(collectionMatches).every(Boolean),
    collectionMatches,
    before,
    rollback,
    fullHashMatches: before.combined === rollback.combined
  };
}

module.exports = {
  SNAPSHOT_COLLECTIONS,
  MUTATED_COLLECTIONS,
  normalizeValue,
  stableStringify,
  collectionHash,
  snapshotHashes,
  businessInvariant,
  businessHash,
  buildExpectedMutations,
  detectMigrationState,
  uniqueMessageConflicts,
  verifyMigration,
  verifyRollback
};
