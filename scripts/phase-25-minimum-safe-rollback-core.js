const crypto = require('crypto');

const MINIMUM_SAFE_ROLLBACK_BASELINE = Object.freeze({
  id: 'phase25-message-query-projection-floor-v1',
  functionName: 'messageQuery',
  sourceSha256: 'c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30',
  phase24ForbiddenSha256: 'a758d68da1d811d692a6bf0330580b3ecf155e215bb91b71a7a91cd6339b0313',
  sourceCommit: 'PHASE25_UNCOMMITTED_CANDIDATE',
  compatibleClients: Object.freeze(['phase24', 'phase25']),
  compatibleMessageActions: Object.freeze(['phase24', 'phase25']),
  compatibleAppointmentActions: Object.freeze(['phase24', 'phase25']),
  requiredProjectionBehavior: Object.freeze([
    'recalled payload replaced by neutral server projection',
    'delete-for-me filtered by authenticated participant slot',
    'hidden conversation filtered until a different activity snapshot arrives',
    'system message projection and appointment reference preserved'
  ])
});
const APPROVED_MESSAGE_QUERY_HASHES = Object.freeze(new Set([
  MINIMUM_SAFE_ROLLBACK_BASELINE.sourceSha256
]));
const BREAK_GLASS_AUTHORIZATION =
  'phase25-projection-floor-break-glass-approved-by-project-owner';
const LIFECYCLE_DATA_STATES = Object.freeze(new Set([
  'present',
  'absent',
  'unknown'
]));
const REQUIRED_SOURCE_MARKERS = Object.freeze([
  'if (record.recalled === true)',
  'isMessageDeletedFor(record, slot)',
  'isConversationHiddenFor(record, slot)',
  "type: 'recalled'",
  'message.appointmentId = normalizeString(record.appointmentId)'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function inspectMessageQuerySource(source) {
  const text = String(source || '');
  const sourceSha256 = sha256(text);
  const missingMarkers = REQUIRED_SOURCE_MARKERS.filter((marker) => (
    !text.includes(marker)
  ));
  return {
    sourceSha256,
    approved: APPROVED_MESSAGE_QUERY_HASHES.has(sourceSha256),
    phase24Forbidden: sourceSha256
      === MINIMUM_SAFE_ROLLBACK_BASELINE.phase24ForbiddenSha256,
    requiredBehaviorMarkersPresent: missingMarkers.length === 0,
    missingMarkers
  };
}

function evaluateProductionMessageQueryCandidate(source, options = {}) {
  const lifecycleDataState = String(
    options.lifecycleDataState || 'present'
  ).trim().toLowerCase();
  if (!LIFECYCLE_DATA_STATES.has(lifecycleDataState)) {
    const error = new Error('lifecycle data state must be present|absent|unknown');
    error.code = 'INVALID_LIFECYCLE_DATA_STATE';
    throw error;
  }
  const inspection = inspectMessageQuerySource(source);
  if (inspection.approved && inspection.requiredBehaviorMarkersPresent) {
    return {
      allowed: true,
      code: 'MINIMUM_SAFE_PROJECTION_APPROVED',
      lifecycleDataState,
      baselineId: MINIMUM_SAFE_ROLLBACK_BASELINE.id,
      inspection
    };
  }
  if (lifecycleDataState === 'present') {
    return {
      allowed: false,
      code: inspection.phase24Forbidden
        ? 'FORBIDDEN_PHASE24_MESSAGE_QUERY_ROLLBACK'
        : 'UNSEALED_MESSAGE_QUERY_ROLLBACK_TARGET',
      lifecycleDataState,
      baselineId: MINIMUM_SAFE_ROLLBACK_BASELINE.id,
      inspection
    };
  }
  const breakGlassApproved = lifecycleDataState === 'absent'
    && options.breakGlass === true
    && String(options.ownerAuthorization || '') === BREAK_GLASS_AUTHORIZATION;
  return {
    allowed: breakGlassApproved,
    code: breakGlassApproved
      ? 'PRE_LIFECYCLE_BREAK_GLASS_APPROVED'
      : inspection.phase24Forbidden
        ? 'FORBIDDEN_PHASE24_MESSAGE_QUERY_ROLLBACK'
        : 'UNSEALED_MESSAGE_QUERY_ROLLBACK_TARGET',
    lifecycleDataState,
    baselineId: MINIMUM_SAFE_ROLLBACK_BASELINE.id,
    inspection
  };
}

function assertProductionMessageQueryCandidate(source, options = {}) {
  const result = evaluateProductionMessageQueryCandidate(source, options);
  if (!result.allowed) {
    const error = new Error(
      `${result.code}: production messageQuery cannot go below ${result.baselineId}`
    );
    error.code = result.code;
    error.result = result;
    throw error;
  }
  return result;
}

module.exports = {
  MINIMUM_SAFE_ROLLBACK_BASELINE,
  APPROVED_MESSAGE_QUERY_HASHES,
  BREAK_GLASS_AUTHORIZATION,
  REQUIRED_SOURCE_MARKERS,
  sha256,
  inspectMessageQuerySource,
  evaluateProductionMessageQueryCandidate,
  assertProductionMessageQueryCandidate
};
