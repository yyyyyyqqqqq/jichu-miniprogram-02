'use strict';

const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const { queryAll } = require('./final-release-product-cleanup-dry-run');
const { readFunctionDetail } = require('./phase-18-canary-core');
const {
  EXPECTED_TOTAL,
  loadNormalized,
  compareProductionSchools,
  assertProductionIntegrity,
  hashRecords,
  countBy
} = require('./final-release-step-3b-core');
const {
  PRODUCTION_COLLECTION_NAMES,
  PRODUCTION_FUNCTION_NAMES,
  HOTFIX_FUNCTION_CANDIDATES,
  resolvePrivatePath,
  writePrivateJson,
  readJson,
  summarizeFunction,
  assertFunctionAvailable,
  functionConfigurationFingerprint,
  localFunctionPackage,
  sameObject,
  sanitizeErrorMessage
} = require('./disabled-account-rollout-core');

const DEFAULT_PRE_PATH = path.join(
  ROOT,
  'tmp',
  'disabled-account-production-integrity-pre.json'
);
const DEFAULT_POST_PATH = path.join(
  ROOT,
  'tmp',
  'disabled-account-production-integrity-post.json'
);
const PHASES = Object.freeze(['pre', 'post']);

function parseArguments(argv) {
  const options = {
    environmentName: '',
    phase: '',
    confirmTarget: '',
    baselinePath: DEFAULT_PRE_PATH,
    outputPath: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--phase') options.phase = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--baseline') {
      options.baselinePath = resolvePrivatePath(argv[++index], DEFAULT_PRE_PATH);
    } else if (value === '--output') {
      options.outputPath = resolvePrivatePath(argv[++index], '');
    } else {
      throw Object.assign(new Error(`unsupported argument: ${value}`), {
        code: 'INVALID_ARGUMENT'
      });
    }
  }
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  assert(PHASES.includes(options.phase), '--phase pre|post is required', 'INVALID_PHASE');
  if (!options.outputPath) {
    options.outputPath = options.phase === 'pre' ? DEFAULT_PRE_PATH : DEFAULT_POST_PATH;
  }
  return options;
}

