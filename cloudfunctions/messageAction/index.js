const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const maintenance = require('./maintenance');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const products = db.collection('products');
const conversations = db.collection('conversations');
const users = db.collection('users');
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^m_[a-f0-9]{64}$/;
const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const CLIENT_MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const NEW_CONVERSATION_STATUSES = new Set(['available', 'reserved']);
const MESSAGE_TYPES = new Set([
  'text',
  'voice',
  'image',
  'location',
  'product'
]);
const RECALLABLE_MESSAGE_TYPES = new Set([
  'text',
  'voice',
  'image',
  'location',
  'product'
]);
const FORWARDABLE_MESSAGE_TYPES = new Set(RECALLABLE_MESSAGE_TYPES);
const SELECTABLE_PRODUCT_STATUSES = new Set([
  'available',
  'reserved',
  'sold'
]);
const IMAGE_FILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{8,80}\.(?:jpg|jpeg|png|webp)$/i;
const VOICE_FILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{8,80}\.mp3$/i;
const MESSAGE_MAX_LENGTH = 500;
const LAST_MESSAGE_MAX_LENGTH = 80;
const MAX_MEDIA_FILE_ID_LENGTH = 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_SIZE = 10 * 1024 * 1024;
const MIN_VOICE_DURATION_MS = 1000;
const MAX_VOICE_DURATION_MS = 60000;
const MAX_MEDIA_DIMENSION = 12000;
const MAX_LOCATION_NAME_LENGTH = 80;
const MAX_LOCATION_ADDRESS_LENGTH = 200;
const LAST_MESSAGE_SUMMARIES = {
  voice: '[语音]',
  image: '[图片]',
  location: '[位置]',
  product: '[商品]'
};
const RECALL_WINDOW_MS = 2 * 60 * 1000;
const TRANSACTION_MAX_ATTEMPTS = 3;
const SAFE_TRACE_ID_PATTERN = /^tr_[a-z0-9_-]{8,40}$/;
const ATTEMPT_DIAGNOSTIC_ENV_NAME = 'JICHU_ENVIRONMENT_ROLE';
const ATTEMPT_DIAGNOSTIC_ACTIONS = new Set([
  'sendTextMessage',
  'sendMessage',
  'hideConversation'
]);
const ATTEMPT_DIAGNOSTIC_ROLES = new Set(['staging', 'development']);
const SAFE_DIAGNOSTIC_CODES = new Set([
  'OK',
  'DATABASE_TRANSACTION_CONFLICT',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
  'NETWORK_ERROR',
  'CLOUD_TIMEOUT',
  'UNKNOWN_SAFE_ERROR'
]);
const SAFE_ATTEMPT_STAGES = new Set([
  'transaction_start',
  'canonical_resolve',
  'participant_validate',
  'existing_message_check',
  'source_validate',
  'context_validate',
  'context_product_read',
  'payload_validate',
  'shared_product_read',
  'message_write',
  'conversation_update_prepare',
  'conversation_update_write',
  'response_projection',
  'commit'
]);
const SAFE_NUMERIC_ERROR_CODES = Object.freeze({
  '-501001': 'INTERNAL_ERROR',
  '-501002': 'CLOUD_TIMEOUT',
  '-501003': 'INTERNAL_ERROR',
  '-501004': 'INTERNAL_ERROR',
  '-502001': 'DATABASE_ERROR',
  '-502002': 'DATABASE_ERROR',
  '-502003': 'DATABASE_ERROR',
  '-502004': 'DATABASE_ERROR',
  '-502005': 'DATABASE_ERROR'
});

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  PRODUCT_SELLER_UNAVAILABLE: 'PRODUCT_SELLER_UNAVAILABLE',
  SELF_CONVERSATION_FORBIDDEN: 'SELF_CONVERSATION_FORBIDDEN',
  CROSS_SCHOOL_RELATION_FORBIDDEN: 'CROSS_SCHOOL_RELATION_FORBIDDEN',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  MESSAGE_EMPTY: 'MESSAGE_EMPTY',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
  INVALID_MESSAGE_TYPE: 'INVALID_MESSAGE_TYPE',
  INVALID_MEDIA: 'INVALID_MEDIA',
  INVALID_LOCATION: 'INVALID_LOCATION',
  INVALID_PRODUCT: 'INVALID_PRODUCT',
  PRODUCT_NOT_ACCESSIBLE: 'PRODUCT_NOT_ACCESSIBLE',
  MESSAGE_SEND_FAILED: 'MESSAGE_SEND_FAILED',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  MESSAGE_NOT_OWNED: 'MESSAGE_NOT_OWNED',
  MESSAGE_NOT_RECALLABLE: 'MESSAGE_NOT_RECALLABLE',
  MESSAGE_RECALL_EXPIRED: 'MESSAGE_RECALL_EXPIRED',
  MESSAGE_ALREADY_RECALLED: 'MESSAGE_ALREADY_RECALLED',
  MESSAGE_NOT_FORWARDABLE: 'MESSAGE_NOT_FORWARDABLE',
  INVALID_FORWARD_TARGET: 'INVALID_FORWARD_TARGET',
  MEDIA_FORWARD_FAILED: 'MEDIA_FORWARD_FAILED',
  SERVICE_MAINTENANCE: 'SERVICE_MAINTENANCE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function success(data) {
  return {
    success: true,
    code: ERROR_CODES.OK,
    message: '',
    data
  };
}

function failure(code, message) {
  return {
    success: false,
    code,
    message,
    data: null
  };
}

