const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const conversations = db.collection('conversations');
const users = db.collection('users');
const products = db.collection('products');
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const MESSAGE_TYPES = new Set([
  'text',
  'voice',
  'image',
  'location',
  'product',
  'system'
]);
const CONVERSATION_PRODUCT_STATUSES = [
  'available',
  'reserved',
  'sold'
];
const MAX_PAGE_SIZE = 30;
const DEFAULT_CONVERSATION_PAGE_SIZE = 10;
const DEFAULT_MESSAGE_PAGE_SIZE = 20;
const DEFAULT_PRODUCT_PAGE_SIZE = 8;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_OWNER_SCOPE: 'INVALID_OWNER_SCOPE',
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

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeConversationId(value) {
  const conversationId = normalizeString(value);
  return CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : '';
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

function normalizeCursor(value, idPattern) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const time = toIsoString(value.time);
  const id = normalizeString(value.id);
  return time && idPattern.test(id)
    ? {
        time,
        date: new Date(time),
        id
      }
    : null;
}

function normalizeProductCursor(value) {
  return normalizeCursor(value, PRODUCT_ID_PATTERN);
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

function compareByTimeAndId(left, right, field) {
  const leftTime = new Date(left[field]).getTime();
  const rightTime = new Date(right[field]).getTime();
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return String(right._id || '').localeCompare(String(left._id || ''));
}

function buildCursorCondition(identityField, openId, timeField, cursor) {
  if (!cursor) {
    return {
      [identityField]: openId
    };
  }
  return command.or([
    {
      [identityField]: openId,
      [timeField]: command.lt(cursor.date)
    },
    {
      [identityField]: openId,
      [timeField]: command.eq(cursor.date),
      _id: command.lt(cursor.id)
    }
  ]);
}

async function fetchConversationBranch(
  identityField,
  openId,
  cursor,
  pageSize
) {
  const result = await conversations
    .where(buildCursorCondition(
      identityField,
      openId,
      'lastMessageAt',
      cursor
    ))
    .orderBy('lastMessageAt', 'desc')
    .orderBy('_id', 'desc')
    .limit(pageSize + 1)
    .get();
  return Array.isArray(result.data) ? result.data : [];
}

function safeUser(record, publicUserId) {
  const nickname = normalizeString(record && record.nickname) || '即出用户';
  return {
    publicUserId,
    nickname,
    avatarUrl: normalizeString(record && record.avatarUrl),
    campus: normalizeString(record && record.campus) || '校园信息待完善'
  };
}

function safeProduct(record, snapshot) {
  const source = record || snapshot || {};
  const productId = normalizeString(
    source._id || source.productId || (snapshot && snapshot.productId)
  );
  const status = normalizeString(source.status) || 'deleted';
  return {
    productId,
    title: normalizeString(source.title) || '商品已不可用',
    coverImage: normalizeString(source.coverImage),
    price: Number.isFinite(Number(source.price)) && Number(source.price) >= 0
      ? Number(source.price)
      : 0,
    status,
    schoolId: normalizeString(source.schoolId),
    schoolName: normalizeString(source.schoolName),
    location: normalizeString(source.location)
  };
}

async function enrichConversation(conversation, openId) {
  const slot = getParticipantSlot(conversation, openId);
  const otherUserId = slot === 'A'
    ? normalizeString(conversation.participantBUserId)
    : normalizeString(conversation.participantAUserId);
  const unreadCount = slot === 'A'
    ? normalizeCount(conversation.participantAUnreadCount)
    : normalizeCount(conversation.participantBUnreadCount);
  const [otherUser, product] = await Promise.all([
    otherUserId
      ? getDocumentOrNull(users.doc(otherUserId))
      : Promise.resolve(null),
    conversation.productId
      ? getDocumentOrNull(products.doc(conversation.productId))
      : Promise.resolve(null)
  ]);
  const safeProductValue = safeProduct(product, conversation.productSnapshot);
  return {
    conversationId: String(conversation._id || ''),
    otherUser: safeUser(otherUser, otherUserId),
    product: safeProductValue,
    lastMessage: normalizeString(conversation.lastMessage),
    lastMessageType: MESSAGE_TYPES.has(conversation.lastMessageType)
      ? conversation.lastMessageType
      : '',
    lastMessageAt: toIsoString(conversation.lastMessageAt),
    unreadCount,
    canSend: Boolean(product && product.status !== 'deleted')
  };
}

async function listConversations(data, openId) {
  const pageSize = normalizePositiveInteger(
    data.pageSize,
    DEFAULT_CONVERSATION_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const cursor = normalizeCursor(data.cursor, CONVERSATION_ID_PATTERN);
  const [participantAList, participantBList] = await Promise.all([
    fetchConversationBranch(
      'participantAOpenid',
      openId,
      cursor,
      pageSize
    ),
    fetchConversationBranch(
      'participantBOpenid',
      openId,
      cursor,
      pageSize
    )
  ]);
  const unique = new Map();
  [...participantAList, ...participantBList].forEach((record) => {
    unique.set(String(record._id || ''), record);
  });
  const ordered = [...unique.values()]
    .sort((left, right) => compareByTimeAndId(
      left,
      right,
      'lastMessageAt'
    ));
  const page = ordered.slice(0, pageSize);
  const list = await Promise.all(
    page.map((record) => enrichConversation(record, openId))
  );
  const last = page[page.length - 1];
  return success({
    list,
    hasMore: ordered.length > pageSize
      || participantAList.length > pageSize
      || participantBList.length > pageSize,
    nextCursor: last
      ? {
          time: toIsoString(last.lastMessageAt),
          id: String(last._id || '')
        }
      : null
  });
}

async function getConversationRecord(conversationId, openId) {
  const conversation = await getDocumentOrNull(
    conversations.doc(conversationId)
  );
  if (!conversation) {
    return {
      error: failure(
        ERROR_CODES.CONVERSATION_NOT_FOUND,
        '会话不存在或已失效'
      )
    };
  }
  if (!getParticipantSlot(conversation, openId)) {
    return {
      error: failure(ERROR_CODES.FORBIDDEN, '无权访问该会话')
    };
  }
  return { conversation };
}

async function getConversation(data, openId) {
  const conversationId = normalizeConversationId(data.conversationId);
  if (!conversationId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '缺少有效会话 ID');
  }
  const result = await getConversationRecord(conversationId, openId);
  if (result.error) {
    return result.error;
  }
  return success({
    conversation: await enrichConversation(result.conversation, openId)
  });
}

function toSafeMessage(record, openId) {
  const type = MESSAGE_TYPES.has(record.type) ? record.type : 'unsupported';
  const message = {
    messageId: String(record._id || ''),
    senderPublicUserId: String(record.senderPublicUserId || ''),
    isMine: record.senderOpenid === openId,
    type,
    createdAt: toIsoString(record.createdAt)
  };
  if (type === 'text') {
    message.content = normalizeString(record.content);
  } else if (type === 'system') {
    message.eventType = normalizeString(record.eventType);
    message.appointmentId = normalizeString(record.appointmentId);
    message.content = normalizeString(record.content);
  } else if (type === 'voice' || type === 'image') {
    const media = record.media && typeof record.media === 'object'
      ? record.media
      : {};
    message.media = {
      fileId: normalizeString(media.fileId),
      durationMs: normalizeCount(media.durationMs),
      size: normalizeCount(media.size),
      format: type === 'voice' ? 'mp3' : '',
      width: type === 'image' ? normalizeCount(media.width) : 0,
      height: type === 'image' ? normalizeCount(media.height) : 0
    };
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
  } else {
    message.content = '当前版本暂不支持此消息类型';
  }
  return message;
}

async function listMessages(data, openId) {
  const conversationId = normalizeConversationId(data.conversationId);
  if (!conversationId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '缺少有效会话 ID');
  }
  const conversationResult = await getConversationRecord(
    conversationId,
    openId
  );
  if (conversationResult.error) {
    return conversationResult.error;
  }

  const pageSize = normalizePositiveInteger(
    data.pageSize,
    DEFAULT_MESSAGE_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const cursor = normalizeCursor(data.cursor, /^m_[a-f0-9]{64}$/);
  const condition = buildCursorCondition(
    'conversationId',
    conversationId,
    'createdAt',
    cursor
  );
  const result = await db.collection('messages')
    .where(condition)
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'desc')
    .limit(pageSize + 1)
    .get();
  const records = Array.isArray(result.data)
    ? result.data.slice(0, pageSize)
    : [];
  const last = records[records.length - 1];
  return success({
    list: records.map((record) => toSafeMessage(record, openId)),
    hasMore: Array.isArray(result.data) && result.data.length > pageSize,
    nextCursor: last
      ? {
          time: toIsoString(last.createdAt),
          id: String(last._id || '')
        }
      : null
  });
}

