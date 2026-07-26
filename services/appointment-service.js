const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');
const {
  APPOINTMENT_STATUS,
  APPOINTMENT_STATUS_META,
  APPOINTMENT_LIST_FILTER,
  APPOINTMENT_LIMITS
} = require('../constants/appointment');
const { formatPrice, formatPublishedTime } = require('../utils/format');

const APPOINTMENT_ID_PATTERN = /^a_[a-f0-9]{64}$/;
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const MAX_PAGE_SIZE = 30;
const DEFAULT_PAGE_SIZE = 10;

const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  CLOUD_TIMEOUT: '预约请求超时，请重新尝试',
  CLOUD_UNAVAILABLE: '当前微信版本不支持云服务',
  CLOUD_INIT_FAILED: '预约服务初始化失败，请稍后重试',
  CLOUD_CALL_FAILED: '预约服务暂不可用，请稍后重试',
  FUNCTION_NOT_FOUND: '预约云函数尚未部署',
  INVALID_ACTION: '预约操作不受支持',
  UNAUTHORIZED: '请先登录后使用预约功能',
  INVALID_PARAMS: '预约参数不正确',
  PRODUCT_NOT_FOUND: '商品已不存在',
  PRODUCT_UNAVAILABLE: '当前商品不能进行面交预约',
  SELF_APPOINTMENT_NOT_ALLOWED: '不能预约自己的商品',
  CONVERSATION_NOT_FOUND: '会话不存在或已失效',
  FORBIDDEN: '无权访问该预约',
  APPOINTMENT_NOT_FOUND: '预约不存在或已失效',
  APPOINTMENT_ALREADY_EXISTS: '当前商品已有进行中的面交预约',
  INVALID_APPOINTMENT_TIME: '面交时间必须在未来 30 天内',
  INVALID_APPOINTMENT_LOCATION: '请选择有效的面交地点',
  INVALID_STATUS_TRANSITION: '当前预约状态不支持此操作',
  ACTION_NOT_ALLOWED: '当前账号不能执行此操作',
  IDEMPOTENCY_CONFLICT: '重复请求发生冲突，请刷新后重试',
  DATABASE_ERROR: '预约数据暂不可用，请稍后重试',
  INTERNAL_ERROR: '预约服务暂不可用，请稍后重试',
  INVALID_RESPONSE: '预约服务返回异常',
  UNKNOWN_ERROR: '预约服务暂不可用'
};

class AppointmentError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'AppointmentError';
    this.code = code || 'UNKNOWN_ERROR';
  }
}

function createError(code, message) {
  return new AppointmentError(
    code,
    ERROR_MESSAGES[code] || message || ERROR_MESSAGES.UNKNOWN_ERROR
  );
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDate(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.floor(number), maximum);
}

function normalizeCursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const time = normalizeDate(value.time);
  const id = normalizeString(value.id);
  return time && APPOINTMENT_ID_PATTERN.test(id)
    ? { time, id }
    : null;
}

function normalizeLocation(value) {
  const record = value && typeof value === 'object' ? value : {};
  const latitude = typeof record.latitude === 'number'
    ? record.latitude
    : NaN;
  const longitude = typeof record.longitude === 'number'
    ? record.longitude
    : NaN;
  return {
    name: normalizeString(record.name),
    address: normalizeString(record.address),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null
  };
}

function validateLocation(value) {
  const location = normalizeLocation(value);
  if (
    !location.name
    || location.name.length > APPOINTMENT_LIMITS.LOCATION_NAME_MAX_LENGTH
    || !location.address
    || location.address.length > APPOINTMENT_LIMITS.LOCATION_ADDRESS_MAX_LENGTH
    || !Number.isFinite(location.latitude)
    || location.latitude < -90
    || location.latitude > 90
    || !Number.isFinite(location.longitude)
    || location.longitude < -180
    || location.longitude > 180
    || (location.latitude === 0 && location.longitude === 0)
  ) {
    throw createError('INVALID_APPOINTMENT_LOCATION');
  }
  return location;
}

function validateScheduledAt(value) {
  const isoTime = normalizeDate(value);
  const time = isoTime ? new Date(isoTime).getTime() : NaN;
  const now = Date.now();
  const maximum = now
    + APPOINTMENT_LIMITS.MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000;
  if (Number.isNaN(time) || time <= now || time > maximum) {
    throw createError('INVALID_APPOINTMENT_TIME');
  }
  return isoTime;
}

