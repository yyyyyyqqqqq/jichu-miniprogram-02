const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const { runNoSql } = require('./schools/cloud-cli');
const {
  OWNER_AUTHORIZATION,
  readSnapshot,
  readMaintenance,
  dropTargetIndexes
} = require('./migrate-phase-24-pair-conversations');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_PATH = path.join(ROOT, 'tmp', 'phase-114-staging-original-private.json');
const DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'lastMessageAt', 'scheduledAt']);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function id(prefix, value, length) {
  return `${prefix}_${digest(`phase114:${value}`).slice(0, length)}`;
}

function parseArguments(argv) {
  const options = { mode: '', confirmTarget: '', ownerAuthorization: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--prepare') options.mode = 'prepare';
    else if (value === '--restore') options.mode = 'restore';
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--owner-authorization') options.ownerAuthorization = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(['prepare', 'restore'].includes(options.mode), '--prepare or --restore is required', 'INVALID_ARGUMENT');
  return options;
}

function encodeMongo(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => encodeMongo(item));
  if (!value || typeof value !== 'object') {
    if (DATE_FIELDS.has(key) && typeof value === 'string') {
      return { $date: { $numberLong: String(new Date(value).getTime()) } };
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
    childKey,
    encodeMongo(item, childKey)
  ]));
}

function execute(environmentId, collection, commandType, command) {
  return runNoSql(environmentId, [{
    TableName: collection,
    CommandType: commandType,
    Command: JSON.stringify(command)
  }]);
}

function chunks(values, size = 20) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function insertDocuments(environmentId, collection, documents) {
  for (const values of chunks(documents, 1)) {
    if (values.length === 0) continue;
    execute(environmentId, collection, 'INSERT', {
      insert: collection,
      documents: values.map((item) => encodeMongo(item)),
      ordered: true
    });
  }
}

function deleteDocuments(environmentId, collection, ids) {
  for (const values of chunks(ids)) {
    if (values.length === 0) continue;
    execute(environmentId, collection, 'DELETE', {
      delete: collection,
      deletes: values.map((documentId) => ({ q: { _id: documentId }, limit: 1 }))
    });
  }
}

function fixture(schools) {
  assert(schools.length >= 2, 'staging drill requires two schools', 'STAGING_FIXTURE_PRECONDITION_FAILED');
  const schoolA = schools[0];
  const schoolB = schools.find((item) => item._id !== schoolA._id);
  const users = ['a', 'b', 'c', 'd'].map((key, index) => ({
    _id: id('u', `user-${key}`, 32),
    openid: `phase114-fixture-openid-${key}`,
    nickname: `Phase114 ${key.toUpperCase()}`,
    avatarUrl: '',
    profileCompleted: true,
    schoolId: index === 2 ? schoolB._id : schoolA._id,
    schoolName: index === 2 ? schoolB.name : schoolA.name,
    schoolVersion: 1,
    status: 'active',
    role: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z'
  }));
  const [userA, userB, userC, userD] = users;
  const productSpecs = [
    ['ab-1', userB, schoolA], ['ab-2', userB, schoolA], ['ab-3', userB, schoolA],
    ['ac-1', userA, schoolA], ['ac-2', userA, schoolA], ['bd-1', userD, schoolA]
  ];
  const products = productSpecs.map(([key, seller, school], index) => ({
    _id: id('p', `product-${key}`, 32),
    title: `Phase114 Drill ${key}`,
    sellerId: seller._id,
    sellerOpenid: seller.openid,
    schoolId: school._id,
    schoolName: school.name,
    status: 'available',
    price: index + 1,
    coverImage: '',
    images: [],
    location: 'staging drill',
    createdAt: `2026-08-01T0${index}:00:00.000Z`,
    updatedAt: `2026-08-01T0${index}:00:00.000Z`
  }));
  const pairs = [
    { key: 'ab-1', left: userA, right: userB, product: products[0], unread: [2, 1] },
    { key: 'ab-2', left: userB, right: userA, product: products[1], unread: [3, 4] },
    { key: 'ab-3', left: userA, right: userB, product: products[2], unread: [0, 2] },
    { key: 'ac-1', left: userA, right: userC, product: products[3], unread: [1, 0] },
    { key: 'ac-2', left: userC, right: userA, product: products[4], unread: [0, 1] },
    { key: 'bd-1', left: userB, right: userD, product: products[5], unread: [0, 0] }
  ];
  const conversations = pairs.map((item, index) => ({
    _id: id('c', `conversation-${item.key}`, 64),
    participantAOpenid: item.left.openid,
    participantBOpenid: item.right.openid,
    participantAUserId: item.left._id,
    participantBUserId: item.right._id,
    participantAUnreadCount: item.unread[0],
    participantBUnreadCount: item.unread[1],
    productId: item.product._id,
    productSnapshot: {
      title: item.product.title,
      price: item.product.price,
      status: item.product.status,
      schoolId: item.product.schoolId,
      schoolName: item.product.schoolName
    },
    lastMessage: `legacy-${item.key}`,
    lastMessageType: 'text',
    lastMessageAt: `2026-08-02T0${index}:10:00.000Z`,
    lastSenderOpenid: item.left.openid,
    createdAt: `2026-08-02T0${index}:00:00.000Z`,
    updatedAt: `2026-08-02T0${index}:10:00.000Z`
  }));
  const messages = [];
  let messageIndex = 0;
  const messageCounts = [4, 3, 3, 2, 2, 2];
  pairs.forEach((item, pairIndex) => {
    for (let index = 0; index < messageCounts[pairIndex]; index += 1) {
      const sender = index % 2 === 0 ? item.left : item.right;
      messages.push({
        _id: id('m', `message-${messageIndex}`, 64),
        conversationId: conversations[pairIndex]._id,
        senderOpenid: sender.openid,
        senderPublicUserId: sender._id,
        clientMessageId: `phase114_message_${messageIndex}`,
        type: 'text',
        content: `Phase114 message ${messageIndex}`,
        ...(index % 2 === 0 ? { contextProductId: item.product._id } : { productId: item.product._id }),
        createdAt: `2026-08-03T${String(messageIndex).padStart(2, '0')}:00:00.000Z`
      });
      messageIndex += 1;
    }
  });
  const appointmentSpecs = [
    [0, products[0], userA, userB, 'pending'],
    [0, products[0], userA, userB, 'cancelled'],
    [1, products[1], userA, userB, 'completed'],
    [3, products[3], userC, userA, 'accepted']
  ];
  const appointments = appointmentSpecs.map(([conversationIndex, product, buyer, seller, status], index) => ({
    _id: id('a', `appointment-${index}`, 64),
    conversationId: conversations[conversationIndex]._id,
    productId: product._id,
    buyerOpenid: buyer.openid,
    buyerUserId: buyer._id,
    sellerOpenid: seller.openid,
    sellerUserId: seller._id,
    initiatorOpenid: buyer.openid,
    status,
    isDeleted: false,
    activeKey: ['pending', 'accepted'].includes(status) ? 'active' : `closed:${index}`,
    createIdempotencyKey: `phase114_appointment_${index}`,
    scheduledAt: `2026-08-20T0${index}:00:00.000Z`,
    location: { name: 'staging', address: 'staging drill', latitude: 31.2, longitude: 121.4 },
    note: `Phase114 appointment ${index}`,
    createdAt: `2026-08-04T0${index}:00:00.000Z`,
    updatedAt: `2026-08-04T0${index}:10:00.000Z`
  }));
  return { users, products, conversations, messages, appointments };
}

