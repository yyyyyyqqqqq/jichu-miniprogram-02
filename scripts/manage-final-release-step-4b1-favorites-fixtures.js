'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const {
  queryCollection,
  insertDocuments
} = require('./phase-24-staging-core');
const { runNoSql } = require('./schools/cloud-cli');

const MANIFEST_PATH = path.join(ROOT, 'tmp', 'final-release-step-4b1-favorites-fixture-manifest.json');
const ACTOR_PATH = path.join(ROOT, 'tmp', 'final-release-step-4b1-actor.json');
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    action: '',
    actorPath: ACTOR_PATH,
    manifestPath: MANIFEST_PATH
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--action') options.action = String(argv[++index] || '').trim();
    else if (value === '--actor') options.actorPath = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--manifest') options.manifestPath = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'staging', 'this workflow accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
  assert(['prepare', 'cleanup', 'audit'].includes(options.action), '--action prepare|cleanup|audit is required', 'INVALID_ACTION');
  return options;
}

function favoriteId(openId, productId) {
  return `f_${sha256(`${openId}:${productId}`)}`;
}

function fixtureId(prefix, runId, key) {
  return `${prefix}_step4b1_${sha256(`${runId}:${key}`).slice(0, 32)}`;
}

function readActor(environmentId, actorPath) {
  assert(fs.existsSync(actorPath), 'private staging actor file is missing', 'STAGING_ACTOR_MISSING');
  const actor = loadJson(actorPath);
  assert(actor.environmentRole === 'staging', 'actor is not marked as staging', 'STAGING_ACTOR_INVALID');
  assert(typeof actor.userId === 'string' && /^u_[0-9a-f]{32}$/.test(actor.userId), 'actor user ID is invalid');
  assert(SCHOOL_ID_PATTERN.test(String(actor.schoolId || '')), 'actor school is invalid');
  const users = queryCollection(environmentId, 'users', { _id: actor.userId }, 2);
  assert(users.length === 1, 'staging actor user does not exist', 'STAGING_ACTOR_NOT_FOUND');
  const user = users[0];
  assert(user.status === 'active' && user.schoolId === actor.schoolId, 'staging actor is inactive or school drifted');
  assert(typeof user.openid === 'string' && user.openid, 'staging actor identity is unavailable');
  assert(sha256(user.openid) === actor.openidSha256, 'staging actor identity fingerprint drifted');
  return { actor, user };
}

function selectOtherSchool(environmentId, actorSchoolId) {
  const rows = queryCollection(environmentId, 'schools', {
    platformStatus: 'active',
    officialStatus: 'valid'
  }, 100);
  const school = rows.find((item) => SCHOOL_ID_PATTERN.test(String(item._id || '')) && item._id !== actorSchoolId);
  assert(school, 'a second active staging school is required', 'STAGING_SECOND_SCHOOL_MISSING');
  return school;
}

