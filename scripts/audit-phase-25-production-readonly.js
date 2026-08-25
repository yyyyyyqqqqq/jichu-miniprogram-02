const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  runPreflight,
  publicSummary
} = require('./environment-preflight');
const {
  runNoSql,
  extractCommandResults,
  extractDocuments
} = require('./schools/cloud-cli');
const {
  callTcb
} = require('./phase-18-final-cutover-core');
const {
  readFunctionDetail
} = require('./phase-18-canary-core');

const ROOT = path.resolve(__dirname, '..');
const PHASE24_COMMIT = '7131e58a72dfe2a90342e8a23554c6e94aeabb6c';
const PAGE_SIZE = 1000;
const MAXIMUM_RECORDS = 10000;
const FUNCTION_NAMES = Object.freeze([
  'messageAction',
  'messageQuery',
  'appointmentAction',
  'appointmentQuery'
]);
const COLLECTION_PROJECTIONS = Object.freeze({
  users: Object.freeze({ _id: 1 }),
  products: Object.freeze({ _id: 1 }),
  conversations: Object.freeze({
    _id: 1,
    schemaVersion: 1,
    status: 1,
    participantPairKey: 1,
    participantAUserId: 1,
    participantBUserId: 1,
    participantAOpenid: 1,
    participantBOpenid: 1,
    participantAUnreadCount: 1,
    participantBUnreadCount: 1,
    mergedInto: 1,
    canonicalConversationId: 1,
    lastMessageId: 1,
    lastMessageType: 1,
    lastMessageAt: 1,
    lastSenderOpenid: 1,
    participantAHiddenAt: 1,
    participantBHiddenAt: 1,
    participantAHiddenActivityId: 1,
    participantBHiddenActivityId: 1,
    participantAHiddenActivityAt: 1,
    participantBHiddenActivityAt: 1,
    participantAHiddenLastMessageId: 1,
    participantBHiddenLastMessageId: 1,
    participantAHiddenLastMessageAt: 1,
    participantBHiddenLastMessageAt: 1
  }),
  messages: Object.freeze({
    _id: 1,
    conversationId: 1,
    senderOpenid: 1,
    type: 1,
    appointmentId: 1,
    recalled: 1,
    recalledAt: 1,
    deletedForParticipantAAt: 1,
    deletedForParticipantBAt: 1
  }),
  appointments: Object.freeze({
    _id: 1,
    conversationId: 1,
    productId: 1,
    buyerOpenid: 1,
    sellerOpenid: 1,
    status: 1,
    isDeleted: 1
  })
});
const COLLECTION_NAMES = Object.freeze(Object.keys(COLLECTION_PROJECTIONS));
const ACL_COLLECTION_NAMES = Object.freeze([
  'messages',
  'conversations',
  'appointments'
]);
const MESSAGE_TYPES = new Set([
  'text', 'voice', 'image', 'location', 'product', 'system'
]);
const RECALLABLE_TYPES = new Set([
  'text', 'voice', 'image', 'location', 'product'
]);
const SUMMARY_TYPES = new Set([
  'text', 'voice', 'image', 'location', 'product', 'system', 'recalled'
]);
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^m_[a-f0-9]{64}$/;
const PAIR_KEY_PATTERN = /^pp_[a-f0-9]{64}$/;
const ARCHIVED_PAIR_KEY_PATTERN = /^archived:c_[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidDate(value) {
  return value !== undefined
    && value !== null
    && Number.isFinite(new Date(value).getTime());
}

function isNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0;
}

function extractQueryDocuments(response) {
  const results = extractCommandResults(response);
  return results.length > 0
    ? results.flatMap((result) => extractDocuments(result))
    : extractDocuments(response);
}

