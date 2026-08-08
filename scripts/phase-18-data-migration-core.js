const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readiness = require('./audit-phase-18-user-school-readiness');
const {
  ROOT,
  FIXTURE_PREFIX,
  USER_ID_PATTERN,
  SCHOOL_ID_PATTERN,
  normalizeText,
  maskId,
  assert,
  queryCollection,
  writePrivateJson,
  loadEnvironmentId,
  maskEnvironmentId,
  runNoSql
} = require('./phase-18-canary-core');

const TARGET_SCHOOL_NAME = '上海工程技术大学';
const PRIVATE_RESULT_PATH = path.join(ROOT, 'tmp', 'phase-18-data-migration-private.json');
const EXPECTED_MISSING_USERS = 4;
const EXPECTED_PUBLIC_PRODUCTS = 20;
const PUBLIC_STATUSES = new Set(['available', 'reserved']);
const MIGRATABLE_PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const USER_PROJECTION = Object.freeze({
  _id: 1,
  status: 1,
  profileCompleted: 1,
  nickname: 1,
  avatarUrl: 1,
  schoolId: 1,
  schoolName: 1,
  schoolSelectedAt: 1,
  schoolUpdatedAt: 1,
  schoolVersion: 1,
  createdAt: 1,
  updatedAt: 1
});

const PRODUCT_PROJECTION = Object.freeze({
  _id: 1,
  title: 1,
  sellerId: 1,
  status: 1,
  schoolId: 1,
  schoolName: 1,
  price: 1,
  createdAt: 1,
  updatedAt: 1
});

function stableFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function userProtectedFingerprint(user) {
  return stableFingerprint({
    status: user.status,
    profileCompleted: user.profileCompleted,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    schoolSelectedAt: user.schoolSelectedAt,
    createdAt: user.createdAt
  });
}

function productProtectedSnapshot(product) {
  return {
    title: product.title,
    sellerId: product.sellerId,
    status: product.status,
    price: product.price,
    createdAt: product.createdAt
  };
}

function productProtectedFingerprint(product) {
  return stableFingerprint(productProtectedSnapshot(product));
}

function loadPrivateResult(filePath = PRIVATE_RESULT_PATH) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function updatePrivateResult(filePath, changes) {
  const existing = loadPrivateResult(filePath) || {
    schemaVersion: 1,
    createdAt: new Date().toISOString()
  };
  writePrivateJson(filePath, Object.assign({}, existing, changes, {
    updatedAt: new Date().toISOString()
  }));
}

