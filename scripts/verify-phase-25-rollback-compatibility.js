const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const {
  MINIMUM_SAFE_ROLLBACK_BASELINE,
  BREAK_GLASS_AUTHORIZATION,
  inspectMessageQuerySource,
  evaluateProductionMessageQueryCandidate
} = require('./phase-25-minimum-safe-rollback-core');
const {
  auditLifecycleState
} = require('./audit-phase-25-production-readonly');

const ROOT = path.resolve(__dirname, '..');
const QUERY_PATH = path.join(ROOT, 'cloudfunctions', 'messageQuery', 'index.js');
const PHASE24_COMMIT = '7131e58a72dfe2a90342e8a23554c6e94aeabb6c';
let assertionCount = 0;
const gates = [];

function assert(condition, message) {
  assertionCount += 1;
  if (!condition) throw new Error(message);
}

async function gate(name, callback) {
  const before = assertionCount;
  await callback();
  gates.push({ name, assertions: assertionCount - before });
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
    || value;
}

function matches(record, condition) {
  if (!condition || typeof condition !== 'object') return true;
  if (Array.isArray(condition.$or)) {
    return condition.$or.some((item) => matches(record, item));
  }
  return Object.entries(condition).every(([key, expected]) => {
    if (key === '$or') return expected.some((item) => matches(record, item));
    const actual = record[key];
    if (expected && typeof expected === 'object' && expected.__op) {
      if (expected.__op === 'lt') return comparable(actual) < comparable(expected.value);
      if (expected.__op === 'eq') return comparable(actual) === comparable(expected.value);
      if (expected.__op === 'gt') return comparable(actual) > comparable(expected.value);
      if (expected.__op === 'in') return expected.value.includes(actual);
    }
    return actual === expected;
  });
}

function clone(value) {
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    clone(item)
  ]));
}

function createQuery(store, condition = null) {
  const orders = [];
  let maximum = Number.MAX_SAFE_INTEGER;
  return {
    where(nextCondition) {
      return createQuery(store, nextCondition);
    },
    orderBy(field, direction) {
      orders.push({ field, direction });
      return this;
    },
    limit(value) {
      maximum = Number(value);
      return this;
    },
    async get() {
      return {
        data: [...store.values()]
          .filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const order of orders) {
              const leftValue = comparable(left[order.field]);
              const rightValue = comparable(right[order.field]);
              if (leftValue === rightValue) continue;
              const result = leftValue < rightValue ? -1 : 1;
              return order.direction === 'desc' ? -result : result;
            }
            return 0;
          })
          .slice(0, maximum)
          .map(clone)
      };
    }
  };
}