function queryAll(environmentId, collectionName, projection) {
  const records = [];
  for (let skip = 0; skip < MAXIMUM_RECORDS; skip += PAGE_SIZE) {
    const response = runNoSql(environmentId, [{
      TableName: collectionName,
      CommandType: 'QUERY',
      Command: JSON.stringify({
        find: collectionName,
        filter: {},
        projection,
        sort: { _id: 1 },
        skip,
        limit: PAGE_SIZE
      })
    }]);
    const page = extractQueryDocuments(response);
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
  throw Object.assign(
    new Error(`${collectionName} reached read-only safety limit ${MAXIMUM_RECORDS}`),
    { code: 'READ_ONLY_AUDIT_LIMIT_REACHED' }
  );
}

async function readTables(environmentId) {
  const response = await callTcb('DescribeTables', {
    EnvId: environmentId,
    MgoLimit: 100,
    MgoOffset: 0
  });
  return Object.fromEntries((response.Tables || []).map((item) => [
    String(item.TableName || ''),
    {
      count: Number(item.Count || 0),
      indexCount: Number(item.IndexCount || 0)
    }
  ]));
}

async function readAcl(environmentId) {
  const result = {};
  for (const collectionName of ACL_COLLECTION_NAMES) {
    const response = await callTcb('DescribeSafeRule', {
      EnvId: environmentId,
      CollectionName: collectionName
    });
    result[collectionName] = String(response.AclTag || '');
  }
  return result;
}

function normalizeIndex(index) {
  const keys = index.MgoKeySchema && index.MgoKeySchema.MgoIndexKeys
    || index.Keys
    || Object.entries(index.key || {}).map(([Name, Direction]) => ({ Name, Direction }));
  return {
    name: String(index.IndexName || index.Name || index.name || ''),
    unique: index.MgoKeySchema && index.MgoKeySchema.MgoIsUnique === true
      || index.Unique === true
      || index.unique === true
      || String(index.IndexName || index.Name || index.name || '') === '_id_',
    keys: (Array.isArray(keys) ? keys : []).map((item) => [
      String(item.Name || ''),
      Number(item.Direction)
    ])
  };
}

async function readIndexes(environmentId) {
  const result = {};
  for (const collectionName of ACL_COLLECTION_NAMES) {
    const response = await callTcb('DescribeTable', {
      EnvId: environmentId,
      TableName: collectionName
    });
    result[collectionName] = (response.Indexes || [])
      .map(normalizeIndex)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  return result;
}

function readGitSource(commit, relativePath) {
  return execFileSync(
    'git',
    ['show', `${commit}:${relativePath.replace(/\\/g, '/')}`],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  );
}

function readEnvironmentRole(detail) {
  const variables = detail && detail.Environment && detail.Environment.Variables;
  const match = (Array.isArray(variables) ? variables : []).find((item) => (
    String(item.Key || item.key || '') === 'JICHU_ENVIRONMENT_ROLE'
  ));
  return match ? String(match.Value || match.value || '') : '';
}

function readFunctionState(environmentId) {
  const result = {};
  for (const functionName of FUNCTION_NAMES) {
    const relativePath = `cloudfunctions/${functionName}/index.js`;
    const detail = readFunctionDetail(environmentId, functionName);
    const remoteSource = String(detail.CodeInfo || '');
    const localSource = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const phase24Source = readGitSource(PHASE24_COMMIT, relativePath);
    const productionHash = remoteSource ? sha256(remoteSource) : '';
    result[functionName] = {
      status: String(detail.Status || ''),
      availableStatus: String(detail.AvailableStatus || ''),
      runtime: String(detail.Runtime || ''),
      handler: String(detail.Handler || ''),
      timeout: Number(detail.Timeout || 0),
      memory: Number(detail.MemorySize || 0),
      installDependency: String(detail.InstallDependency || ''),
      diagnosticEnvironmentRole: readEnvironmentRole(detail) || '(unset)',
      productionSourceSha256: productionHash,
      phase24SourceSha256: sha256(phase24Source),
      localPhase25SourceSha256: sha256(localSource),
      productionMatchesPhase24: Boolean(productionHash)
        && productionHash === sha256(phase24Source),
      localDiffersFromProduction: Boolean(productionHash)
        && productionHash !== sha256(localSource)
    };
  }
  return result;
}

function auditConversations(conversations) {
  const byId = new Map(conversations.map((item) => [normalizeText(item._id), item]));
  const active = conversations.filter((item) => item.status === 'active');
  const merged = conversations.filter((item) => item.status === 'merged');
  const pairCounts = new Map();
  const allPairCounts = new Map();
  for (const item of conversations) {
    const key = normalizeText(item.participantPairKey);
    if (key) allPairCounts.set(key, Number(allPairCounts.get(key) || 0) + 1);
  }
  for (const item of active) {
    const key = normalizeText(item.participantPairKey);
    if (key) pairCounts.set(key, Number(pairCounts.get(key) || 0) + 1);
  }
  const duplicateActiveKeys = [...pairCounts.values()]
    .filter((count) => count > 1).length;
  const duplicateAllKeys = [...allPairCounts.values()]
    .filter((count) => count > 1).length;
  const activeMalformed = active.filter((item) => (
    !CONVERSATION_ID_PATTERN.test(normalizeText(item._id))
    || Number(item.schemaVersion) !== 2
    || !PAIR_KEY_PATTERN.test(normalizeText(item.participantPairKey))
    || !normalizeText(item.participantAUserId)
    || !normalizeText(item.participantBUserId)
    || normalizeText(item.participantAUserId) === normalizeText(item.participantBUserId)
    || !normalizeText(item.participantAOpenid)
    || !normalizeText(item.participantBOpenid)
    || normalizeText(item.participantAOpenid) === normalizeText(item.participantBOpenid)
    || !isNonNegativeInteger(item.participantAUnreadCount)
    || !isNonNegativeInteger(item.participantBUnreadCount)
  )).length;
  const mergedMalformed = merged.filter((item) => {
    const canonicalId = normalizeText(item.mergedInto || item.canonicalConversationId);
    return !CONVERSATION_ID_PATTERN.test(normalizeText(item._id))
      || !ARCHIVED_PAIR_KEY_PATTERN.test(normalizeText(item.participantPairKey))
      || !CONVERSATION_ID_PATTERN.test(canonicalId)
      || canonicalId === normalizeText(item._id);
  }).length;
  const danglingAliases = merged.filter((item) => {
    const canonicalId = normalizeText(item.mergedInto || item.canonicalConversationId);
    const target = byId.get(canonicalId);
    return !target || target.status !== 'active';
  }).length;
  return {
    total: conversations.length,
    activeCanonical: active.length,
    mergedAliases: merged.length,
    invalidOrUnknownStatus: conversations.filter((item) => (
      item.status !== 'active' && item.status !== 'merged'
    )).length,
    duplicateActiveParticipantPairKey: duplicateActiveKeys,
    duplicateAllParticipantPairKey: duplicateAllKeys,
    missingParticipantPairKey: conversations.filter((item) => (
      !normalizeText(item.participantPairKey)
    )).length,
    activeCanonicalMalformed: activeMalformed,
    mergedAliasMalformed: mergedMalformed,
    aliasCanonicalDangling: danglingAliases
  };
}

function auditMessages(messages, conversations, appointments) {
  const conversationsById = new Map(conversations.map((item) => [
    normalizeText(item._id), item
  ]));
  const appointmentsById = new Map(appointments.map((item) => [
    normalizeText(item._id), item
  ]));
  const messageIds = new Set(messages.map((item) => normalizeText(item._id)));
  const systemMessages = messages.filter((item) => item.type === 'system');
  const missingConversation = messages.filter((item) => (
    !conversationsById.has(normalizeText(item.conversationId))
  )).length;
  const nonCanonicalConversation = messages.filter((item) => {
    const conversation = conversationsById.get(normalizeText(item.conversationId));
    return Boolean(conversation) && conversation.status !== 'active';
  }).length;
  const senderNotParticipant = messages.filter((item) => {
    const conversation = conversationsById.get(normalizeText(item.conversationId));
    if (!conversation || conversation.status !== 'active') return false;
    const sender = normalizeText(item.senderOpenid);
    return !sender || ![
      normalizeText(conversation.participantAOpenid),
      normalizeText(conversation.participantBOpenid)
    ].includes(sender);
  }).length;
  const malformedRecalled = messages.filter((item) => {
    const hasRecalled = Object.prototype.hasOwnProperty.call(item, 'recalled');
    const hasRecalledAt = item.recalledAt !== undefined && item.recalledAt !== null;
    if (!hasRecalled && !hasRecalledAt) return false;
    if (item.recalled === false && !hasRecalledAt) return false;
    return item.recalled !== true
      || !isValidDate(item.recalledAt)
      || !RECALLABLE_TYPES.has(item.type);
  }).length;
  const malformedDeleted = messages.filter((item) => (
    ['deletedForParticipantAAt', 'deletedForParticipantBAt'].some((field) => (
      item[field] !== undefined
      && item[field] !== null
      && !isValidDate(item[field])
    ))
  )).length;
  const systemAppointmentMissing = systemMessages.filter((item) => (
    !normalizeText(item.appointmentId)
    || !appointmentsById.has(normalizeText(item.appointmentId))
  )).length;
  const systemConversationMismatch = systemMessages.filter((item) => {
    const appointment = appointmentsById.get(normalizeText(item.appointmentId));
    return Boolean(appointment)
      && normalizeText(appointment.conversationId)
        !== normalizeText(item.conversationId);
  }).length;
  return {
    total: messages.length,
    uniqueMessageIdCount: messageIds.size,
    orphanMessage: missingConversation + nonCanonicalConversation,
    conversationMissing: missingConversation,
    conversationNotActiveCanonical: nonCanonicalConversation,
    senderNotParticipant,
    invalidType: messages.filter((item) => !MESSAGE_TYPES.has(item.type)).length,
    malformedRecalledState: malformedRecalled,
    malformedDeleteForMeState: malformedDeleted,
    systemMessageCount: systemMessages.length,
    systemAppointmentReferenceMissing: systemAppointmentMissing,
    systemAppointmentConversationMismatch: systemConversationMismatch
  };
}

function auditAppointments(appointments, conversations, products) {
  const conversationsById = new Map(conversations.map((item) => [
    normalizeText(item._id), item
  ]));
  const productIds = new Set(products.map((item) => normalizeText(item._id)));
  return {
    total: appointments.length,
    conversationMissing: appointments.filter((item) => (
      !conversationsById.has(normalizeText(item.conversationId))
    )).length,
    conversationNotActiveCanonical: appointments.filter((item) => {
      const conversation = conversationsById.get(normalizeText(item.conversationId));
      return Boolean(conversation) && conversation.status !== 'active';
    }).length,
    participantMismatch: appointments.filter((item) => {
      const conversation = conversationsById.get(normalizeText(item.conversationId));
      if (!conversation || conversation.status !== 'active') return false;
      const participants = new Set([
        normalizeText(conversation.participantAOpenid),
        normalizeText(conversation.participantBOpenid)
      ]);
      return !participants.has(normalizeText(item.buyerOpenid))
        || !participants.has(normalizeText(item.sellerOpenid));
    }).length,
    productMissing: appointments.filter((item) => (
      !productIds.has(normalizeText(item.productId))
    )).length
  };
}

function auditLatestSummary(conversations, messages) {
  const messagesById = new Map(messages.map((item) => [normalizeText(item._id), item]));
  const active = conversations.filter((item) => item.status === 'active');
  const withLastMessageId = active.filter((item) => normalizeText(item.lastMessageId));
  return {
    activeConversationCount: active.length,
    optionalLastMessageIdAbsent: active.length - withLastMessageId.length,
    lastMessageIdPresent: withLastMessageId.length,
    lastMessageMissing: withLastMessageId.filter((item) => (
      !messagesById.has(normalizeText(item.lastMessageId))
    )).length,
    lastMessageConversationMismatch: withLastMessageId.filter((item) => {
      const message = messagesById.get(normalizeText(item.lastMessageId));
      return Boolean(message)
        && normalizeText(message.conversationId) !== normalizeText(item._id);
    }).length,
    invalidLastMessageType: active.filter((item) => (
      normalizeText(item.lastMessageId)
      && !SUMMARY_TYPES.has(normalizeText(item.lastMessageType))
    )).length,
    invalidLastMessageAt: active.filter((item) => (
      normalizeText(item.lastMessageId) && !isValidDate(item.lastMessageAt)
    )).length,
    lastSenderNotParticipant: active.filter((item) => {
      if (!normalizeText(item.lastMessageId)) return false;
      return ![
        normalizeText(item.participantAOpenid),
        normalizeText(item.participantBOpenid)
      ].includes(normalizeText(item.lastSenderOpenid));
    }).length,
    unreadAccuracyAssessment: 'not fully provable by read-only audit'
  };
}

function auditLifecycleState(conversations, messages) {
  const recalledMessages = messages.filter((item) => (
    item.recalled === true || item.recalledAt !== undefined && item.recalledAt !== null
  )).length;
  const deleteForMeMessages = messages.filter((item) => (
    item.deletedForParticipantAAt !== undefined
      && item.deletedForParticipantAAt !== null
    || item.deletedForParticipantBAt !== undefined
      && item.deletedForParticipantBAt !== null
  )).length;
  const hideFields = [
    'participantAHiddenAt',
    'participantBHiddenAt',
    'participantAHiddenActivityId',
    'participantBHiddenActivityId',
    'participantAHiddenActivityAt',
    'participantBHiddenActivityAt',
    'participantAHiddenLastMessageId',
    'participantBHiddenLastMessageId',
    'participantAHiddenLastMessageAt',
    'participantBHiddenLastMessageAt'
  ];
  const hiddenConversations = conversations.filter((item) => (
    hideFields.some((field) => {
      const value = item[field];
      return value !== undefined && value !== null && value !== '';
    })
  )).length;
  const phase25LifecycleRecordCount = recalledMessages
    + deleteForMeMessages
    + hiddenConversations;
  return {
    state: phase25LifecycleRecordCount === 0 ? 'absent' : 'present',
    recalledMessages,
    deleteForMeMessages,
    hiddenConversations,
    phase25LifecycleRecordCount,
    transitionRule: phase25LifecycleRecordCount === 0
      ? 'pre-first-lifecycle-mutation'
      : 'minimum-safe-messageQuery-floor-permanently-enforced'
  };
}

async function run() {
  const preflight = runPreflight({
    environmentName: 'production',
    action: 'audit',
    allowInactiveRead: true,
    allowProductionWrite: false
  });
  const tables = await readTables(preflight.environmentId);
  const records = Object.fromEntries(COLLECTION_NAMES.map((collectionName) => [
    collectionName,
    queryAll(
      preflight.environmentId,
      collectionName,
      COLLECTION_PROJECTIONS[collectionName]
    )
  ]));
  const acl = await readAcl(preflight.environmentId);
  const indexes = await readIndexes(preflight.environmentId);
  const functions = readFunctionState(preflight.environmentId);
  const conversationAudit = auditConversations(records.conversations);
  const messageAudit = auditMessages(
    records.messages,
    records.conversations,
    records.appointments
  );
  const appointmentAudit = auditAppointments(
    records.appointments,
    records.conversations,
    records.products
  );
  const latestSummaryAudit = auditLatestSummary(
    records.conversations,
    records.messages
  );
  const lifecycleState = auditLifecycleState(
    records.conversations,
    records.messages
  );
  const blockers = [];
  if (conversationAudit.duplicateActiveParticipantPairKey !== 0
    || conversationAudit.duplicateAllParticipantPairKey !== 0
    || conversationAudit.missingParticipantPairKey !== 0
    || conversationAudit.activeCanonicalMalformed !== 0
    || conversationAudit.mergedAliasMalformed !== 0
    || conversationAudit.aliasCanonicalDangling !== 0
    || conversationAudit.invalidOrUnknownStatus !== 0) {
    blockers.push('CANONICAL_CONVERSATION_INVARIANT_FAILED');
  }
  if (messageAudit.orphanMessage !== 0
    || messageAudit.senderNotParticipant !== 0
    || messageAudit.invalidType !== 0
    || messageAudit.malformedRecalledState !== 0
    || messageAudit.malformedDeleteForMeState !== 0) {
    blockers.push('MESSAGE_INTEGRITY_FAILED');
  }
  if (appointmentAudit.conversationMissing !== 0
    || appointmentAudit.conversationNotActiveCanonical !== 0
    || appointmentAudit.participantMismatch !== 0
    || appointmentAudit.productMissing !== 0
    || messageAudit.systemAppointmentReferenceMissing !== 0
    || messageAudit.systemAppointmentConversationMismatch !== 0) {
    blockers.push('APPOINTMENT_SYSTEM_MESSAGE_INTEGRITY_FAILED');
  }
  if (Object.values(acl).some((value) => value !== 'ADMINONLY')) {
    blockers.push('COLLECTION_ACL_FAILED');
  }
  if (latestSummaryAudit.lastMessageMissing !== 0
    || latestSummaryAudit.lastMessageConversationMismatch !== 0
    || latestSummaryAudit.invalidLastMessageType !== 0
    || latestSummaryAudit.invalidLastMessageAt !== 0
    || latestSummaryAudit.lastSenderNotParticipant !== 0) {
    blockers.push('LATEST_SUMMARY_INTEGRITY_FAILED');
  }
  if (Object.values(functions).some((item) => (
    item.status !== 'Active'
    || item.availableStatus !== 'Available'
    || item.handler !== 'index.main'
  ))) {
    blockers.push('PRODUCTION_FUNCTION_BASELINE_FAILED');
  }
  return {
    schemaVersion: 1,
    mode: 'phase-25-production-read-only-review',
    completedAt: new Date().toISOString(),
    environment: publicSummary(preflight),
    readOnlyProof: {
      allowedDatabaseCommandTypes: ['QUERY'],
      databaseWriteApiCalled: false,
      functionInvoked: false,
      deploymentExecuted: false,
      environmentModified: false,
      aclIndexCollectionStorageModified: false,
      sensitivePayloadExported: false
    },
    tableCounts: Object.fromEntries(COLLECTION_NAMES.map((name) => [
      name,
      Number(tables[name] && tables[name].count || 0)
    ])),
    scannedCounts: Object.fromEntries(COLLECTION_NAMES.map((name) => [
      name,
      records[name].length
    ])),
    conversations: conversationAudit,
    messages: messageAudit,
    appointments: appointmentAudit,
    latestSummary: latestSummaryAudit,
    lifecycleState,
    acl,
    indexes,
    functions,
    readinessGate: {
      passed: blockers.length === 0,
      blockers
    }
  };
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(
      `${error.code || 'PHASE25_PRODUCTION_READONLY_AUDIT_FAILED'}: ${error.message}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTION_PROJECTIONS,
  queryAll,
  auditConversations,
  auditMessages,
  auditAppointments,
  auditLatestSummary,
  auditLifecycleState,
  run
};
