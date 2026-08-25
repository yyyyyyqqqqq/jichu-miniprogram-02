const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');
const { formatPublishedTime, formatPrice } = require('../utils/format');
const { buildUserPresentation } = require('../utils/user-presentation');

const DEFAULT_CONVERSATION_PAGE_SIZE = 10;
const DEFAULT_MESSAGE_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 30;
const MESSAGE_MAX_LENGTH = 500;
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^m_[a-f0-9]{64}$/;
const CLIENT_MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const SAFE_TRACE_ID_PATTERN = /^tr_[a-z0-9_-]{8,40}$/;
const SAFE_DIAGNOSTIC_ACTIONS = new Set([
  'sendTextMessage',
  'sendMessage',
  'hideConversation',
  'getMessageDeliveryStatus'
]);
const SAFE_DIAGNOSTIC_CODES = new Set([
  'OK',
  'DATABASE_TRANSACTION_CONFLICT',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
  'NETWORK_ERROR',
  'CLOUD_TIMEOUT',
  'UNKNOWN_SAFE_ERROR'
]);
const SAFE_COMMIT_OUTCOMES = new Set([
  'committed',
  'conflict',
  'failed_non_conflict',
  'outcome_unknown',
  'rolled_back',
  'unknown'
]);
const SAFE_RECONCILIATION_OUTCOMES = new Set([
  'found',
  'not_found',
  'query_failed',
  'not_applicable'
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
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const APPOINTMENT_ID_PATTERN = /^a_[a-f0-9]{64}$/;
const MESSAGE_TYPES = new Set([
  'text',
  'voice',
  'image',
  'location',
  'product',
  'system',
  'recalled',
  'deleted'
]);
const PRODUCT_MESSAGE_STATUSES = new Set([
  'available',
  'reserved',
  'sold'
]);
const MIN_VOICE_DURATION_MS = 1000;
const MAX_VOICE_DURATION_MS = 60000;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_SIZE = 10 * 1024 * 1024;
const MAX_MEDIA_DIMENSION = 12000;
const APPOINTMENT_EVENT_TYPES = new Set([
  'appointment_created',
  'appointment_accepted',
  'appointment_rejected',
  'appointment_cancelled',
  'appointment_completed',
  'appointment_auto_cancelled'
]);
const DELIVERY_RECONCILIATION_ERROR_CODES = new Set([
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
  'NETWORK_ERROR',
  'CLOUD_TIMEOUT',
  'CLOUD_CALL_FAILED',
  'INVALID_RESPONSE'
]);

const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  CLOUD_TIMEOUT: '消息请求超时，请重新尝试',
  CLOUD_UNAVAILABLE: '当前微信版本不支持云服务',
  CLOUD_INIT_FAILED: '消息服务初始化失败，请稍后重试',
  CLOUD_CALL_FAILED: '消息服务暂不可用，请稍后重试',
  FUNCTION_NOT_FOUND: '消息服务未正确部署，请稍后重试',
  AUTH_REQUIRED: '请先登录后使用消息功能',
  PROFILE_INCOMPLETE: '请先完善头像和昵称',
  INVALID_ACTION: '消息操作不受支持',
  INVALID_ARGUMENT: '消息参数不正确',
  INVALID_PARAMS: '消息参数不正确',
  LOGIN_REQUIRED: '请先登录后使用消息功能',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  USER_NOT_FOUND: '用户记录不存在，请重新登录',
  PRODUCT_NOT_FOUND: '商品已不存在',
  PRODUCT_UNAVAILABLE: '当前商品暂不能发起新会话',
  PRODUCT_SELLER_UNAVAILABLE: '商品卖家信息暂不可用',
  SELF_CONVERSATION_FORBIDDEN: '不能给自己发送私信',
  CROSS_SCHOOL_RELATION_FORBIDDEN: '暂不支持与其他学校的商品建立新的交易关系',
  CONVERSATION_NOT_FOUND: '会话不存在或已失效',
  FORBIDDEN: '无权访问该会话',
  MESSAGE_EMPTY: '消息内容不能为空',
  MESSAGE_TOO_LONG: `消息不能超过 ${MESSAGE_MAX_LENGTH} 个字`,
  INVALID_MESSAGE_TYPE: '暂不支持这种消息类型',
  INVALID_MEDIA: '媒体文件不正确，请重新选择',
  INVALID_LOCATION: '位置信息不正确，请重新选择',
  INVALID_PRODUCT: '商品信息不正确，请重新选择',
  PRODUCT_NOT_ACCESSIBLE: '商品不存在或当前不可发送',
  INVALID_OWNER_SCOPE: '商品归属筛选不正确',
  MEDIA_UPLOAD_FAILED: '媒体上传失败，请稍后重试',
  PERMISSION_DENIED: '需要相关权限才能继续',
  MESSAGE_SEND_FAILED: '发送失败，请重试',
  MESSAGE_NOT_FOUND: '消息不存在或已失效',
  MESSAGE_NOT_OWNED: '只能撤回自己发送的消息',
  MESSAGE_NOT_RECALLABLE: '该消息不可撤回',
  MESSAGE_RECALL_EXPIRED: '已超过 2 分钟撤回时限',
  MESSAGE_ALREADY_RECALLED: '消息已经撤回',
  MESSAGE_NOT_FORWARDABLE: '该消息不可转发',
  INVALID_FORWARD_TARGET: '请选择其他有效会话',
  MEDIA_FORWARD_FAILED: '媒体文件暂不可转发',
  DATABASE_ERROR: '消息数据暂不可用，请稍后重试',
  INTERNAL_ERROR: '消息服务暂不可用',
  INVALID_RESPONSE: '消息服务返回异常',
  UNKNOWN_ERROR: '消息服务暂不可用'
};

class MessageError extends Error {
  constructor(code, message, traceId = '', diagnostic) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'MessageError';
    this.code = code || 'UNKNOWN_ERROR';
    this.traceId = SAFE_TRACE_ID_PATTERN.test(normalizeString(traceId))
      ? normalizeString(traceId)
      : '';
    this.diagnostic = normalizeAttemptDiagnostic(diagnostic);
  }
}

