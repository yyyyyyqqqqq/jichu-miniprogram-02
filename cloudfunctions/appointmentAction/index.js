const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const appointments = db.collection('appointments');
const conversations = db.collection('conversations');
const products = db.collection('products');

const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const APPOINTMENT_ID_PATTERN = /^a_[a-f0-9]{64}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const ACTIVE_STATUSES = ['pending', 'accepted'];
const CREATABLE_PRODUCT_STATUS = 'available';
const COMPLETABLE_PRODUCT_STATUSES = new Set(['available', 'reserved']);
const NOTE_MAX_LENGTH = 200;
const LOCATION_NAME_MAX_LENGTH = 80;
const LOCATION_ADDRESS_MAX_LENGTH = 120;
const MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;
const LAST_MESSAGE_MAX_LENGTH = 80;

const EVENT_CONTENT = {
  appointment_created: '发起了面交预约',
  appointment_accepted: '接受了面交预约',
  appointment_rejected: '拒绝了面交预约',
  appointment_cancelled: '取消了面交预约',
  appointment_completed: '已确认完成面交',
  appointment_auto_cancelled: '商品已完成面交，本预约已自动关闭'
};

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  SELF_APPOINTMENT_NOT_ALLOWED: 'SELF_APPOINTMENT_NOT_ALLOWED',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  APPOINTMENT_NOT_FOUND: 'APPOINTMENT_NOT_FOUND',
  APPOINTMENT_ALREADY_EXISTS: 'APPOINTMENT_ALREADY_EXISTS',
  INVALID_APPOINTMENT_TIME: 'INVALID_APPOINTMENT_TIME',
  INVALID_APPOINTMENT_LOCATION: 'INVALID_APPOINTMENT_LOCATION',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  ACTION_NOT_ALLOWED: 'ACTION_NOT_ALLOWED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
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

function createDigest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createAppointmentId(conversationId, openId, idempotencyKey) {
  return `a_${createDigest(
    `${conversationId}:${openId}:${idempotencyKey}`
  )}`;
}

