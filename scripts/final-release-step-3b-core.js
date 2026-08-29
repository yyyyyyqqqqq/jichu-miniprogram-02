const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { ROOT, publicSummary, assert } = require('./environment-preflight');
const schoolCore = require('./schools/core');
const {
  runCloudBase,
  runNoSql,
  extractCommandResults,
  extractDocuments,
  readAllSchools
} = require('./schools/cloud-cli');
const { queryAll, stableStringify } = require('./final-release-product-cleanup-dry-run');
const { readFunctionDetail } = require('./phase-18-canary-core');
const { readIndexes, indexMatches } = require('./phase-24-staging-core');

const EXPECTED_XLS_SHA256 = 'a0ceb41a15f335c0adfb2d0239137b879b1c58d1b57a322d3e1794866de7d09c';
const EXPECTED_NORMALIZED_SHA256 = 'cf69adbecbeda6d7de3150a8fc19616bd09c2d9cdc2d0fac5e90d55ae2a2fcd3';
const EXPECTED_TOTAL = 2952;
const EXPECTED_TARGET_COUNT = 2950;
const AUTHORIZATION_PHRASE = 'FINAL RELEASE STEP 3B PRODUCTION NATIONWIDE SCHOOL ACTIVATION';
const SCHOOL_SECRET_KEY = 'SCHOOL_QUERY_CURSOR_HMAC_SECRET';
const SECRET_PATH = path.join(ROOT, 'tmp', 'final-release-step-3b-production-school-secret.json');
const BEFORE_PATH = path.join(ROOT, 'tmp', 'final-release-step-3b-before-activation.json');
const MANIFEST_PATH = path.join(ROOT, 'tmp', 'final-release-step-3b-activation-manifest.json');
const STATE_PATH = path.join(ROOT, 'tmp', 'final-release-step-3b-operation-state.json');
const FINAL_AUDIT_PATH = path.join(ROOT, 'tmp', 'final-release-step-3b-final-audit.json');
const QUERY_AUDIT_PATH = path.join(ROOT, 'tmp', 'final-release-step-3b-query-audit.json');
const CHECKPOINTS = Object.freeze([20, 100, 500, 1000, 2000, 2950]);
const OFFICIAL_FIELDS = Object.freeze([
  '_id', 'officialCode', 'name', 'nameNormalized', 'province', 'city',
  'educationLevel', 'authority', 'remark', 'officialStatus', 'dataSource',
  'sourceYear', 'sourceVersion', 'sourceRow'
]);
const BUSINESS_COLLECTIONS = Object.freeze([
  'users', 'products', 'favorites', 'conversations', 'messages',
  'appointments', 'productViews'
]);
const FUNCTION_NAMES = Object.freeze([
  'appointmentAction', 'appointmentQuery', 'authUser', 'createProduct',
  'favoriteProduct', 'manageProduct', 'messageAction', 'messageQuery',
  'productQuery', 'productViewAction', 'schoolQuery', 'userQuery'
]);
const REQUIRED_INDEXES = Object.freeze([
  Object.freeze({
    name: 'idx_officialCode_unique',
    unique: true,
    keys: Object.freeze([['officialCode', 1]])
  }),
  Object.freeze({
    name: 'idx_school_active_name_id',
    unique: false,
    keys: Object.freeze([
      ['platformStatus', 1], ['officialStatus', 1], ['nameNormalized', 1], ['_id', 1]
    ])
  }),
  Object.freeze({
    name: 'idx_school_active_province_name_id',
    unique: false,
    keys: Object.freeze([
      ['platformStatus', 1], ['officialStatus', 1], ['province', 1],
      ['nameNormalized', 1], ['_id', 1]
    ])
  })
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function officialProjection(record) {
  return Object.fromEntries(OFFICIAL_FIELDS.map((field) => [
    field,
    record && record[field] === undefined ? null : record && record[field]
  ]));
}

function hashRecords(records) {
  return sha256(stableStringify(records));
}

function countBy(records, field) {
  return records.reduce((counts, record) => {
    const value = String(record && record[field] || '(missing)');
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function duplicateCount(records, field) {
  return records.length - new Set(records.map((record) => String(record && record[field] || ''))).size;
}

function loadNormalized() {
  const records = JSON.parse(fs.readFileSync(schoolCore.NORMALIZED_JSON_PATH, 'utf8'));
  assert(Array.isArray(records), 'normalized school source is not an array', 'NORMALIZED_SOURCE_INVALID');
  return records;
}

function validateSource() {
  const sourceSha256 = hashFile(schoolCore.SOURCE_PATH);
  const normalizedSha256 = hashFile(schoolCore.NORMALIZED_JSON_PATH);
  const rebuilt = schoolCore.normalizeSource(schoolCore.parseSource());
  const persisted = loadNormalized();
  const validation = schoolCore.validateSchools(rebuilt.records);
  const rebuiltSha256 = sha256(schoolCore.stableJson(rebuilt.records));
  const missingRequired = rebuilt.records.filter((record) => (
    !record._id || !record.officialCode || !record.name || !record.nameNormalized
    || !record.province || !record.city || !record.educationLevel || !record.authority
    || !record.officialStatus
  )).length;
  const result = {
    sourceSha256,
    normalizedSha256,
    rebuiltSha256,
    records: rebuilt.records.length,
    persistedRecords: persisted.length,
    missing: persisted.filter((record) => !rebuilt.records.some((item) => item._id === record._id)).length,
    extra: rebuilt.records.filter((record) => !persisted.some((item) => item._id === record._id)).length,
    different: rebuilt.records.filter((record, index) => (
      stableStringify(record) !== stableStringify(persisted[index])
    )).length,
    duplicateId: duplicateCount(rebuilt.records, '_id'),
    duplicateOfficialCode: duplicateCount(rebuilt.records, 'officialCode'),
    duplicateNormalizedName: duplicateCount(rebuilt.records, 'nameNormalized'),
    requiredMissing: missingRequired,
    p0: validation.p0.length,
    p1: validation.p1.length
  };
  assert(sourceSha256 === EXPECTED_XLS_SHA256, 'XLS checksum drifted', 'SOURCE_CHECKSUM_DRIFT');
  assert(normalizedSha256 === EXPECTED_NORMALIZED_SHA256, 'normalized JSON checksum drifted', 'NORMALIZED_CHECKSUM_DRIFT');
  assert(rebuiltSha256 === EXPECTED_NORMALIZED_SHA256, 'rebuilt normalized checksum drifted', 'REBUILD_CHECKSUM_DRIFT');
  assert(result.records === EXPECTED_TOTAL && result.persistedRecords === EXPECTED_TOTAL, 'school source count drifted', 'SOURCE_COUNT_DRIFT');
  assert([
    result.missing, result.extra, result.different, result.duplicateId,
    result.duplicateOfficialCode, result.duplicateNormalizedName,
    result.requiredMissing, result.p0, result.p1
  ].every((count) => count === 0), 'school source validation failed', 'SOURCE_VALIDATION_FAILED');
  return { result, records: rebuilt.records };
}

function compareProductionSchools(normalized, production) {
  const expectedById = new Map(normalized.map((record) => [record._id, record]));
  const productionById = new Map(production.map((record) => [record._id, record]));
  const missing = normalized.filter((record) => !productionById.has(record._id));
  const extra = production.filter((record) => !expectedById.has(record._id));
  const different = production.filter((record) => {
    const expected = expectedById.get(record._id);
    return expected && stableStringify(officialProjection(record)) !== stableStringify(officialProjection(expected));
  });
  const identityConflicts = production.filter((record) => {
    const expected = expectedById.get(record._id);
    return expected && expected.officialCode !== record.officialCode;
  });
  const expectedOfficial = normalized.map(officialProjection).sort((a, b) => a._id.localeCompare(b._id));
  const productionOfficial = production.map(officialProjection).sort((a, b) => a._id.localeCompare(b._id));
  return {
    exactIds: production.length,
    missing: missing.length,
    extra: extra.length,
    different: different.length,
    identityConflicts: identityConflicts.length,
    unexpectedOfficialStatus: production.filter((record) => record.officialStatus !== 'valid').length,
    duplicateId: duplicateCount(production, '_id'),
    duplicateOfficialCode: duplicateCount(production, 'officialCode'),
    duplicateNormalizedName: duplicateCount(production, 'nameNormalized'),
    officialFieldChecksumExpected: hashRecords(expectedOfficial),
    officialFieldChecksumProduction: hashRecords(productionOfficial),
    statusCounts: countBy(production, 'platformStatus')
  };
}

function assertProductionIntegrity(integrity) {
  assert(integrity.exactIds === EXPECTED_TOTAL, 'production school count drifted', 'PRODUCTION_SCHOOL_COUNT_DRIFT');
  assert([
    integrity.missing, integrity.extra, integrity.different,
    integrity.identityConflicts, integrity.unexpectedOfficialStatus,
    integrity.duplicateId, integrity.duplicateOfficialCode,
    integrity.duplicateNormalizedName
  ].every((count) => count === 0), 'production official fields drifted', 'PRODUCTION_OFFICIAL_FIELD_DRIFT');
  assert(
    integrity.officialFieldChecksumExpected === integrity.officialFieldChecksumProduction,
    'production official checksum drifted',
    'PRODUCTION_OFFICIAL_CHECKSUM_DRIFT'
  );
}

function extractQueryDocuments(response) {
  const results = extractCommandResults(response);
  return results.length > 0
    ? results.flatMap((result) => extractDocuments(result))
    : extractDocuments(response);
}

function queryByIds(environmentId, ids) {
  assert(Array.isArray(ids) && ids.length > 0 && ids.length <= 20, 'queryByIds requires 1..20 IDs', 'QUERY_ID_BATCH_INVALID');
  const response = runNoSql(environmentId, [{
    TableName: 'schools',
    CommandType: 'QUERY',
    Command: JSON.stringify({
      find: 'schools',
      filter: { _id: { $in: ids } },
      sort: { _id: 1 },
      limit: 20
    })
  }]);
  return extractQueryDocuments(response);
}

function readBusinessSnapshot(environmentId) {
  const collections = {};
  for (const name of BUSINESS_COLLECTIONS) {
    const records = queryAll(environmentId, name, undefined);
    collections[name] = {
      count: records.length,
      sha256: hashRecords(records)
    };
  }
  const products = queryAll(environmentId, 'products', { _id: 1, status: 1, schoolId: 1 });
  const productStatusCounts = countBy(products, 'status');
  const publicVisible = products.filter((record) => ['available', 'reserved'].includes(record.status)).length;
  assert(Number(productStatusCounts.available || 0) === 0, 'production available products are not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  assert(Number(productStatusCounts.reserved || 0) === 0, 'production reserved products are not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  assert(publicVisible === 0, 'production public visible products are not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  return {
    collections,
    products: {
      total: products.length,
      statusCounts: productStatusCounts,
      publicVisible,
      publicMarketZero: true
    }
  };
}

function readUserProtection(environmentId) {
  const users = queryAll(environmentId, 'users', undefined);
  const referencesBySchool = countBy(users.filter((user) => user.schoolId), 'schoolId');
  const protectedProjection = users.map((user) => ({
    _id: user._id,
    schoolId: user.schoolId || '',
    schoolName: user.schoolName || '',
    schoolChangedAt: user.schoolChangedAt === undefined ? null : user.schoolChangedAt,
    schoolCooldownAt: user.schoolCooldownAt === undefined ? null : user.schoolCooldownAt,
    schoolVersion: user.schoolVersion === undefined ? null : user.schoolVersion
  })).sort((a, b) => a._id.localeCompare(b._id));
  return {
    count: users.length,
    fullSha256: hashRecords(users),
    protectedSha256: hashRecords(protectedProjection),
    referencesBySchool
  };
}

function environmentMap(detail) {
  return Object.fromEntries((detail && detail.Environment && detail.Environment.Variables || []).map((item) => [
    String(item.Key || item.key || ''),
    String(item.Value || item.value || '')
  ]));
}

function environmentFingerprint(detail) {
  const values = Object.entries(environmentMap(detail))
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return sha256(JSON.stringify(values));
}

function functionSummary(environmentId) {
  const detail = readFunctionDetail(environmentId, 'schoolQuery');
  const variables = environmentMap(detail);
  return {
    status: detail.Status || '',
    availableStatus: detail.AvailableStatus || '',
    runtime: detail.Runtime || '',
    handler: detail.Handler || '',
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    sourceSha256: sha256(detail.CodeInfo || ''),
    environmentKeys: Object.keys(variables).sort(),
    environmentFingerprint: environmentFingerprint(detail),
    schoolSecretPresent: Boolean(variables[SCHOOL_SECRET_KEY]),
    schoolSecretFingerprint: variables[SCHOOL_SECRET_KEY]
      ? sha256(variables[SCHOOL_SECRET_KEY]).slice(0, 16)
      : ''
  };
}

function allFunctionSummaries(environmentId) {
  return Object.fromEntries(FUNCTION_NAMES.map((name) => {
    const detail = readFunctionDetail(environmentId, name);
    return [name, {
      status: detail.Status || '',
      availableStatus: detail.AvailableStatus || '',
      runtime: detail.Runtime || '',
      handler: detail.Handler || '',
      timeout: Number(detail.Timeout || 0),
      memorySize: Number(detail.MemorySize || 0),
      sourceSha256: sha256(detail.CodeInfo || ''),
      environmentFingerprint: environmentFingerprint(detail)
    }];
  }));
}

function assertRequiredIndexes(indexes) {
  const byName = new Map(indexes.map((index) => [index.name, index]));
  for (const definition of REQUIRED_INDEXES) {
    assert(indexMatches(byName.get(definition.name) || {}, definition), `${definition.name} missing or drifted`, 'SCHOOL_INDEX_MISSING');
  }
}

function parseInvocation(response) {
  const root = response && (response.data || response.Response || response) || {};
  assert(Number(root.InvokeResult) === 0, 'schoolQuery invocation failed', 'SCHOOL_QUERY_INVOKE_FAILED');
  return {
    result: JSON.parse(String(root.RetMsg || '{}')),
    remoteDurationMs: Number(root.Duration || 0),
    memoryBytes: Number(root.MemUsage || 0),
    payloadBytes: Buffer.byteLength(String(root.RetMsg || ''), 'utf8')
  };
}

function invokeSchoolQuery(environmentId, event) {
  const started = performance.now();
  const response = runCloudBase([
    '--env-id', environmentId,
    'fn', 'invoke', 'schoolQuery',
    '--params', JSON.stringify(event),
    '--json'
  ], { timeoutMs: 120000 });
  const parsed = parseInvocation(response);
  return {
    ...parsed,
    elapsedMs: Math.round(performance.now() - started)
  };
}

function gitSummary() {
  const run = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const status = run(['status', '--short', '--untracked-files=all']).split(/\r?\n/).filter(Boolean);
  return {
    branch: run(['branch', '--show-current']),
    head: run(['rev-parse', 'HEAD']),
    originMain: run(['rev-parse', 'origin/main']),
    aheadBehind: run(['rev-list', '--left-right', '--count', 'main...origin/main']),
    staged: status.filter((line) => line[0] !== ' ' && line[0] !== '?').length,
    modified: status.filter((line) => line[1] !== ' ' && line[0] !== '?').length,
    untracked: status.filter((line) => line.startsWith('??')).length
  };
}

function safeWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readJson(filePath, code = 'PRIVATE_INPUT_MISSING') {
  assert(fs.existsSync(filePath), `${path.basename(filePath)} is unavailable`, code);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  ROOT,
  EXPECTED_XLS_SHA256,
  EXPECTED_NORMALIZED_SHA256,
  EXPECTED_TOTAL,
  EXPECTED_TARGET_COUNT,
  AUTHORIZATION_PHRASE,
  SCHOOL_SECRET_KEY,
  SECRET_PATH,
  BEFORE_PATH,
  MANIFEST_PATH,
  STATE_PATH,
  FINAL_AUDIT_PATH,
  QUERY_AUDIT_PATH,
  CHECKPOINTS,
  OFFICIAL_FIELDS,
  BUSINESS_COLLECTIONS,
  FUNCTION_NAMES,
  REQUIRED_INDEXES,
  sha256,
  hashFile,
  officialProjection,
  hashRecords,
  countBy,
  loadNormalized,
  validateSource,
  compareProductionSchools,
  assertProductionIntegrity,
  queryByIds,
  readAllSchools,
  readBusinessSnapshot,
  readUserProtection,
  environmentMap,
  environmentFingerprint,
  functionSummary,
  allFunctionSummaries,
  readIndexes,
  assertRequiredIndexes,
  invokeSchoolQuery,
  gitSummary,
  safeWriteJson,
  readJson,
  publicSummary,
  assert,
  stableStringify
};
