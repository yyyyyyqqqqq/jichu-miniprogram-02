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
  const normalized = (Array.isArray(variables) ? variables : []).map((item) => ({
    key: item.Key || item.key,
    value: item.Value || item.value
  })).sort((left, right) => String(left.key).localeCompare(String(right.key)));
  return sha256(JSON.stringify(normalized));
}

function summarize(detail, localSource) {
  const remoteSource = String(detail && detail.CodeInfo || '');
  return {
    status: detail && detail.Status || '',
    runtime: detail && detail.Runtime || '',
    handler: detail && detail.Handler || '',
    timeout: Number(detail && detail.Timeout || 0),
    memorySize: Number(detail && detail.MemorySize || 0),
    localSha256: sha256(localSource),
    remoteSha256: remoteSource ? sha256(remoteSource) : '',
    hashMatches: Boolean(remoteSource) && sha256(localSource) === sha256(remoteSource),
    environmentFingerprint: environmentFingerprint(detail)
  };
}

function parseArguments(argv) {
  const options = { confirmTarget: '', deploy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') {
      options.confirmTarget = String(argv[++index] || '').trim();
    } else if (value === '--deploy') {
      options.deploy = true;
    } else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

function validateSource(source) {
  assert(/PRODUCT_SCHOOL_UNAVAILABLE/.test(source), 'unassigned relist error is missing');
  assert(/assertProductSchoolReadyForRelist/.test(source), 'relist school guard is missing');
  assert(/transaction\.collection\('schools'\)/.test(source), 'relist does not read the authoritative school');
  assert(/platformStatus !== 'active'/.test(source), 'relist does not require an active school');
  assert(/officialStatus !== 'valid'/.test(source), 'relist does not require an officially valid school');
  const guard = source.slice(
    source.indexOf('async function assertProductSchoolReadyForRelist'),
    source.indexOf('function toEditableProduct')
  );
  assert(!/collection\(['"]users['"]\)/.test(guard), 'relist must not infer product school from owner current school');
  assert(!/schoolId\s*:/.test(source.slice(source.indexOf('function buildTransitionData'), source.indexOf('async function performTransition'))), 'status transition mutates product school');
}

function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(
    options.confirmTarget === targetMasked,
    `confirm target with --confirm-target ${targetMasked}`,
    'TARGET_ENV_CONFIRMATION_REQUIRED'
  );
  const sourcePath = path.join(ROOT, 'cloudfunctions', FUNCTION.name, 'index.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  validateSource(source);
  const before = summarize(readFunctionDetail(environmentId, FUNCTION.name), source);
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      wouldDeployOnly: [FUNCTION.name],
      writesBusinessData: false,
      changesAcl: false,
      changesIndexes: false,
      before
    };
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-22-deploy-'));
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
    ], {
      timeoutMs: 300000,
      json: false
    });
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    fs.rmdirSync(temporaryDirectory);
  }

  const after = summarize(readFunctionDetail(environmentId, FUNCTION.name), source);
  assert(after.status === 'Active', `${FUNCTION.name} is not Active`);
  assert(after.runtime === FUNCTION.runtime, `${FUNCTION.name} runtime changed`);
  assert(after.handler === FUNCTION.handler, `${FUNCTION.name} handler changed`);
  assert(after.timeout === FUNCTION.timeout, `${FUNCTION.name} timeout changed`);
  assert(after.memorySize === FUNCTION.memorySize, `${FUNCTION.name} memory changed`);
  assert(after.hashMatches, `${FUNCTION.name} remote code hash differs from local`);
  assert(
    before.environmentFingerprint === after.environmentFingerprint,
    `${FUNCTION.name} environment variables changed`
  );
  return {
    mode: 'deployed',
    target: `cloud:${targetMasked}`,
    deployedOnly: [FUNCTION.name],
    writesBusinessData: false,
    changesAcl: false,
    changesIndexes: false,
    environmentVariablesChanged: false,
    before,
    after
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE22_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FUNCTION, parseArguments, validateSource, run };
