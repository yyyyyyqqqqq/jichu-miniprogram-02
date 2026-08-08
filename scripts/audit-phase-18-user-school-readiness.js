const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runNoSql,
  extractCommandResults,
  extractDocuments
} = require('./schools/cloud-cli');

const ROOT = path.resolve(__dirname, '..');
const MODE = 'dry-run-read-only';
const PAGE_SIZE = 1000;
const MAX_RECORDS = 50000;
const PUBLIC_STATUSES = new Set(['available', 'reserved']);
const FIXTURE_PREFIX = '阶段18同校灰度-';
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const PROJECTIONS = Object.freeze({
  users: {
    _id: 1,
    status: 1,
    profileCompleted: 1,
    nickname: 1,
    avatarUrl: 1,
    schoolId: 1,
    schoolName: 1,
    schoolVersion: 1,
    schoolSelectedAt: 1,
    schoolUpdatedAt: 1
  },
  products: {
    _id: 1,
    title: 1,
    status: 1,
    schoolId: 1,
    schoolName: 1,
    sellerId: 1
  },
  schools: {
    _id: 1,
    name: 1,
    platformStatus: 1,
    officialStatus: 1
  }
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function maskId(value) {
  const text = normalizeText(value);
  return text.length > 12 ? `${text.slice(0, 8)}***${text.slice(-4)}` : text ? `${text.slice(0, 3)}***` : '';
}

function assert(condition, message, code = 'PHASE18_READINESS_FAILED') {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

function buildFindCommand(collection, projection, skip, limit = PAGE_SIZE) {
  return {
    TableName: collection,
    CommandType: 'QUERY',
    Command: JSON.stringify({
      find: collection,
      filter: {},
      projection,
      sort: { _id: 1 },
      skip,
      limit
    })
  };
}

function assertReadOnlyCommand(command) {
  assert(command && command.CommandType === 'QUERY', 'readiness command must be QUERY-only');
  const parsed = JSON.parse(command.Command);
  assert(parsed.find === command.TableName, 'readiness command targets an unexpected collection');
  assert(!parsed.update && !parsed.delete && !parsed.insert, 'readiness command contains a write operation');
  return true;
}

function extractQueryDocuments(response) {
  const results = extractCommandResults(response);
  return results.length > 0
    ? results.flatMap((result) => extractDocuments(result))
    : extractDocuments(response);
}

function readCollection(environmentId, collection, projection) {
  const records = [];
  for (let skip = 0; skip < MAX_RECORDS; skip += PAGE_SIZE) {
    const command = buildFindCommand(collection, projection, skip, PAGE_SIZE);
    assertReadOnlyCommand(command);
    const page = extractQueryDocuments(runNoSql(environmentId, [command]));
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
  const error = new Error(`${collection} reached the read safety limit`);
  error.code = 'PHASE18_READINESS_READ_LIMIT';
  throw error;
}

function readSnapshot(environmentId) {
  return Object.fromEntries(Object.entries(PROJECTIONS).map(([collection, projection]) => [
    collection,
    readCollection(environmentId, collection, projection)
  ]));
}

function stableHash(records) {
  return crypto.createHash('sha256').update(JSON.stringify(
    [...records].sort((left, right) => normalizeText(left._id).localeCompare(normalizeText(right._id)))
  )).digest('hex');
}

function schoolState(record, schoolById) {
  const schoolId = normalizeText(record && record.schoolId);
  if (!schoolId) return { state: 'missing', school: null };
  if (!SCHOOL_ID_PATTERN.test(schoolId)) return { state: 'invalidFormat', school: null };
  const school = schoolById.get(schoolId) || null;
  if (!school) return { state: 'notFound', school: null };
  if (school.platformStatus !== 'active' || school.officialStatus !== 'valid' || !normalizeText(school.name)) {
    return { state: 'unavailable', school };
  }
  if (normalizeText(record.schoolName) !== normalizeText(school.name)) return { state: 'nameMismatch', school };
  return { state: 'valid', school };
}

function aggregateBy(records, selector) {
  return Object.fromEntries([...records.reduce((map, record) => {
    const key = normalizeText(selector(record)) || '(missing)';
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

function buildAnomalySamples(records, stateById, maximum = 5) {
  return records.filter((record) => stateById.get(record._id) !== 'valid').slice(0, maximum).map((record) => ({
    id: maskId(record._id),
    state: stateById.get(record._id),
    status: normalizeText(record.status)
  }));
}

function createReport(before, after, targetMasked) {
  const schoolById = new Map(before.schools.map((school) => [school._id, school]));
  const activeSchools = before.schools.filter((school) => (
    school.platformStatus === 'active'
    && school.officialStatus === 'valid'
    && normalizeText(school.name)
  ));
  const userStateById = new Map(before.users.map((user) => [user._id, schoolState(user, schoolById).state]));
  const productStateById = new Map(before.products.map((product) => [product._id, schoolState(product, schoolById).state]));
  const activeUsers = before.users.filter((user) => user.status === 'active');
  const completeProfiles = before.users.filter((user) => (
    user.profileCompleted === true
    && normalizeText(user.nickname)
    && normalizeText(user.nickname) !== '微信用户'
    && normalizeText(user.avatarUrl)
  ));
  const publicProducts = before.products.filter((product) => PUBLIC_STATUSES.has(product.status));
  const strictReadyPublic = publicProducts.filter((product) => productStateById.get(product._id) === 'valid');
  const fixtures = before.products.filter((product) => normalizeText(product.title).startsWith(FIXTURE_PREFIX));
  const fixtureIds = new Set(fixtures.map((product) => product._id));
  const businessProducts = before.products.filter((product) => !fixtureIds.has(product._id));
  const publicBusinessProducts = businessProducts.filter((product) => PUBLIC_STATUSES.has(product.status));
  const strictReadyPublicBusiness = publicBusinessProducts.filter((product) => productStateById.get(product._id) === 'valid');
  const userStateCounts = aggregateBy(before.users, (user) => userStateById.get(user._id));
  const productStateCounts = aggregateBy(before.products, (product) => productStateById.get(product._id));
  const publicStateCounts = aggregateBy(publicProducts, (product) => productStateById.get(product._id));
  const hashesBefore = Object.fromEntries(Object.entries(before).map(([name, records]) => [name, stableHash(records)]));
  const hashesAfter = Object.fromEntries(Object.entries(after).map(([name, records]) => [name, stableHash(records)]));
  const unchanged = Object.keys(hashesBefore).every((name) => hashesBefore[name] === hashesAfter[name]);
  const userReadyForStrictAll = activeUsers.length === before.users.length
    && completeProfiles.length === before.users.length
    && userStateCounts.valid === before.users.length;
  const productsReadyForStrictAll = strictReadyPublic.length === publicProducts.length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: MODE,
    target: `cloud:${targetMasked}`,
    users: {
      total: before.users.length,
      statusCounts: aggregateBy(before.users, (user) => user.status),
      active: activeUsers.length,
      profileCompleted: before.users.filter((user) => user.profileCompleted === true).length,
      fullyValidProfile: completeProfiles.length,
      validActiveSchool: before.users.filter((user) => userStateById.get(user._id) === 'valid').length,
      schoolStateCounts: userStateCounts,
      schoolVersionPresent: before.users.filter((user) => Number.isInteger(Number(user.schoolVersion))).length,
      anomalySamples: buildAnomalySamples(before.users, userStateById),
      readyForStrictForAll: userReadyForStrictAll
    },
    products: {
      total: before.products.length,
      statusCounts: aggregateBy(before.products, (product) => product.status),
      withValidSchool: before.products.filter((product) => productStateById.get(product._id) === 'valid').length,
      schoolStateCounts: productStateCounts,
      publicTotal: publicProducts.length,
      publicStrictReady: strictReadyPublic.length,
      publicNotStrictReady: publicProducts.length - strictReadyPublic.length,
      publicSchoolStateCounts: publicStateCounts,
      publicReadinessRatio: publicProducts.length > 0
        ? Number((strictReadyPublic.length / publicProducts.length).toFixed(6))
        : 1,
      anomalySamples: buildAnomalySamples(publicProducts, productStateById),
      readyForStrictForAll: productsReadyForStrictAll
    },
    businessProductsExcludingFixtures: {
      total: businessProducts.length,
      publicTotal: publicBusinessProducts.length,
      publicStrictReady: strictReadyPublicBusiness.length,
      publicNotStrictReady: publicBusinessProducts.length - strictReadyPublicBusiness.length,
      publicReadinessRatio: publicBusinessProducts.length > 0
        ? Number((strictReadyPublicBusiness.length / publicBusinessProducts.length).toFixed(6))
        : 1
    },
    fixtures: {
      prefix: FIXTURE_PREFIX,
      total: fixtures.length,
      statusCounts: aggregateBy(fixtures, (product) => product.status),
      public: fixtures.filter((product) => PUBLIC_STATUSES.has(product.status)).length,
      noSchool: fixtures.filter((product) => !normalizeText(product.schoolId)).length
    },
    schools: {
      total: before.schools.length,
      activeAndValid: activeSchools.length
    },
    decision: {
      usersReadyForStrictForAll: userReadyForStrictAll,
      productsReadyForStrictForAll: productsReadyForStrictAll,
      strictForAllRecommendedNow: userReadyForStrictAll && productsReadyForStrictAll,
      phase22bStillRequired: !productsReadyForStrictAll
    },
    noWriteProof: {
      commandTypes: ['QUERY'],
      writeApiCalled: false,
      beforeCounts: Object.fromEntries(Object.entries(before).map(([name, records]) => [name, records.length])),
      afterCounts: Object.fromEntries(Object.entries(after).map(([name, records]) => [name, records.length])),
      projectedHashesUnchanged: unchanged,
      hashesBefore,
      hashesAfter
    }
  };
}

function parseArguments(argv) {
  const options = { describeTarget: false, confirmTarget: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--describe-target') options.describeTarget = true;
    else if (value === '--confirm-target') options.confirmTarget = normalizeText(argv[++index]);
    else if (value === '--output') options.output = normalizeText(argv[++index]);
    else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

function runAudit(options = {}) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  if (options.describeTarget) {
    return { schemaVersion: 1, mode: MODE, target: `cloud:${targetMasked}`, databaseAccessed: false, writeCapabilities: false };
  }
  assert(options.confirmTarget === targetMasked, `confirm target with --confirm-target ${targetMasked}`, 'TARGET_ENV_CONFIRMATION_REQUIRED');
  const before = readSnapshot(environmentId);
  const after = readSnapshot(environmentId);
  return createReport(before, after, targetMasked);
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = runAudit(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) fs.writeFileSync(path.resolve(options.output), output, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE18_READINESS_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  MODE,
  PROJECTIONS,
  PUBLIC_STATUSES,
  FIXTURE_PREFIX,
  maskId,
  buildFindCommand,
  assertReadOnlyCommand,
  readCollection,
  readSnapshot,
  stableHash,
  schoolState,
  createReport,
  parseArguments,
  runAudit
};