function businessError(code, message) {
  const error = new Error(message);
  error.businessCode = code;
  throw error;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProductId(value) {
  const productId = normalizeString(value);
  return PRODUCT_ID_PATTERN.test(productId) ? productId : '';
}

function normalizeConversationId(value) {
  const conversationId = normalizeString(value);
  return CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : '';
}

function normalizeMessageId(value) {
  const messageId = normalizeString(value);
  return MESSAGE_ID_PATTERN.test(messageId) ? messageId : '';
}

function normalizeClientMessageId(value) {
  const clientMessageId = normalizeString(value);
  return CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId)
    ? clientMessageId
    : '';
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function createSafeTraceId(value) {
  const supplied = normalizeString(value).toLowerCase();
  if (SAFE_TRACE_ID_PATTERN.test(supplied)) {
    return supplied;
  }
  return `tr_${crypto.randomBytes(6).toString('hex')}`;
}

function safeHash(value) {
  const normalized = normalizeString(value);
  return normalized ? createDigest(normalized).slice(0, 12) : '';
}

function getSafeErrorCode(error) {
  const value = error && (
    error.code
    || error.errCode
    || error.name
    || (error.cause && (error.cause.code || error.cause.errCode))
  );
  return normalizeString(String(value || 'UNKNOWN')).slice(0, 80);
}

function isAttemptDiagnosticEnabled() {
  const role = normalizeString(process.env[ATTEMPT_DIAGNOSTIC_ENV_NAME])
    .toLowerCase();
  return ATTEMPT_DIAGNOSTIC_ROLES.has(role);
}

function getWhitelistedDiagnosticCode(error) {
  if (isRetryableTransactionConflict(error)) {
    return 'DATABASE_TRANSACTION_CONFLICT';
  }
  const rawCodes = [
    error && error.code,
    error && error.errCode,
    error && error.name,
    error && error.cause && error.cause.code,
    error && error.cause && error.cause.errCode
  ].filter(Boolean).map((value) => String(value).trim().toUpperCase());
  const rawText = rawCodes.join(' ');
  const numericCode = rawCodes.find((code) => (
    Object.prototype.hasOwnProperty.call(SAFE_NUMERIC_ERROR_CODES, code)
  ));
  if (numericCode) {
    return SAFE_NUMERIC_ERROR_CODES[numericCode];
  }
  if (rawCodes.some((code) => SAFE_DIAGNOSTIC_CODES.has(code))) {
    return rawCodes.find((code) => SAFE_DIAGNOSTIC_CODES.has(code));
  }
  if (rawText.includes('TIMEOUT') || rawText.includes('TIMED_OUT')) {
    return 'CLOUD_TIMEOUT';
  }
  if (
    rawText.includes('NETWORK')
    || rawText.includes('ECONN')
    || rawText.includes('SOCKET')
  ) {
    return 'NETWORK_ERROR';
  }
  if (rawText.includes('DATABASE') || rawText.includes('DB_')) {
    return 'DATABASE_ERROR';
  }
  if (rawText.includes('INTERNAL')) {
    return 'INTERNAL_ERROR';
  }
  return 'UNKNOWN_SAFE_ERROR';
}

function createAttemptDiagnosticCollector(traceId, action, enabled) {
  const active = enabled === undefined
    ? isAttemptDiagnosticEnabled()
    : enabled === true;
  const stageActive = active
    && ['sendTextMessage', 'sendMessage'].includes(action);
  const attempts = new Map();
  let currentAttempt = 0;
  const ensureAttempt = (attemptValue) => {
    const attempt = Number.isInteger(attemptValue) && attemptValue > 0
      ? attemptValue
      : currentAttempt || 1;
    currentAttempt = attempt;
    if (!attempts.has(attempt)) {
      const record = {
        attempt,
        safeCode: 'UNKNOWN_SAFE_ERROR',
        retryable: false,
        transactionCreated: false,
        commitStarted: false,
        commitOutcome: 'unknown'
      };
      if (stageActive) {
        record.lastCompletedStage = '';
        record.failedStage = 'transaction_start';
      }
      attempts.set(attempt, record);
    }
    return attempts.get(attempt);
  };
  const onEvent = (event, details = {}) => {
    if (!active) {
      return;
    }
    const record = ensureAttempt(details.attempt);
    if (event === 'transaction_created') {
      record.transactionCreated = true;
      if (stageActive) {
        record.lastCompletedStage = 'transaction_start';
      }
    } else if (event === 'commit_start') {
      record.commitStarted = true;
      if (stageActive) {
        record.failedStage = 'commit';
      }
    } else if (event === 'commit_end') {
      record.safeCode = 'OK';
      record.retryable = false;
      record.commitOutcome = 'committed';
      if (stageActive) {
        record.lastCompletedStage = 'commit';
        record.failedStage = '';
      }
    } else if (event === 'transaction_error') {
      record.safeCode = SAFE_DIAGNOSTIC_CODES.has(details.safeCode)
        ? details.safeCode
        : 'UNKNOWN_SAFE_ERROR';
      record.retryable = details.retryable === true;
      if (record.retryable) {
        record.commitOutcome = 'conflict';
      } else if (record.commitStarted) {
        record.commitOutcome = 'outcome_unknown';
      } else {
        record.commitOutcome = 'failed_non_conflict';
      }
    } else if (event === 'attempt_end') {
      record.safeCode = SAFE_DIAGNOSTIC_CODES.has(details.safeCode)
        ? details.safeCode
        : 'UNKNOWN_SAFE_ERROR';
      record.retryable = details.retryable === true;
      if (record.retryable) {
        record.commitOutcome = 'conflict';
      } else if (record.commitOutcome === 'unknown') {
        record.commitOutcome = record.commitStarted
          ? 'outcome_unknown'
          : 'failed_non_conflict';
      }
    } else if (event === 'rollback_end' && !record.commitStarted) {
      record.commitOutcome = 'rolled_back';
    }
  };
  const setAttemptBoolean = (field, value) => {
    if (
      active
      && ['messageExistedBeforeAttempt', 'snapshotChanged'].includes(field)
    ) {
      ensureAttempt(currentAttempt)[field] = value === true;
    }
  };
  const beginStage = (stage) => {
    if (stageActive && SAFE_ATTEMPT_STAGES.has(stage)) {
      ensureAttempt(currentAttempt).failedStage = stage;
    }
  };
  const completeStage = (stage) => {
    if (stageActive && SAFE_ATTEMPT_STAGES.has(stage)) {
      ensureAttempt(currentAttempt).lastCompletedStage = stage;
    }
  };
  const toDiagnostic = (reconciliation = {}) => {
    if (!active || !ATTEMPT_DIAGNOSTIC_ACTIONS.has(action)) {
      return undefined;
    }
    const list = [...attempts.values()]
      .sort((left, right) => left.attempt - right.attempt)
      .map((item) => ({ ...item }));
    return {
      traceId,
      action,
      attemptCount: list.length,
      attempts: list,
      reconciliation: {
        attempted: reconciliation.attempted === true,
        outcome: ['found', 'not_found', 'query_failed', 'not_applicable']
          .includes(reconciliation.outcome)
          ? reconciliation.outcome
          : 'not_applicable'
      }
    };
  };
  return Object.freeze({
    enabled: active,
    onEvent,
    setAttemptBoolean,
    beginStage,
    completeStage,
    toDiagnostic
  });
}

function beginAttemptStage(trace, stage) {
  if (trace && trace.attemptDiagnostic) {
    trace.attemptDiagnostic.beginStage(stage);
  }
}

function completeAttemptStage(trace, stage) {
  if (trace && trace.attemptDiagnostic) {
    trace.attemptDiagnostic.completeStage(stage);
  }
}

function appendAttemptDiagnostic(response, trace) {
  const diagnostic = trace
    && trace.attemptDiagnostic
    && trace.attemptDiagnostic.toDiagnostic();
  return diagnostic ? { ...response, diagnostic } : response;
}

function logSafeTrace(trace, event, details = {}) {
  if (
    !trace
    || !trace.traceId
    || !['sendTextMessage', 'sendMessage', 'hideConversation'].includes(
      trace.action
    )
  ) {
    return;
  }
  console.info('[messageAction] safe trace', {
    traceId: trace.traceId,
    action: trace.action,
    stage: event,
    conversationHash: trace.conversationHash || '',
    messageHash: trace.messageHash || '',
    ...details
  });
}

function toDate(value) {
  if (!value) {
    return null;
  }
  let candidate = value;
  if (value && typeof value.toDate === 'function') {
    candidate = value.toDate();
  } else if (
    value
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, '$date')
  ) {
    candidate = value.$date;
  }
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toTimestamp(value) {
  const date = toDate(value);
  return date ? date.getTime() : NaN;
}

function isSameActivity(left, right) {
  const leftTime = toTimestamp(left);
  const rightTime = toTimestamp(right);
  return Number.isFinite(leftTime)
    && Number.isFinite(rightTime)
    && leftTime === rightTime;
}

function getDeletedForField(slot) {
  return `deletedForParticipant${slot}At`;
}

function isDeletedForParticipant(message, slot) {
  return Boolean(slot && message && message[getDeletedForField(slot)]);
}

function getHiddenConversationField(slot) {
  return `participant${slot}HiddenAt`;
}

function getHiddenActivityIdField(slot) {
  return `participant${slot}HiddenActivityId`;
}

function getHiddenActivityAtField(slot) {
  return `participant${slot}HiddenActivityAt`;
}

function getLastMessageDeletedIdField(slot) {
  return `participant${slot}HiddenLastMessageId`;
}

function getLastMessageDeletedAtField(slot) {
  return `participant${slot}HiddenLastMessageAt`;
}

function isConversationLatestMessage(conversation, message) {
  const lastMessageId = normalizeMessageId(conversation && conversation.lastMessageId);
  if (lastMessageId) {
    return lastMessageId === normalizeMessageId(message && message._id);
  }
  return isSameActivity(
    conversation && conversation.lastMessageAt,
    message && message.createdAt
  );
}

function normalizeInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    && number >= minimum
    && number <= maximum
    ? Math.floor(number)
    : null;
}

function normalizeCoordinate(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    && number >= minimum
    && number <= maximum
    ? number
    : null;
}

function getCloudFilePath(fileId) {
  if (
    typeof fileId !== 'string'
    || fileId.length > MAX_MEDIA_FILE_ID_LENGTH
    || !fileId.startsWith('cloud://')
  ) {
    return '';
  }
  const match = fileId.match(/^cloud:\/\/[^/]+\/(.+)$/);
  return match ? match[1] : '';
}

function validateChatMediaPath(
  fileId,
  mediaType,
  conversationId,
  senderPublicUserId,
  clientMessageId
) {
  const segments = getCloudFilePath(fileId).split('/');
  const fileNamePattern = mediaType === 'voice'
    ? VOICE_FILE_NAME_PATTERN
    : IMAGE_FILE_NAME_PATTERN;
  if (
    segments.length !== 6
    || segments[0] !== 'chat-media'
    || segments[1] !== mediaType
    || segments[2] !== conversationId
    || segments[3] !== senderPublicUserId
    || !/^\d{8}$/.test(segments[4])
    || !fileNamePattern.test(segments[5])
  ) {
    return false;
  }
  const fileStem = segments[5].slice(0, segments[5].lastIndexOf('.'));
  return fileStem === clientMessageId;
}

function normalizeMediaPayload(
  type,
  value,
  conversationId,
  senderPublicUserId,
  clientMessageId
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const fileId = normalizeString(value.fileId || value.fileID);
  if (!validateChatMediaPath(
    fileId,
    type,
    conversationId,
    senderPublicUserId,
    clientMessageId
  )) {
    return null;
  }

  if (type === 'voice') {
    const durationMs = normalizeInteger(
      value.durationMs,
      MIN_VOICE_DURATION_MS,
      MAX_VOICE_DURATION_MS
    );
    const size = normalizeInteger(value.size, 1, MAX_VOICE_SIZE);
    const format = normalizeString(value.format).toLowerCase();
    if (durationMs === null || size === null || format !== 'mp3') {
      return null;
    }
    return {
      fileId,
      durationMs,
      size,
      format: 'mp3'
    };
  }

  const width = normalizeInteger(value.width, 1, MAX_MEDIA_DIMENSION);
  const height = normalizeInteger(value.height, 1, MAX_MEDIA_DIMENSION);
  const size = normalizeInteger(value.size, 1, MAX_IMAGE_SIZE);
  if (width === null || height === null || size === null) {
    return null;
  }
  return {
    fileId,
    width,
    height,
    size
  };
}

function normalizeLocationPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const name = normalizeString(value.name);
  const address = normalizeString(value.address);
  const latitude = normalizeCoordinate(value.latitude, -90, 90);
  const longitude = normalizeCoordinate(value.longitude, -180, 180);
  if (
    !name
    || name.length > MAX_LOCATION_NAME_LENGTH
    || !address
    || address.length > MAX_LOCATION_ADDRESS_LENGTH
    || latitude === null
    || longitude === null
  ) {
    return null;
  }
  return {
    name,
    address,
    latitude,
    longitude
  };
}

function normalizeMessageType(value) {
  const type = normalizeString(value);
  return MESSAGE_TYPES.has(type) ? type : '';
}

function logProductLookupDiagnostic(productId, productFound, code) {
  console.info('[messageAction] product lookup', {
    action: 'createOrGetConversation',
    productIdPresent: Boolean(productId),
    productIdLength: productId.length,
    productFound: productFound === true,
    code
  });
}

function createDigest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createUserId(appId, openId) {
  return `u_${createDigest(`${appId}:${openId}`).slice(0, 32)}`;
}

function createParticipantPair(userIdA, userIdB) {
  const sortedUserIds = [normalizeString(userIdA), normalizeString(userIdB)]
    .sort();
  if (
    !PUBLIC_USER_ID_PATTERN.test(sortedUserIds[0])
    || !PUBLIC_USER_ID_PATTERN.test(sortedUserIds[1])
    || sortedUserIds[0] === sortedUserIds[1]
  ) {
    return null;
  }
  const digest = createDigest(sortedUserIds.join(':'));
  return {
    participantAUserId: sortedUserIds[0],
    participantBUserId: sortedUserIds[1],
    participantPairKey: `pp_${digest}`,
    conversationId: `c_${digest}`
  };
}

function canCreateSchoolRelation(user, openId, product) {
  const userSchoolId = normalizeString(user && user.schoolId);
  const productSchoolId = normalizeString(product && product.schoolId);
  return Boolean(
    user
    && user.status === 'active'
    && normalizeString(user.openid) === openId
    && SCHOOL_ID_PATTERN.test(userSchoolId)
    && SCHOOL_ID_PATTERN.test(productSchoolId)
    && userSchoolId === productSchoolId
  );
}

function assertCanCreateSchoolRelation(user, openId, product) {
  if (!canCreateSchoolRelation(user, openId, product)) {
    businessError(
      ERROR_CODES.CROSS_SCHOOL_RELATION_FORBIDDEN,
      '暂不支持与其他学校的商品建立新的交易关系'
    );
  }
}

function createMessageId(conversationId, senderOpenid, clientMessageId) {
  return `m_${createDigest(
    `${conversationId}:${senderOpenid}:${clientMessageId}`
  )}`;
}

function extractRecord(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  if (result.data && !Array.isArray(result.data)) {
    return result.data;
  }
  return Array.isArray(result.data) && result.data.length > 0
    ? result.data[0]
    : null;
}

function isMissingDocumentError(error) {
  const code = String(error && (error.errCode || error.code || '')).toLowerCase();
  const messages = [
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  return code === 'document_not_found'
    || code === 'database_document_not_exist'
    || messages.some((message) => (
      message.includes('document not exists')
      || message.includes('document does not exist')
      || /^document\.get:fail document with _id .+ does not exist$/.test(message)
    ));
}

async function getDocumentOrNull(document) {
  try {
    return extractRecord(await document.get());
  } catch (error) {
    if (isMissingDocumentError(error)) {
      return null;
    }
    throw error;
  }
}

function isRetryableTransactionConflict(error) {
  const codes = [
    error && error.code,
    error && error.errCode,
    error && error.name,
    error && error.cause && error.cause.code,
    error && error.cause && error.cause.errCode
  ].filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim().toUpperCase());
  if (codes.includes('DATABASE_TRANSACTION_CONFLICT')) {
    return true;
  }
  const messages = [
    error && error.message,
    error && error.errMsg,
    error && error.cause && error.cause.message,
    error && error.cause && error.cause.errMsg
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  return messages.some((message) => (
    message === 'database transaction conflict'
    || message.endsWith(': database transaction conflict')
  ));
}

function getTransactionControl(transaction) {
  const raw = transaction
    && transaction._transaction
    && typeof transaction._transaction.commit === 'function'
    ? transaction._transaction
    : null;
  return {
    commit: raw
      ? raw.commit.bind(raw)
      : transaction.commit.bind(transaction),
    rollback: raw && typeof raw.rollback === 'function'
      ? raw.rollback.bind(raw)
      : transaction.rollback.bind(transaction),
    preservesRawErrors: Boolean(raw)
  };
}

async function runSingleTransaction(callback, database, options = {}) {
  if (typeof database.startTransaction !== 'function') {
    const response = await database.runTransaction(
      async (transaction) => callback(transaction)
    );
    if (
      response
      && typeof response === 'object'
      && Object.prototype.hasOwnProperty.call(response, 'result')
    ) {
      return response.result;
    }
    return response;
  }
  const transaction = await database.startTransaction();
  const control = getTransactionControl(transaction);
  if (typeof options.onEvent === 'function') {
    options.onEvent('transaction_created', {
      preservesRawErrors: control.preservesRawErrors
    });
  }
  try {
    const result = await callback(transaction);
    if (typeof options.onEvent === 'function') {
      options.onEvent('commit_start', {});
    }
    await control.commit();
    if (typeof options.onEvent === 'function') {
      options.onEvent('commit_end', { outcome: 'success' });
    }
    return result;
  } catch (error) {
    if (typeof options.onEvent === 'function') {
      options.onEvent('transaction_error', {
        safeCode: getWhitelistedDiagnosticCode(error),
        retryable: isRetryableTransactionConflict(error)
      });
    }
    try {
      await control.rollback(error);
      if (typeof options.onEvent === 'function') {
        options.onEvent('rollback_end', {});
      }
    } catch (rollbackError) {
      // Keep the original failure so conflict classification remains exact.
    }
    throw error;
  }
}

async function runTransaction(callback, options = {}) {
  const database = options.database || db;
  const maximum = Number.isInteger(options.maxAttempts)
    ? Math.min(Math.max(options.maxAttempts, 1), TRANSACTION_MAX_ATTEMPTS)
    : TRANSACTION_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const onEvent = typeof options.onEvent === 'function'
      ? (event, details) => options.onEvent(event, {
          attempt,
          ...details
        })
      : null;
    if (onEvent) {
      onEvent('attempt_start', {});
    }
    try {
      return await runSingleTransaction(callback, database, { onEvent });
    } catch (error) {
      const retryable = isRetryableTransactionConflict(error);
      if (onEvent) {
        onEvent('attempt_end', {
          outcome: 'failed',
          safeCode: getWhitelistedDiagnosticCode(error),
          retryable
        });
      }
      if (attempt >= maximum || !retryable) {
        throw error;
      }
    }
  }
  throw new Error('Transaction failed');
}

function getConversationActivitySnapshot(conversation) {
  return {
    lastMessageId: normalizeString(conversation && conversation.lastMessageId),
    lastMessageAt: toDate(conversation && conversation.lastMessageAt)
  };
}

function conversationMatchesActivitySnapshot(conversation, snapshot) {
  if (!snapshot || !snapshot.lastMessageAt) {
    return false;
  }
  const current = getConversationActivitySnapshot(conversation);
  return current.lastMessageId === snapshot.lastMessageId
    && current.lastMessageAt
    && current.lastMessageAt.getTime() === snapshot.lastMessageAt.getTime();
}

function getParticipantSlot(conversation, openId) {
  if (conversation.participantAOpenid === openId) {
    return 'A';
  }
  if (conversation.participantBOpenid === openId) {
    return 'B';
  }
  return '';
}

function conversationMatchesPair(conversation, pair, userOpenids) {
  return Boolean(
    conversation
    && pair
    && normalizeString(conversation.participantAUserId)
      === pair.participantAUserId
    && normalizeString(conversation.participantBUserId)
      === pair.participantBUserId
    && normalizeString(conversation.participantAOpenid)
      === normalizeString(userOpenids[pair.participantAUserId])
    && normalizeString(conversation.participantBOpenid)
      === normalizeString(userOpenids[pair.participantBUserId])
    && normalizeString(conversation.participantPairKey)
      === pair.participantPairKey
    && normalizeString(conversation.status || 'active') !== 'merged'
  );
}

async function resolveConversation(collection, conversationId) {
  const requested = await getDocumentOrNull(collection.doc(conversationId));
  if (!requested) {
    return null;
  }
  const mergedInto = normalizeConversationId(requested.mergedInto);
  if (
    normalizeString(requested.status) === 'merged'
    && mergedInto
    && mergedInto !== conversationId
  ) {
    const canonical = await getDocumentOrNull(collection.doc(mergedInto));
    return canonical
      ? { conversation: canonical, conversationId: mergedInto, requested }
      : null;
  }
  return { conversation: requested, conversationId, requested };
}