function createError(code, message, traceId = '', diagnostic) {
  return new MessageError(
    code,
    ERROR_MESSAGES[code] || message,
    traceId,
    diagnostic
  );
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTraceId(value) {
  const traceId = normalizeString(value).toLowerCase();
  return SAFE_TRACE_ID_PATTERN.test(traceId) ? traceId : '';
}

function isAttemptDiagnosticClientEnabled() {
  return !CLOUD_CONFIG.environmentValidationError
    && ['staging', 'development'].includes(
      normalizeString(CLOUD_CONFIG.environmentName).toLowerCase()
    );
}

function normalizeAttemptDiagnostic(value) {
  if (
    !isAttemptDiagnosticClientEnabled()
    || !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return undefined;
  }
  const traceId = normalizeTraceId(value.traceId);
  const action = normalizeString(value.action);
  const sourceAttempts = Array.isArray(value.attempts) ? value.attempts : [];
  if (
    !traceId
    || !SAFE_DIAGNOSTIC_ACTIONS.has(action)
    || sourceAttempts.length > 3
  ) {
    return undefined;
  }
  const attempts = [];
  for (const source of sourceAttempts) {
    const attempt = Number(source && source.attempt);
    const safeCode = normalizeString(source && source.safeCode);
    const commitOutcome = normalizeString(source && source.commitOutcome);
    if (
      !Number.isInteger(attempt)
      || attempt < 1
      || attempt > 3
      || !SAFE_DIAGNOSTIC_CODES.has(safeCode)
      || !SAFE_COMMIT_OUTCOMES.has(commitOutcome)
    ) {
      return undefined;
    }
    const item = {
      attempt,
      safeCode,
      retryable: source.retryable === true,
      transactionCreated: source.transactionCreated === true,
      commitStarted: source.commitStarted === true,
      commitOutcome
    };
    if (typeof source.messageExistedBeforeAttempt === 'boolean') {
      item.messageExistedBeforeAttempt = source.messageExistedBeforeAttempt;
    }
    if (typeof source.snapshotChanged === 'boolean') {
      item.snapshotChanged = source.snapshotChanged;
    }
    const lastCompletedStage = normalizeString(source.lastCompletedStage);
    const failedStage = normalizeString(source.failedStage);
    if (lastCompletedStage) {
      if (!SAFE_ATTEMPT_STAGES.has(lastCompletedStage)) {
        return undefined;
      }
      item.lastCompletedStage = lastCompletedStage;
    }
    if (failedStage) {
      if (!SAFE_ATTEMPT_STAGES.has(failedStage)) {
        return undefined;
      }
      item.failedStage = failedStage;
    }
    attempts.push(item);
  }
  const reconciliation = value.reconciliation
    && typeof value.reconciliation === 'object'
    ? value.reconciliation
    : {};
  const outcome = normalizeString(reconciliation.outcome);
  if (!SAFE_RECONCILIATION_OUTCOMES.has(outcome)) {
    return undefined;
  }
  return {
    traceId,
    action,
    attemptCount: attempts.length,
    attempts,
    reconciliation: {
      attempted: reconciliation.attempted === true,
      outcome
    }
  };
}

function withReconciliationOutcome(diagnostic, outcome) {
  const normalized = normalizeAttemptDiagnostic(diagnostic);
  if (!normalized || !SAFE_RECONCILIATION_OUTCOMES.has(outcome)) {
    return undefined;
  }
  return {
    ...normalized,
    reconciliation: {
      attempted: outcome !== 'not_applicable',
      outcome
    }
  };
}

function formatAttemptDiagnostic(value) {
  const diagnostic = normalizeAttemptDiagnostic(value);
  if (!diagnostic) {
    return '';
  }
  return JSON.stringify(diagnostic, null, 2);
}

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.floor(number), maximum);
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
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

