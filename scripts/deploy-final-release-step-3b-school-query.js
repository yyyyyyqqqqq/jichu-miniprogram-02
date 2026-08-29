const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT,
  AUTHORIZATION_PHRASE,
  SCHOOL_SECRET_KEY,
  SECRET_PATH,
  sha256,
  readIndexes,
  assertRequiredIndexes,
  functionSummary,
  environmentMap,
  safeWriteJson,
  readJson,
  publicSummary,
  assert
} = require('./final-release-step-3b-core');
const { runPreflight, maskIdentifier } = require('./environment-preflight');
const { readFunctionDetail } = require('./phase-18-canary-core');
const { runCloudBase } = require('./schools/cloud-cli');
const {
  localDependencySummary,
  verifyRemotePackage
} = require('./deploy-phase-24-auth-flow');

const FUNCTION_NAME = 'schoolQuery';
const RUNTIME = 'Nodejs18.15';
const HANDLER = 'index.main';
const TIMEOUT = 10;
const MEMORY_SIZE = 256;

function parseArguments(argv) {
  const options = {
    environmentName: '', confirmTarget: '', authorization: '',
    prepareSecret: false, configureSecret: false, deploy: false, audit: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--authorization') options.authorization = String(argv[++index] || '').trim();
    else if (value === '--prepare-secret') options.prepareSecret = true;
    else if (value === '--configure-secret') options.configureSecret = true;
    else if (value === '--deploy') options.deploy = true;
    else if (value === '--audit') options.audit = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  const actions = [options.prepareSecret, options.configureSecret, options.deploy, options.audit].filter(Boolean).length;
  assert(actions === 1, 'choose exactly one action', 'ACTION_REQUIRED');
  return options;
}

function prepareSecret() {
  if (fs.existsSync(SECRET_PATH)) {
    const existing = readJson(SECRET_PATH, 'PRODUCTION_SCHOOL_SECRET_INVALID');
    assert(typeof existing.secret === 'string' && existing.secret.length >= 43, 'stored production school secret is weak', 'PRODUCTION_SCHOOL_SECRET_INVALID');
    assert(existing.fingerprint === sha256(existing.secret).slice(0, 16), 'stored production school secret fingerprint drifted', 'PRODUCTION_SCHOOL_SECRET_INVALID');
    return { created: false, fingerprint: existing.fingerprint };
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  const fingerprint = sha256(secret).slice(0, 16);
  safeWriteJson(SECRET_PATH, {
    schemaVersion: 1,
    purpose: 'FINAL_RELEASE_STEP_3B_PRODUCTION_SCHOOL_QUERY_CURSOR_HMAC',
    createdAt: new Date().toISOString(),
    secret,
    fingerprint
  });
  return { created: true, fingerprint };
}

function readSecret() {
  const stored = readJson(SECRET_PATH, 'PRODUCTION_SCHOOL_SECRET_MISSING');
  assert(typeof stored.secret === 'string' && stored.secret.length >= 43, 'production school secret is weak', 'PRODUCTION_SCHOOL_SECRET_WEAK');
  assert(stored.fingerprint === sha256(stored.secret).slice(0, 16), 'production school secret fingerprint drifted', 'PRODUCTION_SCHOOL_SECRET_INVALID');
  return stored;
}

function assertSafeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert(resolved.startsWith(temporaryRoot), 'temporary deploy directory escaped temp root');
  assert(path.basename(resolved).startsWith('final-release-step-3b-school-query-'), 'temporary deploy prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary deploy target is unsafe');
}

function withConfig(environmentId, secret, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'final-release-step-3b-school-query-'));
  assertSafeTemporaryDirectory(directory);
  const configPath = path.join(directory, 'cloudbaserc.json');
  const config = {
    envId: environmentId,
    functionRoot: 'cloudfunctions',
    functions: [{
      name: FUNCTION_NAME,
      runtime: RUNTIME,
      handler: HANDLER,
      timeout: TIMEOUT,
      memorySize: MEMORY_SIZE,
      envVariables: { [SCHOOL_SECRET_KEY]: secret }
    }]
  };
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return callback(configPath);
  } finally {
    if (fs.existsSync(directory)) {
      assertSafeTemporaryDirectory(directory);
      fs.rmSync(directory, { recursive: true, force: false });
    }
  }
}