function createHarness() {
  const buyerOpenId = 'rollback-floor-buyer-openid';
  const sellerOpenId = 'rollback-floor-seller-openid';
  const appId = 'rollback-floor-appid';
  const userId = (openId) => `u_${crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex')
    .slice(0, 32)}`;
  const buyerUserId = userId(buyerOpenId);
  const sellerUserId = userId(sellerOpenId);
  const conversationId = `c_${'c'.repeat(64)}`;
  const appointmentId = `a_${'d'.repeat(64)}`;
  const productId = 'rollback-floor-product';
  let currentOpenId = buyerOpenId;
  let messageNumber = 0;
  const stores = {
    users: new Map(),
    products: new Map(),
    conversations: new Map(),
    messages: new Map(),
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

  function nextMessageId() {
    messageNumber += 1;
    return `m_${messageNumber.toString(16).padStart(64, '0')}`;
  }

  function createCollection(name) {
    const store = stores[name];
    if (!store) throw new Error(`unexpected collection ${name}`);
    const query = createQuery(store);
    return {
      doc(id) {
        return {
          async get() {
            if (!store.has(id)) {
              const error = new Error('document does not exist');
              error.code = -1;
              throw error;
            }
            return { data: clone(store.get(id)) };
          }
        };
      },
      where: query.where.bind(query),
      orderBy: query.orderBy.bind(query),
      limit: query.limit.bind(query),
      get: query.get.bind(query)
    };
  }

  const database = {
    command: {
      or: (conditions) => ({ $or: conditions }),
      lt: (value) => ({ __op: 'lt', value }),
      eq: (value) => ({ __op: 'eq', value }),
      gt: (value) => ({ __op: 'gt', value }),
      in: (value) => ({ __op: 'in', value })
    },
    collection: createCollection
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'rollback-floor-verification',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { OPENID: currentOpenId, APPID: appId };
    }
  };
  const originalLoad = Module._load;
  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloudMock;
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[require.resolve(QUERY_PATH)];
  const messageQuery = require(QUERY_PATH);

  stores.users.set(buyerUserId, {
    _id: buyerUserId,
    openid: buyerOpenId,
    status: 'active',
    nickname: '买家',
    avatarUrl: '',
    schoolName: '学校 A',
    campus: '校区 A'
  });
  stores.users.set(sellerUserId, {
    _id: sellerUserId,
    openid: sellerOpenId,
    status: 'active',
    nickname: '卖家',
    avatarUrl: '',
    schoolName: '学校 A',
    campus: '校区 A'
  });
  stores.products.set(productId, {
    _id: productId,
    title: '安全商品',
    coverImage: '',
    price: 10,
    status: 'available',
    schoolId: `s_${'e'.repeat(32)}`,
    schoolName: '学校 A'
  });

  const initialActivityAt = new Date('2026-08-25T08:00:00.000Z');
  const initialLastMessageId = nextMessageId();
  stores.conversations.set(conversationId, {
    _id: conversationId,
    status: 'active',
    participantAUserId: buyerUserId,
    participantBUserId: sellerUserId,
    participantAOpenid: buyerOpenId,
    participantBOpenid: sellerOpenId,
    participantAUnreadCount: 0,
    participantBUnreadCount: 0,
    productId,
    lastProductId: productId,
    lastMessage: '[系统消息]',
    lastMessageType: 'system',
    lastMessageId: initialLastMessageId,
    lastMessageAt: initialActivityAt,
    lastSenderOpenid: sellerOpenId,
    participantAHiddenAt: new Date('2026-08-25T08:00:01.000Z'),
    participantAHiddenActivityId: initialLastMessageId,
    participantAHiddenActivityAt: initialActivityAt
  });

  const secrets = [];
  const recalledSpecs = [
    ['text', { content: 'rollback-secret-text' }],
    ['image', { media: {
      fileId: 'cloud://rollback-secret-image', width: 10, height: 10, size: 10
    } }],
    ['voice', { media: {
      fileId: 'cloud://rollback-secret-voice', durationMs: 1000, size: 10
    } }],
    ['location', { location: {
      name: 'rollback-secret-location-name',
      address: 'rollback-secret-location-address',
      latitude: 31.2,
      longitude: 121.4
    } }],
    ['product', { product: {
      productId: 'rollback-secret-product-id',
      title: 'rollback-secret-product-title',
      coverImage: 'cloud://rollback-secret-product-cover',
      price: 99,
      status: 'available',
      ownerPublicUserId: sellerUserId
    } }]
  ];
  recalledSpecs.forEach(([type, payload], index) => {
    const messageId = nextMessageId();
    const serialized = JSON.stringify(payload);
    (serialized.match(/rollback-secret-[a-z-]+/g) || []).forEach((value) => {
      secrets.push(value);
    });
    stores.messages.set(messageId, {
      _id: messageId,
      conversationId,
      senderOpenid: buyerOpenId,
      senderPublicUserId: buyerUserId,
      type,
      ...payload,
      recalled: true,
      recalledAt: new Date(`2026-08-25T08:01:0${index}.000Z`),
      createdAt: new Date(`2026-08-25T08:00:0${index}.000Z`)
    });
  });

  const deletedForAId = nextMessageId();
  stores.messages.set(deletedForAId, {
    _id: deletedForAId,
    conversationId,
    senderOpenid: sellerOpenId,
    senderPublicUserId: sellerUserId,
    type: 'text',
    content: 'delete-for-a-secret',
    deletedForParticipantAAt: new Date('2026-08-25T08:02:00.000Z'),
    createdAt: new Date('2026-08-25T08:01:10.000Z')
  });
  const deletedForBId = nextMessageId();
  stores.messages.set(deletedForBId, {
    _id: deletedForBId,
    conversationId,
    senderOpenid: buyerOpenId,
    senderPublicUserId: buyerUserId,
    type: 'text',
    content: 'delete-for-b-secret',
    deletedForParticipantBAt: new Date('2026-08-25T08:02:01.000Z'),
    createdAt: new Date('2026-08-25T08:01:11.000Z')
  });
  stores.messages.set(initialLastMessageId, {
    _id: initialLastMessageId,
    conversationId,
    senderOpenid: sellerOpenId,
    senderPublicUserId: sellerUserId,
    type: 'system',
    eventType: 'appointment_created',
    appointmentId,
    content: '预约已创建',
    createdAt: initialActivityAt
  });
  const forwardedCopyId = nextMessageId();
  stores.messages.set(forwardedCopyId, {
    _id: forwardedCopyId,
    conversationId,
    senderOpenid: buyerOpenId,
    senderPublicUserId: buyerUserId,
    type: 'text',
    content: 'forwarded-copy-remains-visible',
    forwarded: true,
    createdAt: new Date('2026-08-25T08:01:12.000Z')
  });

  return {
    messageQuery,
    stores,
    ids: {
      buyerOpenId,
      sellerOpenId,
      buyerUserId,
      sellerUserId,
      conversationId,
      initialLastMessageId,
      deletedForAId,
      deletedForBId,
      forwardedCopyId
    },
    secrets: [...new Set(secrets)],
    setViewer(openId) {
      currentOpenId = openId;
    },
    cleanup() {
      delete require.cache[require.resolve(QUERY_PATH)];
      Module._load = originalLoad;
    }
  };
}

