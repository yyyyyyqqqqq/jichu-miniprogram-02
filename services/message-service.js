const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');
const { formatPublishedTime, formatPrice } = require('../utils/format');

const DEFAULT_CONVERSATION_PAGE_SIZE = 10;
const DEFAULT_MESSAGE_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 30;
const MESSAGE_MAX_LENGTH = 500;
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^m_[a-f0-9]{64}$/;
const CLIENT_MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;

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
  CONVERSATION_NOT_FOUND: '会话不存在或已失效',
  FORBIDDEN: '无权访问该会话',
  MESSAGE_EMPTY: '消息内容不能为空',
  MESSAGE_TOO_LONG: `消息不能超过 ${MESSAGE_MAX_LENGTH} 个字`,
  MESSAGE_SEND_FAILED: '发送失败，请重试',
  DATABASE_ERROR: '消息数据暂不可用，请稍后重试',
  INTERNAL_ERROR: '消息服务暂不可用',
  INVALID_RESPONSE: '消息服务返回异常',
  UNKNOWN_ERROR: '消息服务暂不可用'
};

class MessageError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'MessageError';
    this.code = code || 'UNKNOWN_ERROR';
  }
}

function createError(code, message) {
  return new MessageError(code, ERROR_MESSAGES[code] || message);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function normalizePublicUser(value) {
  const record = value && typeof value === 'object' ? value : {};
  const nickname = normalizeString(record.nickname) || '即出用户';
  const publicUserId = normalizeString(record.publicUserId);
  return {
    publicUserId: PUBLIC_USER_ID_PATTERN.test(publicUserId) ? publicUserId : '',
    nickname,
    avatarUrl: normalizeString(record.avatarUrl),
    avatarText: nickname.slice(0, 1) || '即',
    campus: normalizeString(record.campus) || '校园信息待完善'
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
    statusText
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
    lastMessageType: record.lastMessageType === 'text' ? 'text' : '',
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
  if (
    !MESSAGE_ID_PATTERN.test(messageId)
    || !PUBLIC_USER_ID_PATTERN.test(senderPublicUserId)
    || record.type !== 'text'
    || typeof record.content !== 'string'
  ) {
    throw createError('INVALID_RESPONSE');
  }
  const content = record.content.trim();
  if (!content || content.length > MESSAGE_MAX_LENGTH) {
    throw createError('INVALID_RESPONSE');
  }
  const createdAt = normalizeDate(record.createdAt);
  return {
    messageId,
    senderPublicUserId,
    isMine: record.isMine === true,
    type: 'text',
    content,
    createdAt,
    createdAtText: formatMessageTime(createdAt),
    sendStatus: 'sent',
    clientMessageId: ''
  };
}

function mapTransportError(error) {
  if (error instanceof MessageError) {
    return error;
  }
  const classified = CloudService.classifyCallError(error);
  return createError(classified.code, classified.message);
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
    throw mapTransportError(error);
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
    throw createError(code, payload.message);
  }
  return payload.data && typeof payload.data === 'object'
    ? payload.data
    : {};
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
  const data = await callAction('sendTextMessage', {
    conversationId,
    content,
    clientMessageId
  });
  return {
    message: normalizeMessage(data.message),
    reused: data.reused === true
  };
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

function createClientMessageId() {
  const random = Math.random().toString(36).slice(2, 12);
  return `msg_${Date.now().toString(36)}_${random}`;
}

module.exports = {
  MessageError,
  MESSAGE_MAX_LENGTH,
  normalizeConversation,
  normalizeMessage,
  createClientMessageId,
  createOrGetConversation,
  listConversations,
  getConversation,
  listMessages,
  sendTextMessage,
  markConversationRead
};