function configureSecret(environmentId, secret) {
  return withConfig(environmentId, secret, (configPath) => runCloudBase([
    '--config-file', configPath,
    '--env-id', environmentId,
    '--yes',
    'config', 'update', 'fn', FUNCTION_NAME,
    '--json'
  ], { timeoutMs: 300000, json: false }));
}

function deployCode(environmentId, secret) {
  return withConfig(environmentId, secret, (configPath) => runCloudBase([
    '--config-file', configPath,
    '--env-id', environmentId,
    'fn', 'deploy', FUNCTION_NAME,
    '--force',
    '--json'
  ], { timeoutMs: 600000, json: false }));
}

function verifyPackageWithRetry(environmentId, local) {
  let finalError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return verifyRemotePackage(environmentId, FUNCTION_NAME, local);
    } catch (error) {
      finalError = error;
      if (!/ECONNRESET|socket hang up|network/i.test(String(error && error.message || ''))) break;
    }
  }
  throw finalError;
}

function assertBaseConfiguration(summary) {
  assert(summary.status === 'Active' && summary.availableStatus === 'Available', 'schoolQuery is unavailable', 'SCHOOL_QUERY_UNAVAILABLE');
  assert(summary.runtime === RUNTIME, 'schoolQuery runtime drifted', 'SCHOOL_QUERY_CONFIG_DRIFT');
  assert(summary.handler === HANDLER, 'schoolQuery handler drifted', 'SCHOOL_QUERY_CONFIG_DRIFT');
  assert(summary.timeout === TIMEOUT && summary.memorySize === MEMORY_SIZE, 'schoolQuery resources drifted', 'SCHOOL_QUERY_CONFIG_DRIFT');
}