function parseArguments(argv) {
  const options = {
    confirmTarget: '',
    apply: false,
    output: PRIVATE_RESULT_PATH
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') options.confirmTarget = normalizeText(argv[++index]);
    else if (value === '--apply') options.apply = true;
    else if (value === '--output') options.output = path.resolve(normalizeText(argv[++index]));
    else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

function prepareContext(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(
    options.confirmTarget === targetMasked,
    `confirm target with --confirm-target ${targetMasked}`,
    'TARGET_ENV_CONFIRMATION_REQUIRED'
  );
  const snapshot = readiness.readSnapshot(environmentId);
  const targetMatches = snapshot.schools.filter((school) => normalizeText(school.name) === TARGET_SCHOOL_NAME);
  assert(targetMatches.length === 1, 'target school must resolve to exactly one record');
  const targetSchool = targetMatches[0];
  assert(SCHOOL_ID_PATTERN.test(normalizeText(targetSchool._id)), 'target school ID format is invalid');
  assert(targetSchool.platformStatus === 'active', 'target school is not active');
  assert(targetSchool.officialStatus === 'valid', 'target school is not officially valid');
  const report = readiness.createReport(snapshot, snapshot, targetMasked);
  return { environmentId, targetMasked, snapshot, report, targetSchool };
}

function publicTargetSchool(school) {
  return {
    name: school.name,
    id: maskId(school._id),
    platformStatus: school.platformStatus,
    officialStatus: school.officialStatus
  };
}

function privateTargetSchool(school) {
  return {
    id: school._id,
    name: school.name,
    platformStatus: school.platformStatus,
    officialStatus: school.officialStatus
  };
}

function readinessSummary(report) {
  return {
    users: {
      total: report.users.total,
      active: report.users.active,
      ready: report.users.validActiveSchool,
      missing: report.users.schoolStateCounts.missing || 0,
      states: report.users.schoolStateCounts
    },
    products: {
      businessTotal: report.businessProductsExcludingFixtures.total,
      public: report.businessProductsExcludingFixtures.publicTotal,
      strictReady: report.businessProductsExcludingFixtures.publicStrictReady,
      notReady: report.businessProductsExcludingFixtures.publicNotStrictReady,
      readinessRatio: report.businessProductsExcludingFixtures.publicReadinessRatio
    },
    fixtures: report.fixtures
  };
}

function queryExact(environmentId, collection, ids, projection) {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  return queryCollection(environmentId, collection, {
    filter: {},
    projection,
    sort: { _id: 1 },
    limit: 1000
  }).filter((record) => idSet.has(record._id));
}

function missingFieldCondition(record, field) {
  return Object.prototype.hasOwnProperty.call(record, field)
    ? record[field]
    : { $exists: false };
}

function applyUpdates(environmentId, collection, updates, batchSize = 4) {
  for (let offset = 0; offset < updates.length; offset += batchSize) {
    const batch = updates.slice(offset, offset + batchSize);
    assert(batch.every((item) => item.multi === false && item.upsert === false), 'unsafe migration update shape');
    runNoSql(environmentId, [{
      TableName: collection,
      CommandType: 'UPDATE',
      Command: JSON.stringify({
        update: collection,
        updates: batch,
        ordered: true
      })
    }]);
  }
}

function buildUserPlan(context) {
  const schoolById = new Map(context.snapshot.schools.map((school) => [school._id, school]));
  const candidates = context.snapshot.users.filter((user) => (
    user.status === 'active'
    && readiness.schoolState(user, schoolById).state === 'missing'
  ));
  assert(candidates.length === EXPECTED_MISSING_USERS, `expected ${EXPECTED_MISSING_USERS} missing active users, found ${candidates.length}`);
  const details = queryExact(context.environmentId, 'users', candidates.map((item) => item._id), USER_PROJECTION);
  assert(details.length === EXPECTED_MISSING_USERS, 'user migration detail count mismatch');
  details.forEach((user) => {
    assert(USER_ID_PATTERN.test(normalizeText(user._id)), 'user migration contains an invalid ID');
    assert(user.status === 'active' && !normalizeText(user.schoolId), 'user no longer satisfies migration condition');
  });
  return details.map((user) => ({
    userId: user._id,
    before: {
      schoolId: normalizeText(user.schoolId),
      schoolName: normalizeText(user.schoolName),
      schoolVersion: Number.isInteger(Number(user.schoolVersion)) ? Number(user.schoolVersion) : 0,
      schoolSelectedAt: user.schoolSelectedAt || null,
      protectedFingerprint: userProtectedFingerprint(user)
    }
  }));
}

function buildProductPlan(context) {
  const schoolById = new Map(context.snapshot.schools.map((school) => [school._id, school]));
  const candidates = context.snapshot.products.filter((product) => (
    PUBLIC_STATUSES.has(product.status)
    && !normalizeText(product.title).startsWith(FIXTURE_PREFIX)
    && readiness.schoolState(product, schoolById).state !== 'valid'
  ));
  assert(candidates.length === EXPECTED_PUBLIC_PRODUCTS, `expected ${EXPECTED_PUBLIC_PRODUCTS} public products, found ${candidates.length}`);
  candidates.forEach((product) => {
    assert(readiness.schoolState(product, schoolById).state === 'missing', 'product migration would overwrite a non-missing school state');
  });
  const details = queryExact(context.environmentId, 'products', candidates.map((item) => item._id), PRODUCT_PROJECTION);
  assert(
    details.length === EXPECTED_PUBLIC_PRODUCTS,
    `product migration detail count mismatch: expected ${EXPECTED_PUBLIC_PRODUCTS}, found ${details.length}`
  );
  details.forEach((product) => {
    assert(MIGRATABLE_PRODUCT_ID_PATTERN.test(normalizeText(product._id)), 'product migration contains an invalid ID');
    assert(PUBLIC_STATUSES.has(product.status), 'product is no longer public');
    assert(!normalizeText(product.title).startsWith(FIXTURE_PREFIX), 'Phase 18 fixture entered the business migration');
    assert(!normalizeText(product.schoolId), 'product no longer satisfies migration condition');
  });
  return details.map((product) => ({
    productId: product._id,
    before: {
      title: normalizeText(product.title),
      sellerId: normalizeText(product.sellerId),
      status: product.status,
      schoolId: normalizeText(product.schoolId),
      schoolName: normalizeText(product.schoolName),
      price: product.price,
      createdAt: product.createdAt || null,
      protectedFingerprint: productProtectedFingerprint(product)
    }
  }));
}

module.exports = {
  ROOT,
  TARGET_SCHOOL_NAME,
  PRIVATE_RESULT_PATH,
  EXPECTED_MISSING_USERS,
  EXPECTED_PUBLIC_PRODUCTS,
  USER_PROJECTION,
  PRODUCT_PROJECTION,
  parseArguments,
  prepareContext,
  publicTargetSchool,
  privateTargetSchool,
  readinessSummary,
  loadPrivateResult,
  updatePrivateResult,
  queryExact,
  missingFieldCondition,
  applyUpdates,
  userProtectedFingerprint,
  productProtectedFingerprint,
  buildUserPlan,
  buildProductPlan,
  maskId,
  assert
};