function normalizeMessageType(value) {
  return MESSAGE_TYPES.has(value) ? value : 'unsupported';
}

function normalizeDate(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function formatMessageTime(value) {
  const isoTime = normalizeDate(value);
  if (!isoTime) {
    return '';
  }
  const date = new Date(isoTime);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return formatPublishedTime(isoTime, now);
}

function normalizeCursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const time = normalizeDate(value.time);
  const id = normalizeString(value.id);
  return time && /^(?:c|m)_[a-f0-9]{64}$/.test(id)
    ? { time, id }
    : null;
}

function normalizeProductCursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const time = normalizeDate(value.time);
  const id = normalizeString(value.id);
  return time && PRODUCT_ID_PATTERN.test(id) ? { time, id } : null;
}

function normalizePublicUser(value) {
  const record = value && typeof value === 'object' ? value : {};
  const presentation = buildUserPresentation(record);
  const publicUserId = normalizeString(record.publicUserId);
  const schoolName = normalizeString(record.schoolName);
  const campus = normalizeString(record.campus);
  return {
    publicUserId: PUBLIC_USER_ID_PATTERN.test(publicUserId) ? publicUserId : '',
    nickname: presentation.nickname,
    avatarUrl: presentation.avatarUrl,
    avatarText: presentation.avatarText,
    schoolName,
    campus,
    schoolDisplayName: schoolName || campus || '校园信息待完善'
  };
}

function normalizeProduct(value) {
  const record = value && typeof value === 'object' ? value : {};
  const status = ['available', 'reserved', 'offline', 'sold', 'deleted']
    .includes(record.status)
    ? record.status
    : 'deleted';
  const statusText = {
    available: '在售',
    reserved: '已预订',
    offline: '已下架',
    sold: '已售出',
    deleted: '已删除'
  }[status];
  const price = Number(record.price);
  const safePrice = Number.isFinite(price) && price >= 0 ? price : 0;
  return {
    productId: normalizeString(record.productId),
    title: normalizeString(record.title) || '商品已不可用',
    coverImage: normalizeString(record.coverImage),
    price: safePrice,
    priceText: formatPrice(safePrice),
    priceDisplay: safePrice === 0 ? '免费送' : `¥${formatPrice(safePrice)}`,
    status,
    statusText,
    locationName: normalizeString(record.location)
  };
}

