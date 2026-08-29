'use strict';

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
  indexMatches,
  delay
} = require('./phase-24-staging-core');

const COLLECTION = 'favorites';
const REQUIRED_ACL = 'ADMINONLY';
const REQUIRED_INDEXES = Object.freeze([
  Object.freeze({
    name: 'idx_userOpenid_createdAt_id',
    unique: false,
    keys: Object.freeze([
      ['userOpenid', 1],
      ['createdAt', -1],
      ['_id', -1]
    ])
  }),
  Object.freeze({
    name: 'idx_userOpenid_productId_unique',
    unique: true,
    keys: Object.freeze([
      ['userOpenid', 1],
      ['productId', 1]
    ])
  })
]);

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--apply') options.apply = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'staging', 'this workflow accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
  return options;
}

async function inspect(environmentId) {
  const tables = await readTables(environmentId);
  const table = tables.find((item) => item.name === COLLECTION) || null;
  if (!table) return { exists: false, count: 0, acl: '', indexes: [] };
  return {
    exists: true,
    count: table.count,
    acl: await readCollectionAcl(environmentId, COLLECTION),
    indexes: await readIndexes(environmentId, COLLECTION)
  };
}

function missingIndexes(state) {
  return REQUIRED_INDEXES.filter((expected) => (
    !state.indexes.some((actual) => indexMatches(actual, expected))
  ));
}

function conflictingIndexes(state) {
  return REQUIRED_INDEXES.filter((expected) => (
    state.indexes.some((actual) => actual.name === expected.name)
    && !state.indexes.some((actual) => indexMatches(actual, expected))
  ));
}

function publicState(state) {
  return {
    exists: state.exists,
    count: state.count,
    acl: state.acl,
    requiredIndexes: REQUIRED_INDEXES.map((item) => ({
      name: item.name,
      unique: item.unique,
      keys: item.keys
    })),
    requiredIndexesReady: missingIndexes(state).length === 0
  };
}

async function waitUntilReady(environmentId, timeoutMs = 180000) {
  const startedAt = Date.now();
  let state;
  while (Date.now() - startedAt < timeoutMs) {
    state = await inspect(environmentId);
    if (
      state.exists
      && state.acl === REQUIRED_ACL
      && missingIndexes(state).length === 0
    ) return state;
    await delay(3000);
  }
  const error = new Error(`staging ${COLLECTION} infrastructure did not become ready`);
  error.code = 'STAGING_FAVORITES_NOT_READY';
  error.state = publicState(state || { exists: false, count: 0, acl: '', indexes: [] });
  throw error;
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.apply ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !options.apply,
    allowInactiveStagingWrite: options.apply
  });
  assert(preflight.environmentName === 'staging', 'production is forbidden', 'PRODUCTION_TARGET_REJECTED');
  assert(preflight.environmentId === require('../config/cloud.targets.private').staging,
    'target is not the registered staging environment', 'STAGING_TARGET_MISMATCH');
  assert(preflight.environmentId !== require('../config/cloud.targets.private').production,
    'staging and production targets must differ', 'ENVIRONMENT_TARGETS_NOT_DISTINCT');

  const before = await inspect(preflight.environmentId);
  const conflicts = conflictingIndexes(before);
  assert(conflicts.length === 0, `conflicting index definitions: ${conflicts.map((item) => item.name).join(', ')}`,
    'STAGING_INDEX_CONFLICT');
  const needed = missingIndexes(before);
  if (!options.apply) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      collection: COLLECTION,
      before: publicState(before),
      wouldCreateCollection: !before.exists,
      wouldSetAcl: before.acl !== REQUIRED_ACL,
      wouldCreateIndexes: needed.map((item) => item.name),
      writesExecuted: false
    };
  }

  if (!before.exists) await createCollection(preflight.environmentId, COLLECTION);
  const afterCollection = await inspect(preflight.environmentId);
  if (afterCollection.acl !== REQUIRED_ACL) {
    await setCollectionAcl(preflight.environmentId, COLLECTION);
  }
  const indexesNeededAfterCreate = missingIndexes(await inspect(preflight.environmentId));
  if (indexesNeededAfterCreate.length > 0) {
    await createIndexes(preflight.environmentId, COLLECTION, indexesNeededAfterCreate);
  }
  const after = await waitUntilReady(preflight.environmentId);
  assert(after.acl === REQUIRED_ACL, 'staging favorites ACL differs from production', 'STAGING_ACL_DRIFT');
  assert(missingIndexes(after).length === 0, 'required indexes are not ready', 'STAGING_INDEX_NOT_READY');
  return {
    mode: 'applied-and-verified',
    environment: publicSummary(preflight),
    collection: COLLECTION,
    before: publicState(before),
    after: publicState(after),
    createdCollection: !before.exists,
    aclChanged: before.acl !== REQUIRED_ACL,
    createdIndexes: needed.map((item) => item.name),
    indexReadinessEvidence: 'exact definitions returned by DescribeTable',
    productionWrites: 0
  };
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STEP4B1_SETUP_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { COLLECTION, REQUIRED_ACL, REQUIRED_INDEXES, parseArguments, inspect, run };
