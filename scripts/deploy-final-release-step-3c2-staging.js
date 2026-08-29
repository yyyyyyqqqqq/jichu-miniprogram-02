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
  const options = { environmentName: '', confirmTarget: '', deploy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function sourcePath(name) {
  return path.join(ROOT, 'cloudfunctions', name, 'index.js');
}

function sourceHash(name) {
  return sha256(fs.readFileSync(sourcePath(name)));
}

function assertSourceFreeze() {
  for (const name of FUNCTION_NAMES) {
    assert(
      sourceHash(name) === APPROVED_SOURCE_HASHES[name],
      `${name} source changed after freeze`,
      'SOURCE_FREEZE_DRIFT'
    );
  }
}

function environmentVariables(detail) {
  return Object.fromEntries(
    (detail && detail.Environment && detail.Environment.Variables || []).map((item) => [
      String(item.Key || item.key || ''),
      String(item.Value || item.value || '')
    ]).filter(([key]) => key)
  );
}

function approvedConfiguration(detail, name) {
  assert(detail && detail.Status === 'Active', `${name} is not Active before deploy`);
  assert(detail.AvailableStatus === 'Available', `${name} is not Available before deploy`);
  assert(detail.Handler === 'index.main', `${name} handler is not index.main`);
  const runtime = String(detail.Runtime || '');
  const timeout = Number(detail.Timeout || 0);
  const memorySize = Number(detail.MemorySize || 0);
  assert(runtime, `${name} runtime is unavailable`);
  assert(timeout > 0 && memorySize > 0, `${name} resource configuration is unavailable`);
  return {
    name,
    runtime,
    handler: 'index.main',
    timeout,
    memorySize,
    envVariables: environmentVariables(detail),
    environmentFingerprint: environmentFingerprint(detail)
  };
}

function assertSafeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert(resolved.startsWith(temporaryRoot), 'temporary deploy directory escaped temp root');
  assert(path.basename(resolved).startsWith('step-3c2-staging-deploy-'), 'temporary deploy prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary deploy target is unsafe');
}

function deployOnly(environmentId, configurations) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'step-3c2-staging-deploy-'));
  assertSafeTemporaryDirectory(directory);
  const configPath = path.join(directory, 'cloudbaserc.json');
  const config = {
    envId: environmentId,
    functionRoot: 'cloudfunctions',
    functions: configurations.map((item) => ({
      name: item.name,
      runtime: item.runtime,
      handler: item.handler,
      timeout: item.timeout,
      memorySize: item.memorySize,
      envVariables: item.envVariables
    }))
  };
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    for (const item of configurations) {
      runCloudBase([
        '--config-file', configPath,
        '--env-id', environmentId,
        'fn', 'deploy', item.name,
        '--force',
        '--json'
      ], { timeoutMs: 600000, json: false });
    }
  } finally {
    if (fs.existsSync(directory)) {
      assertSafeTemporaryDirectory(directory);
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
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !options.deploy
  });
  assert(preflight.environmentName === 'staging', 'production deployment is forbidden', 'PRODUCTION_WRITE_REJECTED');
  assertSourceFreeze();

  const before = Object.fromEntries(FUNCTION_NAMES.map((name) => [
    name,
    approvedConfiguration(readFunctionDetail(preflight.environmentId, name), name)
  ]));
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      preflight: publicSummary(preflight),
      approvedSourceHashes: APPROVED_SOURCE_HASHES,
      currentRemoteHashes: Object.fromEntries(FUNCTION_NAMES.map((name) => {
        const detail = readFunctionDetail(preflight.environmentId, name);
        return [name, sha256(Buffer.from(String(detail.CodeInfo || ''), 'utf8'))];
      })),
      wouldDeployOnly: FUNCTION_NAMES
    };
  }

  deployOnly(preflight.environmentId, Object.values(before));
  assertSourceFreeze();

  const remote = {};
  const packages = {};
  for (const name of FUNCTION_NAMES) {
    const detail = readFunctionDetail(preflight.environmentId, name);
    const after = approvedConfiguration(detail, name);
    const remoteHash = sha256(Buffer.from(String(detail.CodeInfo || ''), 'utf8'));
    assert(remoteHash === APPROVED_SOURCE_HASHES[name], `${name} remote source hash differs`);
    assert(after.runtime === before[name].runtime, `${name} runtime changed`);
    assert(after.handler === before[name].handler, `${name} handler changed`);
    assert(after.timeout === before[name].timeout, `${name} timeout changed`);
    assert(after.memorySize === before[name].memorySize, `${name} memory changed`);
    assert(
      after.environmentFingerprint === before[name].environmentFingerprint,
      `${name} environment fingerprint changed`
    );
    const dependency = localDependencySummary(name);
    packages[name] = verifyPackageWithRetry(preflight.environmentId, name, {
      ...dependency,
      extraFileSha256: extraFileHashes(name)
    });
    remote[name] = {
      sourceSha256: remoteHash,
      sourceMatches: true,
      status: after && detail.Status,
      availableStatus: detail.AvailableStatus,
      runtime: after.runtime,
      handler: after.handler,
      timeout: after.timeout,
      memorySize: after.memorySize,
      environmentFingerprintUnchanged: true
    };
  }
  return {
    mode: 'deployed-and-verified',
    preflight: publicSummary(preflight),
    deployedOnly: FUNCTION_NAMES,
    approvedSourceHashes: APPROVED_SOURCE_HASHES,
    remote,
    packages
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    let message = String(error && error.message || error);
    try {
      const targets = require('../config/cloud.targets.private');
      for (const id of [targets.production, targets.staging].filter(Boolean)) {
        message = message.split(id).join(maskIdentifier(id));
      }
    } catch (ignored) {
      // Private target absence is already reported by preflight.
    }
    process.stderr.write(`${error.code || 'STEP_3C2_STAGING_DEPLOY_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  APPROVED_SOURCE_HASHES,
  FUNCTION_NAMES,
  parseArguments,
  run
};