function phase24LikeRender(message) {
  if (message.type === 'text' || message.type === 'system') {
    return String(message.content || '');
  }
  if (message.type === 'voice' || message.type === 'image') {
    return JSON.stringify(message.media || {});
  }
  if (message.type === 'location') return JSON.stringify(message.location || {});
  if (message.type === 'product') return JSON.stringify(message.product || {});
  return '当前版本暂不支持此消息类型';
}

async function verifyRuntimeMatrix() {
  const harness = createHarness();
  const MessageService = require(path.join(ROOT, 'services', 'message-service.js'));
  const {
    messageQuery,
    stores,
    ids,
    secrets,
    setViewer
  } = harness;
  try {
    await gate('A Phase25 query/action/client baseline is server-private', async () => {
      setViewer(ids.sellerOpenId);
      const result = await messageQuery.main({
        action: 'listMessages',
        data: { conversationId: ids.conversationId, pageSize: 30 }
      });
      const recalled = result.data.list.filter((item) => item.type === 'recalled');
      assert(result.success === true && recalled.length === 5, 'not all recalled types reached the safe projection');
      assert(recalled.every((item) => (
        item.recalled === true
        && !('content' in item)
        && !('media' in item)
        && !('location' in item)
        && !('product' in item)
      )), 'a recalled server projection retained its original payload shape');
      const serialized = JSON.stringify(result);
      assert(secrets.every((secret) => !serialized.includes(secret)), 'recalled payload leaked through messageQuery');
    });

    await gate('B minimum-safe query with Phase24 action/client stays private', async () => {
      setViewer(ids.buyerOpenId);
      const hidden = await messageQuery.main({
        action: 'listConversations',
        data: { pageSize: 20 }
      });
      const messages = await messageQuery.main({
        action: 'listMessages',
        data: { conversationId: ids.conversationId, pageSize: 30 }
      });
      const rendered = messages.data.list.map(phase24LikeRender).join('|');
      assert(hidden.data.list.length === 0, 'Phase24-like client received a hidden conversation');
      assert(!rendered.includes('delete-for-a-secret'), 'Phase24-like client recovered its delete-for-me message');
      assert(rendered.includes('delete-for-b-secret'), 'delete-for-me incorrectly affected the other participant');
      assert(harness.secrets.every((secret) => !rendered.includes(secret)), 'Phase24-like renderer recovered a recalled original payload');
    });

    await gate('C minimum-safe query with Phase25 writer and Phase24 client is safe', async () => {
      setViewer(ids.sellerOpenId);
      const result = await messageQuery.main({
        action: 'listMessages',
        data: { conversationId: ids.conversationId, pageSize: 30 }
      });
      const rendered = result.data.list.map(phase24LikeRender).join('|');
      assert(!rendered.includes('delete-for-b-secret'), 'participant B recovered its delete-for-me message');
      assert(rendered.includes('delete-for-a-secret'), 'participant A deletion affected participant B');
      assert(harness.secrets.every((secret) => !rendered.includes(secret)), 'old client recovered Phase25 recalled data');
    });

    await gate('D minimum-safe query with Phase24 writer and Phase25 client degrades safely', async () => {
      setViewer(ids.buyerOpenId);
      const result = await messageQuery.main({
        action: 'listMessages',
        data: { conversationId: ids.conversationId, pageSize: 30 }
      });
      const normalized = result.data.list.map((item) => (
        MessageService.normalizeMessage(item)
      ));
      assert(normalized.filter((item) => item.type === 'recalled').length === 5, 'Phase25 client cannot normalize minimum-safe recalled projections');
      assert(normalized.every((item) => !harness.secrets.some((secret) => (
        JSON.stringify(item).includes(secret)
      ))), 'Phase25 client normalization recovered an original payload');
      const unsupportedAction = new MessageService.MessageError(
        'INVALID_ACTION',
        '当前后端版本不支持该操作'
      );
      assert(unsupportedAction.code === 'INVALID_ACTION' && unsupportedAction.message, 'Phase25 client cannot gracefully represent a Phase24 action rejection');
    });

    await gate('hide scope and new activity restoration remain server-side', async () => {
      setViewer(ids.sellerOpenId);
      const sellerVisible = await messageQuery.main({
        action: 'listConversations',
        data: { pageSize: 20 }
      });
      assert(sellerVisible.data.list.length === 1, 'participant A hide affected participant B');
      const nextId = `m_${'f'.repeat(64)}`;
      stores.messages.set(nextId, {
        _id: nextId,
        conversationId: ids.conversationId,
        senderOpenid: ids.sellerOpenId,
        senderPublicUserId: ids.sellerUserId,
        type: 'text',
        content: 'new activity',
        createdAt: new Date('2026-08-25T08:10:00.000Z')
      });
      stores.conversations.set(ids.conversationId, {
        ...stores.conversations.get(ids.conversationId),
        lastMessage: 'new activity',
        lastMessageType: 'text',
        lastMessageId: nextId,
        lastMessageAt: new Date('2026-08-25T08:10:00.000Z'),
        lastSenderOpenid: ids.sellerOpenId
      });
      setViewer(ids.buyerOpenId);
      const buyerResurfaced = await messageQuery.main({
        action: 'listConversations',
        data: { pageSize: 20 }
      });
      assert(buyerResurfaced.data.list.length === 1, 'new activity did not restore a hidden conversation');
    });

    await gate('system and forwarded copy compatibility is preserved', async () => {
      setViewer(ids.buyerOpenId);
      const result = await messageQuery.main({
        action: 'listMessages',
        data: { conversationId: ids.conversationId, pageSize: 30 }
      });
      const system = result.data.list.find((item) => item.type === 'system');
      const forwarded = result.data.list.find((item) => (
        item.messageId === ids.forwardedCopyId
      ));
      assert(system && system.appointmentId && system.content === '预约已创建', 'minimum-safe floor broke appointment system projection');
      assert(forwarded && forwarded.forwarded === true && forwarded.content === 'forwarded-copy-remains-visible', 'forwarded copy semantics changed after source recall');
      assert(result.data.list.filter((item) => item.type === 'recalled').length === 5, 'recalled sources are not independently protected');
    });
  } finally {
    harness.cleanup();
  }
}

