const {
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const {
  runNoSql,
  extractCommandResults,
  extractDocuments,
  decodeExtendedJson
} = require('./schools/cloud-cli');
const {
  readTables,
  createCollection,
  setCollectionAcl
} = require('./phase-24-staging-core');
const {
  OWNER_AUTHORIZATION
} = require('./migrate-phase-24-pair-conversations');
const {
  CONFIG_COLLECTION,
  CONFIG_ID,
  CONFIG_SCHEMA_VERSION,
  normalizeMaintenanceState
} = require('./phase-24-maintenance-core');

function parseArguments(argv) {
  const options = {
    environmentName: '',
    status: 'audit',
    migrationRunId: '',
    confirmTarget: '',
    ownerAuthorization: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--status') options.status = String(argv[++index] || '').trim();
    else if (value === '--migration-run-id') options.migrationRunId = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--owner-authorization') options.ownerAuthorization = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(['production', 'staging'].includes(options.environmentName), 'explicit --env production|staging is required', 'ENVIRONMENT_ROLE_REQUIRED');
  assert(['audit', 'on', 'off'].includes(options.status), '--status audit|on|off is required', 'INVALID_ARGUMENT');
  assert(options.status !== 'on' || /^phase24_pair_[0-9]{17}$/.test(options.migrationRunId), 'maintenance ON requires a migration run id', 'MIGRATION_RUN_ID_REQUIRED');
  return options;
}

function execute(environmentId, commandType, command) {
  return runNoSql(environmentId, [{
    TableName: CONFIG_COLLECTION,
    CommandType: commandType,
    Command: JSON.stringify(command)
  }]);
}

function queryConfig(environmentId) {
  const response = execute(environmentId, 'QUERY', {
    find: CONFIG_COLLECTION,
    filter: { _id: CONFIG_ID },
    limit: 2
  });
  const results = extractCommandResults(response);
  const rows = (results.length > 0
    ? results.flatMap((item) => extractDocuments(item))
    : extractDocuments(response)).map(decodeExtendedJson);
  assert(rows.length <= 1, 'maintenance config id is not unique', 'MAINTENANCE_CONFIG_INVALID');
  return rows[0] || null;
}

async function ensureCollection(environmentId) {
  const tables = await readTables(environmentId);
  if (!tables.some((item) => item.name === CONFIG_COLLECTION)) {
    await createCollection(environmentId, CONFIG_COLLECTION);
  }
  await setCollectionAcl(environmentId, CONFIG_COLLECTION);
}

function writeConfig(environmentId, before, enabled, migrationRunId) {
  const now = new Date().toISOString();
  const document = {
    _id: CONFIG_ID,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled,
    migrationRunId: enabled ? migrationRunId : '',
    scope: 'conversation-appointment-writes',
    updatedAt: { $date: { $numberLong: String(new Date(now).getTime()) } }
  };
  if (!before) {
    document.createdAt = document.updatedAt;
    execute(environmentId, 'INSERT', {
      insert: CONFIG_COLLECTION,
      documents: [document],
      ordered: true
    });
    return;
  }
  execute(environmentId, 'UPDATE', {
    update: CONFIG_COLLECTION,
    updates: [{
      q: {
        _id: CONFIG_ID,
        schemaVersion: CONFIG_SCHEMA_VERSION,
        enabled: before.enabled
      },
      u: { $set: {
        enabled: document.enabled,
        migrationRunId: document.migrationRunId,
        scope: document.scope,
        updatedAt: document.updatedAt
      } },
      multi: false,
      upsert: false
    }],
    ordered: true
  });
}

async function run(options) {
  const write = options.status !== 'audit';
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: write ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: write && options.environmentName === 'production',
    allowInactiveRead: !write
  });
  if (write) {
    assert(options.ownerAuthorization === OWNER_AUTHORIZATION, `maintenance writes require --owner-authorization ${OWNER_AUTHORIZATION}`, 'PROJECT_OWNER_AUTHORIZATION_REQUIRED');
    await ensureCollection(preflight.environmentId);
  }
  const tables = await readTables(preflight.environmentId);
  const exists = tables.some((item) => item.name === CONFIG_COLLECTION);
  const before = exists ? queryConfig(preflight.environmentId) : null;
  if (!write) {
    return {
      mode: 'audit',
      environment: publicSummary(preflight),
      collectionExists: exists,
      state: normalizeMaintenanceState(before)
    };
  }
  writeConfig(
    preflight.environmentId,
    before,
    options.status === 'on',
    options.migrationRunId
  );
  const after = queryConfig(preflight.environmentId);
  const state = normalizeMaintenanceState(after);
  assert(state.valid && state.enabled === (options.status === 'on'), 'maintenance readback differs from requested state', 'MAINTENANCE_WRITE_FAILED');
  if (options.status === 'on') {
    assert(state.migrationRunId === options.migrationRunId, 'maintenance run id readback differs', 'MAINTENANCE_WRITE_FAILED');
  }
  return {
    mode: `maintenance-${options.status}`,
    environment: publicSummary(preflight),
    collection: CONFIG_COLLECTION,
    state
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'MAINTENANCE_CONTROL_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  queryConfig,
  ensureCollection,
  writeConfig,
  run
};
