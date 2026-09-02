'use strict';

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TRUSTED_APP_ID = 'revocation-verification-app';
const TRUSTED_OPEN_ID = 'revocation-disabled-openid';
const FORGED_OPEN_ID = 'forged-client-openid';
const SCHOOL_ID = `s_${'a'.repeat(32)}`;
const PUBLIC_USER_ID = `u_${'b'.repeat(32)}`;
const PRODUCT_ID = 'product-disabled-verification';
const CONVERSATION_ID = `c_${'c'.repeat(64)}`;
const MESSAGE_ID = `m_${'d'.repeat(64)}`;
const APPOINTMENT_ID = `a_${'e'.repeat(64)}`;

const HOTFIX_CASES = Object.freeze({
  productQuery: [
    { action: 'list', data: { pageSize: 1 } },
    { action: 'myProducts', data: { page: 1, pageSize: 1 } }
  ],
  manageProduct: [
    { action: 'takeOffline', productId: PRODUCT_ID },
    { action: 'relist', productId: PRODUCT_ID },
    { action: 'markSold', productId: PRODUCT_ID },
    { action: 'getEditableProduct', productId: PRODUCT_ID },
    { action: 'updateProduct', productId: PRODUCT_ID },
    { action: 'softDelete', productId: PRODUCT_ID },
    { action: 'retryImageCleanup', productId: PRODUCT_ID }
  ],
  favoriteProduct: [
    { action: 'getFavoriteStatus', data: { productId: PRODUCT_ID } },
    { action: 'addFavorite', data: { productId: PRODUCT_ID } },
    { action: 'removeFavorite', data: { productId: PRODUCT_ID } },
    { action: 'listMyFavorites', data: { page: 1, pageSize: 1 } }
  ],
  productViewAction: [
    { action: 'recordView', data: { productId: PRODUCT_ID } }
  ],
  messageQuery: [
    { action: 'listConversations', data: {} },
    { action: 'getConversation', data: { conversationId: CONVERSATION_ID } },
    {
      action: 'getMessageDeliveryStatus',
      data: {
        conversationId: CONVERSATION_ID,
        clientMessageId: 'client_message_disabled_001'
      }
    },
    { action: 'listMessages', data: { conversationId: CONVERSATION_ID } },
    {
      action: 'listConversationProducts',
      data: { conversationId: CONVERSATION_ID, ownerPublicUserId: PUBLIC_USER_ID }
    }
  ],
  messageAction: [
    { action: 'createOrGetConversation', data: { productId: PRODUCT_ID } },
    {
      action: 'sendTextMessage',
      data: {
        conversationId: CONVERSATION_ID,
        content: 'disabled request must not be sent',
        clientMessageId: 'client_message_disabled_002'
      }
    },
    {
      action: 'sendMessage',
      data: {
        conversationId: CONVERSATION_ID,
        type: 'text',
        content: 'disabled request must not be sent',
        clientMessageId: 'client_message_disabled_003'
      }
    },
    { action: 'markConversationRead', data: { conversationId: CONVERSATION_ID } },
    { action: 'hideConversation', data: { conversationId: CONVERSATION_ID } },
    {
      action: 'deleteMessageForMe',
      data: { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID }
    },
    {
      action: 'recallMessage',
      data: { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID }
    },
    {
      action: 'forwardMessage',
      data: {
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        targetConversationId: `c_${'f'.repeat(64)}`
      }
    }
  ],
  appointmentQuery: [
    { action: 'detail', data: { appointmentId: APPOINTMENT_ID } },
    { action: 'listMine', data: { pageSize: 1 } },
    {
      action: 'getActiveByConversation',
      data: { conversationId: CONVERSATION_ID }
    }
  ],
  appointmentAction: [
    {
      action: 'create',
      data: {
        conversationId: CONVERSATION_ID,
        productId: PRODUCT_ID,
        scheduledAt: '2026-09-02T08:00:00.000Z',
        location: {
          name: '图书馆南门',
          address: '验证大学图书馆南门',
          latitude: 31.2304,
          longitude: 121.4737
        },
        idempotencyKey: 'disabled_appointment_001'
      }
    },
    { action: 'accept', data: { appointmentId: APPOINTMENT_ID } },
    { action: 'reject', data: { appointmentId: APPOINTMENT_ID } },
    { action: 'cancel', data: { appointmentId: APPOINTMENT_ID } },
    { action: 'complete', data: { appointmentId: APPOINTMENT_ID } },
    {
      action: 'retryProductSoldCleanup',
      data: { appointmentId: APPOINTMENT_ID, productId: PRODUCT_ID }
    }
  ],
  feedbackAction: [
    {
      action: 'submit',
      content: 'disabled request must not be persisted or mailed',
      requestId: 'disabled_feedback_001'
    }
  ]
});