function formatAppointmentTime(value) {
  const isoTime = normalizeDate(value);
  if (!isoTime) {
    return '';
  }
  const date = new Date(isoTime);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function normalizeProduct(value) {
  const record = value && typeof value === 'object' ? value : {};
  const price = Number(record.price);
  const safePrice = Number.isFinite(price) && price >= 0 ? price : 0;
  return {
    productId: normalizeString(record.productId),
    title: normalizeString(record.title) || '商品已不可用',
    coverImage: normalizeString(record.coverImage),
    price: safePrice,
    priceDisplay: safePrice === 0 ? '免费送' : `¥${formatPrice(safePrice)}`,
    status: normalizeString(record.status) || 'deleted',
    legacyLocationName: normalizeString(record.legacyLocationName)
  };
}

function normalizeUser(value) {
  const record = value && typeof value === 'object' ? value : {};
  const publicUserId = normalizeString(record.publicUserId);
  const nickname = normalizeString(record.nickname) || '即出用户';
  return {
    publicUserId: PUBLIC_USER_ID_PATTERN.test(publicUserId)
      ? publicUserId
      : '',
    nickname,
    avatarUrl: normalizeString(record.avatarUrl),
    avatarText: nickname.slice(0, 1) || '即',
    campus: normalizeString(record.campus) || '校园信息待完善'
  };
}

function normalizeAppointment(record) {
  if (!record || typeof record !== 'object') {
    throw createError('INVALID_RESPONSE');
  }
  const appointmentId = normalizeString(
    record.appointmentId || record._id
  );
  const conversationId = normalizeString(record.conversationId);
  const status = normalizeString(record.status);
  if (
    !APPOINTMENT_ID_PATTERN.test(appointmentId)
    || !CONVERSATION_ID_PATTERN.test(conversationId)
    || !Object.values(APPOINTMENT_STATUS).includes(status)
  ) {
    throw createError('INVALID_RESPONSE');
  }
  const scheduledAt = normalizeDate(record.scheduledAt);
  const statusMeta = APPOINTMENT_STATUS_META[status];
  return {
    appointmentId,
    conversationId,
    product: normalizeProduct(record.product),
    otherUser: normalizeUser(record.otherUser),
    scheduledAt,
    scheduledAtText: formatAppointmentTime(scheduledAt),
    location: normalizeLocation(record.location),
    note: normalizeString(record.note),
    status,
    statusText: statusMeta.text,
    statusClassName: statusMeta.className,
    cancelReason: normalizeString(record.cancelReason),
    cancelReasonText: record.cancelReason === 'product_sold'
      ? '商品已完成其他面交'
      : '',
    isSeller: record.isSeller === true,
    isInitiator: record.isInitiator === true,
    waitingForMe: record.waitingForMe === true,
    canAccept: record.canAccept === true,
    canReject: record.canReject === true,
    canCancel: record.canCancel === true,
    canComplete: record.canComplete === true,
    completionHint: normalizeString(record.completionHint),
    createdAt: normalizeDate(record.createdAt),
    createdAtText: formatPublishedTime(record.createdAt),
    updatedAt: normalizeDate(record.updatedAt),
    acceptedAt: normalizeDate(record.acceptedAt),
    rejectedAt: normalizeDate(record.rejectedAt),
    cancelledAt: normalizeDate(record.cancelledAt),
    completedAt: normalizeDate(record.completedAt)
  };
}

async function callAppointmentFunction(functionName, timeoutMs, action, data) {
  let response;
  try {
    response = await CloudService.callFunction({
      name: functionName,
      data: { action, data },
      timeoutMs
    });
  } catch (error) {
    const classified = CloudService.classifyCallError(error);
    throw createError(classified.code, classified.message);
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
    throw createError(payload.code || 'UNKNOWN_ERROR', payload.message);
  }
  return payload.data && typeof payload.data === 'object'
    ? payload.data
    : {};
}

function callQuery(action, data) {
  return callAppointmentFunction(
    CLOUD_CONFIG.appointmentQueryFunctionName,
    CLOUD_CONFIG.appointmentQueryTimeoutMs,
    action,
    data
  );
}

function callAction(action, data) {
  return callAppointmentFunction(
    CLOUD_CONFIG.appointmentActionFunctionName,
    CLOUD_CONFIG.appointmentActionTimeoutMs,
    action,
    data
  );
}

async function createAppointment(options = {}) {
  const conversationId = normalizeString(options.conversationId);
  const idempotencyKey = normalizeString(options.idempotencyKey);
  const note = normalizeString(options.note);
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw createError('INVALID_PARAMS');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw createError('INVALID_PARAMS');
  }
  if (note.length > APPOINTMENT_LIMITS.NOTE_MAX_LENGTH) {
    throw createError(
      'INVALID_PARAMS',
      `预约备注不能超过 ${APPOINTMENT_LIMITS.NOTE_MAX_LENGTH} 个字`
    );
  }
  const data = await callAction('create', {
    conversationId,
    scheduledAt: validateScheduledAt(options.scheduledAt),
    location: validateLocation(options.location),
    note,
    idempotencyKey
  });
  const appointmentId = normalizeString(data.appointmentId);
  if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    appointmentId,
    status: normalizeString(data.status),
    reused: data.reused === true
  };
}

