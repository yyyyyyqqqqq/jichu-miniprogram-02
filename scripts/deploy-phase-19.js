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

const FUNCTIONS = Object.freeze([
  { name: 'productQuery', runtime: 'Nodejs16.13' },
  { name: 'favoriteProduct', runtime: 'Nodejs18.15' },
  { name: 'messageAction', runtime: 'Nodejs18.15' },
  { name: 'appointmentAction', runtime: 'Nodejs18.15' },
  { name: 'manageProduct', runtime: 'Nodejs16.13' }
]);

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

function validateSources(sources) {
  assert(/resolveDetailAccess/.test(sources.productQuery), 'productQuery detail access policy is missing');
  assert(/crossSchoolReadonly/.test(sources.productQuery), 'productQuery cross-school readonly mode is missing');
  ['favoriteProduct', 'messageAction', 'appointmentAction'].forEach((name) => {
    assert(/CROSS_SCHOOL_RELATION_FORBIDDEN/.test(sources[name]), `${name} cross-school error is missing`);
    assert(/assertCanCreateSchoolRelation/.test(sources[name]), `${name} authoritative relation guard is missing`);
  });
  assert(!/PRODUCT_SCHOOL_MISMATCH/.test(sources.manageProduct), 'historical owner management is still school-blocked');
  assert(/product\.sellerOpenid\s*!==\s*openId/.test(sources.manageProduct), 'manageProduct ownership guard is missing');
}

function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(
    options.confirmTarget === targetMasked,
    `confirm target with --confirm-target ${targetMasked}`
  );
  const sources = Object.fromEntries(FUNCTIONS.map((item) => [
    item.name,
    fs.readFileSync(path.join(ROOT, 'cloudfunctions', item.name, 'index.js'), 'utf8')
  ]));
  validateSources(sources);
  const before = Object.fromEntries(FUNCTIONS.map((item) => [
    item.name,
    summarize(readFunctionDetail(environmentId, item.name), sources[item.name])
  ]));
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      wouldDeployOnly: FUNCTIONS.map((item) => item.name),
      writesDatabase: false,
      changesAcl: false,
      changesIndexes: false,
      before
    };
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'phase-19-deploy-')
  );
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: FUNCTIONS.map((item) => ({
        ...item,
        handler: 'index.main',
        timeout: 10,
        memorySize: 256
      }))
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

  const after = {};
  FUNCTIONS.forEach((item) => {
    const summary = summarize(
      readFunctionDetail(environmentId, item.name),
      sources[item.name]
    );
    assert(summary.status === 'Active', `${item.name} is not Active`);
    assert(summary.runtime === item.runtime, `${item.name} runtime changed`);
    assert(summary.handler === 'index.main', `${item.name} handler changed`);
    assert(summary.timeout === 10, `${item.name} timeout changed`);
    assert(summary.memorySize === 256, `${item.name} memory changed`);
    assert(summary.hashMatches, `${item.name} remote code hash differs from local`);
    assert(
      before[item.name].environmentFingerprint === summary.environmentFingerprint,
      `${item.name} environment variables changed`
    );
    after[item.name] = summary;
  });
  return {
    mode: 'deployed',
    target: `cloud:${targetMasked}`,
    deployedOnly: FUNCTIONS.map((item) => item.name),
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
    process.stderr.write(`${error.code || 'PHASE19_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  FUNCTIONS,
  parseArguments,
  validateSources,
  run
};