function normalizeMessageMedia(type, value) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const fileId = normalizeString(record.fileId || record.fileID);
  if (!fileId.startsWith('cloud://')) {
    throw createError('INVALID_RESPONSE');
  }
  if (type === 'voice') {
    const durationMs = normalizeInteger(
      record.durationMs,
      MIN_VOICE_DURATION_MS,
      MAX_VOICE_DURATION_MS
    );
    const size = normalizeInteger(record.size, 1, MAX_VOICE_SIZE);
    if (
      durationMs === null
      || size === null
      || normalizeString(record.format).toLowerCase() !== 'mp3'
    ) {
      throw createError('INVALID_RESPONSE');
    }
    return {
      fileId,
      durationMs,
      durationText: `${Math.max(1, Math.ceil(durationMs / 1000))}″`,
      size,
      format: 'mp3'
    };
  }
  const width = normalizeInteger(record.width, 1, MAX_MEDIA_DIMENSION);
  const height = normalizeInteger(record.height, 1, MAX_MEDIA_DIMENSION);
  const size = normalizeInteger(record.size, 1, MAX_IMAGE_SIZE);
  if (width === null || height === null || size === null) {
    throw createError('INVALID_RESPONSE');
  }
  const ratio = width / height;
  return {
    fileId,
    width,
    height,
    size,
    displayMode: ratio > 1.35 ? 'landscape' : ratio < 0.74 ? 'portrait' : 'square'
  };
}

function normalizeMessageLocation(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const name = normalizeString(record.name);
  const address = normalizeString(record.address);
  const latitude = normalizeCoordinate(record.latitude, -90, 90);
  const longitude = normalizeCoordinate(record.longitude, -180, 180);
  if (
    !name
    || name.length > 80
    || !address
    || address.length > 200
    || latitude === null
    || longitude === null
  ) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    name,
    address,
    latitude,
    longitude
  };
}

function normalizeMessageProduct(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const productId = normalizeString(record.productId);
  const title = normalizeString(record.title);
  const ownerPublicUserId = normalizeString(record.ownerPublicUserId);
  const status = PRODUCT_MESSAGE_STATUSES.has(record.status)
    ? record.status
    : 'sold';
  const price = Number(record.price);
  if (
    !PRODUCT_ID_PATTERN.test(productId)
    || !title
    || !PUBLIC_USER_ID_PATTERN.test(ownerPublicUserId)
    || !Number.isFinite(price)
    || price < 0
  ) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    productId,
    title,
    coverImage: normalizeString(record.coverImage),
    price,
    priceDisplay: price === 0 ? '免费送' : `¥${formatPrice(price)}`,
    status,
    statusText: {
      available: '在售',
      reserved: '已预定',
      sold: '已售出'
    }[status],
    schoolId: normalizeString(record.schoolId),
    schoolName: normalizeString(record.schoolName),
    ownerPublicUserId
  };
}

function normalizeConversation(record) {
  if (!record || typeof record !== 'object') {
    throw createError('INVALID_RESPONSE');
  }
  const conversationId = normalizeString(
    record.conversationId || record._id
  );
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw createError('INVALID_RESPONSE');
  }
  const lastMessageAt = normalizeDate(record.lastMessageAt);
  return {
    conversationId,
    otherUser: normalizePublicUser(record.otherUser),
    product: normalizeProduct(record.product),
    lastMessage: normalizeString(record.lastMessage) || '开始聊聊这件闲置吧',
    lastMessageType: MESSAGE_TYPES.has(record.lastMessageType)
      ? record.lastMessageType
      : '',
    lastMessageId: MESSAGE_ID_PATTERN.test(normalizeString(record.lastMessageId))
      ? normalizeString(record.lastMessageId)
      : '',
    lastMessageAt,
    lastMessageAtText: formatPublishedTime(lastMessageAt),
    unreadCount: normalizeCount(record.unreadCount),
    canSend: record.canSend === true
  };
}

