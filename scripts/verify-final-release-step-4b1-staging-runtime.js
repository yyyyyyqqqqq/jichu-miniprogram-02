'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const { queryCollection } = require('./phase-24-staging-core');
const { MANIFEST_PATH, ACTOR_PATH } = require('./manage-final-release-step-4b1-favorites-fixtures');

const SAFE_DTO_KEYS = Object.freeze([
  '_id', 'campus', 'categoryId', 'categoryName', 'condition', 'coverImage',
  'coverLabel', 'coverTone', 'createdAt', 'description', 'distanceText',
  'favoriteCount', 'favoritedAt', 'location', 'originalPrice', 'price',
  'schoolId', 'schoolName', 'sellerAvatar', 'sellerName', 'sellerPublicUserId',
  'sellerVerified', 'status', 'tags', 'title', 'updatedAt', 'viewCount'
].sort());

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    allowStagingMutations: false,
    manifestPath: MANIFEST_PATH,
    actorPath: ACTOR_PATH,
    output: path.join(ROOT, 'tmp', 'final-release-step-4b1-functional-runtime.json')
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--allow-staging-mutations') options.allowStagingMutations = true;
    else if (value === '--manifest') options.manifestPath = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--actor') options.actorPath = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--output') options.output = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'staging', 'this workflow accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
  assert(options.allowStagingMutations, '--allow-staging-mutations is required', 'STAGING_MUTATION_CONFIRMATION_REQUIRED');
  return options;
}

function automationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'PHASE23_AUTOMATOR_MODULE is unavailable');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsEndpoint), 'local DevTools automation endpoint is unavailable');
  return { modulePath, wsEndpoint };
}

function assertEnvelope(result, successExpected = true) {
  assert(result && typeof result === 'object', 'response envelope is missing');
  assert(typeof result.success === 'boolean' && typeof result.code === 'string'
    && typeof result.message === 'string' && Object.prototype.hasOwnProperty.call(result, 'data'),
  'response envelope drifted');
  assert(result.success === successExpected, `unexpected response success for ${result.code}`);
}

function assertList(result, expected) {
  assertEnvelope(result, true);
  assert(result.code === 'OK' && result.data && Array.isArray(result.data.list), 'favorite list failed');
  assert(result.data.page === expected.page && result.data.pageSize === expected.pageSize, 'pagination normalization drifted');
  assert(result.data.total === expected.total && result.data.hasMore === expected.hasMore, 'pagination totals drifted');
  const ids = result.data.list.map((item) => item._id);
  assert(JSON.stringify(ids) === JSON.stringify(expected.ids), 'hydrated relation order or filtering drifted');
  for (const item of result.data.list) {
    assert(JSON.stringify(Object.keys(item).sort()) === JSON.stringify(SAFE_DTO_KEYS), 'favorite DTO field shape drifted');
    assert(!Object.prototype.hasOwnProperty.call(item, 'sellerOpenid'), 'private seller identity leaked');
  }
}

