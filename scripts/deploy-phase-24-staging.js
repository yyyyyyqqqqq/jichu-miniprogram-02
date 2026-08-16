const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert,
  maskIdentifier
} = require('./environment-preflight');
const {
  readFunctionDetail
} = require('./phase-18-canary-core');
const {
  runCloudBase
} = require('./schools/cloud-cli');
const {
  localDependencySummary,
  verifyRemotePackage
} = require('./deploy-phase-24-auth-flow');

const FUNCTIONS = Object.freeze([
  Object.freeze({ name: 'authUser', runtime: 'Nodejs16.13' }),
  Object.freeze({ name: 'schoolQuery', runtime: 'Nodejs18.15' }),
  Object.freeze({ name: 'productQuery', runtime: 'Nodejs16.13' }),
  Object.freeze({ name: 'createProduct', runtime: 'Nodejs16.13' }),
  Object.freeze({ name: 'userQuery', runtime: 'Nodejs18.15' })
]);
const HANDLER = 'index.main';
const TIMEOUT = 10;
const MEMORY_SIZE = 256;
const PRODUCT_ENVIRONMENT_KEYS = Object.freeze([
  'PRODUCT_QUERY_CURSOR_HMAC_SECRET',
  'PRODUCT_SEED_ENABLED'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
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

function readStagingSecrets() {
  const filePath = path.join(ROOT, 'config', 'cloud.secrets.private.js');
  assert(fs.existsSync(filePath), 'staging secret file is unavailable', 'STAGING_SECRET_MISSING');
  delete require.cache[require.resolve(filePath)];
  const config = require(filePath);
  const secret = String(config && config.staging && config.staging.productQueryCursorHmacSecret || '').trim();
  assert(secret.length >= 43, 'staging cursor secret must contain at least 256 bits', 'STAGING_SECRET_WEAK');
  return { productQueryCursorHmacSecret: secret };
}

function environmentVariablesFor(name, secrets) {
  if (name !== 'productQuery') return {};
  return {
    PRODUCT_QUERY_CURSOR_HMAC_SECRET: secrets.productQueryCursorHmacSecret,
    PRODUCT_SEED_ENABLED: 'false'
  };
}

function environmentSummary(detail) {
  const variables = (detail && detail.Environment && detail.Environment.Variables || []).map((item) => ({
    key: String(item.Key || item.key || ''),
    value: String(item.Value || item.value || '')
  })).sort((left, right) => left.key.localeCompare(right.key));
  return {
    keys: variables.map((item) => item.key),
    fingerprint: sha256(JSON.stringify(variables))
  };
}

function localSummary(item, secrets) {
  const directory = path.join(ROOT, 'cloudfunctions', item.name);
  const source = fs.readFileSync(path.join(directory, 'index.js'), 'utf8');
  const dependency = localDependencySummary(item.name);
  const variables = environmentVariablesFor(item.name, secrets);
  return {
    runtime: item.runtime,
    handler: HANDLER,
    timeout: TIMEOUT,
    memorySize: MEMORY_SIZE,
    sourceSha256: sha256(source),
    packageSha256: dependency.packageSha256,
    lockSha256: dependency.lockSha256,
    wxServerSdk: dependency.wxServerSdk,
    ws: dependency.ws,
    environmentKeys: Object.keys(variables).sort(),
    environmentFingerprint: sha256(JSON.stringify(
      Object.entries(variables).map(([key, value]) => ({ key, value })).sort((left, right) => left.key.localeCompare(right.key))
    ))
  };
}

function remoteSummary(detail, localSource) {
  const remoteSource = String(detail.CodeInfo || '');
  const environment = environmentSummary(detail);
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
    environmentKeys: environment.keys,
    environmentFingerprint: environment.fingerprint
  };
}

function assertSafeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert(resolved.startsWith(temporaryRoot), 'temporary deploy directory escaped temp root');
  assert(path.basename(resolved).startsWith('phase-24-staging-deploy-'), 'temporary deploy prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary deploy target is unsafe');
}

function deployFunctions(environmentId, secrets) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-24-staging-deploy-'));
  assertSafeTemporaryDirectory(directory);
  const configPath = path.join(directory, 'cloudbaserc.json');
  const config = {
    envId: environmentId,
    // CloudBase CLI resolves functionRoot from its process cwd. On Windows an
    // absolute value is incorrectly appended to cwd by CLI 3.6.3, producing a
    // duplicated drive path, so keep this project-relative.
    functionRoot: 'cloudfunctions',
    functions: FUNCTIONS.map((item) => ({
      name: item.name,
      runtime: item.runtime,
      handler: HANDLER,
      timeout: TIMEOUT,
      memorySize: MEMORY_SIZE,
      envVariables: environmentVariablesFor(item.name, secrets)
    }))
  };
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    for (const item of FUNCTIONS) {
      runCloudBase([
        '--config-file', configPath,
        '--env-id', environmentId,
        'fn', 'deploy', item.name,
        '--force',
        '--json'
      ], {
        timeoutMs: 600000,
        // CLI 3.6.3 may emit only progress text for a successful deployment on
        // Windows. The exit status is authoritative here; the remote function
        // detail and downloaded package are verified immediately afterwards.
        json: false
      });
    }
  } finally {
    if (fs.existsSync(directory)) {
      assertSafeTemporaryDirectory(directory);
      fs.rmSync(directory, { recursive: true, force: false });
    }
  }
}

