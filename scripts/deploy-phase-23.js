const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  runCloudBase,
  assert
} = require('./phase-18-canary-core');

const FUNCTIONS = Object.freeze([
  { name: 'appointmentAction', runtime: 'Nodejs18.15' },
  { name: 'appointmentQuery', runtime: 'Nodejs18.15' },
  { name: 'createProduct', runtime: 'Nodejs16.13' },
  { name: 'favoriteProduct', runtime: 'Nodejs18.15' },
  { name: 'manageProduct', runtime: 'Nodejs16.13' },
  { name: 'messageAction', runtime: 'Nodejs18.15' },
  { name: 'messageQuery', runtime: 'Nodejs18.15' },
  { name: 'productQuery', runtime: 'Nodejs16.13' },
  { name: 'productViewAction', runtime: 'Nodejs18.15' },
  { name: 'schoolQuery', runtime: 'Nodejs18.15' },
  { name: 'userQuery', runtime: 'Nodejs18.15' }
]);

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
    installDependency: String(detail.InstallDependency || ''),
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
    } else if (value === '--deploy') options.deploy = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function localDependencySummary(name) {
  const directory = path.join(ROOT, 'cloudfunctions', name);
  const packageSource = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
  const lockSource = fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8');
  const packageJson = JSON.parse(packageSource);
  const lock = JSON.parse(lockSource);
  assert(packageJson.dependencies && packageJson.dependencies.ws === '8.21.3', `${name} ws must be pinned to 8.21.3`);
  assert(
    ['4.0.2', '^4.0.2'].includes(packageJson.dependencies['wx-server-sdk']),
    `${name} wx-server-sdk range changed unexpectedly`
  );
  assert(lock.packages['node_modules/ws'].version === '8.21.3', `${name} lockfile ws mismatch`);
  assert(lock.packages['node_modules/wx-server-sdk'].version === '4.0.2', `${name} lockfile wx-server-sdk mismatch`);
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

function deployFunctions(environmentId) {
  const prefix = 'phase-23-deploy-';
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: FUNCTIONS.map((item) => ({
        ...item,
        handler: 'index.main',
        timeout: 10,
        memorySize: 256
      }))
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    for (const item of FUNCTIONS) {
      runCloudBase([
        '--config-file', configPath,
        'fn', 'deploy', item.name,
        '--force'
      ], { timeoutMs: 300000, json: false });
    }
  } finally {
    removeSafeTemporaryDirectory(temporaryDirectory, prefix);
  }
}

function verifyRemotePackage(environmentId, name, expected) {
  const prefix = `phase-23-remote-${name}-`;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    runCloudBase([
      'fn', 'code', 'download', name, temporaryDirectory,
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
    assert(sha256(packageSource) === expected.packageSha256, `${name} remote package.json differs`);
    assert(sha256(lockSource) === expected.lockSha256, `${name} remote package-lock.json differs`);
    assert(installedWs === '8.21.3', `${name} remote installed ws is ${installedWs}`);
    assert(installedSdk === '4.0.2', `${name} remote installed wx-server-sdk is ${installedSdk}`);
    return { packageMatches: true, lockMatches: true, installedWs, installedSdk };
  } finally {
    removeSafeTemporaryDirectory(temporaryDirectory, prefix);
  }
}

function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --env ${targetMasked}`);
  const local = {};
  const before = {};
  for (const item of FUNCTIONS) {
    local[item.name] = localDependencySummary(item.name);
    const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', item.name, 'index.js'), 'utf8');
    before[item.name] = summarize(readFunctionDetail(environmentId, item.name), source);
  }
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      wouldDeployOnly: FUNCTIONS.map((item) => item.name),
      dependencyChange: 'ws 8.21.1 -> 8.21.3',
      runtimeChange: false,
      writesBusinessData: false,
      changesAclOrIndexes: false,
      local,
      before
    };
  }

  deployFunctions(environmentId);
  const after = {};
  const remotePackages = {};
  for (const item of FUNCTIONS) {
    const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', item.name, 'index.js'), 'utf8');
    const summary = summarize(readFunctionDetail(environmentId, item.name), source);
    assert(summary.status === 'Active' && summary.availableStatus === 'Available', `${item.name} is unavailable`);
    assert(summary.runtime === item.runtime, `${item.name} runtime changed`);
    assert(summary.handler === 'index.main', `${item.name} handler changed`);
    assert(summary.timeout === 10 && summary.memorySize === 256, `${item.name} resources changed`);
    assert(summary.sourceHashMatches, `${item.name} remote index.js differs from local`);
    assert(before[item.name].environmentFingerprint === summary.environmentFingerprint, `${item.name} environment changed`);
    after[item.name] = summary;
    remotePackages[item.name] = verifyRemotePackage(environmentId, item.name, local[item.name]);
  }
  return {
    mode: 'deployed',
    target: `cloud:${targetMasked}`,
    deployedOnly: FUNCTIONS.map((item) => item.name),
    dependencyChange: 'ws 8.21.1 -> 8.21.3',
    runtimeChanged: false,
    environmentChanged: false,
    writesBusinessData: false,
    changesAclOrIndexes: false,
    before,
    after,
    remotePackages
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE23_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  FUNCTIONS,
  parseArguments,
  localDependencySummary,
  verifyRemotePackage,
  run
};
