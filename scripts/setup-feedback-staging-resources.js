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
  delay,
  indexMatches
} = require('./phase-24-staging-core');

const COLLECTION_NAME = 'feedbacks';
const REQUIRED_INDEX = Object.freeze({
  name: 'idx_userOpenid_createdAt',
  unique: false,
  keys: Object.freeze([
    ['userOpenid', 1],
    ['createdAt', -1]
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
  assert(options.environmentName === 'staging', 'feedback resources accept only --env staging', 'PRODUCTION_TARGET_REJECTED');
  return options;
}

async function readState(environmentId) {
  const tables = await readTables(environmentId);
  const table = tables.find((item) => item.name === COLLECTION_NAME) || null;
  if (!table) return { table: null, acl: '', indexes: [] };
  return {
    table,
    acl: await readCollectionAcl(environmentId, COLLECTION_NAME),
    indexes: await readIndexes(environmentId, COLLECTION_NAME)
  };
}

function planState(state) {
  const sameName = state.indexes.find((item) => item.name === REQUIRED_INDEX.name);
  assert(!sameName || indexMatches(sameName, REQUIRED_INDEX), 'feedback index definition drift', 'INDEX_DEFINITION_DRIFT');
  return {
    createCollection: !state.table,
    setAcl: !state.table || state.acl !== 'ADMINONLY',
    createIndex: !sameName
  };
}

async function waitForCollection(environmentId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await readState(environmentId);
    if (state.table) return state;
    await delay(1500);
  }
  throw Object.assign(new Error('feedbacks collection did not become readable'), { code: 'COLLECTION_INITIALIZATION_TIMEOUT' });
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.apply ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !options.apply,
    allowInactiveStagingWrite: options.apply
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.environmentName === 'staging' && preflight.environmentId === targets.staging,
    'registered staging target is required', 'STAGING_TARGET_MISMATCH');
  assert(preflight.environmentId !== targets.production, 'production target is forbidden', 'PRODUCTION_TARGET_REJECTED');

  const before = await readState(preflight.environmentId);
  const plan = planState(before);
  if (!options.apply) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      collection: COLLECTION_NAME,
      wouldCreateCollection: plan.createCollection,
      wouldSetAclAdminOnly: plan.setAcl,
      wouldCreateIndex: plan.createIndex ? REQUIRED_INDEX : null
    };
  }

  if (plan.createCollection) await createCollection(preflight.environmentId, COLLECTION_NAME);
  let current = plan.createCollection ? await waitForCollection(preflight.environmentId) : before;
  if (current.acl !== 'ADMINONLY') await setCollectionAcl(preflight.environmentId, COLLECTION_NAME);
  current = await readState(preflight.environmentId);
  const indexPlan = planState(current);
  if (indexPlan.createIndex) await createIndexes(preflight.environmentId, COLLECTION_NAME, [REQUIRED_INDEX]);
  await delay(2000);

  const after = await readState(preflight.environmentId);
  const remaining = planState(after);
  assert(after.table && after.acl === 'ADMINONLY', 'feedback ACL verification failed');
  assert(!remaining.createIndex, 'feedback index verification failed');
  return {
    mode: 'applied-and-verified',
    environment: publicSummary(preflight),
    collection: { name: after.table.name, count: after.table.count },
    acl: after.acl,
    requiredIndex: after.indexes.find((item) => item.name === REQUIRED_INDEX.name)
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_STAGING_RESOURCE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { COLLECTION_NAME, REQUIRED_INDEX, parseArguments, readState, planState, run };
