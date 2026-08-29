'use strict';

const fs = require('fs');
const path = require('path');
const { runPreflight, publicSummary, assert } = require('./environment-preflight');
const { queryAll } = require('./final-release-product-cleanup-dry-run');
const {
  ROOT,
  EXPECTED_TOTAL,
  hashRecords,
  countBy,
  validateSource,
  compareProductionSchools,
  assertProductionIntegrity,
  readAllSchools,
  allFunctionSummaries,
  safeWriteJson,
  stableStringify
} = require('./final-release-step-3b-core');

const COLLECTIONS = Object.freeze([
  'users', 'products', 'favorites', 'conversations', 'messages',
  'appointments', 'schools', 'productViews'
]);
const BASELINE_PATH = path.join(ROOT, 'tmp', 'final-release-step-4b-production-pre.json');
const OUTPUT_PATH = path.join(ROOT, 'tmp', 'final-release-step-4b1-production-integrity.json');
const EXPECTED_OLD_FAVORITE_HASH = '89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1';
const EXPECTED_RC_FAVORITE_HASH = '0214cf9d702af7d097aae03169cce9103a9dc54e30e4ec93caebddefe9cd6e60';

function parseArguments(argv) {
  const options = {
    environmentName: '',
    output: OUTPUT_PATH,
    baseline: BASELINE_PATH,
    expectedVersion: 'old'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--output') options.output = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--baseline') options.baseline = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--expected-version') options.expectedVersion = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  assert(['old', 'rc'].includes(options.expectedVersion), '--expected-version old|rc is required', 'INVALID_EXPECTED_VERSION');
  return options;
}

function run(options) {
  const preflight = runPreflight({
    environmentName: 'production',
    action: 'audit',
    allowInactiveRead: true
  });
  assert(fs.existsSync(options.baseline), 'production comparison baseline is unavailable', 'PRODUCTION_BASELINE_MISSING');
  const baseline = JSON.parse(fs.readFileSync(options.baseline, 'utf8'));
  const records = Object.fromEntries(COLLECTIONS.map((name) => [
    name,
    name === 'schools' ? readAllSchools(preflight.environmentId) : queryAll(preflight.environmentId, name, undefined)
  ]));
  const { records: normalized } = validateSource();
  const schoolIntegrity = compareProductionSchools(normalized, records.schools);
  assertProductionIntegrity(schoolIntegrity);
  assert(records.schools.length === EXPECTED_TOTAL, 'school total drifted', 'SCHOOL_COUNT_DRIFT');
  const productStatusCounts = countBy(records.products, 'status');
  const publicVisible = records.products.filter((row) => ['available', 'reserved'].includes(row.status)).length;
  assert(publicVisible === 0, 'PUBLIC MARKET ZERO drifted', 'PUBLIC_MARKET_ZERO_FAILED');
  const collections = Object.fromEntries(COLLECTIONS.map((name) => [name, {
    count: records[name].length,
    sha256: hashRecords(records[name])
  }]));
  const differences = COLLECTIONS.filter((name) => (
    stableStringify(baseline.collections[name]) !== stableStringify(collections[name])
  ));
  assert(differences.length === 0, `production collections changed: ${differences.join(', ')}`,
    'UNEXPECTED_PRODUCTION_MUTATION');
  const functions = allFunctionSummaries(preflight.environmentId);
  const expectedFavoriteHash = options.expectedVersion === 'rc'
    ? EXPECTED_RC_FAVORITE_HASH
    : EXPECTED_OLD_FAVORITE_HASH;
  assert(functions.favoriteProduct
    && functions.favoriteProduct.sourceSha256 === expectedFavoriteHash,
  'production favoriteProduct source hash changed', 'PRODUCTION_FAVORITE_SOURCE_DRIFT');
  const result = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    mode: 'FINAL_RELEASE_STEP_4B1_PRODUCTION_READ_ONLY_INTEGRITY',
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
    productionFavoriteProduct: functions.favoriteProduct,
    productionFavoriteProductSourceSha256: functions.favoriteProduct.sourceSha256,
    expectedFavoriteVersion: options.expectedVersion,
    comparedWithBaseline: path.basename(options.baseline),
    changedCollections: [],
    productionWrites: 0,
    passed: true
  };
  safeWriteJson(options.output, result);
  return result;
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify({
      completedAt: result.completedAt,
      environment: result.environment,
      collectionCounts: Object.fromEntries(Object.entries(result.collections).map(([name, value]) => [name, value.count])),
      products: result.products,
      schools: result.schools,
      productionFavoriteProduct: result.productionFavoriteProduct,
      productionFavoriteProductSourceSha256: result.productionFavoriteProductSourceSha256,
      productionWrites: result.productionWrites,
      passed: result.passed
    }, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STEP4B1_PRODUCTION_AUDIT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { COLLECTIONS, BASELINE_PATH, OUTPUT_PATH, parseArguments, run };