const EXISTING_ACTIVE_REQUIRED_CASES = Object.freeze({
  userQuery: [
    { action: 'publicProfile', data: { publicUserId: PUBLIC_USER_ID } },
    {
      action: 'publicProducts',
      data: { publicUserId: PUBLIC_USER_ID, page: 1, pageSize: 1 }
    }
  ],
  createProduct: [
    {
      requestId: 'disabled_create_001',
      product: {}
    }
  ]
});

const MODIFIED_HOTFIX_FUNCTIONS = Object.freeze([
  'authUser',
  ...Object.keys(HOTFIX_CASES),
  'userQuery'
]);

function createUserId(appId, openId) {
  return `u_${crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)])
    );
  }
  return value;
}

function missingDocumentError(id) {
  const error = new Error(
    `document.get:fail document with _id ${id} does not exist`
  );
  error.code = 'DATABASE_DOCUMENT_NOT_EXIST';
  return error;
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matches(record, condition) {
  if (!condition || typeof condition !== 'object') return true;
  if (condition.__op === 'and') {
    return condition.values.every((item) => matches(record, item));
  }
  if (condition.__op === 'or') {
    return condition.values.some((item) => matches(record, item));
  }
  return Object.entries(condition).every(([key, expected]) => {
    const actual = key.split('.').reduce(
      (result, segment) => result && result[segment],
      record
    );
    if (expected && expected.__op === 'in') {
      return expected.value.includes(actual);
    }
    if (expected && expected.__op === 'eq') return actual === expected.value;
    if (expected && expected.__op === 'neq') return actual !== expected.value;
    if (expected && expected.__op === 'gt') {
      return comparable(actual) > comparable(expected.value);
    }
    if (expected && expected.__op === 'gte') {
      return comparable(actual) >= comparable(expected.value);
    }
    if (expected && expected.__op === 'lt') {
      return comparable(actual) < comparable(expected.value);
    }
    if (expected && expected.__op === 'lte') {
      return comparable(actual) <= comparable(expected.value);
    }
    if (expected && expected.$regexp instanceof RegExp) {
      return expected.$regexp.test(String(actual || ''));
    }
    return comparable(actual) === comparable(expected);
  });
}

function createHarness(options = {}) {
  const identity = {
    OPENID: options.openId === undefined ? TRUSTED_OPEN_ID : options.openId,
    APPID: options.appId === undefined ? TRUSTED_APP_ID : options.appId
  };
  const trustedUserId = createUserId(identity.APPID, identity.OPENID);
  const stores = {
    users: new Map(),
    products: new Map(),
    favorites: new Map(),
    productViews: new Map(),
    conversations: new Map(),
    messages: new Map(),
    appointments: new Map(),
    feedbacks: new Map(),
    schools: new Map(),
    systemConfig: new Map([[
      'conversation_appointment_maintenance',
      {
        _id: 'conversation_appointment_maintenance',
        schemaVersion: 1,
        enabled: false,
        migrationRunId: ''
      }
    ]])
  };
  if (options.includeUser !== false && identity.OPENID && identity.APPID) {
    stores.users.set(trustedUserId, {
      _id: trustedUserId,
      openid: options.userOpenId === undefined
        ? identity.OPENID
        : options.userOpenId,
      nickname: '撤权验证用户',
      avatarUrl: '',
      status: options.userStatus || 'disabled',
      profileCompleted: true,
      schoolId: SCHOOL_ID,
      schoolName: '验证大学',
      schoolVersion: 1,
      createdAt: new Date('2026-08-31T00:00:00.000Z')
    });
  }
  stores.products.set(PRODUCT_ID, {
    _id: PRODUCT_ID,
    title: '公开验证商品',
    description: '只包含公开字段的回归验证商品。',
    price: 10,
    categoryId: 'life',
    categoryName: '生活',
    condition: '九成新',
    images: [],
    coverImage: '',
    status: 'available',
    sellerId: PUBLIC_USER_ID,
    sellerOpenid: 'public-product-owner-openid',
    sellerName: '公开卖家',
    schoolId: SCHOOL_ID,
    schoolName: '验证大学',
    viewCount: 0,
    favoriteCount: 0,
    createdAt: new Date('2026-08-31T00:00:00.000Z')
  });
  stores.schools.set(SCHOOL_ID, {
    _id: SCHOOL_ID,
    officialCode: '9900000001',
    name: '验证大学',
    nameNormalized: '验证大学',
    province: '广东省',
    city: '广州市',
    educationLevel: '本科',
    officialStatus: 'valid',
    platformStatus: 'active'
  });

  const trace = {
    reads: [],
    writes: [],
    transactions: 0,
    mailAttempts: 0,
    externalWrites: 0
  };

  function getStore(name) {
    if (!stores[name]) stores[name] = new Map();
    return stores[name];
  }

  function createDocument(name, id) {
    const store = getStore(name);
    return {
      async get() {
        trace.reads.push({ collection: name, operation: 'doc.get', id });
        if (!store.has(id)) throw missingDocumentError(id);
        return { data: clone(store.get(id)) };
      },
      async set({ data }) {
        trace.writes.push({ collection: name, operation: 'doc.set', id });
        store.set(id, { _id: id, ...clone(data) });
        return { _id: id };
      },
      async update({ data }) {
        trace.writes.push({ collection: name, operation: 'doc.update', id });
        if (!store.has(id)) throw missingDocumentError(id);
        store.set(id, { ...store.get(id), ...clone(data), _id: id });
        return { stats: { updated: 1 }, updated: 1 };
      },
      async remove() {
        trace.writes.push({ collection: name, operation: 'doc.remove', id });
        const removed = store.delete(id);
        return { stats: { removed: removed ? 1 : 0 } };
      }
    };
  }

  function createQuery(name, initialCondition = null) {
    const store = getStore(name);
    let condition = initialCondition;
    let offset = 0;
    let maximum = Number.MAX_SAFE_INTEGER;
    const orders = [];
    const query = {
      where(value) {
        condition = value;
        return query;
      },
      field() {
        return query;
      },
      orderBy(field, direction) {
        orders.push({ field, direction });
        return query;
      },
      skip(value) {
        offset = Number(value) || 0;
        return query;
      },
      limit(value) {
        maximum = Number(value) || 0;
        return query;
      },
      async get() {
        trace.reads.push({ collection: name, operation: 'query.get', condition });
        const data = [...store.values()]
          .filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const order of orders) {
              const leftValue = comparable(left[order.field]);
              const rightValue = comparable(right[order.field]);
              if (leftValue === rightValue) continue;
              const compared = leftValue < rightValue ? -1 : 1;
              return order.direction === 'desc' ? -compared : compared;
            }
            return 0;
          })
          .slice(offset, offset + maximum)
          .map(clone);
        return { data };
      },
      async count() {
        trace.reads.push({ collection: name, operation: 'query.count', condition });
        return {
          total: [...store.values()].filter((record) => matches(record, condition)).length
        };
      },
      async update() {
        trace.writes.push({ collection: name, operation: 'query.update' });
        return { stats: { updated: 0 } };
      },
      async remove() {
        trace.writes.push({ collection: name, operation: 'query.remove' });
        return { stats: { removed: 0 } };
      }
    };
    return query;
  }

  function collection(name) {
    const query = createQuery(name);
    return {
      doc(id) {
        return createDocument(name, id);
      },
      where: query.where,
      field: query.field,
      orderBy: query.orderBy,
      skip: query.skip,
      limit: query.limit,
      get: query.get,
      count: query.count,
      update: query.update,
      remove: query.remove,
      async add({ data }) {
        const id = data && data._id ? data._id : `generated_${getStore(name).size + 1}`;
        trace.writes.push({ collection: name, operation: 'add', id });
        getStore(name).set(id, { _id: id, ...clone(data) });
        return { _id: id };
      }
    };
  }

  function operator(name) {
    return (value) => ({ __op: name, value });
  }

  const command = {
    in: operator('in'),
    eq: operator('eq'),
    neq: operator('neq'),
    gt: operator('gt'),
    gte: operator('gte'),
    lt: operator('lt'),
    lte: operator('lte'),
    inc: operator('inc'),
    and(values) {
      return { __op: 'and', values };
    },
    or(values) {
      return { __op: 'or', values };
    },
    remove() {
      return { __op: 'remove' };
    }
  };

  const database = {
    command,
    collection,
    RegExp({ regexp, options: regexpOptions }) {
      return { $regexp: new RegExp(regexp, regexpOptions) };
    },
    serverDate() {
      return new Date('2026-08-31T08:00:00.000Z');
    },
    async runTransaction(callback) {
      trace.transactions += 1;
      return {
        result: await callback({ collection })
      };
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'revocation-verification',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { ...identity };
    },
    async deleteFile() {
      trace.externalWrites += 1;
      return { fileList: [] };
    },
    async uploadFile() {
      trace.externalWrites += 1;
      return { fileID: 'cloud://unexpected-write' };
    },
    async downloadFile() {
      trace.reads.push({ collection: 'storage', operation: 'download' });
      return { fileContent: Buffer.alloc(0) };
    }
  };
  const mailer = {
    createTransport() {
      trace.mailAttempts += 1;
      return {
        async sendMail() {
          trace.mailAttempts += 1;
          return { accepted: [] };
        },
        close() {}
      };
    }
  };

  return {
    identity,
    trustedUserId,
    stores,
    trace,
    database,
    cloud,
    mailer
  };
}

async function withCloudFunction(functionName, harness, callback) {
  const target = path.join(ROOT, 'cloudfunctions', functionName, 'index.js');
  const originalLoad = Module._load;
  Module._load = function loadWithVerificationMocks(request, parent, isMain) {
    if (request === 'wx-server-sdk') return harness.cloud;
    if (request === 'nodemailer') return harness.mailer;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(target)];
  try {
    const subject = require(target);
    return await callback(subject);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(target)];
  }
}

function withForgedClientIdentity(event) {
  return {
    ...clone(event),
    OPENID: FORGED_OPEN_ID,
    openid: FORGED_OPEN_ID,
    userOpenid: FORGED_OPEN_ID,
    status: 'active',
    data: event.data
      ? {
          ...clone(event.data),
          OPENID: FORGED_OPEN_ID,
          openid: FORGED_OPEN_ID,
          userOpenid: FORGED_OPEN_ID,
          status: 'active'
        }
      : event.data
  };
}

function assertSafeDeniedResponse(result, expectedCodes, label) {
  assert(result && result.success === false, `${label} did not fail closed`);
  assert(expectedCodes.includes(result.code), `${label} returned ${result.code}`);
  assert(result.data === null, `${label} returned non-null private data`);
  const allowedKeys = new Set(['success', 'code', 'message', 'data', 'traceId']);
  assert(
    Object.keys(result).every((key) => allowedKeys.has(key)),
    `${label} returned unexpected response metadata`
  );
  const forbiddenKeys = new Set([
    'openid', 'openId', 'appid', 'appId', 'user', 'record', 'status',
    'error', 'errCode', 'errMsg', 'stack', 'databaseError'
  ]);
  assert(
    !Object.keys(result).some((key) => forbiddenKeys.has(key)),
    `${label} returned forbidden identity/status/error metadata`
  );
  const serialized = JSON.stringify(result);
  [TRUSTED_OPEN_ID, TRUSTED_APP_ID, FORGED_OPEN_ID].forEach((secret) => {
    assert(!serialized.includes(secret), `${label} leaked identity data`);
  });
  assert(!Object.prototype.hasOwnProperty.call(result, 'stack'), `${label} leaked a stack`);
}

function businessCode(error) {
  return error && (error.businessCode || error.code || error.name);
}

function revokedCodes(functionName) {
  return functionName === 'productQuery'
    ? ['USER_INACTIVE']
    : ['USER_DISABLED'];
}

async function expectHelperDenied(callback, expectedCodes, label) {
  let caught = null;
  try {
    await callback();
  } catch (error) {
    caught = error;
  }
  assert(caught, `${label} helper did not fail closed`);
  assert(
    expectedCodes.includes(businessCode(caught)),
    `${label} helper returned ${businessCode(caught)}`
  );
}

async function callActiveHelper(functionName, subject, harness) {
  assert(
    subject.__test && typeof subject.__test.assertActiveUser === 'function',
    `${functionName} does not export its active-user verifier for regression coverage`
  );
  const identity = {
    openId: harness.identity.OPENID,
    appId: harness.identity.APPID,
    userId: harness.trustedUserId
  };
  if (functionName === 'feedbackAction') {
    return subject.__test.assertActiveUser({ database: harness.database }, identity);
  }
  return subject.__test.assertActiveUser(identity);
}

async function verifyHelperSemantics(functionName) {
  const harness = createHarness({ userStatus: 'active' });
  await withCloudFunction(functionName, harness, async (subject) => {
    const active = await callActiveHelper(functionName, subject, harness);
    assert(
      active && active.status === 'active' && active.openid === TRUSTED_OPEN_ID,
      `${functionName} rejected the authoritative active user`
    );

    harness.stores.users.set(harness.trustedUserId, {
      ...harness.stores.users.get(harness.trustedUserId),
      status: 'disabled'
    });
    await expectHelperDenied(
      () => callActiveHelper(functionName, subject, harness),
      revokedCodes(functionName),
      `${functionName} disabled`
    );

    harness.stores.users.set(harness.trustedUserId, {
      ...harness.stores.users.get(harness.trustedUserId),
      status: 'pending'
    });
    await expectHelperDenied(
      () => callActiveHelper(functionName, subject, harness),
      revokedCodes(functionName),
      `${functionName} non-active status`
    );

    harness.stores.users.set(harness.trustedUserId, {
      ...harness.stores.users.get(harness.trustedUserId),
      status: 'active',
      openid: 'binding-mismatch-openid'
    });
    await expectHelperDenied(
      () => callActiveHelper(functionName, subject, harness),
      [
        'UNAUTHORIZED',
        'LOGIN_REQUIRED',
        'AUTH_REQUIRED',
        'USER_NOT_FOUND',
        'SCHOOL_CONTEXT_MISMATCH'
      ],
      `${functionName} binding mismatch`
    );

    harness.stores.users.delete(harness.trustedUserId);
    await expectHelperDenied(
      () => callActiveHelper(functionName, subject, harness),
      ['UNAUTHORIZED', 'LOGIN_REQUIRED', 'AUTH_REQUIRED', 'USER_NOT_FOUND'],
      `${functionName} missing user`
    );

    const userReads = harness.trace.reads.filter(
      (entry) => entry.collection === 'users'
    );
    assert(
      userReads.length >= 5,
      `${functionName} cached authoritative user status across requests`
    );
    assert(harness.trace.writes.length === 0, `${functionName} helper performed a write`);
  });
}

async function verifyDisabledMainMatrix(
  functionName,
  cases,
  expectedCodes,
  userStatus = 'disabled'
) {
  const harness = createHarness({ userStatus });
  await withCloudFunction(functionName, harness, async (subject) => {
    for (const event of cases) {
      const readsBefore = harness.trace.reads.length;
      const writesBefore = harness.trace.writes.length;
      const transactionsBefore = harness.trace.transactions;
      const mailBefore = harness.trace.mailAttempts;
      const externalWritesBefore = harness.trace.externalWrites;
      const result = await subject.main(withForgedClientIdentity(event));
      const label = `${functionName}/${event.action || 'create'}`;
      assertSafeDeniedResponse(result, expectedCodes, label);
      const requestReads = harness.trace.reads.slice(readsBefore);
      assert(
        requestReads.some((entry) => entry.collection === 'users'),
        `${label} did not read the authoritative users record`
      );
      assert(
        requestReads.every((entry) => entry.collection === 'users'),
        `${label} read business data before revocation denial`
      );
      assert(harness.trace.writes.length === writesBefore, `${label} performed a database write`);
      assert(
        harness.trace.transactions === transactionsBefore,
        `${label} entered a business transaction`
      );
      assert(harness.trace.mailAttempts === mailBefore, `${label} attempted mail delivery`);
      assert(
        harness.trace.externalWrites === externalWritesBefore,
        `${label} performed a storage write`
      );
    }
  });
}

async function verifyActiveMainMatrix(functionName, cases, revokedErrorCodes) {
  for (const event of cases) {
    const harness = createHarness({ userStatus: 'active' });
    await withCloudFunction(functionName, harness, async (subject) => {
      const result = await subject.main(withForgedClientIdentity(event));
      const label = `${functionName}/${event.action || 'create'}/active`;
      assert(result && typeof result.success === 'boolean', `${label} returned an invalid envelope`);
      assert(!revokedErrorCodes.includes(result.code), `${label} rejected an active account`);
      assert(
        harness.trace.reads.some((entry) => entry.collection === 'users'),
        `${label} did not consult the authoritative users record`
      );
      const serialized = JSON.stringify(result);
      assert(!serialized.includes(TRUSTED_OPEN_ID), `${label} leaked the trusted OPENID`);
      assert(!serialized.includes(TRUSTED_APP_ID), `${label} leaked the trusted APPID`);
    });
  }
}

async function verifyPublicProductDetail() {
  const scenarios = [
    {
      label: 'anonymous',
      options: { openId: '', appId: '', includeUser: false },
      expectedMode: 'anonymous'
    },
    {
      label: 'trusted context without an account',
      options: { includeUser: false },
      expectedMode: 'accountNotReady'
    },
    {
      label: 'trusted context with a disabled account',
      options: { userStatus: 'disabled' },
      expectedMode: 'accountNotReady'
    }
  ];
  for (const scenario of scenarios) {
    const harness = createHarness(scenario.options);
    await withCloudFunction('productQuery', harness, async (subject) => {
      const result = await subject.main({
        action: 'detail',
        data: { productId: PRODUCT_ID }
      });
      assert(result.success === true, `${scenario.label} public product detail was blocked`);
      assert(result.data.access.mode === scenario.expectedMode,
        `${scenario.label} public detail access mode drifted`);
      const serialized = JSON.stringify(result);
      assert(!serialized.includes('public-product-owner-openid'),
        `${scenario.label} public product detail leaked the seller OPENID`);
      assert(!serialized.includes(TRUSTED_OPEN_ID),
        `${scenario.label} public product detail leaked the viewer OPENID`);
    });
  }
}

async function verifySchoolOnboarding() {
  const schoolHarness = createHarness({ openId: '', appId: '', includeUser: false });
  await withCloudFunction('schoolQuery', schoolHarness, async (subject) => {
    const list = await subject.main({ action: 'list', pageSize: 20 });
    const search = await subject.main({ action: 'search', keyword: '验证大' });
    const detail = await subject.main({ action: 'detail', schoolId: SCHOOL_ID });
    assert(list.success && list.data.items.length === 1, 'anonymous school list was blocked');
    assert(search.success && search.data.items.length === 1, 'anonymous school search was blocked');
    assert(detail.success && detail.data.id === SCHOOL_ID, 'anonymous school detail was blocked');
    assert(
      !schoolHarness.trace.reads.some((entry) => entry.collection === 'users'),
      'school onboarding unexpectedly required a user record'
    );
  });

  const authHarness = createHarness({ includeUser: false, userStatus: 'active' });
  await withCloudFunction('authUser', authHarness, async (subject) => {
    const result = await subject.main({
      action: 'loginIdentity',
      OPENID: FORGED_OPEN_ID,
      data: { status: 'disabled', schoolId: SCHOOL_ID }
    });
    assert(result.success === true, 'identity-first onboarding was blocked');
    assert(
      result.data.user.profileCompleted === false
      && result.data.user.schoolRequired === true,
      'identity-first onboarding state drifted'
    );
    const stored = authHarness.stores.users.get(authHarness.trustedUserId);
    assert(
      stored && stored.openid === TRUSTED_OPEN_ID && stored.status === 'active',
      'onboarding trusted client-supplied identity or status'
    );
  });

  const loginHarness = createHarness({ includeUser: false, userStatus: 'active' });
  await withCloudFunction('authUser', loginHarness, async (subject) => {
    const result = await subject.main({
      action: 'login',
      data: {
        profile: {
          nickname: '撤权验证用户',
          avatarUrl: ''
        }
      }
    });
    const stored = loginHarness.stores.users.get(loginHarness.trustedUserId);
    assert(result.success === true, 'profile bootstrap onboarding was blocked');
    assert(
      stored && stored.openid === TRUSTED_OPEN_ID && stored.status === 'active',
      'profile bootstrap did not create an authoritative active account'
    );
  });
}

function authExistingActionCases(userId) {
  const profile = {
    nickname: '撤权验证用户',
    avatarUrl: `cloud://revocation-verification/avatars/${userId}/20260831/avatar.png`
  };
  return [
    { action: 'loginIdentity' },
    { action: 'login', data: { profile } },
    { action: 'current' },
    { action: 'updateProfile', data: { profile } },
    { action: 'selectSchool', data: { schoolId: SCHOOL_ID } },
    { action: 'updateSchool', data: { schoolId: SCHOOL_ID } }
  ];
}

