const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT
} = require('./core');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runCloudBase
} = require('./cloud-cli');

const FUNCTION_NAME = 'schoolQuery';
const FUNCTION_DIR = path.join(ROOT, 'cloudfunctions', FUNCTION_NAME);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deploy() {
  const environmentId = loadEnvironmentId();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'school-query-deploy-'));
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  const config = {
    envId: environmentId,
    functionRoot: 'cloudfunctions',
    functions: [{
      name: FUNCTION_NAME,
      timeout: 10,
      memorySize: 256,
      runtime: 'Nodejs18.15',
      handler: 'index.main'
    }]
  };
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    runCloudBase([
      '--config-file', configPath,
      'fn', 'deploy', FUNCTION_NAME,
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
  const detail = runCloudBase([
    'fn', 'detail', FUNCTION_NAME,
    '--envId', environmentId,
    '--json'
  ], {
    timeoutMs: 180000
  });
  const remote = detail.data || detail.Response || detail;
  const localCode = fs.readFileSync(path.join(FUNCTION_DIR, 'index.js'), 'utf8');
  const remoteCode = remote.CodeInfo || remote.codeInfo || '';
  const result = {
    target: `cloud:${maskEnvironmentId(environmentId)}`,
    functionName: FUNCTION_NAME,
    status: remote.Status || remote.status || '',
    runtime: remote.Runtime || remote.runtime || '',
    localSha256: sha256(localCode),
    remoteSha256: remoteCode ? sha256(remoteCode) : '',
    hashMatches: Boolean(remoteCode) && sha256(localCode) === sha256(remoteCode)
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'Active' || !result.hashMatches) {
    const error = new Error('schoolQuery deployment verification failed');
    error.code = 'QUERY_DEPLOYMENT_MISMATCH';
    throw error;
  }
}

if (require.main === module) {
  try {
    deploy();
  } catch (error) {
    process.stderr.write(`${error.code || 'QUERY_DEPLOYMENT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  deploy
};
