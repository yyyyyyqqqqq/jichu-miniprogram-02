const crypto = require('crypto');
const path = require('path');
const Module = require('module');
const fs = require('fs');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createVerificationDatabase() {
  const stores = {
    users: new Map(),
    products: new Map(),
    conversations: new Map(),
    messages: new Map(),
    appointments: new Map()
  };
  let serverTick = 0;

  function missingDocumentError(id) {
    const error = new Error(
      `document.get:fail document with _id ${id} does not exist`
    );
    error.code = -1;
    return error;
  }

  function clone(value) {
    if (value === null || value === undefined) {
      return value;
    }
    if (value instanceof Date) {
      return new Date(value.getTime());
    }
    if (Array.isArray(value)) {
      return value.map(clone);
    }
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, clone(item)])
      );
    }
    return value;
  }

  function createDocument(store, id) {
    return {
      async get() {
        if (!store.has(id)) {
          throw missingDocumentError(id);
        }
        return { data: clone(store.get(id)) };
      },
      async set({ data }) {
        store.set(id, {
          _id: id,
          ...clone(data)
        });
        return { _id: id };
      },
      async update({ data }) {
        if (!store.has(id)) {
          throw missingDocumentError(id);
        }
        store.set(id, {
          ...store.get(id),
          ...clone(data),
          _id: id
        });
        return { updated: 1 };
      }
    };
  }

  function comparable(value) {
    return value instanceof Date ? value.getTime() : value;
  }

  function matches(record, condition) {
    if (!condition || typeof condition !== 'object') {
      return true;
    }
    if (Array.isArray(condition.$or)) {
      return condition.$or.some((item) => matches(record, item));
    }
    return Object.entries(condition).every(([key, expected]) => {
      if (key === '$or') {
        return expected.some((item) => matches(record, item));
      }
      const actual = record[key];
      if (expected && typeof expected === 'object' && expected.__op) {
        if (expected.__op === 'lt') {
          return comparable(actual) < comparable(expected.value);
        }
        if (expected.__op === 'eq') {
          return comparable(actual) === comparable(expected.value);
        }
        if (expected.__op === 'in') {
          return expected.value.some(
            (item) => comparable(actual) === comparable(item)
          );
        }
        if (expected.__op === 'neq') {
          return comparable(actual) !== comparable(expected.value);
        }
      }
      return comparable(actual) === comparable(expected);
    });
  }

  function createQuery(store) {
    let condition = null;
    const orders = [];
    let limitValue = Number.MAX_SAFE_INTEGER;
    return {
      where(nextCondition) {
        condition = nextCondition;
        return this;
      },
      orderBy(field, direction) {
        orders.push({ field, direction });
        return this;
      },
      limit(value) {
        limitValue = value;
        return this;
      },
      async get() {
        const data = [...store.values()]
          .filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const order of orders) {
              const leftValue = comparable(left[order.field]);
              const rightValue = comparable(right[order.field]);
              if (leftValue === rightValue) {
                continue;
              }
              const compared = leftValue < rightValue ? -1 : 1;
              return order.direction === 'desc' ? -compared : compared;
            }
            return 0;
          })
          .slice(0, limitValue)
          .map(clone);
        return { data };
      }
    };
  }

  function createCollection(name) {
    const store = stores[name];
    assert(store, `unexpected appointment collection ${name}`);
    return {
      doc(id) {
        return createDocument(store, id);
      },
      where(condition) {
        return createQuery(store).where(condition);
      },
      orderBy(field, direction) {
        return createQuery(store).orderBy(field, direction);
      },
      limit(value) {
        return createQuery(store).limit(value);
      },
      get() {
        return createQuery(store).get();
      }
    };
  }

  const command = {
    or(conditions) {
      return { $or: conditions };
    },
    lt(value) {
      return { __op: 'lt', value };
    },
    eq(value) {
      return { __op: 'eq', value };
    },
    in(value) {
      return { __op: 'in', value };
    },
    neq(value) {
      return { __op: 'neq', value };
    }
  };

  return {
    stores,
    database: {
      command,
      collection: createCollection,
      serverDate() {
        serverTick += 1;
        return new Date(Date.now() + serverTick * 1000);
      },
      async runTransaction(callback) {
        return {
          result: await callback({
            collection: createCollection
          })
        };
      }
    }
  };
}