function normalizeMessage(record) {
  if (!record || typeof record !== 'object') {
    throw createError('INVALID_RESPONSE');
  }
  const messageId = normalizeString(record.messageId || record._id);
  const senderPublicUserId = normalizeString(record.senderPublicUserId);
  let type = normalizeMessageType(record.type);
  const eventType = normalizeString(record.eventType);
  const appointmentId = normalizeString(record.appointmentId);
  if (
    !MESSAGE_ID_PATTERN.test(messageId)
    || !PUBLIC_USER_ID_PATTERN.test(senderPublicUserId)
  ) {
    throw createError('INVALID_RESPONSE');
  }
  if (
    type === 'system'
    && (
      !APPOINTMENT_EVENT_TYPES.has(eventType)
      || !APPOINTMENT_ID_PATTERN.test(appointmentId)
    )
  ) {
    type = 'unsupported';
  }
  const createdAt = normalizeDate(record.createdAt);
  const message = {
    messageId,
    senderPublicUserId,
    isMine: record.isMine === true,
    type,
    contextProductId: PRODUCT_ID_PATTERN.test(
      normalizeString(record.contextProductId)
    )
      ? normalizeString(record.contextProductId)
      : '',
    createdAt,
    createdAtText: formatMessageTime(createdAt),
    sendStatus: 'sent',
    clientMessageId: '',
    forwarded: record.forwarded === true
  };
  if (type === 'recalled') {
    message.recalled = true;
    message.recalledAt = normalizeDate(record.recalledAt);
    message.content = message.isMine ? '你撤回了一条消息' : '对方撤回了一条消息';
  } else if (type === 'text' || type === 'system') {
    const content = typeof record.content === 'string'
      ? record.content.trim()
      : '';
    if (!content || content.length > MESSAGE_MAX_LENGTH) {
      message.type = 'unsupported';
      message.content = '当前版本暂不支持此消息类型';
      return message;
    }
    message.content = content;
    message.eventType = type === 'system' ? eventType : '';
    message.appointmentId = type === 'system' ? appointmentId : '';
  } else if (type === 'voice' || type === 'image') {
    try {
      message.media = normalizeMessageMedia(type, record.media);
    } catch (error) {
      message.type = 'unsupported';
      message.content = '当前版本暂不支持此消息类型';
      return message;
    }
    message.content = type === 'voice' ? '[语音]' : '[图片]';
  } else if (type === 'location') {
    try {
      message.location = normalizeMessageLocation(record.location);
    } catch (error) {
      message.type = 'unsupported';
      message.content = '当前版本暂不支持此消息类型';
      return message;
    }
    message.content = '[位置]';
  } else if (type === 'product') {
    try {
      message.product = normalizeMessageProduct(record.product);
    } catch (error) {
      message.type = 'unsupported';
      message.content = '当前版本暂不支持此消息类型';
      return message;
    }
    message.content = '[商品]';
  } else {
    message.content = '当前版本暂不支持此消息类型';
  }
  return message;
}

function mapTransportError(error) {
  if (error instanceof MessageError) {
    return error;
  }
  const classified = CloudService.classifyCallError(error);
  return createError(classified.code, classified.message, error && error.traceId);
}

function isDevelopmentEnvironment() {
  if (
    typeof wx === 'undefined'
    || typeof wx.getAccountInfoSync !== 'function'
  ) {
    return false;
  }
  try {
    const account = wx.getAccountInfoSync();
    return Boolean(
      account
      && account.miniProgram
      && account.miniProgram.envVersion === 'develop'
    );
  } catch (error) {
    return false;
  }
}

function logCallFailure(stage, functionName, action, error) {
  if (!isDevelopmentEnvironment()) {
    return;
  }
  console.error('[message-service] call failed', {
    stage,
    cloudReady: CloudService.isCloudReady(),
    functionName,
    action,
    errCode: error && (error.errCode || error.code),
    errMsg: error && (error.errMsg || error.message)
  });
}

async function callMessageFunction(
  functionName,
  timeoutMs,
  action,
  data,
  flatData = false
) {
  let response;
  try {
    response = await CloudService.callFunction({
      name: functionName,
      data: flatData
        ? Object.assign({ action }, data)
        : { action, data },
      timeoutMs
    });
  } catch (error) {
    const stage = error && (
      error.code === 'CLOUD_UNAVAILABLE'
      || error.code === 'CLOUD_INIT_FAILED'
    )
      ? 'cloud_init'
      : 'cloud_call';
    logCallFailure(stage, functionName, action, error);
    const mapped = mapTransportError(error);
    mapped.traceId = normalizeTraceId(data && data.traceId);
    throw mapped;
  }

  const payload = response && response.result;
  if (
    !payload
    || typeof payload !== 'object'
    || typeof payload.success !== 'boolean'
  ) {
    throw createError('INVALID_RESPONSE');
  }
  if (!payload.success) {
    const code = payload.code === 'LOGIN_REQUIRED'
      ? 'AUTH_REQUIRED'
      : payload.code || 'UNKNOWN_ERROR';
    throw createError(
      code,
      payload.message,
      payload.traceId,
      payload.diagnostic
    );
  }
  const result = payload.data && typeof payload.data === 'object'
    ? { ...payload.data }
    : {};
  if (SAFE_TRACE_ID_PATTERN.test(normalizeString(payload.traceId))) {
    result.traceId = normalizeString(payload.traceId);
  }
  const diagnostic = normalizeAttemptDiagnostic(payload.diagnostic);
  if (diagnostic) {
    result.diagnostic = diagnostic;
  }
  return result;
}

