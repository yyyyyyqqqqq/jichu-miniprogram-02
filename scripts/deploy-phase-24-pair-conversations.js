const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const {
  runCloudBase,
  runNoSql
} = require('./schools/cloud-cli');
const {
  readIndexes,
  queryCollection
} = require('./phase-24-staging-core');
const {
  OWNER_AUTHORIZATION,
  readMaintenance
} = require('./migrate-phase-24-pair-conversations');
const {
  assertProductionMessageQueryCandidate
} = require('./phase-25-minimum-safe-rollback-core');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS = Object.freeze([
  'messageAction',
  'appointmentAction',
  'messageQuery',
  'appointmentQuery'
]);
const INDEXES = Object.freeze({
  conversations: Object.freeze([
    Object.freeze({
      name: 'idx_participant_pair_unique',
      key: Object.freeze({ participantPairKey: 1 }),
      unique: true,
      sparse: false
    }),
    Object.freeze({
      name: 'idx_participantA_status_lastMessageAt_id',
      key: Object.freeze({ participantAOpenid: 1, status: 1, lastMessageAt: -1, _id: -1 }),
      unique: false
    }),
    Object.freeze({
      name: 'idx_participantB_status_lastMessageAt_id',
      key: Object.freeze({ participantBOpenid: 1, status: 1, lastMessageAt: -1, _id: -1 }),
      unique: false
    })
  ]),
  appointments: Object.freeze([
    Object.freeze({
      name: 'idx_conversation_product_status_deleted_updatedAt_id',
      key: Object.freeze({ conversationId: 1, productId: 1, status: 1, isDeleted: 1, updatedAt: -1, _id: -1 }),
      unique: false
    })
  ])
});

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    deploy: false,
    maintenanceGateOnly: false,
    ownerAuthorization: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--owner-authorization') options.ownerAuthorization = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else if (value === '--maintenance-gate-only') options.maintenanceGateOnly = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(!options.maintenanceGateOnly || options.deploy, '--maintenance-gate-only requires --deploy', 'INVALID_ARGUMENT');
  return options;
}

function normalizeIndex(index) {
  return {
    name: String(index.Name || index.name || ''),
    unique: index.Unique === true || index.unique === true,
    sparse: index.Sparse === true || index.sparse === true,
    key: Object.fromEntries(
      (index.keys || index.Keys || []).map((item) => (
        Array.isArray(item)
          ? [String(item[0]), Number(item[1])]
          : [String(item.Name), Number(item.Direction)]
      ))
    )
  };
}

function matches(actual, expected) {
  return actual.name === expected.name
    && actual.unique === expected.unique
    && (!expected.sparse || actual.sparse === true)
    && JSON.stringify(actual.key) === JSON.stringify(expected.key);
}

async function inspectIndexes(environmentId) {
  const state = {};
  for (const [collection, definitions] of Object.entries(INDEXES)) {
    const actual = (await readIndexes(environmentId, collection)).map(normalizeIndex);
    state[collection] = definitions.map((definition) => {
      const sameName = actual.find((item) => item.name === definition.name);
      assert(!sameName || matches(sameName, definition), `${collection}.${definition.name} has a conflicting definition`, 'INDEX_CONFLICT');
      return { definition, exists: Boolean(sameName) };
    });
  }
  return state;
}

function assertMigrationReady(environmentId, environmentName) {
  const conversations = queryCollection(environmentId, 'conversations', {}, 1000);
  if (environmentName === 'staging' && conversations.length === 0) {
    return { total: 0, active: 0, merged: 0, emptyStagingBootstrap: true };
  }
  const active = conversations.filter((item) => item.status === 'active');
  const merged = conversations.filter((item) => item.status === 'merged');
  const keys = conversations.map((item) => String(item.participantPairKey || '')).filter(Boolean);
  assert(active.length > 0, 'no active canonical conversations found', 'MIGRATION_NOT_APPLIED');
  assert(active.every((item) => item.schemaVersion === 2 && /^pp_[a-f0-9]{64}$/.test(item.participantPairKey)), 'active conversations are not canonical', 'MIGRATION_NOT_APPLIED');
  assert(merged.every((item) => /^c_[a-f0-9]{64}$/.test(item.mergedInto)), 'merged aliases are incomplete', 'MIGRATION_NOT_APPLIED');
  assert(new Set(keys).size === keys.length, 'participantPairKey values are not unique', 'PAIR_KEY_CONFLICT');
  return { total: conversations.length, active: active.length, merged: merged.length };
}