function buildFixture(environmentId, targetMasked, actor, user, otherSchool) {
  const runId = `step4b1-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
  const keys = ['visible-a', 'visible-sold', 'visible-offline', 'visible-reserved', 'visible-b', 'visible-sold-b', 'deleted', 'mutation', 'own', 'cross'];
  const productIds = Object.fromEntries(keys.map((key) => [key, fixtureId('p', runId, key)]));
  const relationKeys = ['visible-a', 'missing', 'visible-sold', 'deleted', 'visible-offline', 'visible-reserved', 'visible-b', 'visible-sold-b'];
  const missingProductId = fixtureId('p', runId, 'missing-no-document');
  const relationProductIds = {
    ...productIds,
    missing: missingProductId
  };
  const favoriteIds = Object.fromEntries(relationKeys.map((key) => [key, favoriteId(user.openid, relationProductIds[key])]));
  const runtimeFavoriteId = favoriteId(user.openid, productIds.mutation);
  const start = Date.UTC(2026, 7, 29, 12, 0, 0);
  const relationTimes = Object.fromEntries(relationKeys.map((key, index) => [key, new Date(start - index * 60000).toISOString()]));
  const sellerOpenid = `step4b1-seller-${sha256(runId).slice(0, 24)}`;
  const sellerId = `u_${sha256(`seller:${runId}`).slice(0, 32)}`;
  const baseProduct = (key, status, schoolId = actor.schoolId, seller = sellerOpenid) => ({
    _id: productIds[key],
    title: `STEP4B1-${key}`,
    description: 'Synthetic staging-only favorite regression fixture',
    price: 12,
    originalPrice: 18,
    categoryId: 'books',
    categoryName: '书籍教材',
    condition: 'good',
    images: [],
    coverLabel: 'STAGING',
    coverTone: 'blue',
    location: 'Staging fixture location',
    campus: actor.campus || '',
    schoolId,
    schoolName: schoolId === actor.schoolId ? actor.schoolName : String(otherSchool.name || ''),
    distanceText: '',
    sellerId: seller === user.openid ? actor.userId : sellerId,
    sellerName: 'Staging Fixture Seller',
    sellerAvatar: '',
    sellerVerified: false,
    sellerOpenid: seller,
    status,
    tags: ['staging', 'step4b1'],
    viewCount: 0,
    favoriteCount: relationKeys.includes(key) ? 1 : 0,
    fixtureRunId: runId,
    createdAt: new Date(start - 3600000).toISOString(),
    updatedAt: new Date(start - 3600000).toISOString()
  });
  const products = [
    baseProduct('visible-a', 'available'),
    baseProduct('visible-sold', 'sold'),
    baseProduct('visible-offline', 'offline'),
    baseProduct('visible-reserved', 'reserved'),
    baseProduct('visible-b', 'available'),
    baseProduct('visible-sold-b', 'sold'),
    baseProduct('deleted', 'deleted'),
    baseProduct('mutation', 'available'),
    baseProduct('own', 'available', actor.schoolId, user.openid),
    baseProduct('cross', 'available', otherSchool._id)
  ];
  const favorites = relationKeys.map((key) => ({
    _id: favoriteIds[key],
    userOpenid: user.openid,
    productId: relationProductIds[key],
    fixtureRunId: runId,
    createdAt: relationTimes[key],
    updatedAt: relationTimes[key]
  }));
  return {
    manifest: {
      schemaVersion: 1,
      status: 'planned-before-write',
      fixtureRunId: runId,
      environmentRole: 'staging',
      environmentMasked: targetMasked,
      environmentFingerprint: sha256(`staging:${environmentId}`),
      purpose: 'Final Release Step 4B-1 staging-only favorites runtime gate',
      createdAt: new Date().toISOString(),
      actorUserId: actor.userId,
      actorOpenidSha256: actor.openidSha256,
      collections: {
        products: products.map((item) => item._id),
        favorites: favorites.map((item) => item._id)
      },
      runtimeFavoriteId,
      productIds,
      missingProductId,
      expected: {
        totalRelations: favorites.length,
        pageSize: 5,
        page1ProductIds: [productIds['visible-a'], productIds['visible-sold'], productIds['visible-offline']],
        page2ProductIds: [productIds['visible-reserved'], productIds['visible-b'], productIds['visible-sold-b']],
        allowedStatuses: ['available', 'sold', 'offline', 'reserved']
      }
    },
    products,
    favorites
  };
}

function existingIds(environmentId, collection, ids) {
  if (!ids.length) return [];
  return queryCollection(environmentId, collection, { _id: { $in: ids } }, Math.max(ids.length, 1))
    .map((item) => item._id)
    .sort();
}

function deleteExactIds(environmentId, collection, ids) {
  if (!ids.length) return;
  runNoSql(environmentId, [{
    TableName: collection,
    CommandType: 'DELETE',
    Command: JSON.stringify({
      delete: collection,
      deletes: ids.map((id) => ({ q: { _id: id }, limit: 1 }))
    })
  }]);
}

async function run(options) {
  const write = options.action !== 'audit';
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: write ? 'cleanup' : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !write,
    allowInactiveStagingWrite: write
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.environmentName === 'staging' && preflight.environmentId === targets.staging,
    'registered staging target is required', 'STAGING_TARGET_MISMATCH');
  assert(preflight.environmentId !== targets.production, 'production target is forbidden', 'PRODUCTION_TARGET_REJECTED');

  if (options.action === 'prepare') {
    if (fs.existsSync(options.manifestPath)) {
      const previous = loadJson(options.manifestPath);
      assert(previous.status === 'cleaned-and-verified' && Number(previous.leftoverFixtureCount || 0) === 0,
        'fixture manifest already exists; cleanup it before preparing another run', 'FIXTURE_MANIFEST_EXISTS');
    }
    const { actor, user } = readActor(preflight.environmentId, options.actorPath);
    const otherSchool = selectOtherSchool(preflight.environmentId, actor.schoolId);
    const fixture = buildFixture(preflight.environmentId, preflight.environmentIdMasked, actor, user, otherSchool);
    writePrivateJson(options.manifestPath, fixture.manifest);
    const productExisting = existingIds(preflight.environmentId, 'products', fixture.manifest.collections.products);
    const favoriteExisting = existingIds(preflight.environmentId, 'favorites', fixture.manifest.collections.favorites);
    assert(productExisting.length === 0 && favoriteExisting.length === 0, 'fixture document ID collision', 'FIXTURE_ID_COLLISION');
    for (const product of fixture.products) {
      insertDocuments(preflight.environmentId, 'products', [product]);
    }
    for (let offset = 0; offset < fixture.favorites.length; offset += 2) {
      insertDocuments(preflight.environmentId, 'favorites', fixture.favorites.slice(offset, offset + 2));
    }
    const productsAfter = existingIds(preflight.environmentId, 'products', fixture.manifest.collections.products);
    const favoritesAfter = existingIds(preflight.environmentId, 'favorites', fixture.manifest.collections.favorites);
    assert(productsAfter.length === fixture.products.length && favoritesAfter.length === fixture.favorites.length,
      'fixture readback count mismatch', 'FIXTURE_WRITE_INCOMPLETE');
    fixture.manifest.status = 'prepared-and-verified';
    fixture.manifest.preparedAt = new Date().toISOString();
    fixture.manifest.createdFixtureCount = fixture.products.length + fixture.favorites.length;
    writePrivateJson(options.manifestPath, fixture.manifest);
    return {
      mode: 'prepared-and-verified',
      environment: publicSummary(preflight),
      fixtureRunId: fixture.manifest.fixtureRunId,
      productFixtures: fixture.products.length,
      favoriteFixtures: fixture.favorites.length,
      createdFixtureCount: fixture.manifest.createdFixtureCount,
      manifestWrittenBeforeWrites: true,
      productionWrites: 0
    };
  }

  assert(fs.existsSync(options.manifestPath), 'fixture manifest is missing', 'FIXTURE_MANIFEST_MISSING');
  const manifest = loadJson(options.manifestPath);
  assert(manifest.environmentRole === 'staging'
    && manifest.environmentFingerprint === sha256(`staging:${preflight.environmentId}`),
  'fixture manifest environment mismatch', 'FIXTURE_ENVIRONMENT_MISMATCH');
  const productIds = [...manifest.collections.products];
  const favoriteIds = [...manifest.collections.favorites, manifest.runtimeFavoriteId];
  const before = {
    products: existingIds(preflight.environmentId, 'products', productIds),
    favorites: existingIds(preflight.environmentId, 'favorites', favoriteIds)
  };
  if (options.action === 'audit') {
    return {
      mode: 'audit',
      environment: publicSummary(preflight),
      fixtureRunId: manifest.fixtureRunId,
      leftovers: before.products.length + before.favorites.length,
      productLeftovers: before.products.length,
      favoriteLeftovers: before.favorites.length,
      passed: before.products.length + before.favorites.length === 0,
      writesExecuted: false
    };
  }

  deleteExactIds(preflight.environmentId, 'favorites', before.favorites);
  deleteExactIds(preflight.environmentId, 'products', before.products);
  const after = {
    products: existingIds(preflight.environmentId, 'products', productIds),
    favorites: existingIds(preflight.environmentId, 'favorites', favoriteIds)
  };
  assert(after.products.length === 0 && after.favorites.length === 0, 'fixture cleanup left orphan documents', 'FIXTURE_CLEANUP_INCOMPLETE');
  const deletedFixtureCount = before.products.length + before.favorites.length;
  assert(deletedFixtureCount === Number(manifest.createdFixtureCount || 0),
    'created/deleted fixture counts differ', 'FIXTURE_CLEANUP_COUNT_MISMATCH');
  manifest.status = 'cleaned-and-verified';
  manifest.cleanedAt = new Date().toISOString();
  manifest.deletedFixtureCount = deletedFixtureCount;
  manifest.leftoverFixtureCount = 0;
  writePrivateJson(options.manifestPath, manifest);
  return {
    mode: 'cleaned-and-verified',
    environment: publicSummary(preflight),
    fixtureRunId: manifest.fixtureRunId,
    createdFixtureCount: manifest.createdFixtureCount,
    deletedFixtureCount,
    leftovers: 0,
    productionWrites: 0
  };
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STEP4B1_FIXTURE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { MANIFEST_PATH, ACTOR_PATH, parseArguments, favoriteId, run };