function callQuery(action, data) {
  return callMessageFunction(
    CLOUD_CONFIG.messageQueryFunctionName,
    CLOUD_CONFIG.messageQueryTimeoutMs,
    action,
    data
  );
}

function callAction(action, data) {
  return callMessageFunction(
    CLOUD_CONFIG.messageActionFunctionName,
    CLOUD_CONFIG.messageActionTimeoutMs,
    action,
    data,
    true
  );
}

async function reconcileMessageDelivery(
  conversationId,
  clientMessageId,
  originalError
) {
  if (
    !originalError
    || !DELIVERY_RECONCILIATION_ERROR_CODES.has(originalError.code)
  ) {
    return null;
  }
  try {
    const data = await callQuery('getMessageDeliveryStatus', {
      conversationId,
      clientMessageId,
      traceId: normalizeTraceId(originalError.traceId)
    });
    if (data.found !== true || !data.message) {
      originalError.diagnostic = withReconciliationOutcome(
        originalError.diagnostic,
        'not_found'
      );
      return null;
    }
    return {
      message: normalizeMessage(data.message),
      reused: true,
      reconciled: true,
      traceId: normalizeString(originalError.traceId),
      diagnostic: withReconciliationOutcome(
        originalError.diagnostic,
        'found'
      )
    };
  } catch (reconcileError) {
    originalError.diagnostic = withReconciliationOutcome(
      originalError.diagnostic,
      'query_failed'
    );
    return null;
  }
}

async function sendActionWithReconciliation(action, payload) {
  try {
    return await callAction(action, payload);
  } catch (error) {
    const reconciled = await reconcileMessageDelivery(
      payload.conversationId,
      payload.clientMessageId,
      error
    );
    if (reconciled) {
      return reconciled;
    }
    throw error;
  }
}

async function createOrGetConversation(productId) {
  const id = normalizeString(productId);
  if (!PRODUCT_ID_PATTERN.test(id)) {
    throw createError('INVALID_ARGUMENT');
  }
  const data = await callAction('createOrGetConversation', {
    productId: id
  });
  const conversationId = normalizeString(data.conversationId);
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    conversationId,
    reused: data.reused === true
  };
}

async function listConversations(options = {}) {
  const pageSize = normalizePositiveInteger(
    options.pageSize,
    DEFAULT_CONVERSATION_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const data = await callQuery('listConversations', {
    pageSize,
    cursor: normalizeCursor(options.cursor)
  });
  if (!Array.isArray(data.list)) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    list: data.list.map(normalizeConversation),
    hasMore: data.hasMore === true,
    nextCursor: normalizeCursor(data.nextCursor)
  };
}

async function getConversation(conversationId) {
  const id = normalizeString(conversationId);
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw createError('INVALID_ARGUMENT');
  }
  const data = await callQuery('getConversation', {
    conversationId: id
  });
  return normalizeConversation(data.conversation);
}

async function listMessages(conversationId, options = {}) {
  const id = normalizeString(conversationId);
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw createError('INVALID_ARGUMENT');
  }
  const pageSize = normalizePositiveInteger(
    options.pageSize,
    DEFAULT_MESSAGE_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const data = await callQuery('listMessages', {
    conversationId: id,
    pageSize,
    cursor: normalizeCursor(options.cursor)
  });
  if (!Array.isArray(data.list)) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    list: data.list.map(normalizeMessage).reverse(),
    hasMore: data.hasMore === true,
    nextCursor: normalizeCursor(data.nextCursor)
  };
}

function normalizeSelectableProduct(record) {
  const product = normalizeMessageProduct(record);
  const ownerScope = record.ownerScope === 'other' ? 'other' : 'self';
  return {
    ...product,
    ownerScope,
    ownerLabel: ownerScope === 'self' ? '我的商品' : '对方商品'
  };
}

