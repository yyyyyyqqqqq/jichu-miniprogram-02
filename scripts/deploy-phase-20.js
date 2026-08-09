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
  name: 'authUser',
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
    if (value === '--confirm-target') {
      options.confirmTarget = String(argv[++index] || '').trim();
    } else if (value === '--deploy') {
      options.deploy = true;
    } else {
      throw new Error(`unsupported argument: ${value}`);
    }
  }
  return options;
}

function validateSource(source) {
  assert(/SCHOOL_CHANGE_COOLDOWN_MS\s*=\s*7 \* 24 \* 60 \* 60 \* 1000/.test(source), 'seven-day cooldown is missing');
  assert(/schoolChangedAt:\s*now/.test(source), 'server change timestamp is missing');
  assert(/assertSchoolChangeAllowed/.test(source), 'server cooldown guard is missing');
  assert(/runTransaction/.test(source), 'transactional school change is missing');
  assert(!/collection\(['"]products['"]\)/.test(source), 'authUser must not migrate products');
}

function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(
    options.confirmTarget === targetMasked,
    `confirm target with --confirm-target ${targetMasked}`
  );
  const sourcePath = path.join(ROOT, 'cloudfunctions', FUNCTION.name, 'index.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  validateSource(source);
  const before = summarize(
    readFunctionDetail(environmentId, FUNCTION.name),
    source
  );
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

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'phase-20-deploy-')
  );
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

  const after = summarize(
    readFunctionDetail(environmentId, FUNCTION.name),
    source
  );
  assert(after.status === 'Active', 'authUser is not Active');
  assert(after.runtime === FUNCTION.runtime, 'authUser runtime changed');
  assert(after.handler === FUNCTION.handler, 'authUser handler changed');
  assert(after.timeout === FUNCTION.timeout, 'authUser timeout changed');
  assert(after.memorySize === FUNCTION.memorySize, 'authUser memory changed');
  assert(after.hashMatches, 'authUser remote code hash differs from local');
  assert(
    before.environmentFingerprint === after.environmentFingerprint,
    'authUser environment variables changed'
  );
  return {
    mode: 'deployed',
    target: `cloud:${targetMasked}`,
    deployedOnly: [FUNCTION.name],
    writesDatabase: false,
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
    process.stderr.write(`${error.code || 'PHASE20_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FUNCTION, parseArguments, validateSource, run };
