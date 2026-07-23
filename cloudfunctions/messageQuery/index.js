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
const MAX_PAGE_SIZE = 30;
const DEFAULT_CONVERSATION_PAGE_SIZE = 10;
const DEFAULT_MESSAGE_PAGE_SIZE = 20;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
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
    status
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
    lastMessageType: conversation.lastMessageType === 'text' ? 'text' : '',
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
  return {
    messageId: String(record._id || ''),
    senderPublicUserId: String(record.senderPublicUserId || ''),
    isMine: record.senderOpenid === openId,
    type: 'text',
    content: normalizeString(record.content),
    createdAt: toIsoString(record.createdAt)
  };
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
    'listMessages'
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
