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
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const CLIENT_MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const NEW_CONVERSATION_STATUSES = new Set(['available', 'reserved']);
const MESSAGE_TYPES = new Set([
  'text',
  'voice',
  'image',
  'location',
  'product'
]);
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

function createConversationId(productId, participantAOpenid, participantBOpenid) {
  return `c_${createDigest(
    `${productId}:${participantAOpenid}:${participantBOpenid}`
  )}`;
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
  const type = normalizeMessageType(record.type) || 'text';
  const message = {
    messageId: String(record._id || ''),
    senderPublicUserId: String(record.senderPublicUserId || ''),
    isMine: record.senderOpenid === openId,
    type,
    createdAt: toIsoString(record.createdAt)
  };
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
  assertCanCreateSchoolRelation(currentUser, identity.openId, product);

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

    trace.step = 'conversation.transaction_read_product';
    const currentProduct = await getDocumentOrNull(
      transaction.collection('products').doc(productId)
    );
    trace.step = 'conversation.transaction_read_user';
    const transactionUser = await getDocumentOrNull(
      transaction.collection('users').doc(currentUserId)
    );
    if (!currentProduct || !NEW_CONVERSATION_STATUSES.has(currentProduct.status)) {
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
        participantAOpenid,
        participantBOpenid,
        participantAUserId,
        participantBUserId,
        productId,
        productSnapshot: toProductSnapshot(currentProduct, productId),
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

async function sendMessage(data, openId, trace, forcedType = '') {
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

    const messageDocument = transaction.collection('messages').doc(messageId);
    trace.step = 'send.read_message';
    const existingMessage = await getDocumentOrNull(messageDocument);
    if (existingMessage) {
      return {
        message: toSafeMessage(existingMessage, openId),
        reused: true
      };
    }

    const productDocument = transaction
      .collection('products')
      .doc(conversation.productId);
    trace.step = 'send.read_product';
    const conversationProduct = await getDocumentOrNull(productDocument);
    if (!conversationProduct || conversationProduct.status === 'deleted') {
      businessError(
        ERROR_CODES.PRODUCT_UNAVAILABLE,
        '商品已删除，仅可查看历史消息'
      );
    }

    // clientMessageId is a first-write-wins idempotency key. Payload-specific
    // validation intentionally happens after the existing-message lookup so a
    // retry cannot mutate the committed message or advance unread/summary state.
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
      conversationId,
      senderOpenid: openId,
      senderPublicUserId,
      type,
      clientMessageId,
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
      if (productId === conversation.productId) {
        businessError(
          ERROR_CODES.INVALID_PRODUCT,
          '请选择当前会话商品以外的商品'
        );
      }
      trace.step = 'send.read_shared_product';
      const selectedProduct = await getDocumentOrNull(
        transaction.collection('products').doc(productId)
      );
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

    trace.step = 'send.write_message';
    await messageDocument.set({ data: messageData });

    const updateData = {
      productSnapshot: toProductSnapshot(
        conversationProduct,
        conversation.productId
      ),
      lastMessage: type === 'text'
        ? content.slice(0, LAST_MESSAGE_MAX_LENGTH)
        : LAST_MESSAGE_SUMMARIES[type],
      lastMessageType: type,
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
      message: toSafeMessage({
        _id: messageId,
        ...messageData,
        createdAt: new Date().toISOString()
      }, openId),
      reused: false
    };
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
    'sendMessage',
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
    if (action === 'sendMessage') {
      return await sendMessage(data, openId, trace);
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

exports.__test = Object.freeze({
  canCreateSchoolRelation,
  assertCanCreateSchoolRelation,
  createUserId,
  createConversationId
});
