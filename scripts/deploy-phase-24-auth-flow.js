const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  assert
} = require('./phase-18-canary-core');

const DEVTOOLS_ROOT = path.dirname(
  process.env.PHASE24_DEVTOOLS_CLI_PATH || 'D:\\program\\微信web开发者工具\\cli.bat'
);
const DEVTOOLS_NODE = path.join(DEVTOOLS_ROOT, 'node.exe');
const DEVTOOLS_CLI = path.join(DEVTOOLS_ROOT, 'cli.js');

const FUNCTIONS = Object.freeze([
  { name: 'authUser', runtime: 'Nodejs16.13', handler: 'index.main', timeout: 10, memorySize: 256 },
  { name: 'createProduct', runtime: 'Nodejs16.13', handler: 'index.main', timeout: 10, memorySize: 256 },
  { name: 'productQuery', runtime: 'Nodejs16.13', handler: 'index.main', timeout: 10, memorySize: 256 },
  { name: 'userQuery', runtime: 'Nodejs18.15', handler: 'index.main', timeout: 10, memorySize: 256 }
]);
const EXPECTED_ENVIRONMENT_FINGERPRINTS = Object.freeze({
  authUser: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  createProduct: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  productQuery: '506c789e01ed6bfb356ec4d82ec2e588f748a8c20f001f0fbc5915ecfa0d20a2',
  userQuery: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function readCloudBaseCredential() {
  if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
    return {
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY,
      token: process.env.TENCENTCLOUD_SESSIONTOKEN || ''
    };
  }
  const authPath = path.join(os.homedir(), '.config', '.cloudbase', 'auth.json');
  assert(fs.existsSync(authPath), 'CloudBase credential cache is unavailable');
  const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const credential = parsed && parsed.credential || {};
  assert(credential.tmpSecretId && credential.tmpSecretKey && credential.tmpToken, 'CloudBase temporary credential is unavailable');
  assert(Number(credential.tmpExpired || 0) > Date.now(), 'CloudBase temporary credential has expired');
  return {
    secretId: credential.tmpSecretId,
    secretKey: credential.tmpSecretKey,
    token: credential.tmpToken
  };
}

function callScf(action, params) {
  const host = 'scf.tencentcloudapi.com';
  const service = 'scf';
  const version = '2018-04-16';
  const region = 'ap-shanghai';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify(params);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const credential = readCloudBaseCredential();
  const secretDate = hmac(`TC3${credential.secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${credential.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return new Promise((resolve, reject) => {
    const request = https.request({
      host,
      method: 'POST',
      path: '/',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': version,
        'X-TC-Region': region,
        ...(credential.token ? { 'X-TC-Token': credential.token } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const root = value && value.Response || value;
          if (root && root.Error) {
            const error = new Error(`${root.Error.Code}: ${root.Error.Message}`);
            error.code = root.Error.Code;
            reject(error);
            return;
          }
          resolve(root || {});
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('SCF API request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

function readFunctionDetail(environmentId, functionName) {
  return callScf('GetFunction', {
    FunctionName: functionName,
    Namespace: environmentId,
    ShowCode: 'TRUE'
  });
}

function runDevTools(args, timeoutMs = 300000) {
  assert(fs.existsSync(DEVTOOLS_NODE) && fs.existsSync(DEVTOOLS_CLI), 'WeChat DevTools CLI is unavailable');
  const result = spawnSync(DEVTOOLS_NODE, [DEVTOOLS_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  assert(result.status === 0, output.trim() || 'WeChat DevTools CLI failed');
  return output;
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
    sourceHashMatches: Boolean(remoteSource) && sha256(localSource) === sha256(remoteSource),
    environmentFingerprint: environmentFingerprint(detail)
  };
}

function parseArguments(argv) {
  const options = { confirmTarget: '', deploy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env' || value === '--confirm-target') {
      options.confirmTarget = String(argv[++index] || '').trim();
    } else if (value === '--deploy') {
      options.deploy = true;
    } else {
      throw Object.assign(new Error(`unsupported argument: ${value}`), {
        code: 'INVALID_ARGUMENT'
      });
    }
  }
  return options;
}

function localDependencySummary(name) {
  const directory = path.join(ROOT, 'cloudfunctions', name);
  const packageSource = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
  const lockSource = fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8');
  const packageJson = JSON.parse(packageSource);
  const lock = JSON.parse(lockSource);
  const hasDirectWs = Boolean(packageJson.dependencies.ws);
  if (name === 'authUser') {
    assert(!hasDirectWs, 'authUser must retain its baseline without a direct ws dependency');
  } else {
    assert(packageJson.dependencies.ws === '8.21.3', `${name} ws must remain pinned to 8.21.3`);
    assert(lock.packages['node_modules/ws'].version === '8.21.3', `${name} lockfile ws mismatch`);
  }
  assert(
    ['4.0.2', '^4.0.2'].includes(packageJson.dependencies['wx-server-sdk']),
    `${name} wx-server-sdk range changed`
  );
  assert(lock.packages['node_modules/wx-server-sdk'].version === '4.0.2', `${name} lockfile SDK mismatch`);
  return {
    packageSha256: sha256(packageSource),
    lockSha256: sha256(lockSource),
    hasDirectWs,
    ws: hasDirectWs ? lock.packages['node_modules/ws'].version : 'not-direct-dependency',
    wxServerSdk: lock.packages['node_modules/wx-server-sdk'].version
  };
}

function assertSafeTemporaryDirectory(directory, prefix) {
  const resolved = path.resolve(directory);
  const expectedRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert(resolved.startsWith(expectedRoot), 'temporary directory escaped the OS temp root');
  assert(path.basename(resolved).startsWith(prefix), 'temporary directory prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary target is not a plain directory');
}

function removeSafeTemporaryDirectory(directory, prefix) {
  if (!fs.existsSync(directory)) return;
  assertSafeTemporaryDirectory(directory, prefix);
  fs.rmSync(directory, { recursive: true, force: false });
}

function deployFunctions(environmentId) {
  const names = FUNCTIONS.map((item) => item.name);
  const output = runDevTools([
    'cloud', 'functions', 'deploy',
    '--env', environmentId,
    '--names', ...names,
    '--remote-npm-install',
    '--project', ROOT
  ], 600000);
  assert(/deploy cloudfunctions/.test(output), 'DevTools did not report a cloud function deployment');
  assert(!/fail to deploy cloudfunction|success\s*│\s*false/i.test(output), 'at least one cloud function deployment failed');
  for (const name of names) assert(output.includes(name), `${name} is missing from the deployment report`);
}

function verifyRemotePackage(environmentId, name, expected) {
  const prefix = `phase-24-auth-flow-remote-${name}-`;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    const output = runDevTools([
      'cloud', 'functions', 'download',
      '--env', environmentId,
      '--name', name,
      '--path', temporaryDirectory,
      '--project', ROOT
    ], 240000);
    assert(/download cloudfunction/.test(output), `${name} download was not confirmed`);
    const packageSource = fs.readFileSync(path.join(temporaryDirectory, 'package.json'), 'utf8');
    const lockSource = fs.readFileSync(path.join(temporaryDirectory, 'package-lock.json'), 'utf8');
    const installedWs = expected.hasDirectWs
      ? JSON.parse(fs.readFileSync(
        path.join(temporaryDirectory, 'node_modules', 'ws', 'package.json'),
        'utf8'
      )).version
      : 'not-direct-dependency';
    const installedSdk = JSON.parse(fs.readFileSync(
      path.join(temporaryDirectory, 'node_modules', 'wx-server-sdk', 'package.json'),
      'utf8'
    )).version;
    const remoteRequire = createRequire(path.join(temporaryDirectory, 'package.json'));
    remoteRequire('wx-server-sdk');
    if (expected.hasDirectWs) remoteRequire('ws');
    assert(sha256(packageSource) === expected.packageSha256, `${name} remote package.json differs`);
    assert(sha256(lockSource) === expected.lockSha256, `${name} remote package-lock.json differs`);
    for (const [relativePath, expectedSha256] of Object.entries(
      expected.extraFileSha256 || {}
    )) {
      const remotePath = path.join(temporaryDirectory, relativePath);
      assert(fs.existsSync(remotePath), `${name} remote ${relativePath} is missing`);
      assert(
        sha256(fs.readFileSync(remotePath)) === expectedSha256,
        `${name} remote ${relativePath} differs`
      );
    }
    if (expected.hasDirectWs) assert(installedWs === '8.21.3', `${name} remote ws is ${installedWs}`);
    if (!expected.hasDirectWs) {
      assert(!fs.existsSync(path.join(temporaryDirectory, 'node_modules', 'ws', 'package.json')), `${name} gained an unexpected direct ws installation`);
    }
    assert(installedSdk === '4.0.2', `${name} remote wx-server-sdk is ${installedSdk}`);
    return {
      packageMatches: true,
      lockMatches: true,
      installedWs,
      installedSdk,
      dependenciesLoadable: true,
      extraFilesMatch: true
    };
  } finally {
    removeSafeTemporaryDirectory(temporaryDirectory, prefix);
  }
}

function verifyRemotePackageWithRetry(environmentId, name, expected) {
  let finalError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return verifyRemotePackage(environmentId, name, expected);
    } catch (error) {
      finalError = error;
    }
  }
  throw finalError;
}

function assertAuthorizedSource(name, source) {
  if (name === 'authUser') {
    assert(/['"]loginIdentity['"]/.test(source), 'authUser loginIdentity is missing');
    assert(!/function updateSchool[\s\S]{0,900}profileCompleted/.test(source), 'authUser updateSchool still gates profile');
  } else {
    assert(!/profileCompleted/.test(source), `${name} still gates profile completion`);
  }
}

async function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --env ${targetMasked}`);
  const local = {};
  const before = {};
  for (const item of FUNCTIONS) {
    const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', item.name, 'index.js'), 'utf8');
    assertAuthorizedSource(item.name, source);
    local[item.name] = localDependencySummary(item.name);
    before[item.name] = summarize(await readFunctionDetail(environmentId, item.name), source);
    assert(before[item.name].status === 'Active', `${item.name} is not Active before deployment`);
    assert(before[item.name].availableStatus === 'Available', `${item.name} is not Available before deployment`);
    assert(before[item.name].runtime === item.runtime, `${item.name} runtime baseline differs`);
    assert(before[item.name].handler === item.handler, `${item.name} handler baseline differs`);
    assert(before[item.name].timeout === item.timeout, `${item.name} timeout baseline differs`);
    assert(before[item.name].memorySize === item.memorySize, `${item.name} memory baseline differs`);
    assert(
      before[item.name].environmentFingerprint === EXPECTED_ENVIRONMENT_FINGERPRINTS[item.name],
      `${item.name} environment baseline differs`
    );
  }

  if (!options.deploy) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      wouldDeployOnly: FUNCTIONS.map((item) => item.name),
      writesBusinessData: false,
      changesAclOrIndexes: false,
      changesSchoolData: false,
      runtimeChange: false,
      local,
      before
    };
  }

  const alreadyDeployed = FUNCTIONS.every((item) => before[item.name].sourceHashMatches);
  if (!alreadyDeployed) deployFunctions(environmentId);
  const after = {};
  const remotePackages = {};
  for (const item of FUNCTIONS) {
    const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', item.name, 'index.js'), 'utf8');
    const summary = summarize(await readFunctionDetail(environmentId, item.name), source);
    assert(summary.status === 'Active' && summary.availableStatus === 'Available', `${item.name} is unavailable`);
    assert(summary.runtime === item.runtime, `${item.name} runtime changed`);
    assert(summary.handler === item.handler, `${item.name} handler changed`);
    assert(summary.timeout === item.timeout && summary.memorySize === item.memorySize, `${item.name} resources changed`);
    assert(summary.sourceHashMatches, `${item.name} remote source differs from local`);
    assert(before[item.name].environmentFingerprint === summary.environmentFingerprint, `${item.name} environment changed`);
    after[item.name] = summary;
    remotePackages[item.name] = verifyRemotePackageWithRetry(environmentId, item.name, local[item.name]);
  }
  return {
    mode: alreadyDeployed ? 'verified-existing-deployment' : 'deployed',
    target: `cloud:${targetMasked}`,
    deployedOnly: alreadyDeployed ? [] : FUNCTIONS.map((item) => item.name),
    verifiedOnly: alreadyDeployed ? FUNCTIONS.map((item) => item.name) : [],
    writesBusinessData: false,
    changesAclOrIndexes: false,
    changesSchoolData: false,
    runtimeChanged: false,
    environmentChanged: false,
    before,
    after,
    remotePackages
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'PHASE24_AUTH_FLOW_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FUNCTIONS,
  parseArguments,
  localDependencySummary,
  verifyRemotePackage,
  run
};