async function verifyAppointmentFlow(root) {
  const actionPath = path.join(
    root,
    'cloudfunctions/appointmentAction/index.js'
  );
  const queryPath = path.join(
    root,
    'cloudfunctions/appointmentQuery/index.js'
  );
  const messageQueryPath = path.join(
    root,
    'cloudfunctions/messageQuery/index.js'
  );
  const messageServicePath = path.join(root, 'services/message-service.js');
  const originalLoad = Module._load;
  const { stores, database } = createVerificationDatabase();
  const appId = 'appointment-verification-app';
  let currentOpenId = 'appointment-buyer-openid';

  function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  function userId(openId) {
    return `u_${digest(`${appId}:${openId}`).slice(0, 32)}`;
  }

  function conversationId(productId, buyerOpenid, sellerOpenid) {
    const participants = [buyerOpenid, sellerOpenid].sort();
    return `c_${digest(
      `${productId}:${participants[0]}:${participants[1]}`
    )}`;
  }

  const sellerOpenId = 'appointment-seller-openid';
  const buyerOpenId = currentOpenId;
  const buyerTwoOpenId = 'appointment-buyer-two-openid';
  const buyerThreeOpenId = 'appointment-buyer-three-openid';
  const attackerOpenId = 'appointment-attacker-openid';
  const identities = [
    [buyerOpenId, '买家甲'],
    [buyerTwoOpenId, '买家乙'],
    [buyerThreeOpenId, '买家丙'],
    [sellerOpenId, '卖家'],
    [attackerOpenId, '第三方']
  ];
  identities.forEach(([openid, nickname]) => {
    const id = userId(openid);
    stores.users.set(id, {
      _id: id,
      openid,
      nickname,
      avatarUrl: '',
      campus: '即出大学',
      status: 'active',
      schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      schoolName: '学校 A'
    });
  });

  function addProduct(productId, status = 'available', owner = sellerOpenId) {
    stores.products.set(productId, {
      _id: productId,
      title: `预约商品 ${productId}`,
      coverImage: '',
      price: 18,
      status,
      version: 1,
      sellerOpenid: owner,
      sellerId: userId(owner),
      schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      schoolName: '学校 A',
      location: '图书馆南门'
    });
  }

  function addConversation(productId, buyer, seller = sellerOpenId) {
    const id = conversationId(productId, buyer, seller);
    const participants = [buyer, seller].sort();
    stores.conversations.set(id, {
      _id: id,
      productId,
      participantAOpenid: participants[0],
      participantBOpenid: participants[1],
      participantAUserId: userId(participants[0]),
      participantBUserId: userId(participants[1]),
      participantAUnreadCount: 0,
      participantBUnreadCount: 0,
      lastMessage: '',
      lastMessageType: '',
      lastMessageAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    return id;
  }

  addProduct('appointment-product-main');
  addProduct('appointment-product-reject');
  addProduct('appointment-product-cancel');
  addProduct('appointment-product-pending-cancel');
  addProduct('appointment-product-cancel-sold');
  addProduct('appointment-product-concurrent');
  addProduct('appointment-product-reserved', 'reserved');
  addProduct('appointment-product-deleted', 'deleted');
  addProduct('appointment-product-offline', 'offline');
  addProduct('appointment-product-self', 'available', buyerOpenId);
  addProduct('appointment-product-cross-school');
  stores.products.set('appointment-product-cross-school', {
    ...stores.products.get('appointment-product-cross-school'),
    schoolId: 's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    schoolName: '学校 B'
  });

  const mainConversationId = addConversation(
    'appointment-product-main',
    buyerOpenId
  );
  const secondBuyerConversationId = addConversation(
    'appointment-product-main',
    buyerTwoOpenId
  );
  const thirdBuyerConversationId = addConversation(
    'appointment-product-main',
    buyerThreeOpenId
  );
  const rejectConversationId = addConversation(
    'appointment-product-reject',
    buyerOpenId
  );
  const cancelConversationId = addConversation(
    'appointment-product-cancel',
    buyerOpenId
  );
  const pendingCancelConversationId = addConversation(
    'appointment-product-pending-cancel',
    buyerOpenId
  );
  const soldCancelConversationId = addConversation(
    'appointment-product-cancel-sold',
    buyerOpenId
  );
  const concurrentConversationId = addConversation(
    'appointment-product-concurrent',
    buyerOpenId
  );
  const deletedConversationId = addConversation(
    'appointment-product-deleted',
    buyerOpenId
  );
  const offlineConversationId = addConversation(
    'appointment-product-offline',
    buyerOpenId
  );
  const reservedConversationId = addConversation(
    'appointment-product-reserved',
    buyerOpenId
  );
  const missingConversationId = addConversation(
    'appointment-product-missing',
    buyerOpenId
  );
  const selfConversationId = addConversation(
    'appointment-product-self',
    buyerOpenId,
    buyerOpenId
  );
  const mismatchConversationId = addConversation(
    'appointment-product-main',
    buyerOpenId,
    attackerOpenId
  );
  const crossSchoolConversationId = addConversation(
    'appointment-product-cross-school',
    buyerOpenId
  );

  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'verification',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return {
        OPENID: currentOpenId,
        APPID: appId
      };
    }
  };

  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const futureTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    .toISOString();
  const location = {
    name: '图书馆南门',
    address: '即出大学图书馆南门',
    latitude: 31.2304,
    longitude: 121.4737
  };

  function createEvent(conversation, key, overrides = {}) {
    return {
      action: 'create',
      data: {
        conversationId: conversation,
        scheduledAt: futureTime,
        location,
        note: '到达后聊天联系',
        idempotencyKey: key,
        buyerOpenid: attackerOpenId,
        sellerOpenid: attackerOpenId,
        ...overrides
      }
    };
  }

  try {
    [
      actionPath,
      queryPath,
      messageQueryPath,
      messageServicePath
    ].forEach((file) => {
      delete require.cache[require.resolve(file)];
    });
    const appointmentAction = require(actionPath);
    const appointmentQuery = require(queryPath);
    const messageQuery = require(messageQueryPath);
    const MessageService = require(messageServicePath);

    currentOpenId = '';
    const unauthorizedCreate = await appointmentAction.main(
      createEvent(mainConversationId, 'create_unauthorized')
    );
    const unauthorizedList = await appointmentQuery.main({
      action: 'listMine',
      data: {}
    });
    assert(
      unauthorizedCreate.code === 'UNAUTHORIZED'
      && unauthorizedList.code === 'UNAUTHORIZED',
      'unauthenticated appointment access is allowed'
    );

    currentOpenId = buyerOpenId;
    const pastTime = await appointmentAction.main(
      createEvent(mainConversationId, 'create_past_time', {
        scheduledAt: new Date(Date.now() - 1000).toISOString()
      })
    );
    const farFuture = await appointmentAction.main(
      createEvent(mainConversationId, 'create_far_future', {
        scheduledAt: new Date(
          Date.now() + 31 * 24 * 60 * 60 * 1000
        ).toISOString()
      })
    );
    const invalidLocation = await appointmentAction.main(
      createEvent(mainConversationId, 'create_bad_location', {
        location: {
          name: '无效地点',
          address: '无效地址',
          latitude: 0,
          longitude: 0
        }
      })
    );
    const missingCoordinate = await appointmentAction.main(
      createEvent(mainConversationId, 'create_missing_coordinate', {
        location: {
          name: '无效地点',
          address: '无效地址',
          latitude: null,
          longitude: 121.4737
        }
      })
    );
    const overlongNote = await appointmentAction.main(
      createEvent(mainConversationId, 'create_long_note', {
        note: '长'.repeat(201)
      })
    );
    assert(
      pastTime.code === 'INVALID_APPOINTMENT_TIME'
      && farFuture.code === 'INVALID_APPOINTMENT_TIME'
      && invalidLocation.code === 'INVALID_APPOINTMENT_LOCATION'
      && missingCoordinate.code === 'INVALID_APPOINTMENT_LOCATION'
      && overlongNote.code === 'INVALID_PARAMS',
      'appointment time or location validation is incomplete'
    );

    const missingProduct = await appointmentAction.main(
      createEvent(missingConversationId, 'create_missing_product')
    );
    const deletedProduct = await appointmentAction.main(
      createEvent(deletedConversationId, 'create_deleted_product')
    );
    const offlineProduct = await appointmentAction.main(
      createEvent(offlineConversationId, 'create_offline_product')
    );
    const reservedProduct = await appointmentAction.main(
      createEvent(reservedConversationId, 'create_reserved_product')
    );
    const selfAppointment = await appointmentAction.main(
      createEvent(selfConversationId, 'create_self_product')
    );
    const mismatch = await appointmentAction.main(
      createEvent(mismatchConversationId, 'create_mismatch')
    );
    assert(
      missingProduct.code === 'PRODUCT_NOT_FOUND'
      && deletedProduct.code === 'PRODUCT_UNAVAILABLE'
      && offlineProduct.code === 'PRODUCT_UNAVAILABLE'
      && reservedProduct.code === 'PRODUCT_UNAVAILABLE'
      && selfAppointment.code === 'SELF_APPOINTMENT_NOT_ALLOWED'
      && mismatch.code === 'FORBIDDEN',
      'product, self or conversation creation boundaries are incomplete'
    );
    const crossSchoolCreate = await appointmentAction.main(
      createEvent(crossSchoolConversationId, 'create_cross_school', {
        schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      })
    );
    assert(
      crossSchoolCreate.success === false
      && crossSchoolCreate.code === 'CROSS_SCHOOL_RELATION_FORBIDDEN',
      'direct cross-school appointment creation or forged school scope was accepted'
    );

    currentOpenId = attackerOpenId;
    const attackerCreate = await appointmentAction.main(
      createEvent(mainConversationId, 'create_attacker')
    );
    assert(
      attackerCreate.code === 'FORBIDDEN',
      'non-participant can create an appointment'
    );

    currentOpenId = buyerOpenId;
    const created = await appointmentAction.main(
      createEvent(mainConversationId, 'create_main_0001')
    );
    assert(created.success === true, 'valid appointment creation failed');
    const appointmentId = created.data.appointmentId;
    assert(
      /^a_[a-f0-9]{64}$/.test(appointmentId)
      && stores.appointments.size === 1
      && stores.messages.size === 1,
      'appointment or created system message was not persisted once'
    );
    const storedCreated = stores.appointments.get(appointmentId);
    assert(
      storedCreated.buyerOpenid === buyerOpenId
      && storedCreated.sellerOpenid === sellerOpenId
      && storedCreated.initiatorOpenid === buyerOpenId
      && storedCreated.location.latitude === location.latitude
      && storedCreated.note === '到达后聊天联系',
      'appointment trusted forged identities or dropped normalized fields'
    );
    assert(
      stores.products.get('appointment-product-main').status === 'available',
      'pending appointment changed the product before acceptance'
    );
    const mainConversationAfterCreate = stores.conversations.get(
      mainConversationId
    );
    const buyerSlot = mainConversationAfterCreate.participantAOpenid
      === buyerOpenId ? 'A' : 'B';
    const sellerSlot = buyerSlot === 'A' ? 'B' : 'A';
    assert(
      mainConversationAfterCreate[`participant${sellerSlot}UnreadCount`] === 1
      && mainConversationAfterCreate[`participant${buyerSlot}UnreadCount`] === 0,
      'create system message did not increment only the recipient unread slot'
    );

    const repeatedCreate = await appointmentAction.main(
      createEvent(mainConversationId, 'create_main_0001')
    );
    stores.users.set(userId(buyerOpenId), {
      ...stores.users.get(userId(buyerOpenId)),
      schoolId: 's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      schoolName: '学校 B'
    });
    const historicalCreate = await appointmentAction.main(
      createEvent(mainConversationId, 'create_main_0001')
    );
    stores.users.set(userId(buyerOpenId), {
      ...stores.users.get(userId(buyerOpenId)),
      schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      schoolName: '学校 A'
    });
    const duplicateActive = await appointmentAction.main(
      createEvent(mainConversationId, 'create_main_0002')
    );
    assert(
      repeatedCreate.success === true
      && repeatedCreate.data.reused === true
      && historicalCreate.success === true
      && historicalCreate.data.reused === true
      && duplicateActive.code === 'APPOINTMENT_ALREADY_EXISTS'
      && stores.appointments.size === 1
      && stores.messages.size === 1,
      'create idempotency or active appointment uniqueness failed'
    );

    const appointmentCountBeforeConcurrent = stores.appointments.size;
    const messageCountBeforeConcurrent = stores.messages.size;
    const concurrentCreateResults = await Promise.all([
      appointmentAction.main(
        createEvent(concurrentConversationId, 'create_concurrent_0001')
      ),
      appointmentAction.main(
        createEvent(concurrentConversationId, 'create_concurrent_0001')
      )
    ]);
    assert(
      concurrentCreateResults.every((result) => result.success)
      && concurrentCreateResults[0].data.appointmentId
        === concurrentCreateResults[1].data.appointmentId
      && stores.appointments.size === appointmentCountBeforeConcurrent + 1
      && stores.messages.size === messageCountBeforeConcurrent + 1,
      'concurrent idempotent creation did not converge on one appointment'
    );

    currentOpenId = buyerTwoOpenId;
    const secondCreated = await appointmentAction.main(
      createEvent(secondBuyerConversationId, 'create_second_buyer')
    );
    assert(
      secondCreated.success === true
      && stores.products.get('appointment-product-main').status === 'available',
      'multiple pending appointments are not allowed or changed product status'
    );
    const secondAppointmentId = secondCreated.data.appointmentId;

    currentOpenId = buyerOpenId;
    const buyerDetail = await appointmentQuery.main({
      action: 'detail',
      data: { appointmentId }
    });
    assert(
      buyerDetail.success === true
      && buyerDetail.data.appointment.canAccept === false
      && buyerDetail.data.appointment.isSeller === false,
      'buyer cannot safely view their appointment'
    );
    const safeBuyerPayload = JSON.stringify(buyerDetail);
    assert(
      !safeBuyerPayload.includes(buyerOpenId)
      && !safeBuyerPayload.includes(sellerOpenId)
      && !/"buyerOpenid"|"sellerOpenid"|"initiatorOpenid"|"lastActionBy"/.test(
        safeBuyerPayload
      ),
      'appointment detail leaked an internal identity'
    );

    currentOpenId = sellerOpenId;
    const sellerDetail = await appointmentQuery.main({
      action: 'detail',
      data: { appointmentId }
    });
    assert(
      sellerDetail.success === true
      && sellerDetail.data.appointment.canAccept === true
      && sellerDetail.data.appointment.waitingForMe === true,
      'seller pending permissions are incorrect'
    );

    currentOpenId = attackerOpenId;
    const attackerDetail = await appointmentQuery.main({
      action: 'detail',
      data: { appointmentId }
    });
    const attackerList = await appointmentQuery.main({
      action: 'listMine',
      data: { filter: 'pending' }
    });
    assert(
      attackerDetail.code === 'FORBIDDEN'
      && attackerList.success === true
      && attackerList.data.list.length === 0,
      'third party can read or enumerate appointments'
    );

    currentOpenId = buyerOpenId;
    const initiatorAccept = await appointmentAction.main({
      action: 'accept',
      data: {
        appointmentId,
        idempotencyKey: 'accept_by_initiator'
      }
    });
    assert(
      initiatorAccept.code === 'ACTION_NOT_ALLOWED',
      'initiator can accept their own pending appointment'
    );

    currentOpenId = sellerOpenId;
    const accepted = await appointmentAction.main({
      action: 'accept',
      data: {
        appointmentId,
        idempotencyKey: 'accept_main_0001'
      }
    });
    const repeatedAccept = await appointmentAction.main({
      action: 'accept',
      data: {
        appointmentId,
        idempotencyKey: 'accept_main_0001'
      }
    });
    assert(
      accepted.success === true
      && repeatedAccept.success === true
      && repeatedAccept.data.reused === true
      && stores.appointments.get(appointmentId).status === 'accepted'
      && stores.products.get('appointment-product-main').status === 'reserved'
      && stores.products.get('appointment-product-main').reservedAppointmentId
        === appointmentId
      && stores.products.get('appointment-product-main').version === 2
      && [...stores.messages.values()].filter(
        (message) => message.appointmentId === appointmentId
      ).length === 2
      && stores.conversations.get(mainConversationId)[
        `participant${buyerSlot}UnreadCount`
      ] === 1,
      'accept transition, product reservation or idempotency failed'
    );

    const secondAccept = await appointmentAction.main({
      action: 'accept',
      data: {
        appointmentId: secondAppointmentId,
        idempotencyKey: 'accept_second_buyer'
      }
    });
    currentOpenId = buyerThreeOpenId;
    const reservedCreate = await appointmentAction.main(
      createEvent(thirdBuyerConversationId, 'create_while_reserved')
    );
    currentOpenId = sellerOpenId;
    const blockedPendingDetail = await appointmentQuery.main({
      action: 'detail',
      data: { appointmentId: secondAppointmentId }
    });
    assert(
      secondAccept.code === 'PRODUCT_UNAVAILABLE'
      && reservedCreate.code === 'PRODUCT_UNAVAILABLE'
      && stores.appointments.get(secondAppointmentId).status === 'pending'
      && stores.products.get('appointment-product-main').status === 'reserved'
      && blockedPendingDetail.success === true
      && blockedPendingDetail.data.appointment.canAccept === false,
      'reserved product accepted or created another appointment'
    );

    currentOpenId = buyerOpenId;
    const buyerComplete = await appointmentAction.main({
      action: 'complete',
      data: {
        appointmentId,
        idempotencyKey: 'complete_by_buyer'
      }
    });
    assert(
      buyerComplete.code === 'ACTION_NOT_ALLOWED'
      && stores.products.get('appointment-product-main').status === 'reserved'
      && stores.appointments.get(appointmentId).status === 'accepted',
      'buyer can complete an appointment or change the seller product'
    );

    currentOpenId = attackerOpenId;
    const attackerComplete = await appointmentAction.main({
      action: 'complete',
      data: {
        appointmentId,
        idempotencyKey: 'complete_by_attacker'
      }
    });
    assert(
      attackerComplete.code === 'FORBIDDEN',
      'third party can complete an appointment'
    );

    currentOpenId = sellerOpenId;
    const completed = await appointmentAction.main({
      action: 'complete',
      data: {
        appointmentId,
        idempotencyKey: 'complete_main_0001'
      }
    });
    assert(
      completed.success === true
      && stores.appointments.get(appointmentId).status === 'completed'
      && stores.products.get('appointment-product-main').status === 'sold',
      'seller completion did not atomically update appointment and product'
    );
    const cancelCompleted = await appointmentAction.main({
      action: 'cancel',
      data: {
        appointmentId,
        idempotencyKey: 'cancel_completed_main'
      }
    });
    assert(
      cancelCompleted.code === 'INVALID_STATUS_TRANSITION'
      && stores.products.get('appointment-product-main').status === 'sold',
      'completed appointment cancellation restored a sold product'
    );
    const appointmentSystemMessages = [...stores.messages.values()].filter(
      (message) => message.appointmentId === appointmentId
    );
    assert(
      appointmentSystemMessages.every((message) => (
        /^sys_[a-f0-9]{64}$/.test(message.clientMessageId)
      ))
      && new Set(
        appointmentSystemMessages.map((message) => message.clientMessageId)
      ).size === appointmentSystemMessages.length,
      'system messages do not satisfy the existing unique message index'
    );
    assert(
      stores.appointments.get(secondAppointmentId).status === 'cancelled'
      && stores.appointments.get(secondAppointmentId).cancelReason
        === 'product_sold'
      && stores.conversations.get(mainConversationId)[
        `participant${buyerSlot}UnreadCount`
      ] === 2,
      'other active appointment was not automatically closed'
    );
    const secondConversation = stores.conversations.get(
      secondBuyerConversationId
    );
    const secondBuyerSlot = secondConversation.participantAOpenid
      === buyerTwoOpenId ? 'A' : 'B';
    assert(
      secondConversation[`participant${secondBuyerSlot}UnreadCount`] === 1,
      'automatic close did not notify only the affected buyer'
    );
    const messageCountAfterComplete = stores.messages.size;
    const repeatedComplete = await appointmentAction.main({
      action: 'complete',
      data: {
        appointmentId,
        idempotencyKey: 'complete_main_0001'
      }
    });
    assert(
      repeatedComplete.success === true
      && repeatedComplete.data.reused === true
      && stores.messages.size === messageCountAfterComplete,
      'repeat completion duplicated system messages or cleanup'
    );

    const retryCleanup = await appointmentAction.main({
      action: 'retryProductSoldCleanup',
      data: { productId: 'appointment-product-main' }
    });
    assert(
      retryCleanup.success === true
      && stores.messages.size === messageCountAfterComplete,
      'product-sold cleanup retry is not idempotent'
    );

    currentOpenId = buyerThreeOpenId;
    const soldCreate = await appointmentAction.main(
      createEvent(thirdBuyerConversationId, 'create_after_sold')
    );
    assert(
      soldCreate.code === 'PRODUCT_UNAVAILABLE',
      'sold product can create a new appointment'
    );

    currentOpenId = buyerOpenId;
    const rejectCreated = await appointmentAction.main(
      createEvent(rejectConversationId, 'create_reject_flow')
    );
    currentOpenId = sellerOpenId;
    const rejected = await appointmentAction.main({
      action: 'reject',
      data: {
        appointmentId: rejectCreated.data.appointmentId,
        idempotencyKey: 'reject_flow_0001'
      }
    });
    const repeatedReject = await appointmentAction.main({
      action: 'reject',
      data: {
        appointmentId: rejectCreated.data.appointmentId,
        idempotencyKey: 'reject_flow_0001'
      }
    });
    currentOpenId = buyerOpenId;
    const acceptRejected = await appointmentAction.main({
      action: 'accept',
      data: {
        appointmentId: rejectCreated.data.appointmentId,
        idempotencyKey: 'accept_rejected'
      }
    });
    assert(
      rejected.success === true
      && repeatedReject.data.reused === true
      && acceptRejected.code === 'INVALID_STATUS_TRANSITION',
      'reject transition or terminal-state enforcement failed'
    );
    assert(
      stores.products.get('appointment-product-reject').status === 'available',
      'rejecting a pending appointment changed the product status'
    );

    const pendingCancelCreated = await appointmentAction.main(
      createEvent(
        pendingCancelConversationId,
        'create_pending_cancel_flow'
      )
    );
    const pendingCancelled = await appointmentAction.main({
      action: 'cancel',
      data: {
        appointmentId: pendingCancelCreated.data.appointmentId,
        idempotencyKey: 'cancel_pending_flow'
      }
    });
    assert(
      pendingCancelled.success === true
      && stores.products.get('appointment-product-pending-cancel').status
        === 'available',
      'cancelling a pending appointment changed the product status'
    );

    currentOpenId = sellerOpenId;
    const sellerCreated = await appointmentAction.main(
      createEvent(cancelConversationId, 'create_by_seller')
    );
    currentOpenId = buyerOpenId;
    const nonInitiatorCancel = await appointmentAction.main({
      action: 'cancel',
      data: {
        appointmentId: sellerCreated.data.appointmentId,
        idempotencyKey: 'cancel_non_initiator'
      }
    });
    const buyerAcceptsSeller = await appointmentAction.main({
      action: 'accept',
      data: {
        appointmentId: sellerCreated.data.appointmentId,
        idempotencyKey: 'buyer_accepts_seller'
      }
    });
    const acceptedCancel = await appointmentAction.main({
      action: 'cancel',
      data: {
        appointmentId: sellerCreated.data.appointmentId,
        idempotencyKey: 'cancel_accepted_flow'
      }
    });
    const repeatedCancel = await appointmentAction.main({
      action: 'cancel',
      data: {
        appointmentId: sellerCreated.data.appointmentId,
        idempotencyKey: 'cancel_accepted_flow'
      }
    });
    const acceptCancelled = await appointmentAction.main({
      action: 'accept',
      data: {
        appointmentId: sellerCreated.data.appointmentId,
        idempotencyKey: 'accept_cancelled'
      }
    });
    assert(
      nonInitiatorCancel.code === 'ACTION_NOT_ALLOWED'
      && buyerAcceptsSeller.success === true
      && buyerAcceptsSeller.data.productChanged === true
      && acceptedCancel.success === true
      && acceptedCancel.data.productChanged === true
      && repeatedCancel.data.reused === true
      && acceptCancelled.code === 'INVALID_STATUS_TRANSITION',
      'seller initiation, accepted cancellation or terminal state failed'
    );
    assert(
      stores.products.get('appointment-product-cancel').status === 'available'
      && stores.products.get('appointment-product-cancel')
        .reservedAppointmentId === null,
      'accepted cancellation without another accepted appointment did not restore availability'
    );

    currentOpenId = buyerOpenId;
    const soldCancelCreated = await appointmentAction.main(
      createEvent(soldCancelConversationId, 'create_cancel_sold_flow')
    );
    currentOpenId = sellerOpenId;
    const soldCancelAccepted = await appointmentAction.main({
      action: 'accept',
      data: {
        appointmentId: soldCancelCreated.data.appointmentId,
        idempotencyKey: 'accept_cancel_sold_flow'
      }
    });
    stores.products.set('appointment-product-cancel-sold', {
      ...stores.products.get('appointment-product-cancel-sold'),
      status: 'sold'
    });
    const cancelledAfterSold = await appointmentAction.main({
      action: 'cancel',
      data: {
        appointmentId: soldCancelCreated.data.appointmentId,
        idempotencyKey: 'cancel_after_external_sold'
      }
    });
    assert(
      soldCancelAccepted.success === true
      && cancelledAfterSold.success === true
      && stores.products.get('appointment-product-cancel-sold').status
        === 'sold',
      'accepted cancellation incorrectly restored an already sold product'
    );

    currentOpenId = buyerOpenId;
    const completedDetail = await appointmentQuery.main({
      action: 'detail',
      data: { appointmentId }
    });
    assert(
      completedDetail.success === true
      && completedDetail.data.appointment.status === 'completed'
      && completedDetail.data.appointment.canComplete === false
      && completedDetail.data.appointment.product.status === 'sold',
      'completed appointment detail is inconsistent with product status'
    );

    const safeMessages = await messageQuery.main({
      action: 'listMessages',
      data: {
        conversationId: mainConversationId,
        pageSize: 20
      }
    });
    assert(
      safeMessages.success === true
      && safeMessages.data.list.some((message) => (
        message.type === 'system'
        && message.eventType === 'appointment_completed'
        && message.appointmentId === appointmentId
      )),
      'appointment system messages are not readable through messageQuery'
    );
    const safeMessagePayload = JSON.stringify(safeMessages);
    assert(
      !safeMessagePayload.includes(buyerOpenId)
      && !safeMessagePayload.includes(sellerOpenId)
      && !/"senderOpenid"/.test(safeMessagePayload),
      'system message response leaked an internal identity'
    );

    const normalizedSystemMessage = MessageService.normalizeMessage({
      messageId: `m_${'a'.repeat(64)}`,
      senderPublicUserId: userId(sellerOpenId),
      isMine: false,
      type: 'system',
      eventType: 'appointment_completed',
      appointmentId,
      content: '已确认完成面交',
      createdAt: new Date().toISOString()
    });
    assert(
      normalizedSystemMessage.type === 'system'
      && normalizedSystemMessage.appointmentId === appointmentId,
      'MessageService rejected a safe appointment system message'
    );

    const listPageOne = await appointmentQuery.main({
      action: 'listMine',
      data: {
        filter: 'ended',
        pageSize: 1
      }
    });
    const listPageTwo = await appointmentQuery.main({
      action: 'listMine',
      data: {
        filter: 'ended',
        pageSize: 1,
        cursor: listPageOne.data.nextCursor
      }
    });
    assert(
      listPageOne.success === true
      && listPageOne.data.list.length === 1
      && listPageTwo.success === true
      && listPageTwo.data.list.length === 1
      && listPageOne.data.list[0].appointmentId
        !== listPageTwo.data.list[0].appointmentId,
      'appointment stable cursor pagination duplicated an item'
    );

    const invalidAction = await appointmentAction.main({
      action: 'invalidAction'
    });
    const invalidQuery = await appointmentQuery.main({
      action: 'invalidAction'
    });
    assert(
      invalidAction.code === 'INVALID_ACTION'
      && invalidQuery.code === 'INVALID_ACTION',
      'appointment cloud functions accept invalid actions'
    );

    const locationPickerSource = fs.readFileSync(
      path.join(root, 'pages/location-picker/index.js'),
      'utf8'
    );
    const locationServiceSource = fs.readFileSync(
      path.join(root, 'services/location-service.js'),
      'utf8'
    );
    const createPageSource = fs.readFileSync(
      path.join(root, 'pages/appointment-create/index.js'),
      'utf8'
    );
    const chatPageSource = fs.readFileSync(
      path.join(root, 'pages/chat/index.js'),
      'utf8'
    );
    const productConstantsSource = fs.readFileSync(
      path.join(root, 'constants/product.js'),
      'utf8'
    );
    const detailTemplateSource = fs.readFileSync(
      path.join(root, 'pages/product-detail/index.wxml'),
      'utf8'
    );
    const detailPageSource = fs.readFileSync(
      path.join(root, 'pages/product-detail/index.js'),
      'utf8'
    );
    const homePageSource = fs.readFileSync(
      path.join(root, 'pages/home/index.js'),
      'utf8'
    );
    assert(
      locationPickerSource.includes('LocationService.chooseLocation')
      && locationServiceSource.includes('wx.chooseLocation')
      && locationServiceSource.includes("message.includes('cancel')")
      && createPageSource.includes('locationSelected')
      && !createPageSource.includes('latitude: 0')
      && !createPageSource.includes('longitude: 0'),
      'map selection does not preserve cancellation or avoid fake coordinates'
    );
    assert(
      productConstantsSource.includes("text: '已预定'")
      && detailTemplateSource.includes('product.statusText')
      && detailTemplateSource.includes('不能创建或接受新的预约')
      && createPageSource.includes(
        "conversation.product.status !== 'available'"
      )
      && chatPageSource.includes("product.status !== 'available'")
      && /onShow\(\)[\s\S]*this\.loadProduct\(\)/.test(detailPageSource)
      && /onShow\(\)[\s\S]*this\.loadProducts/.test(homePageSource),
      'reserved status display, appointment blocking or onShow refresh is incomplete'
    );

    return {
      creation: true,
      permissions: true,
      transitions: true,
      messaging: true,
      paginationAndLocation: true,
      productReservationLinkage: true
    };
  } finally {
    Module._load = originalLoad;
    [
      actionPath,
      queryPath,
      messageQueryPath,
      messageServicePath
    ].forEach((file) => {
      delete require.cache[require.resolve(file)];
    });
  }
}