function createMissingIndexes(environmentId, state) {
  for (const [collection, items] of Object.entries(state)) {
    const missing = items.filter((item) => !item.exists).map((item) => item.definition);
    if (missing.length === 0) continue;
    runNoSql(environmentId, [{
      TableName: collection,
      CommandType: 'COMMAND',
      Command: JSON.stringify({
        createIndexes: collection,
        indexes: missing.map((definition) => ({
          name: definition.name,
          key: definition.key,
          unique: definition.unique,
          sparse: definition.sparse === true
        }))
      })
    }]);
  }
}

function deployFunctions(environmentId) {
  const prefix = 'phase-24-pair-deploy-';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(directory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: FUNCTIONS.map((name) => ({
        name,
        runtime: 'Nodejs18.15',
        handler: 'index.main',
        timeout: 10,
        memorySize: 256
      }))
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    FUNCTIONS.forEach((name) => runCloudBase([
      '--config-file', configPath,
      'fn', 'deploy', name,
      '--force'
    ], { timeoutMs: 300000, json: false }));
  } finally {
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'temporary directory escaped OS temp', 'UNSAFE_TEMP_PATH');
    assert(path.basename(resolved).startsWith(prefix), 'temporary directory prefix mismatch', 'UNSAFE_TEMP_PATH');
    fs.rmSync(resolved, { recursive: true, force: false });
  }
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: options.deploy && options.environmentName === 'production',
    allowInactiveRead: !options.deploy
  });
  const indexes = await inspectIndexes(preflight.environmentId);
  const messageQuerySource = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions', 'messageQuery', 'index.js'),
    'utf8'
  );
  const rollbackFloor = assertProductionMessageQueryCandidate(
    messageQuerySource,
    { lifecycleDataState: 'present' }
  );
  const wouldCreateIndexes = Object.fromEntries(Object.entries(indexes).map(([name, items]) => [
    name,
    items.filter((item) => !item.exists).map((item) => item.definition.name)
  ]));
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      requiredSequence: [
        'maintenance-config-on',
        'maintenance-gate-function-deploy',
        'maintenance-response-verification',
        'fresh-snapshot-and-dry-run',
        'migration-apply',
        'index-create',
        'function-and-index-verification',
        'maintenance-off'
      ],
      wouldCreateIndexes,
      wouldDeployFunctions: FUNCTIONS,
      rollbackFloor: {
        baselineId: rollbackFloor.baselineId,
        sourceSha256: rollbackFloor.inspection.sourceSha256,
        allowed: true
      },
      writesBusinessData: false,
      changesAcl: false
    };
  }
  assert(options.ownerAuthorization === OWNER_AUTHORIZATION, `deploy requires --owner-authorization ${OWNER_AUTHORIZATION}`, 'PROJECT_OWNER_AUTHORIZATION_REQUIRED');
  if (options.maintenanceGateOnly) {
    const maintenance = readMaintenance(preflight.environmentId);
    assert(
      maintenance.valid && maintenance.enabled && maintenance.migrationRunId,
      'maintenance gate deployment requires authoritative maintenance ON',
      'MAINTENANCE_NOT_ENABLED'
    );
    deployFunctions(preflight.environmentId);
    return {
      mode: 'maintenance-gate-deployed',
      environment: publicSummary(preflight),
      migrationRunId: maintenance.migrationRunId,
      deployedFunctions: FUNCTIONS,
      rollbackFloor: {
        baselineId: rollbackFloor.baselineId,
        sourceSha256: rollbackFloor.inspection.sourceSha256,
        allowed: true
      },
      createdIndexes: {},
      migrationRequiredBeforeMaintenanceOff: true,
      writesBusinessData: false,
      changesAcl: false
    };
  }
  const migration = assertMigrationReady(
    preflight.environmentId,
    preflight.environmentName
  );
  createMissingIndexes(preflight.environmentId, indexes);
  const afterIndexes = await inspectIndexes(preflight.environmentId);
  assert(Object.values(afterIndexes).flat().every((item) => item.exists), 'required index was not created', 'INDEX_CREATE_FAILED');
  deployFunctions(preflight.environmentId);
  return {
    mode: 'deployed',
    environment: publicSummary(preflight),
    migration,
    createdIndexes: wouldCreateIndexes,
    deployedFunctions: FUNCTIONS,
    rollbackFloor: {
      baselineId: rollbackFloor.baselineId,
      sourceSha256: rollbackFloor.inspection.sourceSha256,
      allowed: true
    },
    writesBusinessData: false,
    changesAcl: false
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'PHASE24_PAIR_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { FUNCTIONS, INDEXES, parseArguments, run };