async function run(options) {
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  if (options.prepareSecret) {
    const preflight = runPreflight({ environmentName: 'production', action: 'build' });
    const secret = prepareSecret();
    const targets = require('../config/cloud.targets.private');
    const staging = functionSummary(targets.staging);
    assert(secret.fingerprint !== staging.schoolSecretFingerprint, 'production secret equals staging secret', 'PRODUCTION_SECRET_NOT_INDEPENDENT');
    return {
      mode: secret.created ? 'private-secret-created' : 'private-secret-reused',
      environment: publicSummary(preflight),
      secretPresent: true,
      secretFingerprint: secret.fingerprint,
      differsFromStaging: true,
      privateOutput: 'tmp/final-release-step-3b-production-school-secret.json'
    };
  }
  const write = options.configureSecret || options.deploy;
  const preflight = runPreflight({
    environmentName: 'production',
    action: write ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: write
  });
  if (write) assert(options.authorization === AUTHORIZATION_PHRASE, 'exact Step 3B authorization phrase is required', 'OWNER_AUTHORIZATION_REQUIRED');
  const targets = require('../config/cloud.targets.private');
  const secret = readSecret();
  const localSource = fs.readFileSync(path.join(ROOT, 'cloudfunctions', FUNCTION_NAME, 'index.js'), 'utf8');
  const localSourceSha256 = sha256(localSource);
  const localDependency = localDependencySummary(FUNCTION_NAME);
  const staging = functionSummary(targets.staging);
  assert(staging.sourceSha256 === localSourceSha256, 'local schoolQuery differs from staging approved source', 'STAGING_APPROVED_SOURCE_DRIFT');
  assert(staging.schoolSecretPresent, 'staging schoolQuery secret is missing', 'STAGING_SECRET_MISSING');
  assert(staging.schoolSecretFingerprint !== secret.fingerprint, 'production secret equals staging secret', 'PRODUCTION_SECRET_NOT_INDEPENDENT');
  const stagingPackage = verifyPackageWithRetry(targets.staging, localDependency);
  const before = functionSummary(preflight.environmentId);
  assertBaseConfiguration(before);
  if (options.audit) {
    return {
      mode: 'audit',
      environment: publicSummary(preflight),
      approvedLocalSourceSha256: localSourceSha256,
      stagingApprovedSourceSha256: staging.sourceSha256,
      production: before,
      secretFingerprint: secret.fingerprint,
      differsFromStaging: secret.fingerprint !== staging.schoolSecretFingerprint,
      localDependency,
      stagingPackage
    };
  }
  if (options.configureSecret) {
    const beforeDetail = readFunctionDetail(preflight.environmentId, FUNCTION_NAME);
    const beforeSourceSha256 = before.sourceSha256;
    configureSecret(preflight.environmentId, secret.secret);
    const after = functionSummary(preflight.environmentId);
    assertBaseConfiguration(after);
    assert(after.sourceSha256 === beforeSourceSha256, 'secret configuration changed schoolQuery source', 'UNEXPECTED_SOURCE_CHANGE');
    assert(after.schoolSecretPresent && after.schoolSecretFingerprint === secret.fingerprint, 'production school secret verification failed', 'PRODUCTION_SECRET_CONFIG_FAILED');
    const afterVariables = environmentMap(readFunctionDetail(preflight.environmentId, FUNCTION_NAME));
    assert(Object.keys(afterVariables).length === 1 && Object.keys(afterVariables)[0] === SCHOOL_SECRET_KEY, 'unexpected schoolQuery environment variables', 'PRODUCTION_SECRET_CONFIG_FAILED');
    return {
      mode: 'production-secret-configured-and-verified',
      environment: publicSummary(preflight),
      sourceUnchanged: true,
      sourceSha256: after.sourceSha256,
      secretPresent: true,
      secretFingerprint: after.schoolSecretFingerprint,
      differsFromStaging: true,
      configuration: after
    };
  }
  const indexes = await readIndexes(preflight.environmentId, 'schools');
  assertRequiredIndexes(indexes);
  assert(before.schoolSecretPresent && before.schoolSecretFingerprint === secret.fingerprint, 'production school secret must be configured before code deploy', 'PRODUCTION_SECRET_NOT_CONFIGURED');
  deployCode(preflight.environmentId, secret.secret);
  const after = functionSummary(preflight.environmentId);
  assertBaseConfiguration(after);
  assert(after.sourceSha256 === localSourceSha256, 'deployed schoolQuery source hash differs', 'SCHOOL_QUERY_DEPLOY_HASH_MISMATCH');
  assert(after.schoolSecretPresent && after.schoolSecretFingerprint === secret.fingerprint, 'deployed schoolQuery secret differs', 'SCHOOL_QUERY_DEPLOY_ENV_MISMATCH');
  const productionPackage = verifyPackageWithRetry(preflight.environmentId, localDependency);
  return {
    mode: 'schoolQuery-production-deployed-and-verified',
    environment: publicSummary(preflight),
    deployedOnly: [FUNCTION_NAME],
    approvedLocalSourceSha256: localSourceSha256,
    stagingApprovedSourceSha256: staging.sourceSha256,
    remoteSourceSha256: after.sourceSha256,
    sourceHashMatches: after.sourceSha256 === localSourceSha256,
    secretFingerprint: after.schoolSecretFingerprint,
    productionStagingSecretsDiffer: after.schoolSecretFingerprint !== staging.schoolSecretFingerprint,
    configuration: after,
    localDependency,
    stagingPackage,
    productionPackage,
    indexes: indexes.map((index) => index.name)
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    let message = String(error && error.message || error);
    try {
      const targets = require('../config/cloud.targets.private');
      for (const id of Object.values(targets).filter(Boolean)) message = message.split(id).join(maskIdentifier(id));
    } catch (ignored) {
      // Environment configuration failures are already fail-closed.
    }
    process.stderr.write(`${error.code || 'STEP3B_SCHOOL_QUERY_DEPLOY_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FUNCTION_NAME,
  RUNTIME,
  HANDLER,
  TIMEOUT,
  MEMORY_SIZE,
  parseArguments,
  prepareSecret,
  readSecret,
  configureSecret,
  deployCode,
  run
};