function readMutationState(environmentId, manifest) {
  const relations = queryCollection(environmentId, 'favorites', { _id: manifest.runtimeFavoriteId }, 2);
  const products = queryCollection(environmentId, 'products', { _id: manifest.productIds.mutation }, 2);
  assert(products.length === 1, 'mutation target disappeared');
  return { relationCount: relations.length, favoriteCount: Number(products[0].favoriteCount || 0) };
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: 'cleanup',
    confirmTarget: options.confirmTarget,
    allowInactiveStagingWrite: false
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.staging,
    'active target must be registered staging', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId !== targets.production, 'production target is forbidden', 'PRODUCTION_TARGET_REJECTED');
  assert(fs.existsSync(options.manifestPath) && fs.existsSync(options.actorPath), 'fixture manifest or actor file is missing');
  const manifest = loadJson(options.manifestPath);
  const actor = loadJson(options.actorPath);
  assert(manifest.status === 'prepared-and-verified' && manifest.actorUserId === actor.userId,
    'fixture manifest is not ready for runtime verification');
  const automation = automationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  const checks = [];
  try {
    miniProgram = await automator.connect({ wsEndpoint: automation.wsEndpoint });
    const call = async (action, data = {}) => {
      const response = await miniProgram.evaluate(async function invokeFavorite(requestAction, requestData) {
        return wx.cloud.callFunction({ name: 'favoriteProduct', data: { action: requestAction, data: requestData } });
      }, action, data);
      return response && response.result;
    };

    const current = await miniProgram.evaluate(async function currentUser() {
      return wx.cloud.callFunction({ name: 'authUser', data: { action: 'current', data: {} } });
    });
    assert(current && current.result && current.result.success === true
      && current.result.data.user.id === actor.userId, 'DevTools identity differs from fixture actor');
    checks.push('staging-actor-identity');

    const first = await call('listMyFavorites', { page: 1, pageSize: 5 });
    assertList(first, {
      page: 1,
      pageSize: 5,
      total: manifest.expected.totalRelations,
      hasMore: true,
      ids: manifest.expected.page1ProductIds
    });
    const firstRepeat = await call('listMyFavorites', { page: 1, pageSize: 5 });
    assertList(firstRepeat, {
      page: 1,
      pageSize: 5,
      total: manifest.expected.totalRelations,
      hasMore: true,
      ids: manifest.expected.page1ProductIds
    });
    const second = await call('listMyFavorites', { page: 2, pageSize: 5 });
    assertList(second, {
      page: 2,
      pageSize: 5,
      total: manifest.expected.totalRelations,
      hasMore: false,
      ids: manifest.expected.page2ProductIds
    });
    const statuses = new Set([...first.data.list, ...second.data.list].map((item) => item.status));
    assert(manifest.expected.allowedStatuses.every((status) => statuses.has(status)), 'allowed historical status coverage drifted');
    checks.push('page-1', 'page-2', 'stable-order', 'missing-filter', 'deleted-filter', 'allowed-statuses', 'dto-envelope');

    const invalidPage = await call('listMyFavorites', { page: 0, pageSize: 5 });
    assertList(invalidPage, {
      page: 1,
      pageSize: 5,
      total: manifest.expected.totalRelations,
      hasMore: true,
      ids: manifest.expected.page1ProductIds
    });
    const invalidPageSize = await call('listMyFavorites', { page: 1, pageSize: 0 });
    assert(invalidPageSize.data.pageSize === 6 && invalidPageSize.data.total === manifest.expected.totalRelations,
      'invalid pageSize fallback drifted');
    const clampedPageSize = await call('listMyFavorites', { page: 1, pageSize: 999 });
    assert(clampedPageSize.data.pageSize === 20 && clampedPageSize.data.total === manifest.expected.totalRelations,
      'maximum pageSize clamp drifted');
    checks.push('invalid-page', 'invalid-page-size', 'max-page-size-20');

    const directDatabase = await miniProgram.evaluate(async function directFavoriteRead() {
      try {
        await wx.cloud.database().collection('favorites').limit(1).get();
        return { rejected: false };
      } catch (error) {
        return { rejected: true, codePresent: Boolean(error && (error.errCode || error.code || error.errMsg)) };
      }
    });
    assert(directDatabase && directDatabase.rejected === true, 'client direct favorites database read was not rejected');
    checks.push('client-direct-database-rejected');

    const initial = readMutationState(preflight.environmentId, manifest);
    assert(initial.relationCount === 0 && initial.favoriteCount === 0, 'mutation target is not clean');
    const statusBefore = await call('getFavoriteStatus', { productId: manifest.productIds.mutation });
    assertEnvelope(statusBefore, true);
    assert(statusBefore.data.isFavorited === false && statusBefore.data.canFavorite === true, 'initial favorite status drifted');
    const added = await call('addFavorite', { productId: manifest.productIds.mutation });
    assertEnvelope(added, true);
    assert(added.data.reused === false && added.data.isFavorited === true && added.data.favoriteCount === 1, 'add favorite drifted');
    const afterAdd = readMutationState(preflight.environmentId, manifest);
    assert(afterAdd.relationCount === 1 && afterAdd.favoriteCount === 1, 'add transaction was not atomic');
    const duplicateAdd = await call('addFavorite', { productId: manifest.productIds.mutation });
    assertEnvelope(duplicateAdd, true);
    assert(duplicateAdd.data.reused === true && duplicateAdd.data.favoriteCount === 1, 'duplicate add idempotency drifted');
    const removed = await call('removeFavorite', { productId: manifest.productIds.mutation });
    assertEnvelope(removed, true);
    assert(removed.data.reused === false && removed.data.isFavorited === false && removed.data.favoriteCount === 0, 'remove favorite drifted');
    const afterRemove = readMutationState(preflight.environmentId, manifest);
    assert(afterRemove.relationCount === 0 && afterRemove.favoriteCount === 0, 'remove transaction was not atomic');
    const duplicateRemove = await call('removeFavorite', { productId: manifest.productIds.mutation });
    assertEnvelope(duplicateRemove, true);
    assert(duplicateRemove.data.reused === true && duplicateRemove.data.favoriteCount === 0, 'duplicate remove idempotency drifted');
    checks.push('status', 'add', 'duplicate-add', 'add-transaction', 'remove', 'duplicate-remove', 'remove-transaction');

    const own = await call('addFavorite', { productId: manifest.productIds.own });
    assertEnvelope(own, false);
    assert(own.code === 'CANNOT_FAVORITE_OWN_PRODUCT', 'own-product isolation drifted');
    const cross = await call('addFavorite', { productId: manifest.productIds.cross });
    assertEnvelope(cross, false);
    assert(cross.code === 'CROSS_SCHOOL_RELATION_FORBIDDEN', 'cross-school isolation drifted');
    const invalid = await call('addFavorite', { productId: '!!' });
    assertEnvelope(invalid, false);
    assert(invalid.code === 'INVALID_PARAMS', 'invalid-product validation drifted');
    checks.push('own-product-rejected', 'cross-school-rejected', 'invalid-product-rejected');

    const forgedIdentity = await call('listMyFavorites', {
      page: 1,
      pageSize: 5,
      openid: 'forged-openid',
      OPENID: 'forged-openid',
      userOpenid: 'forged-openid',
      userId: `u_${'f'.repeat(32)}`
    });
    assertList(forgedIdentity, {
      page: 1,
      pageSize: 5,
      total: manifest.expected.totalRelations,
      hasMore: true,
      ids: manifest.expected.page1ProductIds
    });
    checks.push('forged-client-identity-ignored');

    const report = {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      mode: 'FINAL_RELEASE_STEP_4B1_STAGING_FUNCTIONAL_RUNTIME',
      environment: publicSummary(preflight),
      fixtureRunId: manifest.fixtureRunId,
      checks,
      checksPassed: checks.length,
      relationOrderPreservedAfterParallelHydration: true,
      maximumHydrationConcurrencyBound: 20,
      productionWrites: 0,
      passed: true
    };
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return report;
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STEP4B1_RUNTIME_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { SAFE_DTO_KEYS, parseArguments, run };
