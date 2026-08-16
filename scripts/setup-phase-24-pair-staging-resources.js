const {
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const {
  readTables,
  readCollectionAcl,
  readIndexes,
  createCollection,
  setCollectionAcl,
  createIndexes,
  delay,
  indexMatches
} = require('./phase-24-staging-core');

const COLLECTIONS = Object.freeze([
  'conversations',
  'messages',
  'appointments'
]);

const FOUNDATIONAL_INDEXES = Object.freeze({
  messages: Object.freeze([
    Object.freeze({
      name: 'idx_conversation_createdAt_id',
      unique: false,
      keys: Object.freeze([
        ['conversationId', 1],
        ['createdAt', -1],
        ['_id', -1]
      ])
    }),
    Object.freeze({
      name: 'idx_conversation_sender_clientMessage_unique',
      unique: true,
      keys: Object.freeze([
        ['conversationId', 1],
        ['senderOpenid', 1],
        ['clientMessageId', 1]
      ])
    })
  ]),
  appointments: Object.freeze([
    Object.freeze({
      name: 'idx_buyer_deleted_updatedAt_id',
      unique: false,
      keys: Object.freeze([
        ['buyerOpenid', 1], ['isDeleted', 1],
        ['updatedAt', -1], ['_id', -1]
      ])
    }),
    Object.freeze({
      name: 'idx_seller_deleted_updatedAt_id',
      unique: false,
      keys: Object.freeze([
        ['sellerOpenid', 1], ['isDeleted', 1],
        ['updatedAt', -1], ['_id', -1]
      ])
    }),
    Object.freeze({
      name: 'idx_buyer_status_deleted_updatedAt_id',
      unique: false,
      keys: Object.freeze([
        ['buyerOpenid', 1], ['status', 1], ['isDeleted', 1],
        ['updatedAt', -1], ['_id', -1]
      ])
    }),
    Object.freeze({
      name: 'idx_seller_status_deleted_updatedAt_id',
      unique: false,
      keys: Object.freeze([
        ['sellerOpenid', 1], ['status', 1], ['isDeleted', 1],
        ['updatedAt', -1], ['_id', -1]
      ])
    }),
    Object.freeze({
      name: 'idx_product_pair_active_unique',
      unique: true,
      keys: Object.freeze([
        ['productId', 1], ['buyerOpenid', 1],
        ['sellerOpenid', 1], ['activeKey', 1]
      ])
    }),
    Object.freeze({
      name: 'idx_conversation_status_deleted_updatedAt_id',
      unique: false,
      keys: Object.freeze([
        ['conversationId', 1], ['status', 1], ['isDeleted', 1],
        ['updatedAt', -1], ['_id', -1]
      ])
    }),
    Object.freeze({
      name: 'idx_product_status_updatedAt_id',
      unique: false,
      keys: Object.freeze([
        ['productId', 1], ['status', 1],
        ['updatedAt', -1], ['_id', -1]
      ])
    }),
    Object.freeze({
      name: 'idx_initiator_create_key_unique',
      unique: true,
      keys: Object.freeze([
        ['initiatorOpenid', 1], ['createIdempotencyKey', 1]
      ])
    })
  ])
});

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--apply') options.apply = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

async function readState(environmentId) {
  const tables = await readTables(environmentId);
  const tableNames = new Set(tables.map((item) => item.name));
  const acl = {};
  const indexes = {};
  for (const name of COLLECTIONS) {
    if (!tableNames.has(name)) continue;
    acl[name] = await readCollectionAcl(environmentId, name);
    indexes[name] = await readIndexes(environmentId, name);
  }
  return { tables, tableNames, acl, indexes };
}

function planState(state) {
  const missingCollections = COLLECTIONS.filter((name) => !state.tableNames.has(name));
  const aclChanges = COLLECTIONS.filter((name) => (
    state.tableNames.has(name) && state.acl[name] !== 'ADMINONLY'
  ));
  const indexChanges = {};
  for (const [name, definitions] of Object.entries(FOUNDATIONAL_INDEXES)) {
    const actual = state.indexes[name] || [];
    const byName = new Map(actual.map((item) => [item.name, item]));
    definitions.forEach((definition) => {
      const sameName = byName.get(definition.name);
      assert(!sameName || indexMatches(sameName, definition), `${name}.${definition.name} definition drift`, 'INDEX_DEFINITION_DRIFT');
    });
    indexChanges[name] = definitions.filter((definition) => !byName.has(definition.name));
  }
  return { missingCollections, aclChanges, indexChanges };
}

async function waitForCollections(environmentId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await readState(environmentId);
    if (COLLECTIONS.every((name) => state.tableNames.has(name))) return state;
    await delay(1500);
  }
  throw Object.assign(new Error('pair staging collections did not become readable'), { code: 'COLLECTION_INITIALIZATION_TIMEOUT' });
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.apply ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget
  });
  assert(preflight.environmentName === 'staging', 'pair resources only support staging', 'PRODUCTION_WRITE_REJECTED');
  const before = await readState(preflight.environmentId);
  const plan = planState(before);
  if (!options.apply) {
    return {
      mode: 'dry-run',
      preflight: publicSummary(preflight),
      wouldCreateCollections: plan.missingCollections,
      wouldSetAclAdminOnly: [...new Set([...plan.missingCollections, ...plan.aclChanges])],
      wouldCreateFoundationalIndexes: Object.fromEntries(
        Object.entries(plan.indexChanges).map(([name, items]) => [name, items.map((item) => item.name)])
      ),
      createsPhase24PairIndexes: false
    };
  }

  for (const name of plan.missingCollections) await createCollection(preflight.environmentId, name);
  let current = plan.missingCollections.length
    ? await waitForCollections(preflight.environmentId)
    : before;
  for (const name of COLLECTIONS) {
    if (current.acl[name] !== 'ADMINONLY') await setCollectionAcl(preflight.environmentId, name);
  }
  current = await readState(preflight.environmentId);
  const indexPlan = planState(current).indexChanges;
  for (const [name, definitions] of Object.entries(indexPlan)) {
    if (definitions.length > 0) await createIndexes(preflight.environmentId, name, definitions);
  }
  await delay(2000);
  const after = await readState(preflight.environmentId);
  const remaining = planState(after);
  assert(remaining.missingCollections.length === 0, 'pair staging collection missing after apply');
  assert(remaining.aclChanges.length === 0, 'pair staging ACL verification failed');
  assert(Object.values(remaining.indexChanges).every((items) => items.length === 0), 'foundational index verification failed');
  const businessTables = after.tables.filter((item) => COLLECTIONS.includes(item.name));
  assert(businessTables.every((item) => item.count === 0), 'new staging pair collections are not empty', 'STAGING_PAIR_COLLECTION_NOT_EMPTY');
  return {
    mode: 'applied-and-verified',
    preflight: publicSummary(preflight),
    collections: businessTables,
    acl: after.acl,
    foundationalIndexes: Object.fromEntries(
      Object.entries(after.indexes).map(([name, items]) => [name, items.map((item) => item.name)])
    )
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'PHASE24_PAIR_STAGING_RESOURCE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { COLLECTIONS, FOUNDATIONAL_INDEXES, parseArguments, run };