function toIsoString(value) {
  if (!value) {
    return '';
  }
  let candidate = value;
  if (value && typeof value.toDate === 'function') {
    candidate = value.toDate();
  } else if (
    value
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, '$date')
  ) {
    candidate = value.$date;
  }
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toSafeMessage(record, openId) {
  const type = normalizeMessageType(record.type) || 'text';
  const message = {
    messageId: String(record._id || ''),
    senderPublicUserId: String(record.senderPublicUserId || ''),
    isMine: record.senderOpenid === openId,
    type,
    contextProductId: normalizeProductId(record.contextProductId),
    createdAt: toIsoString(record.createdAt)
  };
  if (record.recalled === true) {
    return {
      messageId: message.messageId,
      senderPublicUserId: message.senderPublicUserId,
      isMine: message.isMine,
      type: 'recalled',
      recalled: true,
      createdAt: message.createdAt,
      recalledAt: toIsoString(record.recalledAt)
    };
  }
  if (record.forwarded === true) {
    message.forwarded = true;
  }
  if (type === 'text') {
    message.content = normalizeString(record.content);
  } else if (type === 'voice' || type === 'image') {
    message.media = record.media && typeof record.media === 'object'
      ? {
          fileId: normalizeString(record.media.fileId),
          durationMs: normalizeCount(record.media.durationMs),
          size: normalizeCount(record.media.size),
          format: type === 'voice' ? 'mp3' : '',
          width: type === 'image' ? normalizeCount(record.media.width) : 0,
          height: type === 'image' ? normalizeCount(record.media.height) : 0
        }
      : {};
  } else if (type === 'location') {
    const location = record.location && typeof record.location === 'object'
      ? record.location
      : {};
    message.location = {
      name: normalizeString(location.name),
      address: normalizeString(location.address),
      latitude: Number(location.latitude),
      longitude: Number(location.longitude)
    };
  } else if (type === 'product') {
    const product = record.product && typeof record.product === 'object'
      ? record.product
      : {};
    message.product = {
      productId: normalizeString(product.productId),
      title: normalizeString(product.title),
      coverImage: normalizeString(product.coverImage),
      price: Number(product.price) || 0,
      status: normalizeString(product.status),
      ownerPublicUserId: normalizeString(product.ownerPublicUserId)
    };
  }
  return message;
}

function toProductSnapshot(product, productId) {
  return {
    productId,
    title: normalizeString(product.title).slice(0, 80) || '未命名闲置',
    coverImage: normalizeString(product.coverImage),
    price: Number.isFinite(Number(product.price))
      && Number(product.price) >= 0
      ? Number(product.price)
      : 0,
    status: normalizeString(product.status) || 'deleted',
    schoolId: normalizeString(product.schoolId),
    schoolName: normalizeString(product.schoolName)
  };
}