function collectionSnapshot(environmentId) {
  const collections = {};
  const recordsByName = {};
  for (const name of PRODUCTION_COLLECTION_NAMES) {
    const records = queryAll(environmentId, name, undefined);
    recordsByName[name] = records;
    collections[name] = {
      count: records.length,
      sha256: hashRecords(records)
    };
  }
  const products = recordsByName.products;
  const productStatusCounts = countBy(products, 'status');
  const publicVisible = products.filter((record) => (
    ['available', 'reserved'].includes(record.status)
  )).length;
  assert(Number(productStatusCounts.available || 0) === 0, 'production available products are not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  assert(Number(productStatusCounts.reserved || 0) === 0, 'production reserved products are not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  assert(publicVisible === 0, 'production public market is not zero', 'PUBLIC_MARKET_ZERO_FAILED');

  const schools = recordsByName.schools;
  const schoolIntegrity = compareProductionSchools(loadNormalized(), schools);
  assertProductionIntegrity(schoolIntegrity);
  assert(Number(schoolIntegrity.statusCounts.active || 0) === EXPECTED_TOTAL,
    'production schools are not all active', 'PRODUCTION_SCHOOL_STATUS_DRIFT');
  assert(Number(schoolIntegrity.statusCounts.pending || 0) === 0,
    'production pending schools are not zero', 'PRODUCTION_SCHOOL_STATUS_DRIFT');

  return {
    collections,
    publicMarket: {
      totalProducts: products.length,
      statusCounts: productStatusCounts,
      publicVisible,
      zero: true
    },
    schools: {
      total: schoolIntegrity.exactIds,
      active: Number(schoolIntegrity.statusCounts.active || 0),
      pending: Number(schoolIntegrity.statusCounts.pending || 0),
      missing: schoolIntegrity.missing,
      extra: schoolIntegrity.extra,
      different: schoolIntegrity.different,
      identityConflicts: schoolIntegrity.identityConflicts,
      unexpectedOfficialStatus: schoolIntegrity.unexpectedOfficialStatus,
      duplicateId: schoolIntegrity.duplicateId,
      duplicateOfficialCode: schoolIntegrity.duplicateOfficialCode,
      duplicateNormalizedName: schoolIntegrity.duplicateNormalizedName,
      officialFieldChecksum: schoolIntegrity.officialFieldChecksumProduction
    }
  };
}

function functionInventory(environmentId) {
  return Object.fromEntries(PRODUCTION_FUNCTION_NAMES.map((name) => {
    const summary = summarizeFunction(readFunctionDetail(environmentId, name));
    assertFunctionAvailable(summary, name);
    return [name, {
      ...summary,
      configurationFingerprint: functionConfigurationFingerprint(summary)
    }];
  }));
}

function changedFunctions(inventory) {
  return PRODUCTION_FUNCTION_NAMES.filter((name) => (
    inventory[name].sourceSha256 !== localFunctionPackage(name).indexSha256
  ));
}

function sameFunctionSet(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && sameObject([...left].sort(), [...right].sort());
}

function assertPostMatchesBaseline(baseline, snapshot, inventory) {
  assert(baseline.schemaVersion === 1 && baseline.phase === 'pre',
    'production PRE baseline is invalid', 'PRODUCTION_BASELINE_INVALID');
  assert(sameObject(snapshot.collections, baseline.snapshot.collections),
    'production collection count/digest changed', 'PRODUCTION_DATA_INTEGRITY_DRIFT');
  assert(sameObject(snapshot.publicMarket, baseline.snapshot.publicMarket),
    'production public-market invariant changed', 'PUBLIC_MARKET_DRIFT');
  assert(sameObject(snapshot.schools, baseline.snapshot.schools),
    'production school invariant changed', 'PRODUCTION_SCHOOL_DRIFT');

  const selected = new Set(baseline.changedFunctions || []);
  assert(sameFunctionSet([...selected], HOTFIX_FUNCTION_CANDIDATES),
    'production PRE did not identify exactly the eleven hotfix functions',
    'HOTFIX_FUNCTION_SET_DRIFT');
  for (const name of PRODUCTION_FUNCTION_NAMES) {
    const before = baseline.functions[name];
    const after = inventory[name];
    assert(before && after, `${name} inventory is missing`, 'FUNCTION_INVENTORY_MISSING');
    assert(after.configurationFingerprint === before.configurationFingerprint,
      `${name} configuration changed`, 'FUNCTION_CONFIGURATION_DRIFT');
    const expectedSource = selected.has(name)
      ? localFunctionPackage(name).indexSha256
      : before.sourceSha256;
    assert(after.sourceSha256 === expectedSource,
      `${name} source hash differs from the rollout manifest`, 'FUNCTION_SOURCE_DRIFT');
  }
}

function run(options) {
  const preflight = runPreflight({
    environmentName: 'production',
    action: 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: false,
    allowInactiveRead: false
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches, 'active client target must be production', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId === targets.production
    && preflight.environmentId !== targets.staging,
  'registered production target mismatch', 'PRODUCTION_TARGET_MISMATCH');
  assert(options.confirmTarget === preflight.environmentIdMasked,
    `confirm target with --confirm-target ${preflight.environmentIdMasked}`,
    'TARGET_CONFIRMATION_REQUIRED');

  const snapshot = collectionSnapshot(preflight.environmentId);
  const functions = functionInventory(preflight.environmentId);
  const report = {
    schemaVersion: 1,
    phase: options.phase,
    capturedAt: new Date().toISOString(),
    mode: `DISABLED_ACCOUNT_PRODUCTION_INTEGRITY_${options.phase.toUpperCase()}`,
    environment: publicSummary(preflight),
    snapshot,
    functions,
    changedFunctions: options.phase === 'pre'
      ? changedFunctions(functions)
      : [],
    nineCollectionsExact: true,
    publicMarketZero: true,
    schools2952Active: true,
    productionWrites: 0,
    passed: true
  };
  if (options.phase === 'pre') {
    assert(sameFunctionSet(report.changedFunctions, HOTFIX_FUNCTION_CANDIDATES),
      'local/remote diff is not exactly the eleven approved hotfix functions',
      'HOTFIX_FUNCTION_SET_DRIFT');
  } else {
    const baseline = readJson(
      resolvePrivatePath(options.baselinePath, DEFAULT_PRE_PATH),
      'PRODUCTION_BASELINE_MISSING'
    );
    assertPostMatchesBaseline(baseline, snapshot, functions);
    report.changedFunctions = baseline.changedFunctions;
    report.baselineCapturedAt = baseline.capturedAt;
    report.postMatchesPreDataExactly = true;
    report.functionConfigurationUnchanged = true;
    report.onlyApprovedFunctionSourcesChanged = true;
  }
  writePrivateJson(options.outputPath, report);
  return report;
}

if (require.main === module) {
  try {
    const result = run(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PRODUCTION_INTEGRITY_FAILED'}: ${sanitizeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_PRE_PATH,
  DEFAULT_POST_PATH,
  PHASES,
  parseArguments,
  collectionSnapshot,
  functionInventory,
  changedFunctions,
  sameFunctionSet,
  assertPostMatchesBaseline,
  run
};
