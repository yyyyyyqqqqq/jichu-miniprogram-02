const fs = require('fs');
const path = require('path');
const {
  ROOT
} = require('./schools/core');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runCloudBase,
  runNoSql,
  extractCommandResults,
  extractDocuments
} = require('./schools/cloud-cli');

const FIXTURE_PREFIX = '阶段18同校灰度-';
const PRIVATE_BOOTSTRAP_PATH = path.join(
  ROOT,
  'tmp',
  'phase-18-school-change-private-result.json'
);
const PRIVATE_CANARY_PATH = path.join(
  ROOT,
  'tmp',
  'phase-18-school-scoped-canary-private.json'
);
const USER_ID_PATTERN = /^u_[0-9a-f]{32}$/;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const PRODUCT_ID_PATTERN = /^p_[0-9a-f]{32}$/;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function maskId(value) {
  const text = normalizeText(value);
  return text.length > 12
    ? `${text.slice(0, 8)}***${text.slice(-4)}`
    : text ? `${text.slice(0, 3)}***` : '';
}

function assert(condition, message, code = 'PHASE18_CANARY_PRECONDITION_FAILED') {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadBootstrapPrivate(filePath = PRIVATE_BOOTSTRAP_PATH) {
  assert(fs.existsSync(filePath), 'private Phase 18 bootstrap file is missing');
  const value = loadJson(filePath);
  assert(USER_ID_PATTERN.test(normalizeText(value.userId)), 'private userId is invalid');
  assert(
    value.schoolA && SCHOOL_ID_PATTERN.test(normalizeText(value.schoolA.id)),
    'private school A is invalid'
  );
  assert(
    value.schoolB && SCHOOL_ID_PATTERN.test(normalizeText(value.schoolB.id)),
    'private school B is invalid'
  );
  assert(value.schoolA.id !== value.schoolB.id, 'private schools must differ');
  assert(PRODUCT_ID_PATTERN.test(normalizeText(value.productAId)), 'private product A is invalid');
  assert(PRODUCT_ID_PATTERN.test(normalizeText(value.productBId)), 'private product B is invalid');
  return value;
}

function mongoDate(value) {
  const time = new Date(value).getTime();
  assert(Number.isFinite(time), 'fixture date is invalid');
  return {
    $date: {
      $numberLong: String(time)
    }
  };
}

function queryCollection(environmentId, collection, options = {}) {
  const command = {
    TableName: collection,
    CommandType: 'QUERY',
    Command: JSON.stringify({
      find: collection,
      filter: options.filter || {},
      projection: options.projection || { _id: 1 },
      sort: options.sort || { _id: 1 },
      limit: Math.min(Math.max(Number(options.limit) || 100, 1), 1000)
    })
  };
  const response = runNoSql(environmentId, [command]);
  const results = extractCommandResults(response);
  return results.length > 0
    ? results.flatMap((result) => extractDocuments(result))
    : extractDocuments(response);
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

function readFunctionDetail(environmentId, functionName) {
  const response = runCloudBase([
    'fn', 'detail', functionName,
    '--envId', environmentId,
    '--json'
  ], { timeoutMs: 180000 });
  return response && (response.data || response.Response || response) || {};
}

function buildFixtureSpecs() {
  const sharedTimestamp = '2026-08-05T12:00:00.000Z';
  const aPublic = Array.from({ length: 12 }, (_, index) => {
    const number = index + 1;
    const price = number <= 7 ? 10 : number <= 10 ? 20 : 30;
    return {
      key: `A-${String(number).padStart(2, '0')}`,
      school: 'A',
      title: `${FIXTURE_PREFIX}A-${String(number).padStart(2, '0')}`,
      requestId: `phase18_canary_20260806_a_${String(number).padStart(2, '0')}`,
      status: number === 1 ? 'reserved' : 'available',
      categoryId: number <= 8 ? 'books' : 'digital',
      price,
      favoriteCount: number <= 7 ? 9 : number <= 10 ? 5 : 2,
      viewCount: number <= 7 ? 90 : number <= 10 ? 50 : 20,
      createdAt: number <= 7
        ? sharedTimestamp
        : `2026-08-05T${String(12 - number).padStart(2, '0')}:00:00.000Z`,
      public: true
    };
  });
  const aOffline = {
    key: 'A-13',
    school: 'A',
    title: `${FIXTURE_PREFIX}A-13-非公开`,
    requestId: 'phase18_canary_20260806_a_13',
    status: 'offline',
    categoryId: 'books',
    price: 40,
    favoriteCount: 0,
    viewCount: 0,
    createdAt: '2026-08-05T01:00:00.000Z',
    public: false
  };
  const bPublic = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    return {
      key: `B-${String(number).padStart(2, '0')}`,
      school: 'B',
      title: `${FIXTURE_PREFIX}B-${String(number).padStart(2, '0')}`,
      requestId: `phase18_canary_20260806_b_${String(number).padStart(2, '0')}`,
      status: number === 1 ? 'reserved' : 'available',
      categoryId: number <= 3 ? 'books' : 'digital',
      price: number <= 2 ? 10 : number === 3 ? 20 : 30,
      favoriteCount: number <= 3 ? 7 : 3,
      viewCount: number <= 3 ? 70 : 30,
      createdAt: number <= 3
        ? '2026-08-05T11:00:00.000Z'
        : `2026-08-05T0${6 - number}:00:00.000Z`,
      public: true
    };
  });
  const bOffline = {
    key: 'B-06',
    school: 'B',
    title: `${FIXTURE_PREFIX}B-06-非公开`,
    requestId: 'phase18_canary_20260806_b_06',
    status: 'offline',
    categoryId: 'books',
    price: 40,
    favoriteCount: 0,
    viewCount: 0,
    createdAt: '2026-08-05T01:30:00.000Z',
    public: false
  };
  const noSchool = {
    key: 'N-01',
    school: 'B',
    title: `${FIXTURE_PREFIX}N-01-无学校历史`,
    requestId: 'phase18_canary_20260806_n_01',
    status: 'available',
    categoryId: 'books',
    price: 10,
    favoriteCount: 9,
    viewCount: 90,
    createdAt: sharedTimestamp,
    public: true,
    removeSchool: true
  };
  return [...aPublic, aOffline, ...bPublic, bOffline, noSchool];
}

function publicSummary(specs) {
  return specs.map((spec) => ({
    key: spec.key,
    title: spec.title,
    school: spec.removeSchool ? 'none' : spec.school,
    status: spec.status,
    categoryId: spec.categoryId,
    price: spec.price,
    favoriteCount: spec.favoriteCount,
    viewCount: spec.viewCount,
    createdAt: spec.createdAt
  }));
}

module.exports = {
  ROOT,
  FIXTURE_PREFIX,
  PRIVATE_BOOTSTRAP_PATH,
  PRIVATE_CANARY_PATH,
  USER_ID_PATTERN,
  SCHOOL_ID_PATTERN,
  PRODUCT_ID_PATTERN,
  normalizeText,
  maskId,
  assert,
  loadJson,
  loadBootstrapPrivate,
  mongoDate,
  queryCollection,
  writePrivateJson,
  readFunctionDetail,
  buildFixtureSpecs,
  publicSummary,
  loadEnvironmentId,
  maskEnvironmentId,
  runCloudBase,
  runNoSql
};
