const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT
} = require('./schools/core');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runCloudBase
} = require('./schools/cloud-cli');

const FUNCTIONS = [
  {
    name: 'createProduct',
    runtime: 'Nodejs16.13'
  },
  {
    name: 'productQuery',
    runtime: 'Nodejs16.13'
  }
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeRemoteDetail(detail) {
  return detail.data || detail.Response || detail;
}

function deployProductSchoolBinding() {
  const environmentId = loadEnvironmentId();
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'product-school-binding-deploy-')
  );
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  const config = {
    envId: environmentId,
    functionRoot: 'cloudfunctions',
    functions: FUNCTIONS.map((item) => ({
      name: item.name,
      timeout: 10,
      memorySize: 256,
      runtime: item.runtime,
      handler: 'index.main'
    }))
  };

  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    FUNCTIONS.forEach((item) => {
      runCloudBase([
        '--config-file', configPath,
        'fn', 'deploy', item.name,
        '--force'
      ], {
        timeoutMs: 300000,
        json: false
      });
    });
  } finally {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    fs.rmdirSync(temporaryDirectory);
  }

  const results = FUNCTIONS.map((item) => {
    const detail = runCloudBase([
      'fn', 'detail', item.name,
      '--envId', environmentId,
      '--json'
    ], {
      timeoutMs: 180000
    });
    const remote = normalizeRemoteDetail(detail);
    const localCode = fs.readFileSync(
      path.join(ROOT, 'cloudfunctions', item.name, 'index.js'),
      'utf8'
    );
    const remoteCode = remote.CodeInfo || remote.codeInfo || '';
    const localSha256 = sha256(localCode);
    const remoteSha256 = remoteCode ? sha256(remoteCode) : '';
    return {
      functionName: item.name,
      status: remote.Status || remote.status || '',
      runtime: remote.Runtime || remote.runtime || '',
      handler: remote.Handler || remote.handler || '',
      timeout: Number(remote.Timeout || remote.timeout || 0),
      memorySize: Number(remote.MemorySize || remote.memorySize || 0),
      localSha256,
      remoteSha256,
      hashMatches: Boolean(remoteCode) && localSha256 === remoteSha256
    };
  });
  const output = {
    target: `cloud:${maskEnvironmentId(environmentId)}`,
    functions: results
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  const invalid = results.find((item) => (
    item.status !== 'Active'
    || item.runtime !== FUNCTIONS.find(
      (expected) => expected.name === item.functionName
    ).runtime
    || item.handler !== 'index.main'
    || item.timeout !== 10
    || item.memorySize !== 256
    || !item.hashMatches
  ));
  if (invalid) {
    const error = new Error(
      `${invalid.functionName} deployment verification failed`
    );
    error.code = 'PRODUCT_SCHOOL_DEPLOYMENT_MISMATCH';
    throw error;
  }
  return output;
}

if (require.main === module) {
  try {
    deployProductSchoolBinding();
  } catch (error) {
    process.stderr.write(
      `${error.code || 'PRODUCT_SCHOOL_DEPLOYMENT_FAILED'}: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  deployProductSchoolBinding
};
