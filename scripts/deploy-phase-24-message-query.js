const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  runCloudBase,
  assert
} = require('./phase-18-canary-core');

const FUNCTION = Object.freeze({
  name: 'messageQuery',
  runtime: 'Nodejs18.15',
  handler: 'index.main',
  timeout: 10,
  memorySize: 256
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function environmentFingerprint(detail) {
  const variables = detail && detail.Environment && detail.Environment.Variables;
  const normalized = (Array.isArray(variables) ? variables : []).map((item) => ({
    key: item.Key || item.key,
    value: item.Value || item.value
  })).sort((left, right) => String(left.key).localeCompare(String(right.key)));
  return sha256(JSON.stringify(normalized));
}

function summarize(detail, localSource) {
  const remoteSource = String(detail.CodeInfo || '');
  return {
    status: detail.Status || '',
    availableStatus: detail.AvailableStatus || '',
    runtime: detail.Runtime || '',
    handler: detail.Handler || '',
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    localSourceSha256: sha256(localSource),
    remoteSourceSha256: remoteSource ? sha256(remoteSource) : '',
    sourceHashMatches: Boolean(remoteSource) && sha256(localSource) === sha256(remoteSource),
    environmentFingerprint: environmentFingerprint(detail)
  };
}

function parseArguments(argv) {
  const options = { confirmTarget: '', deploy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env' || value === '--confirm-target') {
      options.confirmTarget = String(argv[++index] || '').trim();
    } else if (value === '--deploy') {
      options.deploy = true;
    } else {
      throw Object.assign(new Error(`unsupported argument: ${value}`), {
        code: 'INVALID_ARGUMENT'
      });
    }
  }
  return options;
}

function localDependencySummary() {
  const directory = path.join(ROOT, 'cloudfunctions', FUNCTION.name);
  const packageSource = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
  const lockSource = fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8');
  const packageJson = JSON.parse(packageSource);
  const lock = JSON.parse(lockSource);
  assert(packageJson.dependencies.ws === '8.21.3', 'messageQuery ws must remain pinned to 8.21.3');
  assert(['4.0.2', '^4.0.2'].includes(packageJson.dependencies['wx-server-sdk']), 'messageQuery wx-server-sdk range changed');
  assert(lock.packages['node_modules/ws'].version === '8.21.3', 'messageQuery lockfile ws mismatch');
  assert(lock.packages['node_modules/wx-server-sdk'].version === '4.0.2', 'messageQuery lockfile SDK mismatch');
  return {
    packageSha256: sha256(packageSource),
    lockSha256: sha256(lockSource),
    ws: lock.packages['node_modules/ws'].version,
    wxServerSdk: lock.packages['node_modules/wx-server-sdk'].version
  };
}

function assertSafeTemporaryDirectory(directory, prefix) {
  const resolved = path.resolve(directory);
  const expectedRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert(resolved.startsWith(expectedRoot), 'temporary directory escaped the OS temp root');
  assert(path.basename(resolved).startsWith(prefix), 'temporary directory prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary target is not a plain directory');
}

function removeSafeTemporaryDirectory(directory, prefix) {
  if (!fs.existsSync(directory)) return;
  assertSafeTemporaryDirectory(directory, prefix);
  fs.rmSync(directory, { recursive: true, force: false });
}

function deploy(environmentId) {
  const prefix = 'phase-24-message-query-deploy-';
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [FUNCTION]
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase([
      '--config-file', configPath,
      'fn', 'deploy', FUNCTION.name,
      '--force'
    ], { timeoutMs: 300000, json: false });
  } finally {
    removeSafeTemporaryDirectory(temporaryDirectory, prefix);
  }
}

function verifyRemotePackage(environmentId, expected) {
  const prefix = 'phase-24-message-query-remote-';
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    runCloudBase([
      'fn', 'code', 'download', FUNCTION.name, temporaryDirectory,
      '--env-id', environmentId
    ], { timeoutMs: 240000, json: false });
    const packageSource = fs.readFileSync(path.join(temporaryDirectory, 'package.json'), 'utf8');
    const lockSource = fs.readFileSync(path.join(temporaryDirectory, 'package-lock.json'), 'utf8');
    const installedWs = JSON.parse(fs.readFileSync(
      path.join(temporaryDirectory, 'node_modules', 'ws', 'package.json'),
      'utf8'
    )).version;
    const installedSdk = JSON.parse(fs.readFileSync(
      path.join(temporaryDirectory, 'node_modules', 'wx-server-sdk', 'package.json'),
      'utf8'
    )).version;
    const remoteRequire = createRequire(path.join(temporaryDirectory, 'package.json'));
    remoteRequire('wx-server-sdk');
    remoteRequire('ws');
    assert(sha256(packageSource) === expected.packageSha256, 'remote package.json differs');
    assert(sha256(lockSource) === expected.lockSha256, 'remote package-lock.json differs');
    assert(installedWs === '8.21.3', `remote ws is ${installedWs}`);
    assert(installedSdk === '4.0.2', `remote wx-server-sdk is ${installedSdk}`);
    return {
      packageMatches: true,
      lockMatches: true,
      installedWs,
      installedSdk,
      dependenciesLoadable: true
    };
  } finally {
    removeSafeTemporaryDirectory(temporaryDirectory, prefix);
  }
}

function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --env ${targetMasked}`);
  const source = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions', FUNCTION.name, 'index.js'),
    'utf8'
  );
  assert(/schoolName:\s*normalizeString\(record\s*&&\s*record\.schoolName\)/.test(source), 'messageQuery schoolName response is missing');
  const dependency = localDependencySummary();
  const before = summarize(readFunctionDetail(environmentId, FUNCTION.name), source);
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      wouldDeployOnly: [FUNCTION.name],
      writesBusinessData: false,
      changesAclOrIndexes: false,
      runtimeChange: false,
      dependency,
      before
    };
  }

  deploy(environmentId);
  const after = summarize(readFunctionDetail(environmentId, FUNCTION.name), source);
  assert(after.status === 'Active' && after.availableStatus === 'Available', 'messageQuery is unavailable');
  assert(after.runtime === FUNCTION.runtime, 'messageQuery runtime changed');
  assert(after.handler === FUNCTION.handler, 'messageQuery handler changed');
  assert(after.timeout === FUNCTION.timeout && after.memorySize === FUNCTION.memorySize, 'messageQuery resources changed');
  assert(after.sourceHashMatches, 'messageQuery remote source differs from local');
  assert(before.environmentFingerprint === after.environmentFingerprint, 'messageQuery environment changed');
  const remotePackage = verifyRemotePackage(environmentId, dependency);
  return {
    mode: 'deployed',
    target: `cloud:${targetMasked}`,
    deployedOnly: [FUNCTION.name],
    writesBusinessData: false,
    changesAclOrIndexes: false,
    runtimeChanged: false,
    environmentChanged: false,
    before,
    after,
    remotePackage
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE24_MESSAGE_QUERY_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  FUNCTION,
  parseArguments,
  localDependencySummary,
  verifyRemotePackage,
  run
};