async function verifyAuthExistingNonActive(userStatus) {
  const harness = createHarness({ userStatus });
  await withCloudFunction('authUser', harness, async (subject) => {
    for (const event of authExistingActionCases(harness.trustedUserId)) {
      const readsBefore = harness.trace.reads.length;
      const writesBefore = harness.trace.writes.length;
      const result = await subject.main(withForgedClientIdentity(event));
      const label = `authUser/${event.action}/${userStatus}`;
      assertSafeDeniedResponse(result, ['USER_DISABLED'], label);
      const requestReads = harness.trace.reads.slice(readsBefore);
      assert(
        requestReads.length > 0
        && requestReads.every((entry) => entry.collection === 'users'),
        `${label} read non-user business data before revocation denial`
      );
      assert(harness.trace.writes.length === writesBefore, `${label} performed a write`);
    }
  });
}

async function verifyAuthBindingMismatch() {
  const harness = createHarness({ userStatus: 'active', userOpenId: 'binding-mismatch' });
  await withCloudFunction('authUser', harness, async (subject) => {
    for (const action of ['loginIdentity', 'current']) {
      const writesBefore = harness.trace.writes.length;
      const result = await subject.main({ action });
      assertSafeDeniedResponse(result, ['AUTH_FAILED'], `authUser/${action}/binding`);
      assert(harness.trace.writes.length === writesBefore,
        `authUser/${action}/binding performed a write`);
    }
  });
}

