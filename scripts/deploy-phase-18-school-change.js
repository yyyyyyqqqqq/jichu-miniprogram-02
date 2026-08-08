const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT } = require('./schools/core');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runCloudBase
} = require('./schools/cloud-cli');

const FUNCTION = Object.freeze({
  name: 'authUser',
  runtime: 'Nodejs16.13',
  timeout: 10,
  memorySize: 256,
  handler: 'index.main'
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeDetail(detail) {
  return detail && (detail.data || detail.Response || detail) || {};
}

function readDetail(environmentId) {
  return normalizeDetail(runCloudBase([
    'fn', 'detail', FUNCTION.name,
    '--envId', environmentId,
    '--json'
  ], {
    timeoutMs: 180000
  }));
}

function summarize(detail, localCode) {
  const remoteCode = detail.CodeInfo || detail.codeInfo || '';
  const localSha256 = sha256(localCode);
  const remoteSha256 = remoteCode ? sha256(remoteCode) : '';
  return {
    status: detail.Status || detail.status || '',
    runtime: detail.Runtime || detail.runtime || '',
    handler: detail.Handler || detail.handler || '',
    timeout: Number(detail.Timeout || detail.timeout || 0),
    memorySize: Number(detail.MemorySize || detail.memorySize || 0),
    localSha256,
    remoteSha256,
    hashMatches: Boolean(remoteCode) && localSha256 === remoteSha256
  };
}

function deployPhase18SchoolChange() {
  const environmentId = loadEnvironmentId();
  const functionPath = path.join(ROOT, 'cloudfunctions', FUNCTION.name);
  const localCode = fs.readFileSync(path.join(functionPath, 'index.js'), 'utf8');
  const before = summarize(readDetail(environmentId), localCode);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'phase-18-school-change-deploy-')
  );
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [{
        name: FUNCTION.name,
        timeout: FUNCTION.timeout,
        memorySize: FUNCTION.memorySize,
        runtime: FUNCTION.runtime,
        handler: FUNCTION.handler
      }]
    }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    runCloudBase([
      '--config-file', configPath,
      'fn', 'deploy', FUNCTION.name,
      '--force'
    ], {
      timeoutMs: 300000,
      json: false
    });
  } finally {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    fs.rmdirSync(temporaryDirectory);
  }

  const after = summarize(readDetail(environmentId), localCode);
  const output = {
    target: `cloud:${maskEnvironmentId(environmentId)}`,
    functionName: FUNCTION.name,
    before,
    after
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (
    after.status !== 'Active'
    || after.runtime !== FUNCTION.runtime
    || after.handler !== FUNCTION.handler
    || after.timeout !== FUNCTION.timeout
    || after.memorySize !== FUNCTION.memorySize
    || !after.hashMatches
  ) {
    const error = new Error('authUser deployment verification failed');
    error.code = 'SCHOOL_CHANGE_DEPLOYMENT_MISMATCH';
    throw error;
  }
  return output;
}

if (require.main === module) {
  try {
    deployPhase18SchoolChange();
  } catch (error) {
    process.stderr.write(
      `${error.code || 'SCHOOL_CHANGE_DEPLOYMENT_FAILED'}: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  deployPhase18SchoolChange
};
