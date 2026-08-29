'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  maskIdentifier,
  assert
} = require('./environment-preflight');
const { readFunctionDetail } = require('./phase-18-canary-core');
const { runCloudBase } = require('./schools/cloud-cli');
const {
  localDependencySummary,
  verifyRemotePackage
} = require('./deploy-phase-24-auth-flow');
const { environmentFingerprint } = require('./final-release-step-3b-core');

const FUNCTION_NAME = 'favoriteProduct';
const OWNER_AUTHORIZATION = 'FINAL RELEASE STEP 4B FAVORITE PRODUCT DEPLOYMENT';
const APPROVED_SOURCE_SHA256 = '0214cf9d702af7d097aae03169cce9103a9dc54e30e4ec93caebddefe9cd6e60';
const ROLLBACK = Object.freeze({
  commit: 'e47329bde21756cbbbadc2637db5169209e01e1b',
  gitBlob: '6732bd123b5b02ede3464e869ebc32a8126f2686',
  sourceSha256: '89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1'
});
const DEFAULT_CONFIGURATION = Object.freeze({
  runtime: 'Nodejs18.15',
  handler: 'index.main',
  timeout: 10,
  memorySize: 256,
  envVariables: {}
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    ownerAuthorization: '',
    deploy: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--owner-authorization') options.ownerAuthorization = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function environmentVariables(detail) {
  return Object.fromEntries(
    (detail && detail.Environment && detail.Environment.Variables || [])
      .map((item) => [String(item.Key || item.key || ''), String(item.Value || item.value || '')])
      .filter(([key]) => key)
  );
}

function summary(detail) {
  assert(detail && detail.Status === 'Active', `${FUNCTION_NAME} is not Active`);
  assert(detail.AvailableStatus === 'Available', `${FUNCTION_NAME} is not Available`);
  assert(detail.Handler === 'index.main', `${FUNCTION_NAME} handler drifted`);
  return {
    status: detail.Status,
    availableStatus: detail.AvailableStatus,
    runtime: String(detail.Runtime || ''),
    handler: detail.Handler,
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    installDependency: detail.InstallDependency,
    sourceSha256: sha256(Buffer.from(String(detail.CodeInfo || ''), 'utf8')),
    environmentFingerprint: environmentFingerprint(detail),
    envVariables: environmentVariables(detail)
  };
}

function assertConfiguration(value) {
  assert(value.runtime === DEFAULT_CONFIGURATION.runtime, `${FUNCTION_NAME} runtime drifted`);
  assert(value.handler === DEFAULT_CONFIGURATION.handler, `${FUNCTION_NAME} handler drifted`);
  assert(value.timeout === DEFAULT_CONFIGURATION.timeout, `${FUNCTION_NAME} timeout drifted`);
  assert(value.memorySize === DEFAULT_CONFIGURATION.memorySize, `${FUNCTION_NAME} memory drifted`);
}

function assertSafeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  assert(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'temporary directory escaped temp root');
  assert(path.basename(resolved).startsWith('step-4b-favorite-deploy-'), 'temporary directory prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary deploy directory is unsafe');
}

function deployOnly(environmentId, configuration) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'step-4b-favorite-deploy-'));
  const configPath = path.join(directory, 'cloudbaserc.json');
  try {
    assertSafeTemporaryDirectory(directory);
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [{
        name: FUNCTION_NAME,
        runtime: configuration.runtime,
        handler: configuration.handler,
        timeout: configuration.timeout,
        memorySize: configuration.memorySize,
        envVariables: configuration.envVariables
      }]
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase([
      '--config-file', configPath,
      '--env-id', environmentId,
      'fn', 'deploy', FUNCTION_NAME,
      '--force', '--json'
    ], { timeoutMs: 600000, json: false });
  } finally {
    if (fs.existsSync(directory)) {
      assertSafeTemporaryDirectory(directory);
      fs.rmSync(directory, { recursive: true, force: false });
    }
  }
}

function verifyPackageWithRetry(environmentId) {
  const expected = localDependencySummary(FUNCTION_NAME);
  let finalError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return verifyRemotePackage(environmentId, FUNCTION_NAME, expected);
    } catch (error) {
      finalError = error;
    }
  }
  throw finalError;
}

function readExisting(environmentId) {
  try {
    return summary(readFunctionDetail(environmentId, FUNCTION_NAME));
  } catch (error) {
    const text = String(error && error.message || error);
    if (/RESOURCE_NOT_FOUND|Function does not exist/i.test(text)) return null;
    throw error;
  }
}

async function run(options) {
  assert(['staging', 'production'].includes(options.environmentName), '--env staging|production is required');
  if (options.deploy) {
    assert(options.ownerAuthorization === OWNER_AUTHORIZATION, 'owner authorization phrase mismatch', 'OWNER_AUTHORIZATION_REQUIRED');
  }
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !options.deploy,
    allowInactiveStagingWrite: options.environmentName === 'staging' && options.deploy,
    allowProductionWrite: options.environmentName === 'production' && options.deploy
  });
  const localHash = sha256(fs.readFileSync(path.join(ROOT, 'cloudfunctions', FUNCTION_NAME, 'index.js')));
  assert(localHash === APPROVED_SOURCE_SHA256, `${FUNCTION_NAME} approved source drift`, 'SOURCE_FREEZE_DRIFT');

  const before = readExisting(preflight.environmentId);
  if (before) assertConfiguration(before);
  const configuration = before || { ...DEFAULT_CONFIGURATION, environmentFingerprint: sha256('[]') };
  if (!options.deploy) {
    if (before) delete before.envVariables;
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      functionName: FUNCTION_NAME,
      approvedSourceSha256: APPROVED_SOURCE_SHA256,
      rollback: ROLLBACK,
      currentRemote: before,
      functionExists: Boolean(before),
      wouldDeployOnly: [FUNCTION_NAME]
    };
  }

  deployOnly(preflight.environmentId, configuration);
  const after = summary(readFunctionDetail(preflight.environmentId, FUNCTION_NAME));
  assertConfiguration(after);
  assert(after.sourceSha256 === APPROVED_SOURCE_SHA256, `${FUNCTION_NAME} remote source hash differs`, 'REMOTE_SOURCE_DRIFT');
  if (before) {
    for (const field of ['runtime', 'handler', 'timeout', 'memorySize', 'environmentFingerprint']) {
      assert(after[field] === before[field], `${FUNCTION_NAME} ${field} changed`, 'FUNCTION_CONFIGURATION_DRIFT');
    }
  } else {
    assert(Object.keys(after.envVariables).length === 0, `${FUNCTION_NAME} unexpected staging variables`);
  }
  const remotePackage = verifyPackageWithRetry(preflight.environmentId);
  if (before) delete before.envVariables;
  delete after.envVariables;
  return {
    mode: 'deployed-and-verified',
    environment: publicSummary(preflight),
    deployedOnly: [FUNCTION_NAME],
    approvedSourceSha256: APPROVED_SOURCE_SHA256,
    rollback: ROLLBACK,
    createdFunction: !before,
    before,
    after,
    remotePackage,
    businessDataMutation: 0
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
    } catch (_) {}
    process.stderr.write(`${error.code || 'STEP4B_FAVORITE_DEPLOY_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FUNCTION_NAME,
  OWNER_AUTHORIZATION,
  APPROVED_SOURCE_SHA256,
  ROLLBACK,
  parseArguments,
  run
};