async function verifyUserQueryNonActiveTarget() {
  const harness = createHarness({ userStatus: 'active' });
  harness.stores.users.set(PUBLIC_USER_ID, {
    _id: PUBLIC_USER_ID,
    openid: 'pending-public-target-openid',
    status: 'pending',
    nickname: '不可公开用户',
    schoolId: SCHOOL_ID,
    createdAt: new Date('2026-08-31T00:00:00.000Z')
  });
  await withCloudFunction('userQuery', harness, async (subject) => {
    for (const event of EXISTING_ACTIVE_REQUIRED_CASES.userQuery) {
      const writesBefore = harness.trace.writes.length;
      const productReadsBefore = harness.trace.reads.filter(
        (entry) => entry.collection === 'products'
      ).length;
      const result = await subject.main(event);
      assertSafeDeniedResponse(result, ['USER_NOT_FOUND'],
        `userQuery/${event.action}/non-active-target`);
      const productReadsAfter = harness.trace.reads.filter(
        (entry) => entry.collection === 'products'
      ).length;
      assert(productReadsAfter === productReadsBefore,
        `userQuery/${event.action} exposed products for a non-active target`);
      assert(harness.trace.writes.length === writesBefore,
        `userQuery/${event.action}/non-active-target performed a write`);
    }
  });
}

