'use strict';

const { runPreflight, publicSummary, assert } = require('./environment-preflight');
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
const { REQUIRED_INDEX } = require('./capture-feedback-production-snapshot');

const COLLECTION_NAME = 'feedbacks';

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', apply: false, authorized: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--apply') options.apply = true;
    else if (value === '--allow-feedback-production-rollout') options.authorized = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'production', 'resources accept only --env production', 'STAGING_TARGET_REJECTED');
  if (options.apply) assert(options.authorized, '--allow-feedback-production-rollout is required', 'PRODUCTION_AUTHORIZATION_REQUIRED');
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

async function waitForState(environmentId, predicate, errorCode) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = await readState(environmentId);
    if (predicate(state)) return state;
    await delay(2000);
  }
  throw Object.assign(new Error('production feedback resource readiness timed out'), { code: errorCode });
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.apply ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: options.apply
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.production,
    'active target must be registered production', 'PRODUCTION_TARGET_MISMATCH');
  assert(preflight.environmentId !== targets.staging, 'staging target is forbidden', 'STAGING_TARGET_REJECTED');

  const before = await readState(preflight.environmentId);
  const plan = planState(before);
  if (!options.apply) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      collection: COLLECTION_NAME,
      wouldCreateCollection: plan.createCollection,
      wouldSetAclAdminOnly: plan.setAcl,
      wouldCreateIndex: plan.createIndex ? REQUIRED_INDEX : null,
      productionWrites: 0
    };
  }

  if (plan.createCollection) await createCollection(preflight.environmentId, COLLECTION_NAME);
  let current = plan.createCollection
    ? await waitForState(preflight.environmentId, (state) => Boolean(state.table), 'COLLECTION_INITIALIZATION_TIMEOUT')
    : before;
  if (current.acl !== 'ADMINONLY') await setCollectionAcl(preflight.environmentId, COLLECTION_NAME);
  current = await readState(preflight.environmentId);
  if (planState(current).createIndex) await createIndexes(preflight.environmentId, COLLECTION_NAME, [REQUIRED_INDEX]);
  const after = await waitForState(preflight.environmentId, (state) => {
    const required = state.indexes.find((item) => item.name === REQUIRED_INDEX.name);
    return Boolean(state.table && state.acl === 'ADMINONLY' && required && indexMatches(required, REQUIRED_INDEX));
  }, 'FEEDBACK_RESOURCE_READINESS_TIMEOUT');
  const required = after.indexes.find((item) => item.name === REQUIRED_INDEX.name);
  return {
    mode: 'applied-and-verified',
    environment: publicSummary(preflight),
    collection: { name: after.table.name, count: after.table.count },
    acl: after.acl,
    requiredIndex: required,
    changedOnly: [COLLECTION_NAME, REQUIRED_INDEX.name, `${COLLECTION_NAME}:ACL`]
  };
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_PRODUCTION_RESOURCE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { COLLECTION_NAME, parseArguments, readState, planState, run };
