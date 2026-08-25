const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

const FUNCTION_NAMES = Object.freeze(['messageAction', 'messageQuery']);
const DIAGNOSTIC_ENV_NAME = 'JICHU_ENVIRONMENT_ROLE';
const DIAGNOSTIC_ENV_VALUE = 'staging';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    deploy: false,
    onlyFunctions: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') {
      options.environmentName = String(argv[++index] || '').trim();
    } else if (value === '--confirm-target') {
      options.confirmTarget = String(argv[++index] || '').trim();
    } else if (value === '--deploy') {
      options.deploy = true;
    } else if (value === '--only') {
      options.onlyFunctions.push(String(argv[++index] || '').trim());
    } else {
      throw Object.assign(new Error(`unsupported argument: ${value}`), {
        code: 'INVALID_ARGUMENT'
      });
    }
  }
  return options;
}

function readEnvironmentVariables(detail) {
  const variables = detail && detail.Environment && detail.Environment.Variables;
  return Object.fromEntries((Array.isArray(variables) ? variables : [])
    .map((item) => [item.Key || item.key, item.Value || item.value])
    .filter(([key]) => Boolean(key)));
}

function environmentFingerprint(detail, excludedKeys = []) {
  const excluded = new Set(excludedKeys);
  const normalized = Object.entries(readEnvironmentVariables(detail))
    .filter(([key]) => !excluded.has(key))
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => String(left.key).localeCompare(String(right.key)));
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
    sourceHashMatches: Boolean(remoteSource)
      && sha256(localSource) === sha256(remoteSource),
    environmentFingerprint: environmentFingerprint(detail)
  };
}

function publicConfiguration(configuration) {
  return {
    name: configuration.name,
    runtime: configuration.runtime,
    handler: configuration.handler,
    timeout: configuration.timeout,
    memorySize: configuration.memorySize,
    diagnosticEnvironmentRole: DIAGNOSTIC_ENV_VALUE
  };
}

function assertSafeTemporaryDirectory(directory, prefix) {
  const resolved = path.resolve(directory);
  const expectedRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert(resolved.startsWith(expectedRoot), 'temporary directory escaped OS temp');
  assert(path.basename(resolved).startsWith(prefix), 'temporary prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary target is unsafe');
}

function removeSafeTemporaryDirectory(directory, prefix) {
  if (!fs.existsSync(directory)) {
    return;
  }
  assertSafeTemporaryDirectory(directory, prefix);
  fs.rmSync(directory, { recursive: true, force: false });
}

function deploy(environmentId, configurations) {
  const prefix = 'phase-25-hide-send-race-deploy-';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(directory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: configurations
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    for (const item of configurations) {
      runCloudBase([
        '--config-file', configPath,
        'fn', 'deploy', item.name,
        '--force'
      ], { timeoutMs: 300000, json: false });
    }
  } finally {
    removeSafeTemporaryDirectory(directory, prefix);
  }
}

function run(options) {
  assert(options.environmentName === 'staging', 'only staging is authorized');
  const selectedNames = options.onlyFunctions.length > 0
    ? [...new Set(options.onlyFunctions)]
    : [...FUNCTION_NAMES];
  assert(selectedNames.length > 0, 'at least one function is required');
  assert(
    selectedNames.every((name) => FUNCTION_NAMES.includes(name)),
    'only messageAction/messageQuery may be deployed'
  );
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: false,
    allowInactiveRead: false
  });
  const sources = Object.fromEntries(selectedNames.map((name) => [
    name,
    fs.readFileSync(
      path.join(ROOT, 'cloudfunctions', name, 'index.js'),
      'utf8'
    )
  ]));
  const beforeDetails = Object.fromEntries(selectedNames.map((name) => [
    name,
    readFunctionDetail(preflight.environmentId, name)
  ]));
  const before = Object.fromEntries(selectedNames.map((name) => [
    name,
    summarize(beforeDetails[name], sources[name])
  ]));
  const configurations = selectedNames.map((name) => {
    const detail = beforeDetails[name];
    assert(detail.Status === 'Active', `${name} is not active before deploy`);
    assert(detail.AvailableStatus === 'Available', `${name} is unavailable before deploy`);
    return {
      name,
      runtime: detail.Runtime,
      handler: detail.Handler,
      timeout: Number(detail.Timeout),
      memorySize: Number(detail.MemorySize),
      envVariables: {
        ...readEnvironmentVariables(detail),
        [DIAGNOSTIC_ENV_NAME]: DIAGNOSTIC_ENV_VALUE
      }
    };
  });
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      wouldDeployOnly: selectedNames,
      writesBusinessData: false,
      changesAclIndexesOrMaintenance: false,
      configurations: configurations.map(publicConfiguration),
      before
    };
  }
  deploy(preflight.environmentId, configurations);
  const after = {};
  for (const item of configurations) {
    const detail = readFunctionDetail(preflight.environmentId, item.name);
    const summary = summarize(detail, sources[item.name]);
    assert(summary.status === 'Active', `${item.name} is not active after deploy`);
    assert(summary.availableStatus === 'Available', `${item.name} is unavailable after deploy`);
    assert(summary.runtime === item.runtime, `${item.name} runtime changed`);
    assert(summary.handler === item.handler, `${item.name} handler changed`);
    assert(summary.timeout === item.timeout, `${item.name} timeout changed`);
    assert(summary.memorySize === item.memorySize, `${item.name} memory changed`);
    assert(summary.sourceHashMatches, `${item.name} remote source differs`);
    const variables = readEnvironmentVariables(detail);
    assert(
      variables[DIAGNOSTIC_ENV_NAME] === DIAGNOSTIC_ENV_VALUE,
      `${item.name} diagnostic environment role is not staging`
    );
    assert(
      environmentFingerprint(detail, [DIAGNOSTIC_ENV_NAME])
        === environmentFingerprint(
          beforeDetails[item.name],
          [DIAGNOSTIC_ENV_NAME]
        ),
      `${item.name} unrelated environment variables changed`
    );
    after[item.name] = summary;
  }
  return {
    mode: 'deployed',
    environment: publicSummary(preflight),
    deployedOnly: selectedNames,
    writesBusinessData: false,
    changesAclIndexesOrMaintenance: false,
    runtimeChanged: false,
    diagnosticEnvironmentRoleSet: true,
    unrelatedEnvironmentChanged: false,
    before,
    after
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(
      run(parseArguments(process.argv.slice(2))),
      null,
      2
    )}\n`);
  } catch (error) {
    process.stderr.write(
      `${error.code || 'PHASE25_RACE_DEPLOY_FAILED'}: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  FUNCTION_NAMES,
  DIAGNOSTIC_ENV_NAME,
  parseArguments,
  readEnvironmentVariables,
  summarize,
  run
};
