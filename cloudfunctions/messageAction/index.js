const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const products = db.collection('products');
const conversations = db.collection('conversations');
const users = db.collection('users');
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const CLIENT_MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const NEW_CONVERSATION_STATUSES = new Set(['available', 'reserved']);
const MESSAGE_MAX_LENGTH = 500;
const LAST_MESSAGE_MAX_LENGTH = 80;

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
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  MESSAGE_EMPTY: 'MESSAGE_EMPTY',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
  MESSAGE_SEND_FAILED: 'MESSAGE_SEND_FAILED',
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

function createConversationId(productId, participantAOpenid, participantBOpenid) {
  return `c_${createDigest(
    `${productId}:${participantAOpenid}:${participantBOpenid}`
  )}`;
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

async function runTransaction(callback) {
  const response = await db.runTransaction(
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

function getParticipantSlot(conversation, openId) {
  if (conversation.participantAOpenid === openId) {
    return 'A';
  }
  if (conversation.participantBOpenid === openId) {
    return 'B';
  }
  return '';
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
  return {
    messageId: String(record._id || ''),
    senderPublicUserId: String(record.senderPublicUserId || ''),
    isMine: record.senderOpenid === openId,
    type: 'text',
    content: normalizeString(record.content),
    createdAt: toIsoString(record.createdAt)
  };
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
    status: normalizeString(product.status) || 'deleted'
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

  const sortedOpenids = [identity.openId, sellerOpenid].sort();
  const participantAOpenid = sortedOpenids[0];
  const participantBOpenid = sortedOpenids[1];
  const conversationId = createConversationId(
    productId,
    participantAOpenid,
    participantBOpenid
  );

  trace.step = 'conversation.read_existing';
  const existing = await getDocumentOrNull(conversations.doc(conversationId));
  if (existing) {
    if (!getParticipantSlot(existing, identity.openId)) {
      logProductLookupDiagnostic(
        productId,
        true,
        ERROR_CODES.FORBIDDEN
      );
      return failure(ERROR_CODES.FORBIDDEN, '无权访问该会话');
    }
    logProductLookupDiagnostic(productId, true, ERROR_CODES.OK);
    return success({
      conversationId,
      reused: true
    });
  }

  if (!NEW_CONVERSATION_STATUSES.has(product.status)) {
    logProductLookupDiagnostic(
      productId,
      true,
      ERROR_CODES.PRODUCT_UNAVAILABLE
    );
    return failure(
      ERROR_CODES.PRODUCT_UNAVAILABLE,
      '当前商品暂不能发起新会话'
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

  const participantAUserId = participantAOpenid === identity.openId
    ? currentUserId
    : sellerUserId;
  const participantBUserId = participantBOpenid === identity.openId
    ? currentUserId
    : sellerUserId;

  trace.step = 'conversation.begin_transaction';
  const result = await runTransaction(async (transaction) => {
    const document = transaction.collection('conversations').doc(conversationId);
    trace.step = 'conversation.transaction_read';
    const duplicate = await getDocumentOrNull(document);
    if (duplicate) {
      return {
        conversationId,
        reused: true
      };
    }

    trace.step = 'conversation.transaction_write';
    await document.set({
      data: {
        participantAOpenid,
        participantBOpenid,
        participantAUserId,
        participantBUserId,
        productId,
        productSnapshot: toProductSnapshot(product, productId),
        lastMessage: '',
        lastMessageType: '',
        lastMessageAt: db.serverDate(),
        lastSenderOpenid: '',
        participantAUnreadCount: 0,
        participantBUnreadCount: 0,
        createdAt: db.serverDate(),
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

async function sendTextMessage(data, openId, trace) {
  trace.step = 'send.validate';
  const conversationId = normalizeConversationId(data.conversationId);
  const clientMessageId = normalizeClientMessageId(data.clientMessageId);
  const content = typeof data.content === 'string' ? data.content.trim() : '';
  if (!conversationId || !clientMessageId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '消息参数不正确');
  }
  if (!content) {
    return failure(ERROR_CODES.MESSAGE_EMPTY, '消息内容不能为空');
  }
  if (content.length > MESSAGE_MAX_LENGTH) {
    return failure(
      ERROR_CODES.MESSAGE_TOO_LONG,
      `消息不能超过 ${MESSAGE_MAX_LENGTH} 个字`
    );
  }

  const messageId = createMessageId(
    conversationId,
    openId,
    clientMessageId
  );
  trace.step = 'send.begin_transaction';
  const result = await runTransaction(async (transaction) => {
    const conversationDocument = transaction
      .collection('conversations')
      .doc(conversationId);
    trace.step = 'send.read_conversation';
    const conversation = await getDocumentOrNull(conversationDocument);
    if (!conversation) {
      businessError(
        ERROR_CODES.CONVERSATION_NOT_FOUND,
        '会话不存在或已失效'
      );
    }

    const slot = getParticipantSlot(conversation, openId);
    if (!slot) {
      businessError(ERROR_CODES.FORBIDDEN, '无权向该会话发送消息');
    }

    const productDocument = transaction
      .collection('products')
      .doc(conversation.productId);
    trace.step = 'send.read_product';
    const product = await getDocumentOrNull(productDocument);
    if (!product || product.status === 'deleted') {
      businessError(
        ERROR_CODES.PRODUCT_UNAVAILABLE,
        '商品已删除，仅可查看历史消息'
      );
    }

    const messageDocument = transaction.collection('messages').doc(messageId);
    trace.step = 'send.read_message';
    const existingMessage = await getDocumentOrNull(messageDocument);
    if (existingMessage) {
      return {
        message: toSafeMessage(existingMessage, openId),
        reused: true
      };
    }

    const senderPublicUserId = slot === 'A'
      ? conversation.participantAUserId
      : conversation.participantBUserId;
    trace.step = 'send.write_message';
    await messageDocument.set({
      data: {
        conversationId,
        senderOpenid: openId,
        senderPublicUserId,
        type: 'text',
        content,
        clientMessageId,
        createdAt: db.serverDate()
      }
    });

    const updateData = {
      productSnapshot: toProductSnapshot(product, conversation.productId),
      lastMessage: content.slice(0, LAST_MESSAGE_MAX_LENGTH),
      lastMessageType: 'text',
      lastMessageAt: db.serverDate(),
      lastSenderOpenid: openId,
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
    trace.step = 'send.update_conversation';
    await conversationDocument.update({
      data: updateData
    });

    return {
      message: {
        messageId,
        senderPublicUserId,
        isMine: true,
        type: 'text',
        content,
        createdAt: new Date().toISOString()
      },
      reused: false
    };
  });
  return success(result);
}

async function markConversationRead(data, openId, trace) {
  trace.step = 'read.validate';
  const conversationId = normalizeConversationId(data.conversationId);
  if (!conversationId) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '缺少有效会话 ID');
  }

  trace.step = 'read.begin_transaction';
  const result = await runTransaction(async (transaction) => {
    const document = transaction.collection('conversations').doc(conversationId);
    trace.step = 'read.read_conversation';
    const conversation = await getDocumentOrNull(document);
    if (!conversation) {
      businessError(
        ERROR_CODES.CONVERSATION_NOT_FOUND,
        '会话不存在或已失效'
      );
    }
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
      conversationId,
      unreadCount: 0,
      reused: currentUnread === 0
    };
  });
  return success(result);
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
    'markConversationRead'
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
    step: 'start',
    productId: '',
    productFound: false
  };
  try {
    if (action === 'createOrGetConversation') {
      return await createOrGetConversation(data, {
        openId,
        appId
      }, trace);
    }
    if (action === 'sendTextMessage') {
      return await sendTextMessage(data, openId, trace);
    }
    return await markConversationRead(data, openId, trace);
  } catch (error) {
    if (error && error.businessCode) {
      return failure(error.businessCode, error.message);
    }
    const code = classifyFailure(error);
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
    return failure(
      code,
      code === ERROR_CODES.DATABASE_ERROR
        ? '消息数据暂不可用，请稍后重试'
        : '消息服务暂不可用，请稍后重试'
    );
  }
};