async function listConversationProducts(conversationId, options = {}) {
  const id = normalizeString(conversationId);
  const ownerScope = options.ownerScope === 'other' ? 'other' : 'self';
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw createError('INVALID_ARGUMENT');
  }
  const pageSize = normalizePositiveInteger(
    options.pageSize,
    8,
    MAX_PAGE_SIZE
  );
  const data = await callQuery('listConversationProducts', {
    conversationId: id,
    ownerScope,
    pageSize,
    cursor: normalizeProductCursor(options.cursor)
  });
  if (!Array.isArray(data.list)) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    ownerScope,
    owner: normalizePublicUser(data.owner),
    list: data.list.map(normalizeSelectableProduct),
    hasMore: data.hasMore === true,
    nextCursor: normalizeProductCursor(data.nextCursor)
  };
}

async function sendTextMessage(options = {}) {
  const conversationId = normalizeString(options.conversationId);
  const content = typeof options.content === 'string'
    ? options.content.trim()
    : '';
  const clientMessageId = normalizeString(options.clientMessageId);
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw createError('INVALID_ARGUMENT');
  }
  if (!content) {
    throw createError('MESSAGE_EMPTY');
  }
  if (content.length > MESSAGE_MAX_LENGTH) {
    throw createError('MESSAGE_TOO_LONG');
  }
  if (!CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId)) {
    throw createError('INVALID_ARGUMENT');
  }
  const data = await sendActionWithReconciliation('sendTextMessage', {
    conversationId,
    content,
    clientMessageId,
    traceId: normalizeTraceId(options.traceId) || createTraceId()
  });
  return {
    message: normalizeMessage(data.message),
    reused: data.reused === true,
    reconciled: data.reconciled === true,
    traceId: normalizeTraceId(data.traceId)
  };
}

async function sendTypedMessage(type, options = {}) {
  const conversationId = normalizeString(options.conversationId);
  const clientMessageId = normalizeString(options.clientMessageId);
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw createError('INVALID_ARGUMENT');
  }
  if (!CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId)) {
    throw createError('INVALID_ARGUMENT');
  }
  if (!['voice', 'image', 'location', 'product'].includes(type)) {
    throw createError('INVALID_MESSAGE_TYPE');
  }
  const payload = {
    conversationId,
    clientMessageId,
    type,
    traceId: normalizeTraceId(options.traceId) || createTraceId()
  };
  if (type === 'voice' || type === 'image') {
    const media = options.media && typeof options.media === 'object'
      ? options.media
      : null;
    if (!media) {
      throw createError('INVALID_MEDIA');
    }
    payload.media = media;
  } else if (type === 'location') {
    try {
      payload.location = normalizeMessageLocation(options.location);
    } catch (error) {
      throw createError('INVALID_LOCATION');
    }
  } else {
    const productId = normalizeString(options.productId);
    if (!PRODUCT_ID_PATTERN.test(productId)) {
      throw createError('INVALID_PRODUCT');
    }
    payload.productId = productId;
  }
  const data = await sendActionWithReconciliation('sendMessage', payload);
  return {
    message: normalizeMessage(data.message),
    reused: data.reused === true,
    reconciled: data.reconciled === true,
    traceId: normalizeTraceId(data.traceId)
  };
}

function sendVoiceMessage(options) {
  return sendTypedMessage('voice', options);
}

function sendImageMessage(options) {
  return sendTypedMessage('image', options);
}

function sendLocationMessage(options) {
  return sendTypedMessage('location', options);
}

function sendProductMessage(options) {
  return sendTypedMessage('product', options);
}

async function markConversationRead(conversationId) {
  const id = normalizeString(conversationId);
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw createError('INVALID_ARGUMENT');
  }
  const data = await callAction('markConversationRead', {
    conversationId: id
  });
  return {
    conversationId: id,
    unreadCount: normalizeCount(data.unreadCount)
  };
}

