const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const MarketCore = require('../cloudfunctions/productQuery/market-core');
const readiness = require('./audit-phase-18-user-school-readiness');
const {
  ROOT,
  FINAL_CONFIG,
  LEGACY_CONFIG,
  PRIVATE_SNAPSHOT_PATH,
  sourceConfig,
  assertConfig,
  functionSummary,
  readProductIndexes,
  readProductsAcl,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  assert: gate
} = require('./phase-18-final-cutover-core');
const { queryCollection, maskId } = require('./phase-18-canary-core');
const { loadDualAccountPrivate } = require('./phase-18-dual-account-core');
const { buildRollbackDryRun } = require('./rollback-phase-18-school-scoped-canary');

let checks = 0;
function check(value, message) {
  assert(value, message);
  checks += 1;
}

async function run() {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  const sourcePath = path.join(ROOT, 'cloudfunctions', 'productQuery', 'index.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const config = sourceConfig(source);
  check(assertConfig(config, FINAL_CONFIG, 'final source'), 'final config does not match');
  check(config.allowlistKinds.length === 0, 'production allowlist is not empty');
  check(!/sha256:[0-9a-f]{64}/.test(source.slice(source.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST'), source.indexOf('CURSOR_SECRET_ENV_NAME'))), 'production rollout retains identity tokens');

  const detail = readFunctionDetail(environmentId, 'productQuery');
  const summary = functionSummary(detail, source);
  check(summary.status === 'Active', 'productQuery is not Active');
  check(summary.runtime === 'Nodejs16.13' && summary.handler === 'index.main', 'productQuery runtime/handler changed');
  check(summary.timeout === 10 && summary.memorySize === 256, 'productQuery resources changed');
  check(summary.hashMatches, 'productQuery local/remote hash differs');
  check(summary.cursorHmacLengthQualified, 'cursor HMAC is unavailable');
  check(summary.productSeedEnabled === 'false', 'product seed is enabled');

  const indexes = readProductIndexes(environmentId);
  check(indexes.length === 19, 'products index count is not 19');
  check(await readProductsAcl(environmentId) === 'ADMINONLY', 'products ACL is not ADMINONLY');
  const readinessReport = readiness.runAudit({ confirmTarget: targetMasked });
  check(readinessReport.users.validActiveSchool === readinessReport.users.total, 'user school readiness is incomplete');
  check(readinessReport.products.publicStrictReady === readinessReport.products.publicTotal, 'public product readiness is incomplete');
  check(readinessReport.noWriteProof.projectedHashesUnchanged === true, 'readiness no-write proof failed');

  const privateData = loadDualAccountPrivate();
  const finalValidation = privateData.finalCutoverValidation || {};
  const accountAValidation = finalValidation.accountA || {};
  const accountBValidation = finalValidation.accountBPhone || {};
  const legacyRollbackValidation = finalValidation.legacyRollback || {};
  const accountBRestoreValidation = finalValidation.accountBStrictRestore || {};
  check(accountAValidation.marketMode === MarketCore.RESPONSE_MARKET_MODE.SCHOOL_SCOPED
    && accountAValidation.strictForAllWithoutAllowlist === true
    && accountAValidation.twoPagesPerSort === true
    && accountAValidation.cursorQueryMismatchRejected === true
    && accountAValidation.offlineFixturesHidden === true,
  'account A final strict evidence is incomplete');
  check(accountAValidation.consoleErrors === 0 && accountAValidation.exceptions === 0,
    'account A final strict runtime errors were recorded');
  check(accountBValidation.result === 'passed'
    && accountBValidation.marketMode === MarketCore.RESPONSE_MARKET_MODE.SCHOOL_SCOPED
    && accountBValidation.allowlistEmpty === true,
  'account B final phone evidence is incomplete');
  check(legacyRollbackValidation.result === 'passed'
    && legacyRollbackValidation.marketMode === MarketCore.RESPONSE_MARKET_MODE.LEGACY
    && legacyRollbackValidation.twoPagesPerSort === true
    && legacyRollbackValidation.schoolChange === 'A->B->A',
  'real legacy rollback evidence is incomplete');
  check(legacyRollbackValidation.consoleErrors === 0 && legacyRollbackValidation.exceptions === 0,
    'real legacy rollback runtime errors were recorded');
  check(accountBRestoreValidation.result === 'passed'
    && accountBRestoreValidation.marketMode === MarketCore.RESPONSE_MARKET_MODE.SCHOOL_SCOPED
    && accountBRestoreValidation.allowlistEmpty === true,
  'account B strict restore evidence is incomplete');

  const logoutEvidencePath = path.join(ROOT, 'tmp', 'phase-18-explicit-logout-devtools-private.json');
  check(fs.existsSync(logoutEvidencePath), 'explicit logout evidence is missing');
  const logoutEvidence = JSON.parse(fs.readFileSync(logoutEvidencePath, 'utf8'));
  check(logoutEvidence.afterLogout.products === 0
    && logoutEvidence.afterLogout.productListCalls === 0
    && logoutEvidence.afterLogout.explicitLogout === true
    && logoutEvidence.afterLogout.cachedUserPresent === false,
  'explicit logout fail-closed evidence is incomplete');
  check(logoutEvidence.afterRestart.products === 0
    && logoutEvidence.afterRestart.explicitLogout === true
    && logoutEvidence.afterRestart.cachedUserPresent === false,
  'anonymous restart evidence is incomplete');
  check(logoutEvidence.afterManualLogin.marketMode === MarketCore.RESPONSE_MARKET_MODE.SCHOOL_SCOPED
    && logoutEvidence.afterManualLogin.explicitLogout === false,
  'manual login strict restore evidence is incomplete');
  const userIds = [privateData.accountA.userId, privateData.accountB.userId];
  const users = queryCollection(environmentId, 'users', {
    filter: {},
    projection: { _id: 1, status: 1, profileCompleted: 1, nickname: 1, avatarUrl: 1, schoolId: 1, schoolName: 1 },
    limit: 100
  });
  const third = users.find((user) => !userIds.includes(user._id)
    && user.status === 'active'
    && user.profileCompleted === true
    && user.schoolId);
  check(Boolean(third), 'no valid third existing user was found');
  check(MarketCore.decideMarketMode({
    enabled: true,
    strictForAll: true,
    allowlist: [],
    userId: third._id
  }) === MarketCore.MARKET_MODE.SCHOOL_SCOPED, 'third non-allowlisted user did not enter strict mode');
  for (const account of [privateData.accountA, privateData.accountB]) {
    check(MarketCore.decideMarketMode({
      enabled: true,
      strictForAll: true,
      allowlist: [],
      userId: account.userId
    }) === MarketCore.MARKET_MODE.SCHOOL_SCOPED, 'A/B strict mode still depends on allowlist');
  }

  const publicProducts = queryCollection(environmentId, 'products', {
    filter: { status: { $in: ['available', 'reserved'] } },
    projection: { _id: 1, status: 1, schoolId: 1, schoolName: 1 },
    limit: 1000
  });
  check(publicProducts.every((item) => item.schoolId), 'public product without school exists');
  check(publicProducts.some((item) => item.schoolId === privateData.accountA.schoolId), 'school A has no public products');
  check(publicProducts.some((item) => item.schoolId === privateData.accountB.schoolId), 'school B has no public products');
  check(publicProducts.filter((item) => item.schoolId === privateData.accountA.schoolId).every((item) => item.schoolId !== privateData.accountB.schoolId), 'A/B product scope overlaps');

  check(MarketCore.decideMarketMode({ ...LEGACY_CONFIG, allowlist: [], userId: third._id }) === MarketCore.MARKET_MODE.LEGACY, 'rollback config does not restore legacy');
  const rollback = buildRollbackDryRun({ confirmTarget: targetMasked });
  check(rollback.mode === 'dry-run' && rollback.deploymentExecuted === false, 'rollback is not dry-run by default');
  check(rollback.wouldDeployOnly.length === 1 && rollback.wouldDeployOnly[0] === 'productQuery', 'rollback scope is not productQuery-only');
  check(rollback.requiredSourceConfig.enabled === false
    && rollback.requiredSourceConfig.strictForAll === false
    && rollback.requiredSourceConfig.accessRequiresAuth === false
    && rollback.requiredSourceConfig.allowlistCount === 0, 'rollback target config is invalid');

  check(/AUTH_REQUIRED/.test(source) && /PROFILE_INCOMPLETE/.test(source) && /SCHOOL_REQUIRED/.test(source), 'auth fail-closed errors are missing');
  check(/SCHOOL_INVALID/.test(source) && /SCHOOL_UNAVAILABLE/.test(source) && /USER_INACTIVE/.test(source), 'school/user fail-closed errors are missing');
  check(/INVALID_CURSOR_SCOPE/.test(source), 'cursor scope rejection is missing');
  const manageSource = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'manageProduct', 'index.js'), 'utf8');
  check(/product\.sellerOpenid\s*!==\s*openId/.test(manageSource), 'historical product management no longer enforces ownership');
  check(!/schoolId\s*:/.test(manageSource.slice(manageSource.indexOf('function buildTransitionData'), manageSource.indexOf('async function performTransition'))), 'status transition can mutate product school');
  const homeSource = fs.readFileSync(path.join(ROOT, 'pages', 'home', 'index.js'), 'utf8');
  check(/showMarketGuide/.test(homeSource) && /loadProducts/.test(homeSource), 'anonymous home guard is missing');
  const logoutSource = fs.readFileSync(path.join(ROOT, 'store', 'auth-store.js'), 'utf8');
  check(/explicitLogoutKey/.test(logoutSource) && /setStorageSync/.test(logoutSource), 'explicit logout persistence is missing');

  check(fs.existsSync(PRIVATE_SNAPSHOT_PATH), 'private pre-cutover snapshot is missing');
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', path.relative(ROOT, PRIVATE_SNAPSHOT_PATH)], { cwd: ROOT });
  check(ignored.status === 0, 'private pre-cutover snapshot is not ignored');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check(Boolean(packageJson.scripts['phase-18-final-cutover:verify']), 'final-cutover verification command is missing');
  const rollbackSource = fs.readFileSync(path.join(ROOT, 'scripts', 'rollback-phase-18-school-scoped-canary.js'), 'utf8');
  check(/--confirm-target/.test(rollbackSource) && /--deploy/.test(rollbackSource), 'rollback explicit guards are missing');
  check(!/authUser|manageProduct/.test(rollbackSource.slice(0, rollbackSource.indexOf('module.exports'))), 'rollback can deploy non-market functions');

  execFileSync(process.execPath, ['--check', sourcePath], { cwd: ROOT, stdio: 'ignore' });
  checks += 1;
  return {
    passed: true,
    checks,
    target: `cloud:${targetMasked}`,
    config,
    productQuerySha256: summary.localSha256,
    productQueryActive: true,
    cursorHmacPresent: true,
    productSeedEnabled: false,
    productsAcl: 'ADMINONLY',
    productIndexCount: indexes.length,
    readiness: {
      users: `${readinessReport.users.validActiveSchool}/${readinessReport.users.total}`,
      publicProducts: `${readinessReport.products.publicStrictReady}/${readinessReport.products.publicTotal}`
    },
    thirdUser: {
      userId: maskId(third._id),
      schoolId: maskId(third.schoolId),
      validationLayer: 'controlled server mode decision + existing authoritative database user'
    },
    rollbackDryRunSafe: true,
    realRollbackAndRestorePassed: true,
    dualAccountPhonePassed: true,
    explicitLogoutRestartPassed: true,
    privateSnapshotIgnored: true
  };
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error.code || 'PHASE18_FINAL_CUTOVER_VERIFY_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});