async function createOrGetConversation(data, identity, trace) {
  trace.step = 'conversation.validate';
  const productId = normalizeProductId(data.productId);
  trace.productId = productId;
  if (!productId) {
    logProductLookupDiagnostic(
      productId,
      false,
      ERROR_CODES.INVALID_ARGUMENT
    );
    return failure(ERROR_CODES.INVALID_ARGUMENT, '缺少有效商品 ID');
  }

  trace.step = 'conversation.read_product';
  const product = await getDocumentOrNull(products.doc(productId));
  trace.productFound = Boolean(product);
  if (!product) {
    logProductLookupDiagnostic(
      productId,
      false,
      ERROR_CODES.PRODUCT_NOT_FOUND
    );
    return failure(ERROR_CODES.PRODUCT_NOT_FOUND, '商品已不存在');
  }
  if (product.status === 'deleted') {
    logProductLookupDiagnostic(
      productId,
      true,
      ERROR_CODES.PRODUCT_UNAVAILABLE
    );
    return failure(
      ERROR_CODES.PRODUCT_UNAVAILABLE,
      '商品已删除，不能发起新会话'
    );
  }

  const sellerUserId = normalizeString(product.sellerId);
  trace.step = 'conversation.read_seller';
  const sellerUser = sellerUserId
    ? await getDocumentOrNull(users.doc(sellerUserId))
    : null;
  const productSellerOpenid = normalizeString(product.sellerOpenid);
  const userSellerOpenid = normalizeString(sellerUser && sellerUser.openid);
  const sellerOpenid = productSellerOpenid || userSellerOpenid;
  if (!sellerOpenid) {
    logProductLookupDiagnostic(
      productId,
      true,
      ERROR_CODES.PRODUCT_SELLER_UNAVAILABLE
    );
    return failure(
      ERROR_CODES.PRODUCT_SELLER_UNAVAILABLE,
      '商品卖家信息暂不可用'
    );
  }
  if (
    productSellerOpenid
    && userSellerOpenid
    && productSellerOpenid !== userSellerOpenid
  ) {
    logProductLookupDiagnostic(
      productId,
      true,
      ERROR_CODES.PRODUCT_SELLER_UNAVAILABLE
    );
    return failure(
      ERROR_CODES.PRODUCT_SELLER_UNAVAILABLE,
      '商品卖家信息暂不可用'
    );
  }
  if (sellerOpenid === identity.openId) {
    logProductLookupDiagnostic(
      productId,
      true,
      ERROR_CODES.SELF_CONVERSATION_FORBIDDEN
    );
    return failure(
      ERROR_CODES.SELF_CONVERSATION_FORBIDDEN,
      '不能给自己发送私信'
    );
  }

  const currentUserId = createUserId(identity.appId, identity.openId);
  trace.step = 'conversation.read_users';
  const currentUser = await getDocumentOrNull(users.doc(currentUserId));
  if (
    !currentUser
    || currentUser.status === 'disabled'
    || !sellerUser
    || sellerUser.status === 'disabled'
  ) {
    logProductLookupDiagnostic(
      productId,
      true,
      ERROR_CODES.USER_NOT_FOUND
    );
    return failure(ERROR_CODES.USER_NOT_FOUND, '用户记录不存在或不可用');
  }
  const pair = createParticipantPair(currentUserId, sellerUserId);
  if (!pair) {
    return failure(ERROR_CODES.FORBIDDEN, '会话参与者资料不可用');
  }
  const userOpenids = {
    [currentUserId]: identity.openId,
    [sellerUserId]: sellerOpenid
  };
  const conversationId = pair.conversationId;

  trace.step = 'conversation.begin_transaction';
  const result = await runTransaction(async (transaction) => {
    const document = transaction.collection('conversations').doc(conversationId);
    trace.step = 'conversation.transaction_read';
    const duplicate = await getDocumentOrNull(document);
    trace.step = 'conversation.transaction_read_product';
    const currentProduct = await getDocumentOrNull(
      transaction.collection('products').doc(productId)
    );
    trace.step = 'conversation.transaction_read_user';
    const transactionUser = await getDocumentOrNull(
      transaction.collection('users').doc(currentUserId)
    );
    const transactionSeller = await getDocumentOrNull(
      transaction.collection('users').doc(sellerUserId)
    );
    if (!currentProduct || currentProduct.status === 'deleted') {
      businessError(
        ERROR_CODES.PRODUCT_UNAVAILABLE,
        '当前商品暂不能发起新会话'
      );
    }
    const currentSellerOpenid = normalizeString(currentProduct.sellerOpenid)
      || normalizeString(transactionSeller && transactionSeller.openid);
    if (
      !transactionSeller
      || transactionSeller.status === 'disabled'
      || normalizeString(currentProduct.sellerId) !== sellerUserId
      || currentSellerOpenid !== sellerOpenid
    ) {
      businessError(
        ERROR_CODES.PRODUCT_SELLER_UNAVAILABLE,
        '商品卖家信息暂不可用'
      );
    }
    const productSnapshot = toProductSnapshot(currentProduct, productId);
    if (duplicate) {
      if (!conversationMatchesPair(duplicate, pair, userOpenids)) {
        businessError(ERROR_CODES.FORBIDDEN, '会话参与者校验失败');
      }
      trace.step = 'conversation.transaction_update_context';
      await document.update({
        data: {
          productId,
          productSnapshot,
          lastProductId: productId,
          lastProductSnapshot: productSnapshot,
          [getHiddenConversationField(
            pair.participantAUserId === currentUserId ? 'A' : 'B'
          )]: null,
          contextUpdatedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return {
        conversationId,
        reused: true
      };
    }

    if (!NEW_CONVERSATION_STATUSES.has(currentProduct.status)) {
      businessError(
        ERROR_CODES.PRODUCT_UNAVAILABLE,
        '当前商品暂不能发起新会话'
      );
    }
    assertCanCreateSchoolRelation(
      transactionUser,
      identity.openId,
      currentProduct
    );

    trace.step = 'conversation.transaction_write';
    await document.set({
      data: {
        participantAOpenid: userOpenids[pair.participantAUserId],
        participantBOpenid: userOpenids[pair.participantBUserId],
        participantAUserId: pair.participantAUserId,
        participantBUserId: pair.participantBUserId,
        participantPairKey: pair.participantPairKey,
        status: 'active',
        schemaVersion: 2,
        productId,
        productSnapshot,
        lastProductId: productId,
        lastProductSnapshot: productSnapshot,
        lastMessage: '',
        lastMessageType: '',
        lastMessageAt: db.serverDate(),
        lastMessageId: '',
        lastSenderOpenid: '',
        participantAUnreadCount: 0,
        participantBUnreadCount: 0,
        createdAt: db.serverDate(),
        contextUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    return {
      conversationId,
      reused: false
    };
  });
  logProductLookupDiagnostic(productId, true, ERROR_CODES.OK);
  return success(result);
}

async function sendMessage(
  data,
  openId,
  trace,
  forcedType = '',
  options = {}
) {
  trace.step = 'send.validate';
  const conversationId = normalizeConversationId(data.conversationId);
  const clientMessageId = normalizeClientMessageId(data.clientMessageId);
  const type = forcedType || normalizeMessageType(data.type);
  const content = typeof data.content === 'string' ? data.content.trim() : '';
  if (!conversationId || !clientMessageId || !type) {
    return failure(
      type ? ERROR_CODES.INVALID_ARGUMENT : ERROR_CODES.INVALID_MESSAGE_TYPE,
      type ? '消息参数不正确' : '不支持的消息类型'
    );
  }
  if (forcedType && normalizeString(data.type) && data.type !== forcedType) {
    return failure(ERROR_CODES.INVALID_MESSAGE_TYPE, '消息类型不正确');
  }
  const messageId = createMessageId(
    conversationId,
    openId,
    clientMessageId
  );
  trace.conversationHash = safeHash(conversationId);
  trace.messageHash = safeHash(messageId);
  trace.step = 'send.begin_transaction';
  const result = await runTransaction(async (transaction) => {
    trace.step = 'send.read_conversation';
    beginAttemptStage(trace, 'canonical_resolve');
    const resolvedConversation = await resolveConversation(
      transaction.collection('conversations'),
      conversationId
    );
    completeAttemptStage(trace, 'canonical_resolve');
    if (!resolvedConversation) {
      businessError(
        ERROR_CODES.CONVERSATION_NOT_FOUND,
        '会话不存在或已失效'
      );
    }
    const canonicalConversationId = resolvedConversation.conversationId;
    const conversation = resolvedConversation.conversation;
    trace.conversationHash = safeHash(canonicalConversationId);
    logSafeTrace(trace, 'activity_read', {
      currentLastMessageHash: safeHash(conversation.lastMessageId),
      currentLastMessageAt: toDate(conversation.lastMessageAt)
        && toDate(conversation.lastMessageAt).toISOString()
    });
    const conversationDocument = transaction
      .collection('conversations')
      .doc(canonicalConversationId);

    beginAttemptStage(trace, 'participant_validate');
    const slot = getParticipantSlot(conversation, openId);
    if (!slot) {
      businessError(ERROR_CODES.FORBIDDEN, '无权向该会话发送消息');
    }
    if (
      options.requireCanonical === true
      && canonicalConversationId !== conversationId
    ) {
      businessError(
        ERROR_CODES.INVALID_FORWARD_TARGET,
        '转发目标必须是有效的当前会话'
      );
    }
    completeAttemptStage(trace, 'participant_validate');

    beginAttemptStage(trace, 'existing_message_check');
    const messageDocument = transaction.collection('messages').doc(messageId);
    trace.step = 'send.read_message';
    const existingMessage = await getDocumentOrNull(messageDocument);
    completeAttemptStage(trace, 'existing_message_check');
    if (trace.attemptDiagnostic) {
      trace.attemptDiagnostic.setAttemptBoolean(
        'messageExistedBeforeAttempt',
        Boolean(existingMessage)
      );
    }
    if (existingMessage) {
      logSafeTrace(trace, 'message_existing', {
        messageHash: trace.messageHash,
        existing: true
      });
      beginAttemptStage(trace, 'response_projection');
      const response = {
        message: toSafeMessage(existingMessage, openId),
        reused: true
      };
      completeAttemptStage(trace, 'response_projection');
      return response;
    }

    if (options.forwardSource) {
      beginAttemptStage(trace, 'source_validate');
      const source = options.forwardSource;
      const resolvedSource = await resolveConversation(
        transaction.collection('conversations'),
        source.conversationId
      );
      if (
        !resolvedSource
        || resolvedSource.conversationId !== source.canonicalConversationId
        || !getParticipantSlot(resolvedSource.conversation, openId)
      ) {
        businessError(ERROR_CODES.MESSAGE_NOT_FORWARDABLE, '原消息不可转发');
      }
      const currentSourceMessage = await getDocumentOrNull(
        transaction.collection('messages').doc(source.messageId)
      );
      const sourceSlot = getParticipantSlot(resolvedSource.conversation, openId);
      if (
        !currentSourceMessage
        || normalizeConversationId(currentSourceMessage.conversationId)
          !== source.canonicalConversationId
        || currentSourceMessage.recalled === true
        || isDeletedForParticipant(currentSourceMessage, sourceSlot)
        || !FORWARDABLE_MESSAGE_TYPES.has(
          normalizeMessageType(currentSourceMessage.type)
        )
      ) {
        businessError(ERROR_CODES.MESSAGE_NOT_FORWARDABLE, '原消息不可转发');
      }
      completeAttemptStage(trace, 'source_validate');
    }

    beginAttemptStage(trace, 'context_validate');
    const contextProductId = normalizeProductId(
      conversation.lastProductId || conversation.productId
    );
    if (!contextProductId) {
      businessError(
        ERROR_CODES.PRODUCT_UNAVAILABLE,
        '当前商品上下文不可用，仅可查看历史消息'
      );
    }
    completeAttemptStage(trace, 'context_validate');
    beginAttemptStage(trace, 'context_product_read');
    const productDocument = transaction
      .collection('products')
      .doc(contextProductId);
    trace.step = 'send.read_product';
    const conversationProduct = await getDocumentOrNull(productDocument);
    completeAttemptStage(trace, 'context_product_read');
    if (!conversationProduct || conversationProduct.status === 'deleted') {
      businessError(
        ERROR_CODES.PRODUCT_UNAVAILABLE,
        '商品已删除，仅可查看历史消息'
      );
    }

    // clientMessageId is a first-write-wins idempotency key. Payload-specific
    // validation intentionally happens after the existing-message lookup so a
    // retry cannot mutate the committed message or advance unread/summary state.
    beginAttemptStage(trace, 'payload_validate');
    if (type === 'text' && !content) {
      businessError(ERROR_CODES.MESSAGE_EMPTY, '消息内容不能为空');
    }
    if (type === 'text' && content.length > MESSAGE_MAX_LENGTH) {
      businessError(
        ERROR_CODES.MESSAGE_TOO_LONG,
        `消息不能超过 ${MESSAGE_MAX_LENGTH} 个字`
      );
    }
    const location = type === 'location'
      ? normalizeLocationPayload(data.location)
      : null;
    if (type === 'location' && !location) {
      businessError(ERROR_CODES.INVALID_LOCATION, '位置信息不正确');
    }
    const productId = type === 'product'
      ? normalizeProductId(data.productId)
      : '';
    if (type === 'product' && !productId) {
      businessError(ERROR_CODES.INVALID_PRODUCT, '商品信息不正确');
    }

    const senderPublicUserId = slot === 'A'
      ? conversation.participantAUserId
      : conversation.participantBUserId;
    const messageData = {
      conversationId: canonicalConversationId,
      senderOpenid: openId,
      senderPublicUserId,
      type,
      clientMessageId,
      contextProductId,
      createdAt: db.serverDate()
    };

    if (type === 'text') {
      messageData.content = content;
    } else if (type === 'voice' || type === 'image') {
      const media = normalizeMediaPayload(
        type,
        data.media,
        conversationId,
        senderPublicUserId,
        clientMessageId
      );
      if (!media) {
        businessError(ERROR_CODES.INVALID_MEDIA, '媒体文件不正确');
      }
      messageData.media = media;
    } else if (type === 'location') {
      messageData.location = location;
    } else if (type === 'product') {
      if (productId === contextProductId && !options.forwardSource) {
        businessError(
          ERROR_CODES.INVALID_PRODUCT,
          '请选择当前会话商品以外的商品'
        );
      }
      trace.step = 'send.read_shared_product';
      beginAttemptStage(trace, 'shared_product_read');
      const selectedProduct = await getDocumentOrNull(
        transaction.collection('products').doc(productId)
      );
      completeAttemptStage(trace, 'shared_product_read');
      if (
        !selectedProduct
        || !SELECTABLE_PRODUCT_STATUSES.has(
          normalizeString(selectedProduct.status)
        )
      ) {
        businessError(
          ERROR_CODES.PRODUCT_NOT_ACCESSIBLE,
          '商品不存在或当前不可发送'
        );
      }
      const ownerOpenId = normalizeString(selectedProduct.sellerOpenid);
      const storedOwnerPublicUserId = normalizeString(
        selectedProduct.sellerId
      );
      let ownerPublicUserId = '';
      if (ownerOpenId) {
        const ownerSlot = getParticipantSlot(conversation, ownerOpenId);
        if (ownerSlot) {
          const participantPublicUserId = normalizeString(
            conversation[`participant${ownerSlot}UserId`]
          );
          if (
            participantPublicUserId
            && (
              !storedOwnerPublicUserId
              || storedOwnerPublicUserId === participantPublicUserId
            )
          ) {
            ownerPublicUserId = participantPublicUserId;
          }
        }
      } else if ([
        conversation.participantAUserId,
        conversation.participantBUserId
      ].includes(storedOwnerPublicUserId)) {
        ownerPublicUserId = storedOwnerPublicUserId;
      }
      if (!ownerPublicUserId) {
        businessError(
          ERROR_CODES.PRODUCT_NOT_ACCESSIBLE,
          '只能发送当前会话双方的商品'
        );
      }
      messageData.product = {
        productId,
        title: normalizeString(selectedProduct.title).slice(0, 80)
          || '未命名闲置',
        coverImage: normalizeString(selectedProduct.coverImage)
          || (
            Array.isArray(selectedProduct.images)
            ? normalizeString(selectedProduct.images[0])
            : ''
          ),
        price: Number.isFinite(Number(selectedProduct.price))
          && Number(selectedProduct.price) >= 0
          ? Number(selectedProduct.price)
          : 0,
        status: normalizeString(selectedProduct.status),
        ownerPublicUserId
      };
    }
    if (options.forwardSource) {
      messageData.forwarded = true;
    }
    completeAttemptStage(trace, 'payload_validate');

    trace.step = 'send.write_message';
    beginAttemptStage(trace, 'message_write');
    await messageDocument.set({ data: messageData });
    completeAttemptStage(trace, 'message_write');

    beginAttemptStage(trace, 'conversation_update_prepare');
    const updateData = {
      productId: contextProductId,
      productSnapshot: toProductSnapshot(conversationProduct, contextProductId),
      lastProductId: contextProductId,
      lastProductSnapshot: toProductSnapshot(
        conversationProduct,
        contextProductId
      ),
      lastMessage: type === 'text'
        ? content.slice(0, LAST_MESSAGE_MAX_LENGTH)
        : LAST_MESSAGE_SUMMARIES[type],
      lastMessageType: type,
      lastMessageAt: db.serverDate(),
      lastMessageId: messageId,
      lastSenderOpenid: openId,
      participantAHiddenAt: null,
      participantBHiddenAt: null,
      participantAHiddenLastMessageId: '',
      participantBHiddenLastMessageId: '',
      participantAHiddenLastMessageAt: null,
      participantBHiddenLastMessageAt: null,
      participantAHiddenActivityId: '',
      participantBHiddenActivityId: '',
      participantAHiddenActivityAt: null,
      participantBHiddenActivityAt: null,
      updatedAt: db.serverDate()
    };
    if (slot === 'A') {
      updateData.participantBUnreadCount = normalizeCount(
        conversation.participantBUnreadCount
      ) + 1;
    } else {
      updateData.participantAUnreadCount = normalizeCount(
        conversation.participantAUnreadCount
      ) + 1;
    }
    completeAttemptStage(trace, 'conversation_update_prepare');
    beginAttemptStage(trace, 'conversation_update_write');
    trace.step = 'send.update_conversation';
    await conversationDocument.update({
      data: updateData
    });
    completeAttemptStage(trace, 'conversation_update_write');

    beginAttemptStage(trace, 'response_projection');
    const response = {
      message: toSafeMessage({
        _id: messageId,
        ...messageData,
        createdAt: new Date().toISOString()
      }, openId),
      reused: false
    };
    completeAttemptStage(trace, 'response_projection');
    return response;
  }, {
    onEvent(event, details) {
      logSafeTrace(trace, event, details);
      if (trace.attemptDiagnostic) {
        trace.attemptDiagnostic.onEvent(event, details);
      }
    }
  });
  logSafeTrace(trace, 'response', {
    outcome: 'success',
    messageExisting: result.reused === true
  });
  return success(result);
}

async function sendTextMessage(data, openId, trace) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '消息参数不正确');
  }
  return sendMessage({ ...data, type: 'text' }, openId, trace, 'text');
}

async function markConversationRead(data, openId, trace) {
  trace.step = 'read.validate';
  const conversationId = normalizeConversationId(data.conversationId);
  if (!conversationId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '缺少有效会话 ID');
  }

  trace.step = 'read.begin_transaction';
  const result = await runTransaction(async (transaction) => {
    trace.step = 'read.read_conversation';
    const resolvedConversation = await resolveConversation(
      transaction.collection('conversations'),
      conversationId
    );
    if (!resolvedConversation) {
      businessError(
        ERROR_CODES.CONVERSATION_NOT_FOUND,
        '会话不存在或已失效'
      );
    }
    const conversation = resolvedConversation.conversation;
    const canonicalConversationId = resolvedConversation.conversationId;
    const document = transaction.collection('conversations')
      .doc(canonicalConversationId);
    const slot = getParticipantSlot(conversation, openId);
    if (!slot) {
      businessError(ERROR_CODES.FORBIDDEN, '无权修改该会话');
    }
    const unreadField = slot === 'A'
      ? 'participantAUnreadCount'
      : 'participantBUnreadCount';
    const currentUnread = normalizeCount(conversation[unreadField]);
    if (currentUnread > 0) {
      trace.step = 'read.update_unread';
      await document.update({
        data: {
          [unreadField]: 0,
          [slot === 'A' ? 'participantALastReadAt' : 'participantBLastReadAt']:
            db.serverDate()
        }
      });
    }
    return {
      conversationId: canonicalConversationId,
      unreadCount: 0,
      reused: currentUnread === 0
    };
  });
  return success(result);
}

async function hideConversation(data, openId, trace) {
  trace.step = 'hide.validate';
  const conversationId = normalizeConversationId(data.conversationId);
  if (!conversationId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '缺少有效会话 ID');
  }
  const hasExpectedActivity = Object.prototype.hasOwnProperty.call(
    data,
    'expectedLastMessageId'
  ) || Object.prototype.hasOwnProperty.call(data, 'expectedLastMessageAt');
  const expectedLastMessageId = normalizeString(data.expectedLastMessageId);
  const expectedLastMessageAt = toDate(data.expectedLastMessageAt);
  if (
    hasExpectedActivity
    && (
      (expectedLastMessageId && !normalizeMessageId(expectedLastMessageId))
      || !expectedLastMessageAt
    )
  ) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '会话活动快照不正确');
  }
  let expectedActivity = hasExpectedActivity
    ? {
        lastMessageId: expectedLastMessageId,
        lastMessageAt: expectedLastMessageAt
      }
    : null;
  trace.conversationHash = safeHash(conversationId);
  trace.expectedLastMessageHash = safeHash(expectedLastMessageId);
  const result = await runTransaction(async (transaction) => {
    trace.step = 'hide.read_conversation';
    const resolved = await resolveConversation(
      transaction.collection('conversations'),
      conversationId
    );
    if (!resolved) {
      businessError(ERROR_CODES.CONVERSATION_NOT_FOUND, '会话不存在或已失效');
    }
    const slot = getParticipantSlot(resolved.conversation, openId);
    if (!slot) {
      businessError(ERROR_CODES.FORBIDDEN, '无权删除该会话');
    }
    if (!expectedActivity) {
      expectedActivity = getConversationActivitySnapshot(resolved.conversation);
      trace.expectedLastMessageHash = safeHash(expectedActivity.lastMessageId);
    }
    const snapshotChanged = !conversationMatchesActivitySnapshot(
      resolved.conversation,
      expectedActivity
    );
    if (trace.attemptDiagnostic) {
      trace.attemptDiagnostic.setAttemptBoolean(
        'snapshotChanged',
        snapshotChanged
      );
    }
    logSafeTrace(trace, 'activity_read', {
      expectedLastMessageHash: trace.expectedLastMessageHash,
      currentLastMessageHash: safeHash(resolved.conversation.lastMessageId),
      expectedLastMessageAt: expectedActivity.lastMessageAt.toISOString(),
      currentLastMessageAt: toDate(resolved.conversation.lastMessageAt)
        && toDate(resolved.conversation.lastMessageAt).toISOString(),
      hiddenSnapshotChanged: snapshotChanged
    });
    if (snapshotChanged) {
      return {
        conversationId: resolved.conversationId,
        reused: false,
        superseded: true
      };
    }
    const hiddenField = getHiddenConversationField(slot);
    const hiddenActivityIdField = getHiddenActivityIdField(slot);
    const hiddenActivityAtField = getHiddenActivityAtField(slot);
    const unreadField = `participant${slot}UnreadCount`;
    const lastReadField = `participant${slot}LastReadAt`;
    const hiddenAt = resolved.conversation[hiddenField];
    const alreadyHidden = Boolean(
      hiddenAt
      && toTimestamp(hiddenAt) >= toTimestamp(resolved.conversation.lastMessageAt)
      && normalizeString(resolved.conversation[hiddenActivityIdField])
        === expectedActivity.lastMessageId
      && toTimestamp(resolved.conversation[hiddenActivityAtField])
        === expectedActivity.lastMessageAt.getTime()
      && normalizeCount(resolved.conversation[unreadField]) === 0
    );
    if (!alreadyHidden) {
      trace.step = 'hide.update_conversation';
      await transaction.collection('conversations')
        .doc(resolved.conversationId)
        .update({
          data: {
            [hiddenField]: db.serverDate(),
            [hiddenActivityIdField]: expectedActivity.lastMessageId,
            [hiddenActivityAtField]: expectedActivity.lastMessageAt,
            [unreadField]: 0,
            [lastReadField]: db.serverDate(),
            updatedAt: db.serverDate()
          }
        });
    }
    return {
      conversationId: resolved.conversationId,
      reused: alreadyHidden,
      superseded: false
    };
  }, {
    onEvent(event, details) {
      logSafeTrace(trace, event, details);
      if (trace.attemptDiagnostic) {
        trace.attemptDiagnostic.onEvent(event, details);
      }
    }
  });
  logSafeTrace(trace, 'response', {
    outcome: 'success',
    superseded: result.superseded === true
  });
  return success(result);
}

