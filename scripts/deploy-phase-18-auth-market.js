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

const FUNCTION = Object.freeze({
  name: 'manageProduct',
  runtime: 'Nodejs16.13',
  handler: 'index.main',
  timeout: 10,
  memorySize: 256
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function environmentFingerprint(detail) {
  const variables = detail && detail.Environment && detail.Environment.Variables;
  return sha256(JSON.stringify((Array.isArray(variables) ? variables : []).map((item) => ({
    key: item.Key || item.key,
    value: item.Value || item.value
  })).sort((left, right) => String(left.key).localeCompare(String(right.key)))));
}

function summarize(detail, localCode) {
  const remoteCode = String(detail.CodeInfo || '');
  return {
    status: detail.Status || '',
    runtime: detail.Runtime || '',
    handler: detail.Handler || '',
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    localSha256: sha256(localCode),
    remoteSha256: remoteCode ? sha256(remoteCode) : '',
    hashMatches: Boolean(remoteCode) && sha256(localCode) === sha256(remoteCode),
    environmentFingerprint: environmentFingerprint(detail)
  };
}

function parseArguments(argv) {
  const options = { confirmTarget: '', deploy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else throw new Error(`unsupported argument: ${value}`);
  }
  return options;
}

function validateSource(source) {
  assert(/PRODUCT_SCHOOL_MISMATCH/.test(source), 'cross-school relist error is missing');
  assert(/action === ACTIONS\.RELIST/.test(source), 'relist school guard is missing');
  assert(/transaction\.collection\('users'\)\.doc\(sellerId\)/.test(source), 'relist does not read the authoritative user');
  assert(/currentSchoolId !== productSchoolId/.test(source), 'relist school comparison is missing');
}

function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --confirm-target ${targetMasked}`);
  const functionPath = path.join(ROOT, 'cloudfunctions', FUNCTION.name);
  const localCode = fs.readFileSync(path.join(functionPath, 'index.js'), 'utf8');
  validateSource(localCode);
  const beforeDetail = readFunctionDetail(environmentId, FUNCTION.name);
  const before = summarize(beforeDetail, localCode);
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      wouldDeployOnly: [FUNCTION.name],
      writesDatabase: false,
      changesAcl: false,
      changesIndexes: false,
      before
    };
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-18-auth-market-deploy-'));
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
  const after = summarize(afterDetail, localCode);
  assert(after.status === 'Active', 'manageProduct is not Active');
  assert(after.runtime === FUNCTION.runtime, 'manageProduct runtime changed');
  assert(after.handler === FUNCTION.handler, 'manageProduct handler changed');
  assert(after.timeout === FUNCTION.timeout && after.memorySize === FUNCTION.memorySize, 'manageProduct resources changed');
  assert(after.hashMatches, 'manageProduct remote code hash differs from local');
  assert(before.environmentFingerprint === after.environmentFingerprint, 'manageProduct environment variables changed');
  return {
    mode: 'deployed',
    target: `cloud:${targetMasked}`,
    deployedOnly: [FUNCTION.name],
    before,
    after,
    writesDatabase: false,
    changesAcl: false,
    changesIndexes: false,
    environmentVariablesChanged: false
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE18_AUTH_MARKET_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FUNCTION, parseArguments, validateSource, run };