async function verifyChatAppointmentDegradation(root) {
  const chatPagePath = path.join(root, 'pages/chat/index.js');
  const originalLoad = Module._load;
  const originalPage = global.Page;
  const originalWx = global.wx;
  let pageDefinition;
  let messageFailure = null;
  let appointmentFailure = null;

  const conversation = {
    otherUser: {
      nickname: '测试卖家',
      avatarUrl: '',
      avatarText: '测',
      campus: '测试校区'
    },
    product: {
      productId: 'chat-degradation-product',
      title: '测试商品',
      coverImage: '',
      priceDisplay: '¥1.00',
      status: 'available',
      statusText: '在售'
    },
    canSend: true
  };

  const MessageService = {
    MESSAGE_MAX_LENGTH: 500,
    async getConversation() {
      if (messageFailure) {
        throw messageFailure;
      }
      return conversation;
    },
    async listMessages() {
      if (messageFailure) {
        throw messageFailure;
      }
      return {
        list: [],
        hasMore: false,
        nextCursor: null
      };
    },
    async markConversationRead() {},
    createClientMessageId() {
      return 'chat-degradation-message';
    }
  };
  const AppointmentService = {
    async getActiveByConversation() {
      if (appointmentFailure) {
        throw appointmentFailure;
      }
      return null;
    }
  };

  function createPageInstance() {
    const instance = {
      ...pageDefinition,
      data: JSON.parse(JSON.stringify(pageDefinition.data)),
      isPageActive: true,
      isPageVisible: true,
      requestVersion: 0,
      serverMessages: [],
      pendingMessages: [],
      nextCursor: null,
      pollInFlight: false,
      conversationId: `c_${'a'.repeat(64)}`
    };
    instance.setData = function setData(nextData, callback) {
      this.data = {
        ...this.data,
        ...nextData
      };
      if (callback) {
        callback();
      }
    };
    instance.renderMessages = () => {};
    instance.markRead = () => {};
    instance.startPolling = () => {};
    return instance;
  }

  try {
    Module._load = function loadChatDependency(request, parent, isMain) {
      if (parent && parent.filename === chatPagePath) {
        if (request === '../../store/auth-store') {
          return {
            isLoggedIn: () => true,
            getCurrentUser: () => ({ id: 'chat-degradation-user' })
          };
        }
        if (request === '../../services/auth-guard') {
          return {
            requireLogin: async () => true
          };
        }
        if (request === '../../services/message-service') {
          return MessageService;
        }
        if (request === '../../services/appointment-service') {
          return AppointmentService;
        }
        if (request === '../../services/navigation-service') {
          return {
            safeNavigateTo() {},
            safeSwitchTab() {}
          };
        }
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    global.Page = (definition) => {
      pageDefinition = definition;
    };
    global.wx = {
      setNavigationBarTitle() {},
      showToast() {}
    };
    delete require.cache[require.resolve(chatPagePath)];
    require(chatPagePath);

    appointmentFailure = new Error('预约云函数尚未部署');
    const appointmentUnavailablePage = createPageInstance();
    await appointmentUnavailablePage.initializeConversation();
    assert(
      appointmentUnavailablePage.data.viewState === 'success'
      && appointmentUnavailablePage.data.conversation.product.title
        === conversation.product.title
      && appointmentUnavailablePage.data.appointmentErrorCode
        === 'APPOINTMENT_SERVICE_ERROR'
      && appointmentUnavailablePage.data.messageErrorCode === '',
      'appointment failure still blocks an otherwise healthy chat'
    );

    appointmentFailure = null;
    messageFailure = new Error('会话查询失败');
    const messageUnavailablePage = createPageInstance();
    await messageUnavailablePage.initializeConversation();
    assert(
      messageUnavailablePage.data.viewState === 'error'
      && messageUnavailablePage.data.messageErrorCode
        === 'MESSAGE_SERVICE_ERROR'
      && messageUnavailablePage.data.errorMessage === '会话查询失败',
      'message failure is swallowed or confused with appointment degradation'
    );

    return true;
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(chatPagePath)];
    if (originalPage === undefined) {
      delete global.Page;
    } else {
      global.Page = originalPage;
    }
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

module.exports = {
  verifyAppointmentFlow,
  verifyChatAppointmentDegradation
};