async function deleteMessageForMe(data, openId, trace) {
  trace.step = 'delete_message.validate';
  const conversationId = normalizeConversationId(data.conversationId);
  const messageId = normalizeMessageId(data.messageId);
  if (!conversationId || !messageId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '消息参数不正确');
  }
  const result = await runTransaction(async (transaction) => {
    const resolved = await resolveConversation(
      transaction.collection('conversations'),
      conversationId
    );
    if (!resolved) {
      businessError(ERROR_CODES.CONVERSATION_NOT_FOUND, '会话不存在或已失效');
    }
    const slot = getParticipantSlot(resolved.conversation, openId);
    if (!slot) {
      businessError(ERROR_CODES.FORBIDDEN, '无权删除该消息');
    }
    const messageDocument = transaction.collection('messages').doc(messageId);
    const message = await getDocumentOrNull(messageDocument);
    if (
      !message
      || normalizeConversationId(message.conversationId) !== resolved.conversationId
    ) {
      businessError(ERROR_CODES.MESSAGE_NOT_FOUND, '消息不存在');
    }
    const deletedField = getDeletedForField(slot);
    if (message[deletedField]) {
      return {
        conversationId: resolved.conversationId,
        messageId,
        reused: true
      };
    }
    await messageDocument.update({
      data: {
        [deletedField]: db.serverDate()
      }
    });
    if (isConversationLatestMessage(resolved.conversation, message)) {
      await transaction.collection('conversations')
        .doc(resolved.conversationId)
        .update({
          data: {
            [getLastMessageDeletedIdField(slot)]: messageId,
            [getLastMessageDeletedAtField(slot)]: message.createdAt,
            updatedAt: db.serverDate()
          }
        });
    }
    return {
      conversationId: resolved.conversationId,
      messageId,
      reused: false
    };
  });
  return success(result);
}

