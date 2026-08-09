const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  runNoSql,
  assert
} = require('./phase-18-canary-core');
const {
  extractCommandResults,
  decodeExtendedJson
} = require('./schools/cloud-cli');

const PRODUCT_QUERY = Object.freeze({
  name: 'productQuery',
  runtime: 'Nodejs16.13',
  handler: 'index.main',
  timeout: 10,
  memorySize: 256
});
const FINAL_CONFIG = Object.freeze({
  enabled: true,
  strictForAll: true,
  accessRequiresAuth: true,
  allowlistCount: 0
});
const LEGACY_CONFIG = Object.freeze({
  enabled: false,
  strictForAll: false,
  accessRequiresAuth: false,
  allowlistCount: 0
});
const PRIVATE_SNAPSHOT_PATH = path.join(ROOT, 'tmp', 'phase-18-final-cutover-private.json');

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

function sourceConfig(source) {
  const allowlistStart = source.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST');
  const allowlistEnd = source.indexOf('CURSOR_SECRET_ENV_NAME');
  assert(allowlistStart >= 0 && allowlistEnd > allowlistStart, 'market rollout source block is missing');
  const block = source.slice(allowlistStart, allowlistEnd);
  const identities = block.match(/(?:u_[0-9a-f]{32}|sha256:[0-9a-f]{64})/g) || [];
  return {
    enabled: /SCHOOL_SCOPED_MARKET_ENABLED\s*=\s*true/.test(source),
    strictForAll: /SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*true/.test(source),
    accessRequiresAuth: /MARKET_ACCESS_REQUIRES_AUTH\s*=\s*true/.test(source),
    allowlistCount: identities.length,
    allowlistKinds: identities.map((value) => value.startsWith('sha256:') ? 'sha256' : 'internal-user-id')
  };
}

function assertConfig(actual, expected, label) {
  for (const key of ['enabled', 'strictForAll', 'accessRequiresAuth', 'allowlistCount']) {
    assert(actual[key] === expected[key], `${label} ${key} must be ${expected[key]}`);
  }
  return true;
}

function functionSummary(detail, localSource) {
  const remoteSource = String(detail.CodeInfo || '');
  const environment = environmentMap(detail);
  return {
    status: detail.Status || '',
    runtime: detail.Runtime || '',
    handler: detail.Handler || '',
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    localSha256: sha256(localSource),
    remoteSha256: remoteSource ? sha256(remoteSource) : '',
    hashMatches: Boolean(remoteSource) && sha256(localSource) === sha256(remoteSource),
    cursorHmacPresent: Boolean(environment.PRODUCT_QUERY_CURSOR_HMAC_SECRET),
    cursorHmacLengthQualified: (environment.PRODUCT_QUERY_CURSOR_HMAC_SECRET || '').length >= 32,
    productSeedEnabledPresent: Object.prototype.hasOwnProperty.call(environment, 'PRODUCT_SEED_ENABLED'),
    productSeedEnabled: environment.PRODUCT_SEED_ENABLED
  };
}

function readProductIndexes(environmentId) {
  const response = runNoSql(environmentId, [{
    TableName: 'products',
    CommandType: 'COMMAND',
    Command: JSON.stringify({ listIndexes: 'products', cursor: {} })
  }]);
  const results = extractCommandResults(response);
  const candidate = results.length === 1 && Array.isArray(results[0]) ? results[0] : results;
  return candidate.map(decodeExtendedJson).filter((item) => item && item.name && item.key).map((item) => ({
    name: item.name,
    key: item.key,
    unique: item.name === '_id_' || item.unique === true
  }));
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
  assert(fs.existsSync(authPath), 'CloudBase CLI credential cache is unavailable');
  const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const credential = parsed && parsed.credential || {};
  assert(credential.tmpSecretId && credential.tmpSecretKey && credential.tmpToken, 'CloudBase CLI temporary credential is unavailable');
  assert(Number(credential.tmpExpired || 0) > Date.now(), 'CloudBase CLI temporary credential has expired');
  return {
    secretId: credential.tmpSecretId,
    secretKey: credential.tmpSecretKey,
    token: credential.tmpToken
  };
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function callTcb(action, params, options = {}) {
  const host = 'tcb.tencentcloudapi.com';
  const service = 'tcb';
  const version = '2018-06-08';
  const region = options.region || 'ap-shanghai';
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
    request.setTimeout(30000, () => request.destroy(new Error('Tencent Cloud API request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function readProductsAcl(environmentId) {
  const result = await callTcb('DescribeSafeRule', {
    EnvId: environmentId,
    CollectionName: 'products'
  });
  return result.AclTag || '';
}

module.exports = {
  ROOT,
  PRODUCT_QUERY,
  FINAL_CONFIG,
  LEGACY_CONFIG,
  PRIVATE_SNAPSHOT_PATH,
  sha256,
  environmentMap,
  sourceConfig,
  assertConfig,
  functionSummary,
  callTcb,
  readProductIndexes,
  readProductsAcl,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  assert
};