function toSelectableProduct(record, ownerPublicUserId, ownerScope) {
  return {
    productId: String(record._id || ''),
    title: normalizeString(record.title) || '未命名闲置',
    coverImage: normalizeString(record.coverImage)
      || (
        Array.isArray(record.images)
        ? normalizeString(record.images[0])
        : ''
      ),
    price: Number.isFinite(Number(record.price)) && Number(record.price) >= 0
      ? Number(record.price)
      : 0,
    status: normalizeString(record.status),
    ownerPublicUserId,
    ownerScope
  };
}

function buildConversationProductCondition(ownerOpenId, cursor) {
  const base = {
    sellerOpenid: ownerOpenId,
    status: command.in(CONVERSATION_PRODUCT_STATUSES)
  };
  if (!cursor) {
    return base;
  }
  return command.or([
    {
      ...base,
      createdAt: command.lt(cursor.date)
    },
    {
      ...base,
      createdAt: command.eq(cursor.date),
      _id: command.gt(cursor.id)
    }
  ]);
}

async function listConversationProducts(data, openId) {
  const conversationId = normalizeConversationId(data.conversationId);
  const ownerScope = normalizeString(data.ownerScope);
  if (!conversationId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '缺少有效会话 ID');
  }
  if (!['self', 'other'].includes(ownerScope)) {
    return failure(ERROR_CODES.INVALID_OWNER_SCOPE, '商品归属筛选不正确');
  }
  const conversationResult = await getConversationRecord(
    conversationId,
    openId
  );
  if (conversationResult.error) {
    return conversationResult.error;
  }
  const conversation = conversationResult.conversation;
  const currentSlot = getParticipantSlot(conversation, openId);
  const targetSlot = ownerScope === 'self'
    ? currentSlot
    : currentSlot === 'A' ? 'B' : 'A';
  const ownerOpenId = normalizeString(
    conversation[`participant${targetSlot}Openid`]
  );
  const ownerPublicUserId = normalizeString(
    conversation[`participant${targetSlot}UserId`]
  );
  if (
    !ownerOpenId
    || !PUBLIC_USER_ID_PATTERN.test(ownerPublicUserId)
  ) {
    return failure(ERROR_CODES.FORBIDDEN, '无法读取该参与者的商品');
  }

  const pageSize = normalizePositiveInteger(
    data.pageSize,
    DEFAULT_PRODUCT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const cursor = normalizeProductCursor(data.cursor);
  const result = await products
    .where(buildConversationProductCondition(ownerOpenId, cursor))
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'asc')
    .limit(pageSize + 2)
    .get();
  const records = Array.isArray(result.data) ? result.data : [];
  const visible = records
    .filter((record) => (
      String(record._id || '') !== normalizeString(conversation.productId)
      && CONVERSATION_PRODUCT_STATUSES.includes(record.status)
      && (
        !normalizeString(record.sellerId)
        || normalizeString(record.sellerId) === ownerPublicUserId
      )
    ));
  const page = visible.slice(0, pageSize);
  const last = page[page.length - 1];
  const ownerUser = await getDocumentOrNull(users.doc(ownerPublicUserId));
  return success({
    ownerScope,
    owner: safeUser(ownerUser, ownerPublicUserId),
    list: page.map((record) => toSelectableProduct(
      record,
      ownerPublicUserId,
      ownerScope
    )),
    hasMore: visible.length > pageSize || records.length > pageSize + 1,
    nextCursor: last
      ? {
          time: toIsoString(last.createdAt),
          id: String(last._id || '')
        }
      : null
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
  const allowedActions = [
    'listConversations',
    'getConversation',
    'listMessages',
    'listConversationProducts'
  ];
  if (!allowedActions.includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的消息查询操作');
  }

  const context = cloud.getWXContext();
  const openId = context && normalizeString(context.OPENID);
  if (!openId) {
    return failure(ERROR_CODES.LOGIN_REQUIRED, '请先登录后使用消息功能');
  }

  try {
    if (action === 'listConversations') {
      return await listConversations(data, openId);
    }
    if (action === 'getConversation') {
      return await getConversation(data, openId);
    }
    if (action === 'listConversationProducts') {
      return await listConversationProducts(data, openId);
    }
    return await listMessages(data, openId);
  } catch (error) {
    console.error('[messageQuery] request failed', {
      action,
      code: error && (error.errCode || error.code || '')
    });
    const code = classifyFailure(error);
    return failure(
      code,
      code === ERROR_CODES.DATABASE_ERROR
        ? '消息数据暂不可用，请稍后重试'
        : '消息服务暂不可用，请稍后重试'
    );
  }
};
