const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  queryCollection,
  readFunctionDetail,
  runNoSql,
  assert
} = require('./phase-18-canary-core');
const {
  callTcb
} = require('./phase-18-final-cutover-core');
const {
  extractCommandResults,
  decodeExtendedJson
} = require('./schools/cloud-cli');

const MODE = 'phase-23-production-read-only-audit';
const FUNCTION_NAMES = Object.freeze([
  'appointmentAction',
  'appointmentQuery',
  'authUser',
  'createProduct',
  'favoriteProduct',
  'manageProduct',
  'messageAction',
  'messageQuery',
  'productQuery',
  'productViewAction',
  'schoolQuery',
  'userQuery'
]);
const COLLECTION_NAMES = Object.freeze([
  'users',
  'products',
  'favorites',
  'conversations',
  'messages',
  'appointments',
  'productViews',
  'schools'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseArguments(argv) {
  const options = { describeTarget: false, confirmTarget: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--describe-target') options.describeTarget = true;
    else if (value === '--confirm-target' || value === '--env') {
      options.confirmTarget = String(argv[++index] || '').trim();
    } else if (value === '--output') options.output = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function environmentSummary(detail) {
  const variables = detail && detail.Environment && detail.Environment.Variables;
  const normalized = (Array.isArray(variables) ? variables : []).map((item) => ({
    key: String(item.Key || item.key || ''),
    value: String(item.Value || item.value || '')
  })).sort((left, right) => left.key.localeCompare(right.key));
  return {
    keys: normalized.map((item) => item.key),
    fingerprint: sha256(JSON.stringify(normalized))
  };
}

function functionSummary(detail) {
  const environment = environmentSummary(detail);
  return {
    status: detail.Status || '',
    availableStatus: detail.AvailableStatus || '',
    runtime: detail.Runtime || '',
    handler: detail.Handler || '',
    timeoutSeconds: Number(detail.Timeout || 0),
    initTimeoutSeconds: Number(detail.InitTimeout || 0),
    memoryMb: Number(detail.MemorySize || 0),
    diskMb: Number(detail.DiskSize || 0),
    installDependency: String(detail.InstallDependency || ''),
    deployMode: detail.DeployMode || '',
    publicNetwork: detail.PublicNetConfig && detail.PublicNetConfig.PublicNetStatus || '',
    triggerCount: Array.isArray(detail.Triggers) ? detail.Triggers.length : 0,
    triggers: (Array.isArray(detail.Triggers) ? detail.Triggers : []).map((item) => ({
      name: item.TriggerName || item.Name || '',
      type: item.Type || '',
      enable: item.Enable || item.EnableStatus || ''
    })),
    logFormat: detail.LogFormat || '',
    logType: detail.LogType || '',
    traceEnabled: String(detail.TraceEnable || ''),
    environmentKeys: environment.keys,
    environmentFingerprint: environment.fingerprint
  };
}

function readIndexes(environmentId, collection) {
  const response = runNoSql(environmentId, [{
    TableName: collection,
    CommandType: 'COMMAND',
    Command: JSON.stringify({ listIndexes: collection, cursor: {} })
  }]);
  const results = extractCommandResults(response);
  const candidate = results.length === 1 && Array.isArray(results[0]) ? results[0] : results;
  return candidate.map(decodeExtendedJson).filter((item) => item && item.name && item.key).map((item) => ({
    name: item.name,
    key: item.key,
    unique: item.name === '_id_' || item.unique === true
  }));
}

function toTimestamp(value) {
  const number = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
  return Number.isFinite(number) ? number : 0;
}

async function readStorageRule(environmentId) {
  const environments = await callTcb('DescribeEnvs', { EnvId: environmentId });
  const current = (environments.EnvList || []).find((item) => item.EnvId === environmentId);
  assert(current, 'target environment was not returned by DescribeEnvs');
  const storage = Array.isArray(current.Storages) ? current.Storages[0] : null;
  assert(storage && storage.Bucket, 'target cloud storage bucket is unavailable');
  const rule = await callTcb('DescribeStorageSafeRule', {
    EnvId: environmentId,
    Bucket: storage.Bucket
  });
  return {
    aclTag: rule.AclTag || '',
    customRuleConfigured: Boolean(String(rule.Rule || '').trim()),
    bucketFingerprint: sha256(storage.Bucket).slice(0, 16)
  };
}

async function runAudit(options = {}) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  if (options.describeTarget) {
    return {
      schemaVersion: 1,
      mode: MODE,
      target: `cloud:${targetMasked}`,
      confirmationRequired: true,
      databaseAccessed: false,
      writeCapabilities: false
    };
  }
  if (options.confirmTarget !== targetMasked) {
    throw Object.assign(
      new Error(`confirm target with --env ${targetMasked}`),
      { code: 'TARGET_ENV_CONFIRMATION_REQUIRED' }
    );
  }

  const functions = {};
  for (const name of FUNCTION_NAMES) {
    functions[name] = functionSummary(readFunctionDetail(environmentId, name));
  }
  const collectionAcl = {};
  for (const name of COLLECTION_NAMES) {
    const response = await callTcb('DescribeSafeRule', {
      EnvId: environmentId,
      CollectionName: name
    });
    collectionAcl[name] = response.AclTag || '';
  }
  const storage = await readStorageRule(environmentId);
  const indexes = {};
  for (const name of COLLECTION_NAMES) {
    indexes[name] = readIndexes(environmentId, name);
  }
  const views = queryCollection(environmentId, 'productViews', {
    projection: { _id: 1, cleanupAfter: 1, viewedAt: 1 },
    limit: 1000
  });
  const now = Date.now();
  const expiredViews = views.filter((item) => {
    const cleanupAfter = toTimestamp(item.cleanupAfter);
    return cleanupAfter > 0 && cleanupAfter <= now;
  });
  const runtimeCounts = Object.values(functions).reduce((result, item) => {
    result[item.runtime] = Number(result[item.runtime] || 0) + 1;
    return result;
  }, {});
  const completionBlockers = [];
  if (Object.values(functions).some((item) => item.status !== 'Active')) {
    completionBlockers.push('FUNCTION_NOT_ACTIVE');
  }
  if (Object.values(functions).some((item) => item.handler !== 'index.main')) {
    completionBlockers.push('FUNCTION_HANDLER_DRIFT');
  }
  if (Object.values(functions).some((item) => item.timeoutSeconds !== 10 || item.memoryMb !== 256)) {
    completionBlockers.push('FUNCTION_RESOURCE_DRIFT');
  }
  if (Object.values(collectionAcl).some((value) => value !== 'ADMINONLY')) {
    completionBlockers.push('COLLECTION_ACL_NOT_ADMINONLY');
  }
  if (storage.aclTag !== 'READONLY') completionBlockers.push('STORAGE_ACL_UNEXPECTED');
  if (!indexes.productViews.some((item) => item.name === 'idx_cleanupAfter')) {
    completionBlockers.push('PRODUCT_VIEWS_CLEANUP_INDEX_MISSING');
  }
  return {
    schemaVersion: 1,
    mode: MODE,
    completedAt: new Date().toISOString(),
    target: `cloud:${targetMasked}`,
    functions,
    runtimeCounts,
    collectionAcl,
    storage,
    indexes: Object.fromEntries(COLLECTION_NAMES.map((name) => [name, {
      count: indexes[name].length,
      names: indexes[name].map((item) => item.name),
      ...(name === 'products' || name === 'productViews'
        ? { definitions: indexes[name] }
        : {})
    }])),
    productViewsRetention: {
      total: views.length,
      withCleanupAfter: views.filter((item) => toTimestamp(item.cleanupAfter) > 0).length,
      expired: expiredViews.length,
      automaticCleanupTriggerPresent: functions.productViewAction.triggerCount > 0,
      assessment: expiredViews.length === 0 && views.length < 1000
        ? 'defer-scheduled-cleanup-low-volume'
        : 'schedule-controlled-cleanup-review'
    },
    readOnlyProof: {
      databaseWriteApiCalled: false,
      functionInvoked: false,
      deploymentExecuted: false,
      aclOrIndexChanged: false
    },
    completionGate: {
      passed: completionBlockers.length === 0,
      blockers: completionBlockers
    }
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await runAudit(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      const outputPath = path.resolve(options.output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, output, { encoding: 'utf8', mode: 0o600 });
    }
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE23_PRODUCTION_AUDIT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  MODE,
  FUNCTION_NAMES,
  COLLECTION_NAMES,
  parseArguments,
  environmentSummary,
  functionSummary,
  readIndexes,
  runAudit
};
