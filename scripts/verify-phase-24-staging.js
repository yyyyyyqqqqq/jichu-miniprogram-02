const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  ROOT,
  maskIdentifier,
  readPrivateEnvironmentConfiguration,
  runPreflight
} = require('./environment-preflight');
const {
  validateEnvironmentConfiguration
} = require('../config/environment');

let checks = 0;
function check(condition, message) {
  assert(condition, message);
  checks += 1;
}

function expectCode(callback, code) {
  let caught = null;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  check(caught && caught.code === code, `expected ${code}, received ${caught && caught.code}`);
}

function testPureValidation() {
  const targets = { production: 'prod-safe-id', staging: 'stage-safe-id' };
  check(validateEnvironmentConfiguration({ environmentName: 'staging', environmentId: 'stage-safe-id' }, targets).valid, 'valid staging mapping rejected');
  check(validateEnvironmentConfiguration({ environmentName: 'production', environmentId: 'prod-safe-id' }, targets).valid, 'valid production mapping rejected');
  check(validateEnvironmentConfiguration({}, targets).code === 'ENVIRONMENT_ROLE_UNCONFIRMED', 'missing role did not fail closed');
  check(validateEnvironmentConfiguration({ environmentName: 'other', environmentId: 'stage-safe-id' }, targets).code === 'ENVIRONMENT_ROLE_UNCONFIRMED', 'unknown role did not fail closed');
  check(validateEnvironmentConfiguration({ environmentName: 'staging', environmentId: 'YOUR_STAGING_ENV_ID' }, targets).code === 'ENVIRONMENT_ID_UNCONFIRMED', 'placeholder active ID did not fail closed');
  check(validateEnvironmentConfiguration({ environmentName: 'staging', environmentId: 'stage-safe-id' }, { production: 'same', staging: 'same' }).code === 'ENVIRONMENT_TARGETS_NOT_DISTINCT', 'same production/staging ID did not fail closed');
  check(validateEnvironmentConfiguration({ environmentName: 'staging', environmentId: 'prod-safe-id' }, targets).code === 'ENVIRONMENT_ROLE_ID_MISMATCH', 'role/ID mismatch did not fail closed');
}

function testLivePreflightBoundaries() {
  const { active, targets } = readPrivateEnvironmentConfiguration();
  check(active.environmentName === 'staging', 'active client is not staging');
  check(targets.production !== targets.staging, 'private production/staging targets are identical');
  expectCode(() => runPreflight({ environmentName: '', action: 'audit' }), 'ENVIRONMENT_ROLE_REQUIRED');
  expectCode(() => runPreflight({ environmentName: 'staging', action: '' }), 'ENVIRONMENT_ACTION_REQUIRED');
  expectCode(() => runPreflight({ environmentName: 'staging', action: 'deploy' }), 'TARGET_CONFIRMATION_REQUIRED');
  expectCode(() => runPreflight({ environmentName: 'staging', action: 'deploy', confirmTarget: 'wrong***target' }), 'TARGET_CONFIRMATION_REQUIRED');
  const stagingWrite = runPreflight({
    environmentName: 'staging',
    action: 'deploy',
    confirmTarget: maskIdentifier(targets.staging)
  });
  check(stagingWrite.write === true && stagingWrite.activeTargetMatches === true, 'confirmed staging write preflight failed');
  expectCode(() => runPreflight({
    environmentName: 'production',
    action: 'deploy',
    confirmTarget: maskIdentifier(targets.production),
    allowProductionWrite: true
  }), 'ACTIVE_ENVIRONMENT_MISMATCH');
  expectCode(() => runPreflight({ environmentName: 'production', action: 'audit' }), 'ACTIVE_ENVIRONMENT_MISMATCH');
  const productionRead = runPreflight({
    environmentName: 'production',
    action: 'audit',
    allowInactiveRead: true
  });
  check(productionRead.write === false && productionRead.activeTargetMatches === false, 'explicit inactive production read was not isolated');
  check(productionRead.label === '[ENV] PRODUCTION', 'production read label differs');
  check(stagingWrite.label === '[ENV] STAGING', 'staging write label differs');
}

function testPublicGitSafety() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/);
  for (const name of [
    'config/cloud.private.js',
    'config/cloud.targets.private.js',
    'config/cloud.secrets.private.js',
    'project.private.config.json'
  ]) {
    check(!tracked.includes(name), `${name} is tracked by Git`);
  }
  const targetsExample = fs.readFileSync(path.join(ROOT, 'config', 'cloud.targets.private.example.js'), 'utf8');
  const activeExample = fs.readFileSync(path.join(ROOT, 'config', 'cloud.private.example.js'), 'utf8');
  const secretExample = fs.readFileSync(path.join(ROOT, 'config', 'cloud.secrets.private.example.js'), 'utf8');
  check(/YOUR_PRODUCTION_ENV_ID/.test(targetsExample), 'production placeholder is missing');
  check(/YOUR_STAGING_ENV_ID/.test(targetsExample), 'staging placeholder is missing');
  check(/YOUR_(?:PRODUCTION|STAGING)_ENV_ID/.test(activeExample), 'active target placeholder is missing');
  check(/YOUR_STAGING_PRODUCT_QUERY_CURSOR_HMAC_SECRET/.test(secretExample), 'secret placeholder is missing');
  check(!/(cloud1|jichu)-[a-z0-9-]{8,}/i.test(`${targetsExample}\n${activeExample}\n${secretExample}`), 'a real environment ID appears in public examples');
}

function testStagingScriptsRequireExplicitTarget() {
  for (const file of [
    'setup-phase-24-staging-resources.js',
    'seed-phase-24-staging-schools.js',
    'deploy-phase-24-staging.js'
  ]) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
    check(/--env/.test(source), `${file} does not parse explicit --env`);
    check(/--confirm-target/.test(source), `${file} does not require target confirmation`);
    check(/production/i.test(source), `${file} does not visibly reject production`);
  }
  const auditSource = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-phase-24-staging.js'), 'utf8');
  check(/readOnlyProof/.test(auditSource), 'audit does not expose read-only proof');
  check(/human-validation-passed/.test(auditSource), 'audit lacks the human-validation completion gate');
}

testPureValidation();
testLivePreflightBoundaries();
testPublicGitSafety();
testStagingScriptsRequireExplicitTarget();
process.stdout.write(`Phase 24 staging verification succeeded: ${checks} checks passed.\n`);