async function recallMessage(data, openId, trace) {
  trace.step = 'recall.validate';
  const conversationId = normalizeConversationId(data.conversationId);
  const messageId = normalizeMessageId(data.messageId);
  if (!conversationId || !messageId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '消息参数不正确');
  }
  const result = await runTransaction(async (transaction) => {
    const resolved = await resolveConversation(
      transaction.collection('conversations'),
      conversationId
    );
    if (!resolved) {
      businessError(ERROR_CODES.CONVERSATION_NOT_FOUND, '会话不存在或已失效');
    }
    const slot = getParticipantSlot(resolved.conversation, openId);
    if (!slot) {
      businessError(ERROR_CODES.FORBIDDEN, '无权撤回该消息');
    }
    const messageDocument = transaction.collection('messages').doc(messageId);
    const message = await getDocumentOrNull(messageDocument);
    if (
      !message
      || normalizeConversationId(message.conversationId) !== resolved.conversationId
    ) {
      businessError(ERROR_CODES.MESSAGE_NOT_FOUND, '消息不存在');
    }
    if (message.senderOpenid !== openId) {
      businessError(ERROR_CODES.MESSAGE_NOT_OWNED, '只能撤回自己发送的消息');
    }
    if (message.recalled === true) {
      return {
        conversationId: resolved.conversationId,
        message: toSafeMessage(message, openId),
        reused: true
      };
    }
    if (
      !RECALLABLE_MESSAGE_TYPES.has(normalizeMessageType(message.type))
      || isDeletedForParticipant(message, slot)
    ) {
      businessError(ERROR_CODES.MESSAGE_NOT_RECALLABLE, '该消息不可撤回');
    }
    const createdAt = toTimestamp(message.createdAt);
    if (
      !Number.isFinite(createdAt)
      || Date.now() - createdAt > RECALL_WINDOW_MS
      || Date.now() < createdAt - 30000
    ) {
      businessError(ERROR_CODES.MESSAGE_RECALL_EXPIRED, '已超过 2 分钟撤回时限');
    }

    await messageDocument.update({
      data: {
        recalled: true,
        recalledAt: db.serverDate()
      }
    });
    const recipientSlot = slot === 'A' ? 'B' : 'A';
    const unreadField = `participant${recipientSlot}UnreadCount`;
    const lastReadAt = resolved.conversation[
      `participant${recipientSlot}LastReadAt`
    ];
    const updateData = {};
    if (
      normalizeCount(resolved.conversation[unreadField]) > 0
      && (
        !lastReadAt
        || toTimestamp(lastReadAt) < createdAt
      )
    ) {
      updateData[unreadField] = Math.max(
        0,
        normalizeCount(resolved.conversation[unreadField]) - 1
      );
    }
    if (isConversationLatestMessage(resolved.conversation, message)) {
      updateData.lastMessage = '[消息已撤回]';
      updateData.lastMessageType = 'recalled';
      updateData.lastMessageId = messageId;
      updateData.updatedAt = db.serverDate();
    }
    if (Object.keys(updateData).length > 0) {
      await transaction.collection('conversations')
        .doc(resolved.conversationId)
        .update({ data: updateData });
    }
    return {
      conversationId: resolved.conversationId,
      message: toSafeMessage({
        ...message,
        recalled: true,
        recalledAt: new Date().toISOString()
      }, openId),
      reused: false
    };
  });
  return success(result);
}

function getForwardMediaExtension(fileId, type) {
  const path = getCloudFilePath(fileId);
  const fileName = path.split('/').pop() || '';
  const extension = fileName.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
    : '';
  if (type === 'voice') {
    return extension === 'mp3' ? 'mp3' : '';
  }
  return ['jpg', 'jpeg', 'png', 'webp'].includes(extension) ? extension : '';
}

async function isValidStoredForwardMedia(
  message,
  canonicalConversationId,
  type
) {
  const media = message.media && typeof message.media === 'object'
    ? message.media
    : null;
  const fileId = normalizeString(media && (media.fileId || media.fileID));
  const pathConversationId = normalizeConversationId(
    (getCloudFilePath(fileId).split('/'))[2]
  );
  if (!fileId || !pathConversationId) {
    return false;
  }
  if (
    !validateChatMediaPath(
      fileId,
      type,
      pathConversationId,
      normalizeString(message.senderPublicUserId),
      normalizeClientMessageId(message.clientMessageId)
    )
  ) {
    return false;
  }
  if (pathConversationId === canonicalConversationId) {
    return true;
  }
  const legacyConversation = await getDocumentOrNull(
    conversations.doc(pathConversationId)
  );
  return Boolean(
    legacyConversation
    && normalizeString(legacyConversation.status) === 'merged'
    && normalizeConversationId(legacyConversation.mergedInto)
      === canonicalConversationId
  );
}

async function copyForwardMedia(
  sourceMessage,
  type,
  targetConversationId,
  senderPublicUserId,
  clientMessageId
) {
  const sourceMedia = sourceMessage.media;
  const sourceFileId = normalizeString(sourceMedia.fileId || sourceMedia.fileID);
  const extension = getForwardMediaExtension(sourceFileId, type);
  if (!extension) {
    businessError(ERROR_CODES.MEDIA_FORWARD_FAILED, '媒体文件暂不可转发');
  }
  const downloaded = await cloud.downloadFile({ fileID: sourceFileId });
  const fileContent = downloaded && downloaded.fileContent;
  const size = fileContent && Number(fileContent.length || fileContent.byteLength);
  const maximum = type === 'voice' ? MAX_VOICE_SIZE : MAX_IMAGE_SIZE;
  if (!fileContent || !Number.isFinite(size) || size < 1 || size > maximum) {
    businessError(ERROR_CODES.MEDIA_FORWARD_FAILED, '媒体文件暂不可转发');
  }
  const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cloudPath = [
    'chat-media',
    type,
    targetConversationId,
    senderPublicUserId,
    dateFolder,
    `${clientMessageId}.${extension}`
  ].join('/');
  const uploaded = await cloud.uploadFile({ cloudPath, fileContent });
  const fileId = normalizeString(uploaded && (uploaded.fileID || uploaded.fileId));
  if (!fileId) {
    businessError(ERROR_CODES.MEDIA_FORWARD_FAILED, '媒体文件暂不可转发');
  }
  return {
    fileId,
    media: {
      ...sourceMedia,
      fileId,
      size
    }
  };
}