async function prepare(environmentId) {
  assert(!fs.existsSync(BACKUP_PATH), 'staging original backup already exists; restore it before preparing again', 'STAGING_BACKUP_EXISTS');
  const maintenance = readMaintenance(environmentId);
  assert(maintenance.valid && maintenance.enabled, 'maintenance must be ON before staging fixture preparation', 'MAINTENANCE_NOT_ENABLED');
  const before = await readSnapshot(environmentId);
  const schools = require('./phase-18-canary-core').queryCollection(environmentId, 'schools', {
    projection: { _id: 1, name: 1, platformStatus: 1 },
    limit: 1000
  }).filter((item) => item.platformStatus === 'active');
  const data = fixture(schools);
  fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
  fs.writeFileSync(BACKUP_PATH, `${JSON.stringify({ schemaVersion: 1, before, fixtureIds: {
    users: data.users.map((item) => item._id),
    products: data.products.map((item) => item._id)
  } }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const droppedIndexes = await dropTargetIndexes(environmentId);
  for (const collection of ['messages', 'appointments', 'conversations']) {
    deleteDocuments(environmentId, collection, before[collection].map((item) => item._id));
  }
  insertDocuments(environmentId, 'users', data.users);
  insertDocuments(environmentId, 'products', data.products);
  for (const collection of ['conversations', 'messages', 'appointments']) {
    insertDocuments(environmentId, collection, data[collection]);
  }
  const after = await readSnapshot(environmentId);
  return {
    mode: 'prepared',
    droppedIndexes,
    counts: Object.fromEntries(['users', 'products', 'conversations', 'messages', 'appointments'].map((name) => [name, after[name].length])),
    fixtureCounts: Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]))
  };
}

async function restore(environmentId) {
  assert(fs.existsSync(BACKUP_PATH), 'staging original backup is missing', 'STAGING_BACKUP_MISSING');
  const maintenance = readMaintenance(environmentId);
  assert(maintenance.valid && maintenance.enabled, 'maintenance must be ON before staging restore', 'MAINTENANCE_NOT_ENABLED');
  const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  const live = await readSnapshot(environmentId);
  for (const collection of ['messages', 'appointments', 'conversations']) {
    deleteDocuments(environmentId, collection, live[collection].map((item) => item._id));
    insertDocuments(environmentId, collection, backup.before[collection]);
  }
  deleteDocuments(environmentId, 'products', backup.fixtureIds.products);
  deleteDocuments(environmentId, 'users', backup.fixtureIds.users);
  const after = await readSnapshot(environmentId);
  const expected = backup.before;
  for (const collection of ['users', 'products', 'conversations', 'messages', 'appointments']) {
    assert(after[collection].length === expected[collection].length, `${collection} restore count differs`, 'STAGING_RESTORE_FAILED');
  }
  fs.unlinkSync(BACKUP_PATH);
  return {
    mode: 'restored',
    counts: Object.fromEntries(['users', 'products', 'conversations', 'messages', 'appointments'].map((name) => [name, after[name].length]))
  };
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: 'staging',
    action: 'resource-create',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: false
  });
  assert(options.ownerAuthorization === OWNER_AUTHORIZATION, `staging drill requires --owner-authorization ${OWNER_AUTHORIZATION}`, 'PROJECT_OWNER_AUTHORIZATION_REQUIRED');
  const result = options.mode === 'prepare'
    ? await prepare(preflight.environmentId)
    : await restore(preflight.environmentId);
  return { environment: publicSummary(preflight), ...result };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STAGING_DRILL_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { BACKUP_PATH, parseArguments, fixture, prepare, restore, run };
