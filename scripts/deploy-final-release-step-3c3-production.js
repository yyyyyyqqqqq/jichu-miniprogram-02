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

const OWNER_AUTHORIZATION = 'FINAL RELEASE STEP 3C-3 PRODUCTION DEPLOYMENT';
const APPROVED_SOURCE_HASHES = Object.freeze({
  userQuery: '65b120ccecb97b19eace5bfa4d5bb2a4ae62d3fadf9d9a5fcc8c47f61ae71ee9',
  appointmentAction: '13e9fcc3d225f3e9e0116a28632283a820b969a6025f9f98a10a436c5d1f5e23',
  messageAction: '301999900a3f170b5d80dc4e34a4404b2d40abe281c43ce73397850ab45d15b5'
});
const FUNCTION_NAMES = Object.freeze(Object.keys(APPROVED_SOURCE_HASHES));
const EXTRA_FILES = Object.freeze({
  appointmentAction: Object.freeze(['current-school-boundary.js']),
  messageAction: Object.freeze(['current-school-boundary.js'])
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = {
    environmentName: '', functionName: '', confirmTarget: '',
    ownerAuthorization: '', deploy: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--function') options.functionName = String(argv[++index] || '').trim();
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

function summary(detail, name) {
  assert(detail && detail.Status === 'Active', `${name} is not Active`);
  assert(detail.AvailableStatus === 'Available', `${name} is not Available`);
  assert(detail.Handler === 'index.main', `${name} handler drifted`);
  assert(String(detail.Runtime || ''), `${name} runtime unavailable`);
  assert(Number(detail.Timeout || 0) > 0, `${name} timeout unavailable`);
  assert(Number(detail.MemorySize || 0) > 0, `${name} memory unavailable`);
  return {
    status: detail.Status,
    availableStatus: detail.AvailableStatus,
    runtime: detail.Runtime,
    handler: detail.Handler,
    timeout: Number(detail.Timeout),
    memorySize: Number(detail.MemorySize),
    installDependency: detail.InstallDependency,
    sourceSha256: sha256(Buffer.from(String(detail.CodeInfo || ''), 'utf8')),
    environmentFingerprint: environmentFingerprint(detail),
    envVariables: environmentVariables(detail)
  };
}

function assertSafeTemporaryDirectory(directory, prefix) {
  const resolved = path.resolve(directory);
  assert(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'temporary directory escaped temp root');
  assert(path.basename(resolved).startsWith(prefix), 'temporary directory prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary directory is unsafe');
}

function deployOnly(environmentId, name, before) {
  const prefix = `step-3c3-production-${name}-`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(directory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [{
        name,
        runtime: before.runtime,
        handler: before.handler,
        timeout: before.timeout,
        memorySize: before.memorySize,
        envVariables: before.envVariables
      }]
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase([
      '--config-file', configPath,
      '--env-id', environmentId,
      'fn', 'deploy', name,
      '--force', '--json'
    ], { timeoutMs: 600000, json: false });
  } finally {
    if (fs.existsSync(directory)) {
      assertSafeTemporaryDirectory(directory, prefix);
      fs.rmSync(directory, { recursive: true, force: false });
    }
  }
}

function extraFileHashes(name) {
  return Object.fromEntries((EXTRA_FILES[name] || []).map((relativePath) => [
    relativePath,
    sha256(fs.readFileSync(path.join(ROOT, 'cloudfunctions', name, relativePath)))
  ]));
}

function verifyPackageWithRetry(environmentId, name, expected) {
  let finalError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return verifyRemotePackage(environmentId, name, expected);
    } catch (error) {
      finalError = error;
    }
  }
  throw finalError;
}

async function run(options) {
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  assert(FUNCTION_NAMES.includes(options.functionName), '--function must name one approved function', 'FUNCTION_REQUIRED');
  if (options.deploy) {
    assert(options.ownerAuthorization === OWNER_AUTHORIZATION, 'owner authorization phrase mismatch', 'OWNER_AUTHORIZATION_REQUIRED');
  }
  const preflight = runPreflight({
    environmentName: 'production',
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: options.deploy,
    allowInactiveRead: false
  });
  const name = options.functionName;
  const localHash = sha256(fs.readFileSync(path.join(ROOT, 'cloudfunctions', name, 'index.js')));
  assert(localHash === APPROVED_SOURCE_HASHES[name], `${name} approved source drift`, 'SOURCE_FREEZE_DRIFT');
  const before = summary(readFunctionDetail(preflight.environmentId, name), name);
  if (!options.deploy) {
    delete before.envVariables;
    return {
      mode: 'dry-run', environment: publicSummary(preflight), functionName: name,
      approvedSourceSha256: APPROVED_SOURCE_HASHES[name], localSourceSha256: localHash,
      currentRemote: before
    };
  }
  deployOnly(preflight.environmentId, name, before);
  const after = summary(readFunctionDetail(preflight.environmentId, name), name);
  assert(after.sourceSha256 === APPROVED_SOURCE_HASHES[name], `${name} remote source hash differs`, 'REMOTE_SOURCE_DRIFT');
  for (const field of ['runtime', 'handler', 'timeout', 'memorySize', 'environmentFingerprint']) {
    assert(after[field] === before[field], `${name} ${field} changed`, 'FUNCTION_CONFIGURATION_DRIFT');
  }
  const dependency = localDependencySummary(name);
  const remotePackage = verifyPackageWithRetry(preflight.environmentId, name, {
    ...dependency,
    extraFileSha256: extraFileHashes(name)
  });
  delete before.envVariables;
  delete after.envVariables;
  return {
    mode: 'deployed-and-verified', environment: publicSummary(preflight),
    deployedOnly: [name], approvedSourceSha256: APPROVED_SOURCE_HASHES[name],
    before, after, remotePackage, businessDataMutation: 0
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
    process.stderr.write(`${error.code || 'STEP3C3_PRODUCTION_DEPLOY_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { OWNER_AUTHORIZATION, APPROVED_SOURCE_HASHES, FUNCTION_NAMES, parseArguments, run };
