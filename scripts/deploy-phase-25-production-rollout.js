const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const {
  ROOT,
  readFunctionDetail,
  runCloudBase,
  assert
} = require('./phase-18-canary-core');
const {
  runPreflight,
  publicSummary
} = require('./environment-preflight');

const OWNER_AUTHORIZATION = 'phase25-production-rollout-authorized-by-project-owner';
const SAFE_QUERY_HASH = 'c4472a128fac981c5e1fa141288876e271d6ec397ef7d7686378596835304f30';
const FUNCTIONS = Object.freeze({
  messageAction: Object.freeze({
    sourceSha256: '345fbe2ab6016ca24f3adfb06189f8c2b0d0e4f05d11d30982c5852c11d5fa47'
  }),
  appointmentAction: Object.freeze({
    sourceSha256: '8959c9a8953071f9819b18bd47b655aa780ad8344e2ec5f4e0c544c9150e2f83'
  })
});
const CONFIGURATION = Object.freeze({
  runtime: 'Nodejs18.15',
  handler: 'index.main',
  timeout: 10,
  memorySize: 256
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseArguments(argv) {
  const options = {
    functionName: '',
    confirmTarget: '',
    ownerAuthorization: '',
    deploy: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--function') options.functionName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--owner-authorization') options.ownerAuthorization = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function readEnvironmentVariables(detail) {
  const variables = detail && detail.Environment && detail.Environment.Variables;
  return Object.fromEntries((Array.isArray(variables) ? variables : [])
    .map((item) => [String(item.Key || item.key || ''), String(item.Value || item.value || '')])
    .filter(([key]) => Boolean(key)));
}

function environmentFingerprint(detail) {
  const normalized = Object.entries(readEnvironmentVariables(detail))
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return sha256(JSON.stringify(normalized));
}

function diagnosticRole(detail) {
  return readEnvironmentVariables(detail).JICHU_ENVIRONMENT_ROLE || '(unset)';
}

function assertDiagnosticSafe(detail, functionName) {
  const role = diagnosticRole(detail).toLowerCase();
  assert(!['staging', 'development'].includes(role), `${functionName} diagnostic role is unsafe for production`);
}

function summarize(detail, localSource) {
  const remoteSource = String(detail.CodeInfo || '');
  return {
    status: String(detail.Status || ''),
    availableStatus: String(detail.AvailableStatus || ''),
    runtime: String(detail.Runtime || ''),
    handler: String(detail.Handler || ''),
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    installDependency: String(detail.InstallDependency || ''),
    diagnosticEnvironmentRole: diagnosticRole(detail),
    localSourceSha256: sha256(localSource),
    remoteSourceSha256: remoteSource ? sha256(remoteSource) : '',
    sourceHashMatches: Boolean(remoteSource) && sha256(localSource) === sha256(remoteSource),
    environmentFingerprint: environmentFingerprint(detail)
  };
}

function assertFunctionConfiguration(summary, functionName) {
  assert(summary.status === 'Active', `${functionName} is not Active`);
  assert(summary.availableStatus === 'Available', `${functionName} is not Available`);
  assert(summary.runtime === CONFIGURATION.runtime, `${functionName} runtime changed`);
  assert(summary.handler === CONFIGURATION.handler, `${functionName} handler changed`);
  assert(summary.timeout === CONFIGURATION.timeout, `${functionName} timeout changed`);
  assert(summary.memorySize === CONFIGURATION.memorySize, `${functionName} memory changed`);
  assert(summary.installDependency === 'TRUE', `${functionName} dependency installation is disabled`);
}

function assertSafeQueryOnline(environmentId) {
  const detail = readFunctionDetail(environmentId, 'messageQuery');
  const remoteHash = sha256(String(detail.CodeInfo || ''));
  assert(remoteHash === SAFE_QUERY_HASH, 'minimum-safe messageQuery is not online');
  assertFunctionConfiguration(summarize(detail, String(detail.CodeInfo || '')), 'messageQuery');
  assertDiagnosticSafe(detail, 'messageQuery');
  return {
    status: detail.Status,
    availableStatus: detail.AvailableStatus,
    sourceSha256: remoteHash,
    diagnosticEnvironmentRole: diagnosticRole(detail)
  };
}

function assertSafeTemporaryDirectory(directory, prefix) {
  const resolved = path.resolve(directory);
  assert(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'temporary directory escaped OS temp');
  assert(path.basename(resolved).startsWith(prefix), 'temporary directory prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary target is unsafe');
}

function removeSafeTemporaryDirectory(directory, prefix) {
  if (!fs.existsSync(directory)) return;
  assertSafeTemporaryDirectory(directory, prefix);
  fs.rmSync(directory, { recursive: true, force: false });
}

function deployFunction(environmentId, functionName, environmentVariables) {
  const prefix = `phase-25-production-${functionName}-`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(directory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [{
        name: functionName,
        ...CONFIGURATION,
        envVariables: environmentVariables
      }]
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase([
      '--config-file', configPath,
      'fn', 'deploy', functionName,
      '--force'
    ], { timeoutMs: 300000, json: false });
  } finally {
    removeSafeTemporaryDirectory(directory, prefix);
  }
}

function verifyRemotePackage(environmentId, functionName) {
  const prefix = `phase-25-production-${functionName}-remote-`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    runCloudBase([
      'fn', 'code', 'download', functionName, directory,
      '--env-id', environmentId
    ], { timeoutMs: 240000, json: false });
    const packageSource = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
    const lockSource = fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8');
    const localDirectory = path.join(ROOT, 'cloudfunctions', functionName);
    assert(sha256(packageSource) === sha256(fs.readFileSync(path.join(localDirectory, 'package.json'), 'utf8')), `${functionName} remote package.json differs`);
    assert(sha256(lockSource) === sha256(fs.readFileSync(path.join(localDirectory, 'package-lock.json'), 'utf8')), `${functionName} remote package-lock.json differs`);
    const remoteRequire = createRequire(path.join(directory, 'package.json'));
    remoteRequire('wx-server-sdk');
    remoteRequire('ws');
    return {
      packageMatches: true,
      lockMatches: true,
      dependenciesLoadable: true,
      wxServerSdk: JSON.parse(fs.readFileSync(path.join(directory, 'node_modules', 'wx-server-sdk', 'package.json'), 'utf8')).version,
      ws: JSON.parse(fs.readFileSync(path.join(directory, 'node_modules', 'ws', 'package.json'), 'utf8')).version
    };
  } finally {
    removeSafeTemporaryDirectory(directory, prefix);
  }
}

function run(options) {
  const approved = FUNCTIONS[options.functionName];
  assert(Boolean(approved), '--function must be messageAction or appointmentAction');
  if (options.deploy) {
    assert(options.ownerAuthorization === OWNER_AUTHORIZATION, `deploy requires --owner-authorization ${OWNER_AUTHORIZATION}`);
  }
  const preflight = runPreflight({
    environmentName: 'production',
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: options.deploy,
    allowInactiveRead: false
  });
  const localSource = fs.readFileSync(path.join(ROOT, 'cloudfunctions', options.functionName, 'index.js'), 'utf8');
  assert(sha256(localSource) === approved.sourceSha256, `${options.functionName} approved source drift`);
  const safeQuery = assertSafeQueryOnline(preflight.environmentId);
  const beforeDetail = readFunctionDetail(preflight.environmentId, options.functionName);
  const before = summarize(beforeDetail, localSource);
  assertFunctionConfiguration(before, options.functionName);
  assertDiagnosticSafe(beforeDetail, options.functionName);
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      wouldDeployOnly: [options.functionName],
      approvedSourceSha256: approved.sourceSha256,
      safeQuery,
      before
    };
  }
  deployFunction(preflight.environmentId, options.functionName, readEnvironmentVariables(beforeDetail));
  const afterDetail = readFunctionDetail(preflight.environmentId, options.functionName);
  const after = summarize(afterDetail, localSource);
  assertFunctionConfiguration(after, options.functionName);
  assert(after.remoteSourceSha256 === approved.sourceSha256, `${options.functionName} remote source differs from approved source`);
  assert(after.sourceHashMatches, `${options.functionName} remote source differs from local source`);
  assert(before.environmentFingerprint === after.environmentFingerprint, `${options.functionName} environment changed`);
  assertDiagnosticSafe(afterDetail, options.functionName);
  const remotePackage = verifyRemotePackage(preflight.environmentId, options.functionName);
  const safeQueryAfter = assertSafeQueryOnline(preflight.environmentId);
  return {
    mode: 'deployed',
    environment: publicSummary(preflight),
    deployedOnly: [options.functionName],
    writesBusinessData: false,
    changesAclIndexesOrMaintenance: false,
    safeQueryBefore: safeQuery,
    safeQueryAfter,
    before,
    after,
    remotePackage
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE25_PRODUCTION_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  OWNER_AUTHORIZATION,
  SAFE_QUERY_HASH,
  FUNCTIONS,
  parseArguments,
  run
};