async function getAppointment(appointmentId) {
  const id = normalizeString(appointmentId);
  if (!APPOINTMENT_ID_PATTERN.test(id)) {
    throw createError('INVALID_PARAMS');
  }
  const data = await callQuery('detail', { appointmentId: id });
  return normalizeAppointment(data.appointment);
}

async function getActiveByConversation(conversationId) {
  const id = normalizeString(conversationId);
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    throw createError('INVALID_PARAMS');
  }
  const data = await callQuery('getActiveByConversation', {
    conversationId: id
  });
  return data.appointment ? normalizeAppointment(data.appointment) : null;
}

async function listMine(options = {}) {
  const filter = Object.values(APPOINTMENT_LIST_FILTER).includes(options.filter)
    ? options.filter
    : APPOINTMENT_LIST_FILTER.PENDING;
  const data = await callQuery('listMine', {
    filter,
    pageSize: normalizePositiveInteger(
      options.pageSize,
      DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE
    ),
    cursor: normalizeCursor(options.cursor)
  });
  if (!Array.isArray(data.list)) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    list: data.list.map(normalizeAppointment),
    hasMore: data.hasMore === true,
    nextCursor: normalizeCursor(data.nextCursor)
  };
}

async function runStatusAction(action, appointmentId, idempotencyKey) {
  const id = normalizeString(appointmentId);
  const key = normalizeString(idempotencyKey);
  if (
    !APPOINTMENT_ID_PATTERN.test(id)
    || !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    throw createError('INVALID_PARAMS');
  }
  const data = await callAction(action, {
    appointmentId: id,
    idempotencyKey: key
  });
  return {
    appointmentId: id,
    productId: PRODUCT_ID_PATTERN.test(normalizeString(data.productId))
      ? normalizeString(data.productId)
      : '',
    status: normalizeString(data.status),
    reused: data.reused === true,
    productChanged: data.productChanged === true,
    cleanup: data.cleanup && typeof data.cleanup === 'object'
      ? data.cleanup
      : null
  };
}

function createIdempotencyKey(prefix = 'apt') {
  const safePrefix = normalizeString(prefix).replace(/[^a-zA-Z0-9_-]/g, '')
    || 'apt';
  return `${safePrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

module.exports = {
  AppointmentError,
  APPOINTMENT_STATUS,
  APPOINTMENT_LIST_FILTER,
  APPOINTMENT_LIMITS,
  normalizeAppointment,
  validateLocation,
  validateScheduledAt,
  formatAppointmentTime,
  createIdempotencyKey,
  createAppointment,
  getAppointment,
  getActiveByConversation,
  listMine,
  acceptAppointment(appointmentId, key) {
    return runStatusAction('accept', appointmentId, key);
  },
  rejectAppointment(appointmentId, key) {
    return runStatusAction('reject', appointmentId, key);
  },
  cancelAppointment(appointmentId, key) {
    return runStatusAction('cancel', appointmentId, key);
  },
  completeAppointment(appointmentId, key) {
    return runStatusAction('complete', appointmentId, key);
  },
  retryProductSoldCleanup(productId) {
    const id = normalizeString(productId);
    if (!PRODUCT_ID_PATTERN.test(id)) {
      return Promise.reject(createError('INVALID_PARAMS'));
    }
    return callAction('retryProductSoldCleanup', { productId: id });
  }
};
