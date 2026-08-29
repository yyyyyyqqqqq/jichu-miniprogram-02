'use strict';

const fs = require('fs');
const path = require('path');
const { runPreflight, publicSummary, assert } = require('./environment-preflight');
const { queryAll } = require('./final-release-product-cleanup-dry-run');
const {
  ROOT, EXPECTED_TOTAL, hashRecords, countBy, validateSource,
  compareProductionSchools, assertProductionIntegrity, readAllSchools,
  allFunctionSummaries, safeWriteJson, stableStringify
} = require('./final-release-step-3b-core');

const COLLECTIONS = Object.freeze([
  'users', 'products', 'favorites', 'conversations', 'messages',
  'appointments', 'schools', 'productViews'
]);
const BEFORE_PATH = path.join(ROOT, 'tmp', 'final-release-step-3c3-before.json');
const AFTER_PATH = path.join(ROOT, 'tmp', 'final-release-step-3c3-after.json');

function parseArguments(argv) {
  const options = { environmentName: '', stage: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--stage') options.stage = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function readBefore() {
  assert(fs.existsSync(BEFORE_PATH), 'Step 3C-3 before snapshot is unavailable', 'BEFORE_SNAPSHOT_MISSING');
  return JSON.parse(fs.readFileSync(BEFORE_PATH, 'utf8'));
}

function run(options) {
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  assert(['before', 'after'].includes(options.stage), '--stage before|after is required', 'AUDIT_STAGE_REQUIRED');
  const preflight = runPreflight({ environmentName: 'production', action: 'audit' });
  const records = Object.fromEntries(COLLECTIONS.map((name) => [
    name, name === 'schools' ? readAllSchools(preflight.environmentId) : queryAll(preflight.environmentId, name, undefined)
  ]));
  const { records: normalized } = validateSource();
  const schoolIntegrity = compareProductionSchools(normalized, records.schools);
  assertProductionIntegrity(schoolIntegrity);
  assert(records.schools.length === EXPECTED_TOTAL, 'school total drifted', 'SCHOOL_COUNT_DRIFT');
  assert(Number(schoolIntegrity.statusCounts.active || 0) === EXPECTED_TOTAL, 'active school count drifted', 'SCHOOL_COUNT_DRIFT');
  assert(Number(schoolIntegrity.statusCounts.pending || 0) === 0, 'pending schools remain', 'SCHOOL_COUNT_DRIFT');
  const productStatusCounts = countBy(records.products, 'status');
  const publicVisible = records.products.filter((row) => ['available', 'reserved'].includes(row.status)).length;
  assert(Number(productStatusCounts.available || 0) === 0, 'available products are not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  assert(Number(productStatusCounts.reserved || 0) === 0, 'reserved products are not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  assert(publicVisible === 0, 'public visible products are not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  const collections = Object.fromEntries(COLLECTIONS.map((name) => [name, {
    count: records[name].length,
    sha256: hashRecords(records[name])
  }]));
  const result = {
    schemaVersion: 1,
    stage: options.stage,
    completedAt: new Date().toISOString(),
    environment: publicSummary(preflight),
    collections,
    products: { statusCounts: productStatusCounts, publicVisible, publicMarketZero: true },
    schools: {
      total: records.schools.length,
      active: Number(schoolIntegrity.statusCounts.active || 0),
      pending: Number(schoolIntegrity.statusCounts.pending || 0),
      officialDrift: schoolIntegrity.different,
      identityConflicts: schoolIntegrity.identityConflicts
    },
    functions: allFunctionSummaries(preflight.environmentId),
    businessDataMutation: 0,
    passed: true
  };
  if (options.stage === 'after') {
    const before = readBefore();
    const differences = COLLECTIONS.filter((name) => stableStringify(before.collections[name]) !== stableStringify(collections[name]));
    assert(differences.length === 0, `business collections changed: ${differences.join(', ')}`, 'UNEXPECTED_BUSINESS_MUTATION');
    result.businessDataMutation = 0;
    result.comparedWithBefore = true;
  }
  safeWriteJson(options.stage === 'before' ? BEFORE_PATH : AFTER_PATH, result);
  return result;
}

if (require.main === module) {
  try {
    const result = run(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      stage: result.stage, completedAt: result.completedAt, environment: result.environment,
      collectionCounts: Object.fromEntries(Object.entries(result.collections).map(([name, value]) => [name, value.count])),
      products: result.products, schools: result.schools,
      businessDataMutation: result.businessDataMutation, passed: result.passed
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'STEP3C3_AUDIT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { COLLECTIONS, BEFORE_PATH, AFTER_PATH, parseArguments, run };