async function hideConversation(conversationId, activity = {}) {
  const id = normalizeString(conversationId);
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw createError('INVALID_ARGUMENT');
  }
  const expectedLastMessageId = normalizeString(activity.expectedLastMessageId);
  const expectedLastMessageAt = normalizeDate(activity.expectedLastMessageAt);
  if (
    (expectedLastMessageId && !MESSAGE_ID_PATTERN.test(expectedLastMessageId))
    || (activity.expectedLastMessageAt && !expectedLastMessageAt)
  ) {
    throw createError('INVALID_ARGUMENT');
  }
  const request = { conversationId: id };
  request.traceId = normalizeTraceId(activity.traceId) || createTraceId();
  if (expectedLastMessageAt) {
    request.expectedLastMessageId = expectedLastMessageId;
    request.expectedLastMessageAt = expectedLastMessageAt;
  }
  const data = await callAction('hideConversation', request);
  return {
    conversationId: normalizeString(data.conversationId) || id,
    reused: data.reused === true,
    superseded: data.superseded === true,
    traceId: normalizeTraceId(data.traceId)
  };
}

async function deleteMessageForMe(conversationId, messageId) {
  const conversation = normalizeString(conversationId);
  const message = normalizeString(messageId);
  if (
    !CONVERSATION_ID_PATTERN.test(conversation)
    || !MESSAGE_ID_PATTERN.test(message)
  ) {
    throw createError('INVALID_ARGUMENT');
  }
  const data = await callAction('deleteMessageForMe', {
    conversationId: conversation,
    messageId: message
  });
  return {
    conversationId: normalizeString(data.conversationId) || conversation,
    messageId: normalizeString(data.messageId) || message,
    reused: data.reused === true
  };
}

async function recallMessage(conversationId, messageId) {
  const conversation = normalizeString(conversationId);
  const message = normalizeString(messageId);
  if (
    !CONVERSATION_ID_PATTERN.test(conversation)
    || !MESSAGE_ID_PATTERN.test(message)
  ) {
    throw createError('INVALID_ARGUMENT');
  }
  const data = await callAction('recallMessage', {
    conversationId: conversation,
    messageId: message
  });
  return {
    conversationId: normalizeString(data.conversationId) || conversation,
    message: normalizeMessage(data.message),
    reused: data.reused === true
  };
}

async function forwardMessage(options = {}) {
  const sourceConversationId = normalizeString(options.sourceConversationId);
  const targetConversationId = normalizeString(options.targetConversationId);
  const sourceMessageId = normalizeString(options.sourceMessageId);
  const clientMessageId = normalizeString(options.clientMessageId)
    || createClientMessageId();
  if (
    !CONVERSATION_ID_PATTERN.test(sourceConversationId)
    || !CONVERSATION_ID_PATTERN.test(targetConversationId)
    || !MESSAGE_ID_PATTERN.test(sourceMessageId)
    || !CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId)
    || sourceConversationId === targetConversationId
  ) {
    throw createError('INVALID_ARGUMENT');
  }
  const data = await callAction('forwardMessage', {
    sourceConversationId,
    targetConversationId,
    sourceMessageId,
    clientMessageId
  });
  return {
    message: normalizeMessage(data.message),
    reused: data.reused === true
  };
}

function canRecallMessage(message, now = Date.now()) {
  if (
    !message
    || message.isMine !== true
    || !['text', 'voice', 'image', 'location', 'product'].includes(message.type)
    || message.sendStatus !== 'sent'
  ) {
    return false;
  }
  const createdAt = new Date(message.createdAt).getTime();
  return Number.isFinite(createdAt)
    && now >= createdAt
    && now - createdAt <= 2 * 60 * 1000;
}

function createClientMessageId() {
  const random = Math.random().toString(36).slice(2, 12);
  return `msg_${Date.now().toString(36)}_${random}`;
}

function createTraceId() {
  const random = Math.random().toString(36).slice(2, 14);
  return `tr_${random.padEnd(8, '0')}`;
}

module.exports = {
  MessageError,
  MESSAGE_MAX_LENGTH,
  normalizeConversation,
  normalizeMessage,
  createClientMessageId,
  createTraceId,
  normalizeAttemptDiagnostic,
  withReconciliationOutcome,
  formatAttemptDiagnostic,
  createOrGetConversation,
  listConversations,
  getConversation,
  listMessages,
  listConversationProducts,
  sendTextMessage,
  sendVoiceMessage,
  sendImageMessage,
  sendLocationMessage,
  sendProductMessage,
  markConversationRead,
  hideConversation,
  deleteMessageForMe,
  recallMessage,
  forwardMessage,
  canRecallMessage
};