async function forwardMessage(data, openId, trace) {
  trace.step = 'forward.validate';
  const sourceConversationId = normalizeConversationId(data.sourceConversationId);
  const targetConversationId = normalizeConversationId(data.targetConversationId);
  const sourceMessageId = normalizeMessageId(data.sourceMessageId);
  const clientMessageId = normalizeClientMessageId(data.clientMessageId);
  if (
    !sourceConversationId
    || !targetConversationId
    || !sourceMessageId
    || !clientMessageId
  ) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '转发参数不正确');
  }
  const sourceResolved = await resolveConversation(
    conversations,
    sourceConversationId
  );
  const targetResolved = await resolveConversation(
    conversations,
    targetConversationId
  );
  if (!sourceResolved || !targetResolved) {
    return failure(ERROR_CODES.CONVERSATION_NOT_FOUND, '会话不存在或已失效');
  }
  if (
    targetResolved.conversationId !== targetConversationId
    || sourceResolved.conversationId === targetConversationId
  ) {
    return failure(ERROR_CODES.INVALID_FORWARD_TARGET, '请选择其他有效会话');
  }
  const sourceSlot = getParticipantSlot(sourceResolved.conversation, openId);
  const targetSlot = getParticipantSlot(targetResolved.conversation, openId);
  if (!sourceSlot || !targetSlot) {
    return failure(ERROR_CODES.FORBIDDEN, '无权转发到该会话');
  }
  const targetMessageId = createMessageId(
    targetConversationId,
    openId,
    clientMessageId
  );
  const existingTargetMessage = await getDocumentOrNull(
    db.collection('messages').doc(targetMessageId)
  );
  if (existingTargetMessage) {
    if (
      normalizeConversationId(existingTargetMessage.conversationId)
        !== targetConversationId
      || existingTargetMessage.senderOpenid !== openId
    ) {
      return failure(ERROR_CODES.INVALID_FORWARD_TARGET, '转发幂等键已失效');
    }
    return success({
      message: toSafeMessage(existingTargetMessage, openId),
      reused: true
    });
  }
  const sourceMessage = await getDocumentOrNull(
    db.collection('messages').doc(sourceMessageId)
  );
  const type = normalizeMessageType(sourceMessage && sourceMessage.type);
  if (
    !sourceMessage
    || normalizeConversationId(sourceMessage.conversationId)
      !== sourceResolved.conversationId
    || sourceMessage.recalled === true
    || isDeletedForParticipant(sourceMessage, sourceSlot)
    || !FORWARDABLE_MESSAGE_TYPES.has(type)
  ) {
    return failure(ERROR_CODES.MESSAGE_NOT_FORWARDABLE, '原消息不可转发');
  }

  const payload = {
    conversationId: targetConversationId,
    clientMessageId,
    type
  };
  if (type === 'text') {
    payload.content = normalizeString(sourceMessage.content);
  } else if (type === 'location') {
    payload.location = sourceMessage.location;
  } else if (type === 'product') {
    payload.productId = normalizeProductId(
      sourceMessage.product && sourceMessage.product.productId
    );
  }

  const forwardOptions = {
    requireCanonical: true,
    forwardSource: {
      conversationId: sourceConversationId,
      canonicalConversationId: sourceResolved.conversationId,
      messageId: sourceMessageId
    }
  };
  let copiedFileId = '';
  try {
    if (type === 'voice' || type === 'image') {
      const mediaValid = await isValidStoredForwardMedia(
        sourceMessage,
        sourceResolved.conversationId,
        type
      );
      if (!mediaValid) {
        return failure(ERROR_CODES.MESSAGE_NOT_FORWARDABLE, '原媒体消息不可转发');
      }
      const targetSenderPublicUserId = normalizeString(
        targetResolved.conversation[`participant${targetSlot}UserId`]
      );
      const copied = await copyForwardMedia(
        sourceMessage,
        type,
        targetConversationId,
        targetSenderPublicUserId,
        clientMessageId
      );
      copiedFileId = copied.fileId;
      payload.media = copied.media;
    }
    const response = await sendMessage(
      payload,
      openId,
      trace,
      '',
      forwardOptions
    );
    if (!response.success && copiedFileId) {
      await cloud.deleteFile({ fileList: [copiedFileId] }).catch(() => {});
    }
    return response;
  } catch (error) {
    if (copiedFileId) {
      await cloud.deleteFile({ fileList: [copiedFileId] }).catch(() => {});
    }
    throw error;
  }
}

function classifyFailure(error) {
  const codes = [
    error && error.code,
    error && error.errCode,
    error && error.cause && error.cause.code,
    error && error.cause && error.cause.errCode
  ].filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim().toUpperCase());
  if (
    codes.includes('DATABASE_TRANSACTION_CONFLICT')
    || codes.includes('DATABASE_REQUEST_FAILED')
  ) {
    return ERROR_CODES.DATABASE_ERROR;
  }
  const message = [
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).join(' ').toLowerCase();
  if (message.includes('database') || message.includes('collection')) {
    return ERROR_CODES.DATABASE_ERROR;
  }
  return ERROR_CODES.INTERNAL_ERROR;
}

exports.main = async (event = {}) => {
  const request = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const action = normalizeString(request.action);
  const nestedData = request.data
    && typeof request.data === 'object'
    && !Array.isArray(request.data)
    ? request.data
    : {};
  const data = Object.assign({}, nestedData, request);
  delete data.action;
  delete data.data;
  const allowedActions = [
    'createOrGetConversation',
    'sendTextMessage',
    'sendMessage',
    'markConversationRead',
    'hideConversation',
    'deleteMessageForMe',
    'recallMessage',
    'forwardMessage'
  ];
  if (!allowedActions.includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的消息操作');
  }

  const context = cloud.getWXContext();
  const openId = context && normalizeString(context.OPENID);
  const appId = context && normalizeString(context.APPID);
  if (!openId || !appId) {
    return failure(ERROR_CODES.LOGIN_REQUIRED, '请先登录后使用消息功能');
  }

  const trace = {
    traceId: createSafeTraceId(data.traceId),
    action,
    step: 'start',
    productId: '',
    productFound: false
  };
  trace.attemptDiagnostic = createAttemptDiagnosticCollector(
    trace.traceId,
    action
  );
  try {
    trace.step = 'maintenance.check';
    await maintenance.assertWritable(db, businessError);
    if (action === 'createOrGetConversation') {
      return await createOrGetConversation(data, {
        openId,
        appId
      }, trace);
    }
    if (action === 'sendTextMessage') {
      return {
        ...await sendTextMessage(data, openId, trace),
        traceId: trace.traceId
      };
    }
    if (action === 'sendMessage') {
      return {
        ...await sendMessage(data, openId, trace),
        traceId: trace.traceId
      };
    }
    if (action === 'markConversationRead') {
      return await markConversationRead(data, openId, trace);
    }
    if (action === 'hideConversation') {
      return {
        ...await hideConversation(data, openId, trace),
        traceId: trace.traceId
      };
    }
    if (action === 'deleteMessageForMe') {
      return await deleteMessageForMe(data, openId, trace);
    }
    if (action === 'recallMessage') {
      return await recallMessage(data, openId, trace);
    }
    return await forwardMessage(data, openId, trace);
  } catch (error) {
    if (error && error.businessCode) {
      return {
        ...failure(error.businessCode, error.message),
        traceId: trace.traceId
      };
    }
    const code = classifyFailure(error);
    logSafeTrace(trace, 'response', {
      outcome: 'failed',
      step: trace.step,
      safeErrorCode: getSafeErrorCode(error),
      retryable: isRetryableTransactionConflict(error)
    });
    console.error('[messageAction] request failed', {
      action,
      step: trace.step,
      code,
      errCode: error && (error.errCode || error.code || error.name || '')
    });
    if (action === 'createOrGetConversation') {
      logProductLookupDiagnostic(
        trace.productId,
        trace.productFound,
        code
      );
    }
    return appendAttemptDiagnostic({
      ...failure(
        code,
        code === ERROR_CODES.DATABASE_ERROR
          ? '消息数据暂不可用，请稍后重试'
          : '消息服务暂不可用，请稍后重试'
      ),
      traceId: trace.traceId
    }, trace);
  }
};

exports.__test = Object.freeze({
  canCreateSchoolRelation,
  assertCanCreateSchoolRelation,
  createUserId,
  createParticipantPair,
  isRetryableTransactionConflict,
  runTransaction,
  getConversationActivitySnapshot,
  conversationMatchesActivitySnapshot,
  getTransactionControl,
  getSafeErrorCode,
  getWhitelistedDiagnosticCode,
  isAttemptDiagnosticEnabled,
  createAttemptDiagnosticCollector,
  appendAttemptDiagnostic,
  beginAttemptStage,
  completeAttemptStage,
  safeAttemptStages: SAFE_ATTEMPT_STAGES,
  transactionMaxAttempts: TRANSACTION_MAX_ATTEMPTS
});