async function verifyGuard() {
  await gate('minimum-safe artifact remains sealed beneath the revocation hotfix', async () => {
    const baselineSource = execFileSync(
      'git',
      [
        'show',
        `${MINIMUM_SAFE_ROLLBACK_BASELINE.sourceCommit}:cloudfunctions/messageQuery/index.js`
      ],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true }
    );
    const baselineInspection = inspectMessageQuerySource(baselineSource);
    assert(
      baselineInspection.sourceSha256
        === MINIMUM_SAFE_ROLLBACK_BASELINE.sourceSha256,
      'sealed baseline hash differs from its recorded source commit'
    );
    assert(
      baselineInspection.approved
        && baselineInspection.requiredBehaviorMarkersPresent,
      'sealed baseline lacks a required privacy marker'
    );
    const currentSource = fs.readFileSync(QUERY_PATH, 'utf8');
    const currentInspection = inspectMessageQuerySource(currentSource);
    assert(
      currentInspection.requiredBehaviorMarkersPresent,
      'revocation hotfix candidate regressed a required privacy marker'
    );
    assert(
      currentSource.includes('await assertActiveUser({ openId, appId });'),
      'revocation hotfix candidate lacks the active-user boundary'
    );
  });

  await gate('E Phase24 and unknown query rollback targets are forbidden', async () => {
    const phase24Source = execFileSync(
      'git',
      ['show', `${PHASE24_COMMIT}:cloudfunctions/messageQuery/index.js`],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true }
    );
    const phase24 = evaluateProductionMessageQueryCandidate(phase24Source, {
      lifecycleDataState: 'present',
      breakGlass: true,
      ownerAuthorization: BREAK_GLASS_AUTHORIZATION
    });
    const unknown = evaluateProductionMessageQueryCandidate(
      `${phase24Source}\n// unsealed candidate`,
      { lifecycleDataState: 'present' }
    );
    assert(!phase24.allowed && phase24.code === 'FORBIDDEN_PHASE24_MESSAGE_QUERY_ROLLBACK', 'Phase24 query was accepted after lifecycle data exists');
    assert(!unknown.allowed && unknown.code === 'UNSEALED_MESSAGE_QUERY_ROLLBACK_TARGET', 'unknown unsealed query was accepted');
  });

  await gate('break-glass is limited to verified pre-lifecycle state', async () => {
    const phase24Source = execFileSync(
      'git',
      ['show', `${PHASE24_COMMIT}:cloudfunctions/messageQuery/index.js`],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true }
    );
    const noAuthorization = evaluateProductionMessageQueryCandidate(phase24Source, {
      lifecycleDataState: 'absent',
      breakGlass: true
    });
    const authorized = evaluateProductionMessageQueryCandidate(phase24Source, {
      lifecycleDataState: 'absent',
      breakGlass: true,
      ownerAuthorization: BREAK_GLASS_AUTHORIZATION
    });
    assert(!noAuthorization.allowed, 'pre-lifecycle break-glass omitted owner authorization');
    assert(authorized.allowed && authorized.code === 'PRE_LIFECYCLE_BREAK_GLASS_APPROVED', 'owner-authorized pre-lifecycle break-glass was not classified');
  });

  await gate('production lifecycle transition is classified fail-closed', async () => {
    assert(
      auditLifecycleState([{}], [{}]).state === 'absent',
      'empty Phase24 records were not classified pre-lifecycle'
    );
    assert(
      auditLifecycleState([{}], [{ recalled: true }]).state === 'present',
      'recalled state did not enforce the floor'
    );
    assert(
      auditLifecycleState([{}], [{ deletedForParticipantAAt: new Date() }]).state === 'present',
      'delete-for-me state did not enforce the floor'
    );
    assert(
      auditLifecycleState([{ participantBHiddenAt: new Date() }], [{}]).state === 'present',
      'hide-for-me state did not enforce the floor'
    );
    assert(
      auditLifecycleState([{ participantAHiddenActivityId: '' }], [{ recalled: false }]).state === 'absent',
      'cleared optional lifecycle fields were misclassified as active'
    );
  });

  await gate('deployment entry points enforce the floor before deployment', async () => {
    for (const relativePath of [
      'scripts/deploy-phase-24-message-query.js',
      'scripts/deploy-phase-24-pair-conversations.js'
    ]) {
      const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      const guardPosition = source.indexOf('const rollbackFloor = assertProductionMessageQueryCandidate');
      const deployPosition = source.indexOf('deployFunctions(preflight.environmentId)', guardPosition);
      const directDeployPosition = source.indexOf('deploy(environmentId)', guardPosition);
      assert(guardPosition >= 0, `${relativePath} does not invoke the rollback floor guard`);
      assert(
        (deployPosition > guardPosition || directDeployPosition > guardPosition),
        `${relativePath} can deploy before the rollback guard`
      );
      assert(!source.includes('BREAK_GLASS_AUTHORIZATION'), `${relativePath} exposes a deployment break-glass bypass`);
    }
  });
}

async function main() {
  await verifyRuntimeMatrix();
  await verifyGuard();
  gates.forEach((item) => {
    console.log(`PASS ${item.name} (${item.assertions} assertions)`);
  });
  console.log(
    `\nPhase 25 rollback compatibility verification succeeded: ${gates.length} gates, ${assertionCount} assertions passed.`
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
