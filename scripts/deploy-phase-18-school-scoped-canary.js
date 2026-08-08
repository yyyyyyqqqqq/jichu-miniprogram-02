const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT,
  PRIVATE_BOOTSTRAP_PATH,
  loadBootstrapPrivate,
  loadEnvironmentId,
  maskEnvironmentId,
  maskId,
  readFunctionDetail,
  runCloudBase,
  assert
} = require('./phase-18-canary-core');

const FUNCTION = Object.freeze({
  name: 'productQuery',
  runtime: 'Nodejs16.13',
  handler: 'index.main',
  timeout: 10,
  memorySize: 256
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function environmentMap(detail) {
  const variables = detail && detail.Environment && detail.Environment.Variables;
  return Object.fromEntries((Array.isArray(variables) ? variables : []).map((item) => [
    item.Key || item.key,
    String(item.Value || item.value || '')
  ]));
}

function summarize(detail, localCode) {
  const remoteCode = String(detail.CodeInfo || '');
  const environment = environmentMap(detail);
  return {
    status: detail.Status || '',
    runtime: detail.Runtime || '',
    handler: detail.Handler || '',
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    localSha256: sha256(localCode),
    remoteSha256: remoteCode ? sha256(remoteCode) : '',
    hashMatches: Boolean(remoteCode) && sha256(localCode) === sha256(remoteCode),
    cursorSecretPresent: Boolean(environment.PRODUCT_QUERY_CURSOR_HMAC_SECRET),
    cursorSecretLengthQualified: (environment.PRODUCT_QUERY_CURSOR_HMAC_SECRET || '').length >= 32,
    productSeedEnabledPresent: Object.prototype.hasOwnProperty.call(environment, 'PRODUCT_SEED_ENABLED')
  };
}

function validateSource(localCode, expectedUserId, enabled) {
  const enabledPattern = new RegExp(`SCHOOL_SCOPED_MARKET_ENABLED\\s*=\\s*${enabled ? 'true' : 'false'}`);
  assert(enabledPattern.test(localCode), `master switch must be ${enabled}`);
  assert(/SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*false/.test(localCode), 'strict-for-all must remain false');
  const authRequiredPattern = new RegExp(`MARKET_ACCESS_REQUIRES_AUTH\\s*=\\s*${enabled ? 'true' : 'false'}`);
  assert(authRequiredPattern.test(localCode), `market auth requirement must be ${enabled}`);
  const block = localCode.slice(
    localCode.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST'),
    localCode.indexOf('CURSOR_SECRET_ENV_NAME')
  );
  const ids = block.match(/u_[0-9a-f]{32}/g) || [];
  const hashes = block.match(/sha256:[0-9a-f]{64}/g) || [];
  if (enabled) {
    const expectedHash = `sha256:${sha256(expectedUserId)}`;
    assert(
      (ids.length === 1 && hashes.length === 0 && ids[0] === expectedUserId)
        || (ids.length === 0 && hashes.length === 1 && hashes[0] === expectedHash),
      'allowlist must contain exactly the controlled identity'
    );
  } else {
    assert(ids.length === 0 && hashes.length === 0, 'rollback source allowlist must be empty');
  }
}

function parseArguments(argv) {
  const options = { confirmTarget: '', deploy: false, rollback: false, privateInput: PRIVATE_BOOTSTRAP_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else if (value === '--rollback') options.rollback = true;
    else if (value === '--private-input') options.privateInput = path.resolve(String(argv[++index] || ''));
    else throw new Error(`unsupported argument: ${value}`);
  }
  return options;
}

function deploy(options = {}) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --confirm-target ${targetMasked}`);
  const privateData = loadBootstrapPrivate(options.privateInput);
  const functionPath = path.join(ROOT, 'cloudfunctions', FUNCTION.name);
  const localCode = fs.readFileSync(path.join(functionPath, 'index.js'), 'utf8');
  validateSource(localCode, privateData.userId, !options.rollback);
  const beforeDetail = readFunctionDetail(environmentId, FUNCTION.name);
  const beforeEnvironment = environmentMap(beforeDetail);
  assert((beforeEnvironment.PRODUCT_QUERY_CURSOR_HMAC_SECRET || '').length >= 32, 'cursor HMAC environment is missing or too short');
  assert(Object.prototype.hasOwnProperty.call(beforeEnvironment, 'PRODUCT_SEED_ENABLED'), 'PRODUCT_SEED_ENABLED is missing');
  const before = summarize(beforeDetail, localCode);
  if (!options.deploy) {
    return {
      mode: 'dry-run', target: `cloud:${targetMasked}`, functionName: FUNCTION.name,
      rollout: options.rollback ? 'rollback' : 'single-user-canary', controlledUser: maskId(privateData.userId),
      wouldDeployOnly: [FUNCTION.name], before
    };
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-18-canary-deploy-'));
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [{ ...FUNCTION }]
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase(['--config-file', configPath, 'fn', 'deploy', FUNCTION.name, '--force'], {
      timeoutMs: 300000,
      json: false
    });
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    fs.rmdirSync(temporaryDirectory);
  }

  const afterDetail = readFunctionDetail(environmentId, FUNCTION.name);
  const afterEnvironment = environmentMap(afterDetail);
  const after = summarize(afterDetail, localCode);
  assert(afterDetail.Status === 'Active', 'deployed function is not Active');
  assert(afterDetail.Runtime === FUNCTION.runtime, 'runtime changed');
  assert(afterDetail.Handler === FUNCTION.handler, 'handler changed');
  assert(Number(afterDetail.Timeout) === FUNCTION.timeout, 'timeout changed');
  assert(Number(afterDetail.MemorySize) === FUNCTION.memorySize, 'memory changed');
  assert(after.hashMatches, 'remote index.js hash does not match local');
  assert(
    afterEnvironment.PRODUCT_QUERY_CURSOR_HMAC_SECRET === beforeEnvironment.PRODUCT_QUERY_CURSOR_HMAC_SECRET,
    'cursor HMAC environment was not preserved'
  );
  assert(afterEnvironment.PRODUCT_SEED_ENABLED === beforeEnvironment.PRODUCT_SEED_ENABLED, 'PRODUCT_SEED_ENABLED was not preserved');
  return {
    mode: 'deployed', target: `cloud:${targetMasked}`, functionName: FUNCTION.name,
    rollout: options.rollback ? 'rollback' : 'single-user-canary', controlledUser: maskId(privateData.userId),
    deployedOnly: [FUNCTION.name], before, after,
    environmentPreserved: { cursorHmac: true, productSeedEnabled: true }
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(deploy(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE18_CANARY_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FUNCTION, environmentMap, summarize, validateSource, parseArguments, deploy };