function expectToolingError(callback, expectedCode, label) {
  let caught = null;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert(caught && caught.code === expectedCode,
    `${label} did not fail with ${expectedCode}`);
}

function verifyRolloutTooling() {
  const actorManager = require('./manage-disabled-account-staging-actor');
  const deployment = require('./deploy-disabled-account-hotfix');
  const stagingRuntime = require('./verify-disabled-account-staging-runtime');
  const productionIntegrity = require(
    './capture-disabled-account-production-integrity'
  );
  const rolloutCore = require('./disabled-account-rollout-core');

  expectToolingError(
    () => actorManager.parseArguments([
      '--env', 'production', '--action', 'prepare'
    ]),
    'PRODUCTION_TARGET_REJECTED',
    'staging actor production role gate'
  );
  expectToolingError(
    () => actorManager.parseArguments([
      '--env', 'staging', '--action', 'disable'
    ]),
    'STAGING_MUTATION_CONFIRMATION_REQUIRED',
    'staging actor explicit mutation gate'
  );
  const command = actorManager.buildStatusUpdateCommand(
    { _id: `u_${'1'.repeat(32)}`, openid: 'tooling-openid' },
    'active',
    'disabled'
  );
  assert(actorManager.assertStatusOnlyCommand(
    command,
    `u_${'1'.repeat(32)}`,
    'active',
    'disabled'
  ), 'status-only compare-and-set command was rejected');
  assert(actorManager.statusMutationLeftoverCount('active', 'active') === 0
    && actorManager.statusMutationLeftoverCount('disabled', 'active') === 1
    && actorManager.statusMutationLeftoverCount('pending', 'active') === null,
  'staging status leftover accounting drifted');
  const unsafeCommand = clone(command);
  const unsafeBody = JSON.parse(unsafeCommand.Command);
  unsafeBody.updates[0].u.$set.updatedAt = 'forbidden';
  unsafeCommand.Command = JSON.stringify(unsafeBody);
  expectToolingError(
    () => actorManager.assertStatusOnlyCommand(
      unsafeCommand,
      `u_${'1'.repeat(32)}`,
      'active',
      'disabled'
    ),
    'STATUS_COMMAND_REJECTED',
    'status mutation field allowlist'
  );

  assert(deployment.DEPLOY_ORDER.length === 11
    && deployment.DEPLOY_ORDER.every((name) => deployment.REASONS[name]),
  'deployment allowlist/reason matrix is incomplete');
  assert(
    rolloutCore.sameObject(
      [...deployment.DEPLOY_ORDER].sort(),
      [...rolloutCore.HOTFIX_FUNCTION_CANDIDATES].sort()
    ),
    'deployment allowlist drifted from the approved hotfix function set'
  );
  assert(
    rolloutCore.sameObject(
      Object.keys(deployment.STAGING_CREATE_CONFIGS).sort(),
      ['manageProduct', 'productViewAction']
    )
    && Object.values(deployment.STAGING_CREATE_CONFIGS).every((config) => (
      config.handler === 'index.main'
      && config.timeout === 10
      && config.memorySize === 256
      && Object.keys(config.envVariables).length === 0
    )),
    'staging-only missing-function creation allowlist/config drifted'
  );
  assert(deployment.isMissingFunctionError({
    message: '[manageProduct] Function does not exist RESOURCE_NOT_FOUND'
  }, 'manageProduct'), 'staging missing-function detection drifted');
  expectToolingError(
    () => deployment.parseArguments([
      '--env', 'production', '--action', 'deploy', '--function', 'createProduct'
    ]),
    'FUNCTION_REQUIRED',
    'deployment function allowlist'
  );
  const configuration = deployment.createDeployConfiguration(
    'masked-environment-not-output',
    'messageQuery',
    {
      Runtime: 'Nodejs16.13',
      Handler: 'index.main',
      Timeout: 10,
      MemorySize: 256,
      Environment: {
        Variables: [{ Key: 'SAFE_KEY', Value: 'preserved-value' }]
      }
    },
    'cloudfunctions'
  );
  assert(configuration.functions.length === 1
    && configuration.functions[0].name === 'messageQuery'
    && configuration.functions[0].envVariables.SAFE_KEY === 'preserved-value',
  'deployment configuration does not preserve one function/config envelope');

  expectToolingError(
    () => stagingRuntime.parseArguments([
      '--env', 'staging'
    ]),
    'STAGING_MUTATION_CONFIRMATION_REQUIRED',
    'staging runtime explicit mutation gate'
  );
  expectToolingError(
    () => productionIntegrity.parseArguments([
      '--env', 'staging', '--phase', 'pre'
    ]),
    'PRODUCTION_TARGET_REQUIRED',
    'production integrity role gate'
  );
  assert(
    productionIntegrity.sameFunctionSet(
      [...rolloutCore.HOTFIX_FUNCTION_CANDIDATES].reverse(),
      rolloutCore.HOTFIX_FUNCTION_CANDIDATES
    )
    && !productionIntegrity.sameFunctionSet(
      rolloutCore.HOTFIX_FUNCTION_CANDIDATES.slice(1),
      rolloutCore.HOTFIX_FUNCTION_CANDIDATES
    )
    && !productionIntegrity.sameFunctionSet(
      [...rolloutCore.HOTFIX_FUNCTION_CANDIDATES, 'schoolQuery'],
      rolloutCore.HOTFIX_FUNCTION_CANDIDATES
    )
    && !productionIntegrity.sameFunctionSet(
      [
        ...rolloutCore.HOTFIX_FUNCTION_CANDIDATES,
        rolloutCore.HOTFIX_FUNCTION_CANDIDATES[0]
      ],
      rolloutCore.HOTFIX_FUNCTION_CANDIDATES
    ),
    'production hotfix function-set comparison is not order-safe and exact'
  );
  expectToolingError(
    () => rolloutCore.resolvePrivatePath('../outside.json', ''),
    'PRIVATE_PATH_OUTSIDE_TMP',
    'private artifact path boundary'
  );
  return true;
}

