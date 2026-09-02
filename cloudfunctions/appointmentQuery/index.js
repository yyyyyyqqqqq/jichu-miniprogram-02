const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const maintenance = require('./maintenance');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const appointments = db.collection('appointments');
const conversations = db.collection('conversations');
const products = db.collection('products');
const users = db.collection('users');

const APPOINTMENT_ID_PATTERN = /^a_[a-f0-9]{64}$/;
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_PAGE_SIZE = 30;
const DEFAULT_PAGE_SIZE = 10;
const ACTIVE_STATUSES = ['pending', 'accepted'];
const ENDED_STATUSES = ['rejected', 'cancelled', 'completed'];
const STATUS_TEXT = {
  pending: '待确认',
  accepted: '已接受',
  rejected: '已拒绝',
  cancelled: '已取消',
  completed: '已完成'
};

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  UNAUTHORIZED: 'UNAUTHORIZED',
  USER_DISABLED: 'USER_DISABLED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  APPOINTMENT_NOT_FOUND: 'APPOINTMENT_NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
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

function createUserId(appId, openId) {
  return `u_${crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.floor(number), maximum);
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
  const message = [
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).join(' ').toLowerCase();
  return code === 'document_not_found'
    || code === 'database_document_not_exist'
    || message.includes('document not exists')
    || message.includes('document does not exist')
    || /^document\.get:fail document with _id .+ does not exist$/.test(message);
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

async function assertActiveUser(identity) {
  const userId = createUserId(identity.appId, identity.openId);
  const user = await getDocumentOrNull(users.doc(userId));
  if (!user || user.openid !== identity.openId) {
    businessError(ERROR_CODES.UNAUTHORIZED, '无法确认当前用户身份');
  }
  if (user.status !== 'active') {
    businessError(ERROR_CODES.USER_DISABLED, '当前账户暂不可用');
  }
  return user;
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

function getParticipantSlot(conversation, openId) {
  if (conversation && conversation.participantAOpenid === openId) {
    return 'A';
  }
  if (conversation && conversation.participantBOpenid === openId) {
    return 'B';
  }
  return '';
}

async function resolveConversation(conversationId) {
  const requested = await getDocumentOrNull(conversations.doc(conversationId));
  if (!requested) {
    return null;
  }
  const mergedInto = normalizeString(requested.mergedInto);
  if (requested.status === 'merged' && CONVERSATION_ID_PATTERN.test(mergedInto)) {
    const canonical = await getDocumentOrNull(conversations.doc(mergedInto));
    return canonical
      ? { conversationId: mergedInto, conversation: canonical }
      : null;
  }
  return { conversationId, conversation: requested };
}

function isAppointmentParticipant(appointment, openId) {
  return Boolean(
    appointment
    && (
      appointment.buyerOpenid === openId
      || appointment.sellerOpenid === openId
    )
  );
}

function safeUser(record, publicUserId) {
  const nickname = normalizeString(record && record.nickname) || '即出用户';
  return {
    publicUserId: normalizeString(publicUserId),
    nickname,
    avatarUrl: normalizeString(record && record.avatarUrl),
    campus: normalizeString(record && record.campus) || '校园信息待完善'
  };
}

function safeProduct(record, productId) {
  const source = record || {};
  return {
    productId,
    title: normalizeString(source.title) || '商品已不可用',
    coverImage: normalizeString(source.coverImage),
    price: Number.isFinite(Number(source.price)) && Number(source.price) >= 0
      ? Number(source.price)
      : 0,
    status: normalizeString(source.status) || 'deleted',
    schoolId: normalizeString(source.schoolId),
    schoolName: normalizeString(source.schoolName),
    legacyLocationName: normalizeString(source.location)
  };
}

function safeLocation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const latitude = typeof source.latitude === 'number'
    ? source.latitude
    : NaN;
  const longitude = typeof source.longitude === 'number'
    ? source.longitude
    : NaN;
  return {
    name: normalizeString(source.name),
    address: normalizeString(source.address),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null
  };
}

async function enrichAppointment(appointment, openId) {
  const isSeller = appointment.sellerOpenid === openId;
  const otherUserId = isSeller
    ? normalizeString(appointment.buyerUserId)
    : normalizeString(appointment.sellerUserId);
  const [otherUser, product] = await Promise.all([
    otherUserId
      ? getDocumentOrNull(users.doc(otherUserId))
      : Promise.resolve(null),
    appointment.productId
      ? getDocumentOrNull(products.doc(appointment.productId))
      : Promise.resolve(null)
  ]);
  const isInitiator = appointment.initiatorOpenid === openId;
  const status = normalizeString(appointment.status);
  const productStatus = normalizeString(product && product.status);
  return {
    appointmentId: String(appointment._id || ''),
    conversationId: normalizeString(appointment.conversationId),
    product: safeProduct(product, normalizeString(appointment.productId)),
    otherUser: safeUser(otherUser, otherUserId),
    scheduledAt: toIsoString(appointment.scheduledAt),
    location: safeLocation(appointment.location),
    note: normalizeString(appointment.note),
    status,
    statusText: STATUS_TEXT[status] || '状态未知',
    cancelReason: normalizeString(appointment.cancelReason),
    isSeller,
    isInitiator,
    waitingForMe: status === 'pending' && !isInitiator,
    canAccept: (
      status === 'pending'
      && !isInitiator
      && productStatus === 'available'
    ),
    canReject: status === 'pending' && !isInitiator,
    canCancel: (
      (status === 'pending' && isInitiator)
      || status === 'accepted'
    ),
    canComplete: (
      status === 'accepted'
      && isSeller
      && ['available', 'reserved'].includes(productStatus)
    ),
    completionHint: status === 'accepted' && !isSeller
      ? '等待卖家确认面交完成'
      : '',
    createdAt: toIsoString(appointment.createdAt),
    updatedAt: toIsoString(appointment.updatedAt),
    acceptedAt: toIsoString(appointment.acceptedAt),
    rejectedAt: toIsoString(appointment.rejectedAt),
    cancelledAt: toIsoString(appointment.cancelledAt),
    completedAt: toIsoString(appointment.completedAt)
  };
}

function normalizeCursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const time = toIsoString(value.time);
  const id = normalizeString(value.id);
  return time && APPOINTMENT_ID_PATTERN.test(id)
    ? {
        time,
        date: new Date(time),
        id
      }
    : null;
}

function normalizeFilter(value) {
  const filter = normalizeString(value);
  return ['all', 'pending', 'accepted', 'ended'].includes(filter)
    ? filter
    : 'all';
}

function addStatusCondition(condition, filter) {
  if (filter === 'pending' || filter === 'accepted') {
    condition.status = filter;
  } else if (filter === 'ended') {
    condition.status = command.in(ENDED_STATUSES);
  }
  return condition;
}

function buildCursorCondition(identityField, openId, cursor, filter) {
  if (!cursor) {
    return addStatusCondition({
      [identityField]: openId,
      isDeleted: false
    }, filter);
  }
  return command.or([
    addStatusCondition({
      [identityField]: openId,
      isDeleted: false,
      updatedAt: command.lt(cursor.date)
    }, filter),
    addStatusCondition({
      [identityField]: openId,
      isDeleted: false,
      updatedAt: command.eq(cursor.date),
      _id: command.lt(cursor.id)
    }, filter)
  ]);
}

async function fetchBranch(identityField, openId, cursor, filter, pageSize) {
  const result = await appointments
    .where(buildCursorCondition(
      identityField,
      openId,
      cursor,
      filter
    ))
    .orderBy('updatedAt', 'desc')
    .orderBy('_id', 'desc')
    .limit(pageSize + 1)
    .get();
  return Array.isArray(result.data) ? result.data : [];
}

function compareByUpdatedAt(left, right) {
  const leftTime = new Date(toIsoString(left.updatedAt)).getTime();
  const rightTime = new Date(toIsoString(right.updatedAt)).getTime();
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return String(right._id || '').localeCompare(String(left._id || ''));
}

async function listMine(data, openId) {
  const pageSize = normalizePositiveInteger(
    data.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const filter = normalizeFilter(data.filter);
  const cursor = normalizeCursor(data.cursor);
  const [buyerList, sellerList] = await Promise.all([
    fetchBranch('buyerOpenid', openId, cursor, filter, pageSize),
    fetchBranch('sellerOpenid', openId, cursor, filter, pageSize)
  ]);
  const unique = new Map();
  [...buyerList, ...sellerList].forEach((record) => {
    unique.set(String(record._id || ''), record);
  });
  const ordered = [...unique.values()].sort(compareByUpdatedAt);
  const page = ordered.slice(0, pageSize);
  const list = await Promise.all(
    page.map((record) => enrichAppointment(record, openId))
  );
  const last = page[page.length - 1];
  return success({
    list,
    hasMore: ordered.length > pageSize
      || buyerList.length > pageSize
      || sellerList.length > pageSize,
    nextCursor: last
      ? {
          time: toIsoString(last.updatedAt),
          id: String(last._id || '')
        }
      : null
  });
}

async function detail(data, openId) {
  const appointmentId = normalizeString(data.appointmentId);
  if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效预约 ID');
  }
  const appointment = await getDocumentOrNull(
    appointments.doc(appointmentId)
  );
  if (!appointment || appointment.isDeleted === true) {
    return failure(
      ERROR_CODES.APPOINTMENT_NOT_FOUND,
      '预约不存在或已失效'
    );
  }
  if (!isAppointmentParticipant(appointment, openId)) {
    return failure(ERROR_CODES.FORBIDDEN, '无权查看该预约');
  }
  return success({
    appointment: await enrichAppointment(appointment, openId)
  });
}

async function getActiveByConversation(data, openId) {
  const requestedConversationId = normalizeString(data.conversationId);
  const productId = normalizeString(data.productId);
  if (
    !CONVERSATION_ID_PATTERN.test(requestedConversationId)
    || !PRODUCT_ID_PATTERN.test(productId)
  ) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效会话或商品 ID');
  }
  const resolved = await resolveConversation(requestedConversationId);
  if (!resolved) {
    return failure(
      ERROR_CODES.CONVERSATION_NOT_FOUND,
      '会话不存在或已失效'
    );
  }
  const { conversationId, conversation } = resolved;
  if (!getParticipantSlot(conversation, openId)) {
    return failure(ERROR_CODES.FORBIDDEN, '无权查看该会话预约');
  }
  const result = await appointments.where({
    conversationId,
    productId,
    status: command.in(ACTIVE_STATUSES),
    isDeleted: false
  }).orderBy('updatedAt', 'desc').limit(1).get();
  const appointment = Array.isArray(result.data) && result.data.length > 0
    ? result.data[0]
    : null;
  if (!appointment) {
    return success({ appointment: null });
  }
  if (!isAppointmentParticipant(appointment, openId)) {
    return failure(ERROR_CODES.FORBIDDEN, '无权查看该预约');
  }
  return success({
    appointment: await enrichAppointment(appointment, openId)
  });
}

function classifyFailure(error) {
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
  const data = request.data
    && typeof request.data === 'object'
    && !Array.isArray(request.data)
    ? request.data
    : {};
  const allowedActions = ['detail', 'listMine', 'getActiveByConversation'];
  if (!allowedActions.includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的预约查询操作');
  }

  const context = cloud.getWXContext();
  const openId = context && normalizeString(context.OPENID);
  const appId = context && normalizeString(context.APPID);
  if (!openId || !appId) {
    return failure(ERROR_CODES.UNAUTHORIZED, '请先登录后使用预约功能');
  }

  try {
    await assertActiveUser({ openId, appId });
    await maintenance.assertAvailable(db, businessError);
    if (action === 'detail') {
      return await detail(data, openId);
    }
    if (action === 'getActiveByConversation') {
      return await getActiveByConversation(data, openId);
    }
    return await listMine(data, openId);
  } catch (error) {
    if (error && error.businessCode) {
      return failure(error.businessCode, error.message);
    }
    console.error('[appointmentQuery] request failed', {
      action,
      code: error && (error.errCode || error.code || '')
    });
    const code = classifyFailure(error);
    return failure(
      code,
      code === ERROR_CODES.DATABASE_ERROR
        ? '预约数据暂不可用，请稍后重试'
        : '预约服务暂不可用，请稍后重试'
    );
  }
};

exports.__test = Object.freeze({
  createUserId,
  assertActiveUser
});