function createSystemMessageId(appointmentId, eventType) {
  return `m_${createDigest(
    `${appointmentId}:system:${eventType}`
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

function getPublicUserId(conversation, openId) {
  const slot = getParticipantSlot(conversation, openId);
  if (slot === 'A') {
    return normalizeString(conversation.participantAUserId);
  }
  if (slot === 'B') {
    return normalizeString(conversation.participantBUserId);
  }
  return '';
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function validateIdempotencyKey(value) {
  const key = normalizeString(value);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    businessError(ERROR_CODES.INVALID_PARAMS, '缺少有效请求 ID');
  }
  return key;
}

function validateScheduledAt(value) {
  const date = new Date(value);
  const time = date.getTime();
  const now = Date.now();
  if (
    Number.isNaN(time)
    || time <= now
    || time > now + MAX_FUTURE_MS
  ) {
    businessError(
      ERROR_CODES.INVALID_APPOINTMENT_TIME,
      '面交时间必须在未来 30 天内'
    );
  }
  return date;
}

function validateLocation(value) {
  const location = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const name = normalizeString(location.name);
  const address = normalizeString(location.address);
  const latitude = typeof location.latitude === 'number'
    ? location.latitude
    : NaN;
  const longitude = typeof location.longitude === 'number'
    ? location.longitude
    : NaN;
  if (
    !name
    || name.length > LOCATION_NAME_MAX_LENGTH
    || !address
    || address.length > LOCATION_ADDRESS_MAX_LENGTH
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
    || (latitude === 0 && longitude === 0)
  ) {
    businessError(
      ERROR_CODES.INVALID_APPOINTMENT_LOCATION,
      '请选择有效的面交地点'
    );
  }
  return {
    name,
    address,
    latitude,
    longitude
  };
}

function validateNote(value) {
  const note = typeof value === 'string' ? value.trim() : '';
  if (note.length > NOTE_MAX_LENGTH) {
    businessError(
      ERROR_CODES.INVALID_PARAMS,
      `预约备注不能超过 ${NOTE_MAX_LENGTH} 个字`
    );
  }
  return note;
}

function getSellerOpenid(product) {
  return normalizeString(product && product.sellerOpenid);
}

function assertConversationParticipants(conversation, openId, sellerOpenid) {
  if (!conversation) {
    businessError(
      ERROR_CODES.CONVERSATION_NOT_FOUND,
      '会话不存在或已失效'
    );
  }
  if (!getParticipantSlot(conversation, openId)) {
    businessError(ERROR_CODES.FORBIDDEN, '无权在该会话发起预约');
  }
  if (!getParticipantSlot(conversation, sellerOpenid)) {
    businessError(ERROR_CODES.FORBIDDEN, '会话与商品卖家不匹配');
  }
}

function buildAppointmentRoles(conversation, sellerOpenid) {
  const buyerOpenid = conversation.participantAOpenid === sellerOpenid
    ? normalizeString(conversation.participantBOpenid)
    : normalizeString(conversation.participantAOpenid);
  if (!buyerOpenid || buyerOpenid === sellerOpenid) {
    businessError(
      ERROR_CODES.SELF_APPOINTMENT_NOT_ALLOWED,
      '不能为自己的商品创建面交预约'
    );
  }
  const roles = {
    buyerOpenid,
    sellerOpenid,
    buyerUserId: getPublicUserId(conversation, buyerOpenid),
    sellerUserId: getPublicUserId(conversation, sellerOpenid)
  };
  if (
    !PUBLIC_USER_ID_PATTERN.test(roles.buyerUserId)
    || !PUBLIC_USER_ID_PATTERN.test(roles.sellerUserId)
  ) {
    businessError(
      ERROR_CODES.FORBIDDEN,
      '会话参与者资料不可用'
    );
  }
  return roles;
}

async function writeSystemMessage(
  transaction,
  conversation,
  appointmentId,
  eventType,
  actorOpenid
) {
  const content = EVENT_CONTENT[eventType];
  const messageId = createSystemMessageId(appointmentId, eventType);
  const clientMessageId = `sys_${createDigest(
    `${appointmentId}:${eventType}`
  ).slice(0, 64)}`;
  const messageDocument = transaction.collection('messages').doc(messageId);
  const existing = await getDocumentOrNull(messageDocument);
  if (existing) {
    return {
      messageId,
      reused: true
    };
  }

  const actorPublicUserId = getPublicUserId(conversation, actorOpenid);
  await messageDocument.set({
    data: {
      conversationId: String(conversation._id || ''),
      senderOpenid: actorOpenid,
      senderPublicUserId: actorPublicUserId,
      type: 'system',
      eventType,
      appointmentId,
      productId: normalizeString(conversation.productId),
      content,
      clientMessageId,
      createdAt: db.serverDate()
    }
  });

  const actorSlot = getParticipantSlot(conversation, actorOpenid);
  const updateData = {
    lastMessage: content.slice(0, LAST_MESSAGE_MAX_LENGTH),
    lastMessageType: 'system',
    lastMessageAt: db.serverDate(),
    lastSenderOpenid: actorOpenid,
    updatedAt: db.serverDate()
  };
  if (actorSlot === 'A') {
    updateData.participantBUnreadCount = normalizeCount(
      conversation.participantBUnreadCount
    ) + 1;
  } else {
    updateData.participantAUnreadCount = normalizeCount(
      conversation.participantAUnreadCount
    ) + 1;
  }
  await transaction.collection('conversations')
    .doc(String(conversation._id || ''))
    .update({ data: updateData });

  return {
    messageId,
    reused: false
  };
}

async function findActiveAppointment(productId, buyerOpenid, sellerOpenid) {
  const result = await appointments.where({
    productId,
    buyerOpenid,
    sellerOpenid,
    activeKey: 'active'
  }).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0
    ? result.data[0]
    : null;
}

async function createAppointment(data, identity) {
  const conversationId = normalizeString(data.conversationId);
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    businessError(ERROR_CODES.INVALID_PARAMS, '缺少有效会话 ID');
  }
  const idempotencyKey = validateIdempotencyKey(data.idempotencyKey);
  const scheduledAt = validateScheduledAt(data.scheduledAt);
  const location = validateLocation(data.location);
  const note = validateNote(data.note);
  const appointmentId = createAppointmentId(
    conversationId,
    identity.openId,
    idempotencyKey
  );

  const existing = await getDocumentOrNull(appointments.doc(appointmentId));
  if (existing) {
    if (
      existing.initiatorOpenid !== identity.openId
      || existing.createIdempotencyKey !== idempotencyKey
    ) {
      businessError(
        ERROR_CODES.IDEMPOTENCY_CONFLICT,
        '请求 ID 已用于其他预约'
      );
    }
    return success({
      appointmentId,
      status: existing.status,
      reused: true
    });
  }

  const conversation = await getDocumentOrNull(
    conversations.doc(conversationId)
  );
  if (!conversation) {
    businessError(
      ERROR_CODES.CONVERSATION_NOT_FOUND,
      '会话不存在或已失效'
    );
  }
  if (!getParticipantSlot(conversation, identity.openId)) {
    businessError(ERROR_CODES.FORBIDDEN, '无权在该会话发起预约');
  }
  const productId = normalizeString(conversation.productId);
  const product = productId
    ? await getDocumentOrNull(products.doc(productId))
    : null;
  if (!product) {
    businessError(ERROR_CODES.PRODUCT_NOT_FOUND, '商品已不存在');
  }
  if (product.status !== CREATABLE_PRODUCT_STATUS) {
    businessError(
      ERROR_CODES.PRODUCT_UNAVAILABLE,
      '当前商品不能创建面交预约'
    );
  }
  const sellerOpenid = getSellerOpenid(product);
  if (!sellerOpenid) {
    businessError(ERROR_CODES.PRODUCT_UNAVAILABLE, '商品卖家信息不可用');
  }
  assertConversationParticipants(conversation, identity.openId, sellerOpenid);
  const roles = buildAppointmentRoles(conversation, sellerOpenid);
  const active = await findActiveAppointment(
    productId,
    roles.buyerOpenid,
    roles.sellerOpenid
  );
  if (active) {
    businessError(
      ERROR_CODES.APPOINTMENT_ALREADY_EXISTS,
      '当前商品已有进行中的面交预约'
    );
  }

  const result = await runTransaction(async (transaction) => {
    const appointmentDocument = transaction
      .collection('appointments')
      .doc(appointmentId);
    const duplicate = await getDocumentOrNull(appointmentDocument);
    if (duplicate) {
      return {
        appointmentId,
        status: duplicate.status,
        reused: true
      };
    }

    const currentConversation = await getDocumentOrNull(
      transaction.collection('conversations').doc(conversationId)
    );
    const currentProduct = await getDocumentOrNull(
      transaction.collection('products').doc(productId)
    );
    if (!currentProduct) {
      businessError(ERROR_CODES.PRODUCT_NOT_FOUND, '商品已不存在');
    }
    if (currentProduct.status !== CREATABLE_PRODUCT_STATUS) {
      businessError(
        ERROR_CODES.PRODUCT_UNAVAILABLE,
        '当前商品不能创建面交预约'
      );
    }
    const currentSellerOpenid = getSellerOpenid(currentProduct);
    assertConversationParticipants(
      currentConversation,
      identity.openId,
      currentSellerOpenid
    );
    if (
      currentConversation.productId !== productId
      || currentSellerOpenid !== roles.sellerOpenid
    ) {
      businessError(ERROR_CODES.FORBIDDEN, '会话与商品不匹配');
    }

    await appointmentDocument.set({
      data: {
        productId,
        conversationId,
        buyerOpenid: roles.buyerOpenid,
        sellerOpenid: roles.sellerOpenid,
        buyerUserId: roles.buyerUserId,
        sellerUserId: roles.sellerUserId,
        initiatorOpenid: identity.openId,
        scheduledAt,
        location,
        note,
        status: 'pending',
        activeKey: 'active',
        createIdempotencyKey: idempotencyKey,
        lastActionType: 'create',
        lastActionIdempotencyKey: idempotencyKey,
        lastActionBy: identity.openId,
        isDeleted: false,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        acceptedAt: null,
        rejectedAt: null,
        cancelledAt: null,
        completedAt: null,
        cancelReason: ''
      }
    });
    await writeSystemMessage(
      transaction,
      currentConversation,
      appointmentId,
      'appointment_created',
      identity.openId
    );
    return {
      appointmentId,
      status: 'pending',
      reused: false
    };
  });
  return success(result);
}

function assertAppointmentParticipant(appointment, openId) {
  if (
    appointment.buyerOpenid !== openId
    && appointment.sellerOpenid !== openId
  ) {
    businessError(ERROR_CODES.FORBIDDEN, '无权操作该预约');
  }
}

function buildClosedActiveKey(appointmentId) {
  return `closed:${appointmentId}`;
}

function getTransitionDefinition(action) {
  const definitions = {
    accept: {
      from: 'pending',
      to: 'accepted',
      timestampField: 'acceptedAt',
      eventType: 'appointment_accepted'
    },
    reject: {
      from: 'pending',
      to: 'rejected',
      timestampField: 'rejectedAt',
      eventType: 'appointment_rejected'
    },
    cancel: {
      from: ['pending', 'accepted'],
      to: 'cancelled',
      timestampField: 'cancelledAt',
      eventType: 'appointment_cancelled'
    }
  };
  return definitions[action];
}

function assertTransitionPermission(action, appointment, openId) {
  if (
    (action === 'accept' || action === 'reject')
    && appointment.initiatorOpenid === openId
  ) {
    businessError(
      ERROR_CODES.ACTION_NOT_ALLOWED,
      '发起方不能处理自己的待确认预约'
    );
  }
  if (
    action === 'cancel'
    && appointment.status === 'pending'
    && appointment.initiatorOpenid !== openId
  ) {
    businessError(
      ERROR_CODES.ACTION_NOT_ALLOWED,
      '只有发起方可以取消待确认预约'
    );
  }
}

async function hasOtherAcceptedAppointment(
  transaction,
  productId,
  appointmentId
) {
  const result = await transaction.collection('appointments').where({
    productId,
    status: 'accepted'
  }).limit(CLEANUP_BATCH_SIZE).get();
  const records = result && Array.isArray(result.data) ? result.data : [];
  return records.some((record) => (
    record
    && record.isDeleted !== true
    && normalizeString(record._id) !== appointmentId
  ));
}

async function transitionAppointment(action, data, openId) {
  const appointmentId = normalizeString(data.appointmentId);
  if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
    businessError(ERROR_CODES.INVALID_PARAMS, '缺少有效预约 ID');
  }
  const idempotencyKey = validateIdempotencyKey(data.idempotencyKey);
  const definition = getTransitionDefinition(action);

  const result = await runTransaction(async (transaction) => {
    const appointmentDocument = transaction
      .collection('appointments')
      .doc(appointmentId);
    const appointment = await getDocumentOrNull(appointmentDocument);
    if (!appointment || appointment.isDeleted === true) {
      businessError(
        ERROR_CODES.APPOINTMENT_NOT_FOUND,
        '预约不存在或已失效'
      );
    }
    assertAppointmentParticipant(appointment, openId);

    if (
      appointment.lastActionIdempotencyKey === idempotencyKey
      && appointment.lastActionType !== action
    ) {
      businessError(
        ERROR_CODES.IDEMPOTENCY_CONFLICT,
        '请求 ID 已用于其他预约操作'
      );
    }
    if (
      appointment.status === definition.to
      && appointment.lastActionType === action
    ) {
      let productChanged = false;
      if (action === 'accept') {
        const productDocument = transaction
          .collection('products')
          .doc(appointment.productId);
        const product = await getDocumentOrNull(productDocument);
        if (!product) {
          businessError(ERROR_CODES.PRODUCT_NOT_FOUND, '商品已不存在');
        }
        const reservationOwner = normalizeString(
          product.reservedAppointmentId
        );
        if (product.status === 'available') {
          await productDocument.update({
            data: {
              status: 'reserved',
              reservedAppointmentId: appointmentId,
              reservedAt: db.serverDate(),
              updatedAt: db.serverDate(),
              version: normalizeCount(product.version) + 1
            }
          });
          productChanged = true;
        } else if (
          product.status === 'reserved'
          && reservationOwner
          && reservationOwner !== appointmentId
        ) {
          businessError(
            ERROR_CODES.PRODUCT_UNAVAILABLE,
            '商品已由其他预约预定'
          );
        } else if (
          product.status === 'reserved'
          && !reservationOwner
        ) {
          await productDocument.update({
            data: {
              reservedAppointmentId: appointmentId,
              reservedAt: product.reservedAt || db.serverDate(),
              updatedAt: db.serverDate(),
              version: normalizeCount(product.version) + 1
            }
          });
          productChanged = true;
        } else if (product.status !== 'reserved') {
          businessError(
            ERROR_CODES.PRODUCT_UNAVAILABLE,
            '当前商品不能接受面交预约'
          );
        }
      }
      return {
        appointmentId,
        productId: appointment.productId,
        status: definition.to,
        productChanged,
        reused: true
      };
    }

    const validFrom = Array.isArray(definition.from)
      ? definition.from.includes(appointment.status)
      : appointment.status === definition.from;
    if (!validFrom) {
      businessError(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        '当前预约状态不支持此操作'
      );
    }
    assertTransitionPermission(action, appointment, openId);

    let productDocument = null;
    let product = null;
    let productChanged = false;
    if (action === 'accept' || (
      action === 'cancel' && appointment.status === 'accepted'
    )) {
      productDocument = transaction
        .collection('products')
        .doc(appointment.productId);
      product = await getDocumentOrNull(productDocument);
      if (!product) {
        businessError(ERROR_CODES.PRODUCT_NOT_FOUND, '商品已不存在');
      }
    }
    if (action === 'accept') {
      if (product.status !== 'available') {
        businessError(
          ERROR_CODES.PRODUCT_UNAVAILABLE,
          product.status === 'reserved'
            ? '商品已有已接受的预约'
            : '当前商品不能接受面交预约'
        );
      }
    }
    const isCancellingReservedProduct = Boolean(
      action === 'cancel'
      && appointment.status === 'accepted'
      && product.status === 'reserved'
    );
    const hasOtherAccepted = isCancellingReservedProduct
      ? await hasOtherAcceptedAppointment(
        transaction,
        appointment.productId,
        appointmentId
      )
      : false;
    const shouldRestoreProduct = (
      isCancellingReservedProduct
      && !hasOtherAccepted
    );

    const conversation = await getDocumentOrNull(
      transaction.collection('conversations').doc(
        appointment.conversationId
      )
    );
    if (!conversation || !getParticipantSlot(conversation, openId)) {
      businessError(ERROR_CODES.FORBIDDEN, '无权操作关联会话');
    }

    const updateData = {
      status: definition.to,
      updatedAt: db.serverDate(),
      [definition.timestampField]: db.serverDate(),
      lastActionBy: openId,
      lastActionType: action,
      lastActionIdempotencyKey: idempotencyKey
    };
    if (!ACTIVE_STATUSES.includes(definition.to)) {
      updateData.activeKey = buildClosedActiveKey(appointmentId);
    }
    if (action === 'cancel') {
      updateData.cancelReason = 'user_cancelled';
    }
    await appointmentDocument.update({ data: updateData });
    if (action === 'accept') {
      await productDocument.update({
        data: {
          status: 'reserved',
          reservedAppointmentId: appointmentId,
          reservedAt: db.serverDate(),
          updatedAt: db.serverDate(),
          version: normalizeCount(product.version) + 1
        }
      });
      productChanged = true;
    } else if (
      shouldRestoreProduct
    ) {
      await productDocument.update({
        data: {
          status: 'available',
          reservedAppointmentId: null,
          reservedAt: null,
          updatedAt: db.serverDate(),
          version: normalizeCount(product.version) + 1
        }
      });
      productChanged = true;
    } else if (isCancellingReservedProduct) {
      await productDocument.update({
        data: {
          updatedAt: db.serverDate(),
          version: normalizeCount(product.version) + 1
        }
      });
    }
    await writeSystemMessage(
      transaction,
      conversation,
      appointmentId,
      definition.eventType,
      openId
    );
    return {
      appointmentId,
      productId: appointment.productId,
      status: definition.to,
      productChanged,
      reused: false
    };
  });
  return success(result);
}

async function closeOtherAppointment(appointmentId, productId, sellerOpenid) {
  return runTransaction(async (transaction) => {
    const appointmentDocument = transaction
      .collection('appointments')
      .doc(appointmentId);
    const appointment = await getDocumentOrNull(appointmentDocument);
    if (
      !appointment
      || appointment.productId !== productId
      || !ACTIVE_STATUSES.includes(appointment.status)
    ) {
      return { closed: false, reused: true };
    }
    if (appointment.sellerOpenid !== sellerOpenid) {
      businessError(ERROR_CODES.FORBIDDEN, '商品卖家身份不匹配');
    }
    const conversation = await getDocumentOrNull(
      transaction.collection('conversations').doc(
        appointment.conversationId
      )
    );
    if (!conversation || !getParticipantSlot(conversation, sellerOpenid)) {
      businessError(ERROR_CODES.FORBIDDEN, '关联会话不可用');
    }
    await appointmentDocument.update({
      data: {
        status: 'cancelled',
        activeKey: buildClosedActiveKey(appointmentId),
        cancelReason: 'product_sold',
        cancelledAt: db.serverDate(),
        updatedAt: db.serverDate(),
        lastActionBy: sellerOpenid,
        lastActionType: 'autoCancelProductSold',
        lastActionIdempotencyKey: `sold_${productId}`.slice(0, 80)
      }
    });
    await writeSystemMessage(
      transaction,
      conversation,
      appointmentId,
      'appointment_auto_cancelled',
      sellerOpenid
    );
    return { closed: true, reused: false };
  });
}

async function cleanupOtherAppointments(
  productId,
  completedAppointmentId,
  sellerOpenid
) {
  const query = await appointments.where({
    productId,
    status: command.in(ACTIVE_STATUSES)
  }).limit(CLEANUP_BATCH_SIZE).get();
  const records = Array.isArray(query.data) ? query.data : [];
  let closedCount = 0;
  let failedCount = 0;
  for (const appointment of records) {
    const appointmentId = normalizeString(appointment && appointment._id);
    if (!appointmentId || appointmentId === completedAppointmentId) {
      continue;
    }
    try {
      const result = await closeOtherAppointment(
        appointmentId,
        productId,
        sellerOpenid
      );
      if (result && result.closed) {
        closedCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      console.error('[appointmentAction] product-sold cleanup failed', {
        productIdPresent: Boolean(productId),
        appointmentIdPresent: Boolean(appointmentId),
        code: error && (error.businessCode || error.errCode || error.code || '')
      });
    }
  }
  return {
    closedCount,
    failedCount,
    cleanupPending: failedCount > 0 || records.length >= CLEANUP_BATCH_SIZE
  };
}

async function completeAppointment(data, openId) {
  const appointmentId = normalizeString(data.appointmentId);
  if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
    businessError(ERROR_CODES.INVALID_PARAMS, '缺少有效预约 ID');
  }
  const idempotencyKey = validateIdempotencyKey(data.idempotencyKey);

  const core = await runTransaction(async (transaction) => {
    const appointmentDocument = transaction
      .collection('appointments')
      .doc(appointmentId);
    const appointment = await getDocumentOrNull(appointmentDocument);
    if (!appointment || appointment.isDeleted === true) {
      businessError(
        ERROR_CODES.APPOINTMENT_NOT_FOUND,
        '预约不存在或已失效'
      );
    }
    assertAppointmentParticipant(appointment, openId);
    if (appointment.sellerOpenid !== openId) {
      businessError(
        ERROR_CODES.ACTION_NOT_ALLOWED,
        '只有商品卖家可以确认完成面交'
      );
    }
    if (
      appointment.lastActionIdempotencyKey === idempotencyKey
      && appointment.lastActionType !== 'complete'
    ) {
      businessError(
        ERROR_CODES.IDEMPOTENCY_CONFLICT,
        '请求 ID 已用于其他预约操作'
      );
    }
    if (
      appointment.status === 'completed'
      && appointment.lastActionType === 'complete'
    ) {
      return {
        appointmentId,
        productId: appointment.productId,
        status: 'completed',
        reused: true
      };
    }
    if (appointment.status !== 'accepted') {
      businessError(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        '只有已接受的预约可以确认完成'
      );
    }

    const productDocument = transaction
      .collection('products')
      .doc(appointment.productId);
    const product = await getDocumentOrNull(productDocument);
    if (!product) {
      businessError(ERROR_CODES.PRODUCT_NOT_FOUND, '商品已不存在');
    }
    if (
      product.sellerOpenid !== openId
      || product.status === 'deleted'
      || !COMPLETABLE_PRODUCT_STATUSES.has(product.status)
    ) {
      businessError(
        product.sellerOpenid !== openId
          ? ERROR_CODES.FORBIDDEN
          : ERROR_CODES.PRODUCT_UNAVAILABLE,
        product.sellerOpenid !== openId
          ? '无权修改该商品'
          : '当前商品不能确认完成面交'
      );
    }
    const conversation = await getDocumentOrNull(
      transaction.collection('conversations').doc(
        appointment.conversationId
      )
    );
    if (!conversation || !getParticipantSlot(conversation, openId)) {
      businessError(ERROR_CODES.FORBIDDEN, '无权操作关联会话');
    }

    await appointmentDocument.update({
      data: {
        status: 'completed',
        activeKey: buildClosedActiveKey(appointmentId),
        completedAt: db.serverDate(),
        updatedAt: db.serverDate(),
        lastActionBy: openId,
        lastActionType: 'complete',
        lastActionIdempotencyKey: idempotencyKey
      }
    });
    await productDocument.update({
      data: {
        status: 'sold',
        reservedAppointmentId: null,
        reservedAt: null,
        soldAt: db.serverDate(),
        updatedAt: db.serverDate(),
        version: normalizeCount(product.version) + 1
      }
    });
    await writeSystemMessage(
      transaction,
      conversation,
      appointmentId,
      'appointment_completed',
      openId
    );
    return {
      appointmentId,
      productId: appointment.productId,
      status: 'completed',
      reused: false
    };
  });

  const cleanup = await cleanupOtherAppointments(
    core.productId,
    appointmentId,
    openId
  );
  return success({
    appointmentId,
    productId: core.productId,
    status: core.status,
    reused: core.reused,
    productChanged: core.reused !== true,
    cleanup
  });
}

async function retryProductSoldCleanup(data, openId) {
  const productId = normalizeString(data.productId);
  if (!PRODUCT_ID_PATTERN.test(productId)) {
    businessError(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }
  const product = await getDocumentOrNull(products.doc(productId));
  if (!product) {
    businessError(ERROR_CODES.PRODUCT_NOT_FOUND, '商品已不存在');
  }
  if (product.sellerOpenid !== openId) {
    businessError(ERROR_CODES.FORBIDDEN, '只有商品卖家可以重试清理');
  }
  if (product.status !== 'sold') {
    businessError(
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      '商品尚未完成面交'
    );
  }
  return success({
    productId,
    cleanup: await cleanupOtherAppointments(productId, '', openId)
  });
}

function classifyFailure(error) {
  const message = [
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).join(' ').toLowerCase();
  if (
    message.includes('duplicate')
    || message.includes('unique index')
    || message.includes('e11000')
  ) {
    return ERROR_CODES.APPOINTMENT_ALREADY_EXISTS;
  }
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
    'create',
    'accept',
    'reject',
    'cancel',
    'complete',
    'retryProductSoldCleanup'
  ];
  if (!allowedActions.includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的预约操作');
  }

  const context = cloud.getWXContext();
  const openId = context && normalizeString(context.OPENID);
  const appId = context && normalizeString(context.APPID);
  if (!openId || !appId) {
    return failure(ERROR_CODES.UNAUTHORIZED, '请先登录后使用预约功能');
  }

  try {
    if (action === 'create') {
      return await createAppointment(data, { openId, appId });
    }
    if (action === 'complete') {
      return await completeAppointment(data, openId);
    }
    if (action === 'retryProductSoldCleanup') {
      return await retryProductSoldCleanup(data, openId);
    }
    return await transitionAppointment(action, data, openId);
  } catch (error) {
    if (error && error.businessCode) {
      return failure(error.businessCode, error.message);
    }
    const code = classifyFailure(error);
    console.error('[appointmentAction] request failed', {
      action,
      code,
      errCode: error && (error.errCode || error.code || error.name || '')
    });
    return failure(
      code,
      code === ERROR_CODES.APPOINTMENT_ALREADY_EXISTS
        ? '当前商品已有进行中的面交预约'
        : code === ERROR_CODES.DATABASE_ERROR
          ? '预约数据暂不可用，请稍后重试'
          : '预约服务暂不可用，请稍后重试'
    );
  }
};