async function verifyDisabledAccountRevocation() {
  const checks = [];
  for (const functionName of Object.keys(HOTFIX_CASES)) {
    await verifyHelperSemantics(functionName);
    checks.push(`${functionName} active/missing/binding/non-active helper semantics`);
    await verifyDisabledMainMatrix(
      functionName,
      HOTFIX_CASES[functionName],
      revokedCodes(functionName)
    );
    checks.push(`${functionName} disabled main action matrix`);
    await verifyActiveMainMatrix(
      functionName,
      HOTFIX_CASES[functionName],
      revokedCodes(functionName)
    );
    checks.push(`${functionName} active main action gate regression`);
  }

  await verifyDisabledMainMatrix(
    'userQuery',
    EXISTING_ACTIVE_REQUIRED_CASES.userQuery,
    ['UNAUTHORIZED', 'USER_DISABLED']
  );
  checks.push('userQuery viewer revocation remains fail-closed');
  await verifyDisabledMainMatrix(
    'userQuery',
    EXISTING_ACTIVE_REQUIRED_CASES.userQuery,
    ['UNAUTHORIZED'],
    'pending'
  );
  checks.push('userQuery rejects every non-active authoritative viewer status');
  await verifyUserQueryNonActiveTarget();
  checks.push('userQuery hides every non-active public target');
  await verifyDisabledMainMatrix(
    'createProduct',
    EXISTING_ACTIVE_REQUIRED_CASES.createProduct,
    ['USER_DISABLED']
  );
  checks.push('createProduct existing revocation remains fail-closed');
  await verifyAuthExistingNonActive('disabled');
  await verifyAuthExistingNonActive('pending');
  checks.push('authUser existing-account actions reject disabled and invalid statuses');
  await verifyAuthBindingMismatch();
  checks.push('authUser checks authoritative identity binding before status');
  await verifyPublicProductDetail();
  checks.push('anonymous public product detail remains available and private-safe');
  await verifySchoolOnboarding();
  checks.push('anonymous school discovery and identity-first onboarding remain available');
  verifyRolloutTooling();
  checks.push('rollout tooling role, function, path, and status-only mutation gates');

  return {
    passed: true,
    protectedFunctions: MODIFIED_HOTFIX_FUNCTIONS.length,
    protectedActions: Object.values(HOTFIX_CASES)
      .reduce((total, cases) => total + cases.length, 0)
      + Object.values(EXISTING_ACTIVE_REQUIRED_CASES)
        .reduce((total, cases) => total + cases.length, 0)
      + authExistingActionCases(`u_${'0'.repeat(32)}`).length,
    checks
  };
}

if (require.main === module) {
  verifyDisabledAccountRevocation()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`DISABLED_REVOCATION_VERIFY_FAILED: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  HOTFIX_CASES,
  EXISTING_ACTIVE_REQUIRED_CASES,
  MODIFIED_HOTFIX_FUNCTIONS,
  verifyDisabledAccountRevocation
};