function verifyPackageWithRetry(environmentId, name, local) {
  let finalError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return verifyRemotePackage(environmentId, name, local);
    } catch (error) {
      finalError = error;
      if (!/ECONNRESET|socket hang up|network/i.test(String(error && error.message || ''))) break;
    }
  }
  throw finalError;
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget
  });
  assert(preflight.environmentName === 'staging', 'staging deploy refuses production', 'PRODUCTION_WRITE_REJECTED');
  const secrets = readStagingSecrets();
  const local = Object.fromEntries(FUNCTIONS.map((item) => [item.name, localSummary(item, secrets)]));
  const publicLocal = Object.fromEntries(Object.entries(local).map(([name, item]) => [name, {
    runtime: item.runtime,
    handler: item.handler,
    timeout: item.timeout,
    memorySize: item.memorySize,
    sourceSha256: item.sourceSha256,
    packageSha256: item.packageSha256,
    lockSha256: item.lockSha256,
    wxServerSdk: item.wxServerSdk,
    ws: item.ws,
    environmentKeys: item.environmentKeys,
    environmentFingerprint: item.environmentFingerprint
  }]));
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      preflight: publicSummary(preflight),
      wouldDeployOnly: FUNCTIONS.map((item) => item.name),
      local: publicLocal,
      secret: {
        key: 'PRODUCT_QUERY_CURSOR_HMAC_SECRET',
        fingerprint: sha256(secrets.productQueryCursorHmacSecret).slice(0, 16),
        independentValueRequired: true
      },
      productSeedEnabled: false
    };
  }

  const targets = require('../config/cloud.targets.private');
  const productionProduct = readFunctionDetail(targets.production, 'productQuery');
  const productionEnvironment = environmentSummary(productionProduct);
  assert(
    productionEnvironment.fingerprint !== local.productQuery.environmentFingerprint,
    'staging productQuery environment fingerprint equals production',
    'STAGING_SECRET_NOT_INDEPENDENT'
  );
  deployFunctions(preflight.environmentId, secrets);
  const remote = {};
  const packages = {};
  for (const item of FUNCTIONS) {
    const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', item.name, 'index.js'), 'utf8');
    const detail = readFunctionDetail(preflight.environmentId, item.name);
    const summary = remoteSummary(detail, source);
    assert(summary.status === 'Active', `${item.name} is not Active`);
    assert(summary.availableStatus === 'Available', `${item.name} is not Available`);
    assert(summary.runtime === item.runtime, `${item.name} runtime differs`);
    assert(summary.handler === HANDLER, `${item.name} handler differs`);
    assert(summary.timeout === TIMEOUT && summary.memorySize === MEMORY_SIZE, `${item.name} resources differ`);
    assert(summary.sourceHashMatches, `${item.name} source hash differs`);
    assert(JSON.stringify(summary.environmentKeys) === JSON.stringify(local[item.name].environmentKeys), `${item.name} environment keys differ`);
    assert(summary.environmentFingerprint === local[item.name].environmentFingerprint, `${item.name} environment fingerprint differs`);
    remote[item.name] = summary;
    packages[item.name] = verifyPackageWithRetry(preflight.environmentId, item.name, localDependencySummary(item.name));
  }
  return {
    mode: 'deployed-and-verified',
    preflight: publicSummary(preflight),
    deployedOnly: FUNCTIONS.map((item) => item.name),
    local: publicLocal,
    remote,
    packages,
    productQueryEnvironmentIndependentFromProduction: true,
    secretFingerprint: sha256(secrets.productQueryCursorHmacSecret).slice(0, 16)
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    const targets = (() => {
      try { return require('../config/cloud.targets.private'); } catch (ignored) { return {}; }
    })();
    let message = String(error && error.message || error);
    for (const id of [targets.production, targets.staging].filter(Boolean)) {
      message = message.split(id).join(maskIdentifier(id));
    }
    process.stderr.write(`${error.code || 'PHASE24_STAGING_DEPLOY_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FUNCTIONS,
  PRODUCT_ENVIRONMENT_KEYS,
  parseArguments,
  readStagingSecrets,
  environmentVariablesFor,
  environmentSummary,
  localSummary,
  remoteSummary,
  run
};
