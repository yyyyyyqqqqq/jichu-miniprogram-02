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
  runNoSql,
  assert
} = require('./phase-18-canary-core');
const { readProductIndexes } = require('./phase-18-final-cutover-core');

const FUNCTIONS = Object.freeze([
  { name: 'favoriteProduct', runtime: 'Nodejs18.15' },
  { name: 'messageQuery', runtime: 'Nodejs18.15' },
  { name: 'messageAction', runtime: 'Nodejs18.15' },
  { name: 'appointmentQuery', runtime: 'Nodejs18.15' },
  { name: 'userQuery', runtime: 'Nodejs18.15' }
]);
const SELLER_SCOPE_INDEX = Object.freeze({
  name: 'idx_seller_school_status_createdAt_id',
  key: Object.freeze({
    sellerOpenid: 1,
    schoolId: 1,
    status: 1,
    createdAt: -1,
    _id: 1
  })
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

function indexMatches(index) {
  return Boolean(
    index
    && index.name === SELLER_SCOPE_INDEX.name
    && JSON.stringify(index.key) === JSON.stringify(SELLER_SCOPE_INDEX.key)
    && index.unique !== true
  );
}

function validateIndexState(indexes) {
  const sameName = indexes.find((item) => item.name === SELLER_SCOPE_INDEX.name);
  if (sameName) {
    assert(indexMatches(sameName), `${SELLER_SCOPE_INDEX.name} exists with a conflicting definition`);
    return { exists: true, index: sameName };
  }
  const sameKey = indexes.find((item) => (
    JSON.stringify(item.key) === JSON.stringify(SELLER_SCOPE_INDEX.key)
  ));
  return { exists: Boolean(sameKey), index: sameKey || null };
}

function validateSources(sources) {
  ['favoriteProduct', 'messageQuery', 'messageAction', 'appointmentQuery'].forEach((name) => {
    assert(/schoolId/.test(sources[name]), `${name} historical product school field is missing`);
  });
  assert(/resolveViewerContext\(cloud\.getWXContext\(\)\)/.test(sources.userQuery), 'userQuery server viewer identity is missing');
  assert(/schoolId:\s*viewer\.schoolId/.test(sources.userQuery), 'userQuery viewer school scope is missing');
  assert(!/data\.(?:schoolId|viewerSchoolId)/.test(sources.userQuery), 'userQuery trusts a client school field');
  assert(/assertCanCreateSchoolRelation/.test(sources.messageAction), 'messageAction Phase 19 guard is missing');
}

function createSellerScopeIndex(environmentId) {
  runNoSql(environmentId, [{
    TableName: 'products',
    CommandType: 'COMMAND',
    Command: JSON.stringify({
      createIndexes: 'products',
      indexes: [{
        name: SELLER_SCOPE_INDEX.name,
        key: SELLER_SCOPE_INDEX.key,
        unique: false
      }]
    })
  }]);
}

function deployFunctions(environmentId) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'phase-21-deploy-')
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
  const indexesBefore = readProductIndexes(environmentId);
  const indexBefore = validateIndexState(indexesBefore);
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      wouldDeployOnly: FUNCTIONS.map((item) => item.name),
      writesBusinessData: false,
      changesAcl: false,
      indexCountBefore: indexesBefore.length,
      wouldCreateIndex: indexBefore.exists ? null : SELLER_SCOPE_INDEX,
      before
    };
  }

  if (!indexBefore.exists) {
    createSellerScopeIndex(environmentId);
  }
  const indexesAfter = readProductIndexes(environmentId);
  const indexAfter = validateIndexState(indexesAfter);
  assert(indexAfter.exists, `${SELLER_SCOPE_INDEX.name} was not found after creation`);
  assert(
    indexesAfter.length === indexesBefore.length + (indexBefore.exists ? 0 : 1),
    'unexpected products index count change'
  );

  deployFunctions(environmentId);
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
    writesBusinessData: false,
    changesAcl: false,
    indexCreated: indexBefore.exists ? null : SELLER_SCOPE_INDEX,
    indexCountBefore: indexesBefore.length,
    indexCountAfter: indexesAfter.length,
    environmentVariablesChanged: false,
    before,
    after
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE21_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  FUNCTIONS,
  SELLER_SCOPE_INDEX,
  parseArguments,
  indexMatches,
  validateIndexState,
  validateSources,
  run
};
