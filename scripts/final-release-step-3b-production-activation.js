const fs = require('fs');
const path = require('path');
const {
  ROOT,
  EXPECTED_NORMALIZED_SHA256,
  EXPECTED_TOTAL,
  EXPECTED_TARGET_COUNT,
  AUTHORIZATION_PHRASE,
  BEFORE_PATH,
  MANIFEST_PATH,
  STATE_PATH,
  CHECKPOINTS,
  sha256,
  officialProjection,
  compareProductionSchools,
  assertProductionIntegrity,
  loadNormalized,
  readAllSchools,
  queryByIds,
  readBusinessSnapshot,
  invokeSchoolQuery,
  safeWriteJson,
  readJson,
  publicSummary,
  assert,
  stableStringify
} = require('./final-release-step-3b-core');
const { runPreflight, maskIdentifier } = require('./environment-preflight');
const { runNoSql } = require('./schools/cloud-cli');

const BATCH_SIZE = 10;

function parseArguments(argv) {
  const options = {
    environmentName: '', write: false, authorization: '', confirmTarget: '',
    input: '', expectedTargetCount: 0, expectedTargetIdHash: '', normalizedChecksum: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--write') options.write = true;
    else if (value === '--authorization') options.authorization = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--input') options.input = path.resolve(ROOT, String(argv[++index] || '').trim());
    else if (value === '--expected-target-count') options.expectedTargetCount = Number(argv[++index]);
    else if (value === '--expected-target-id-hash') options.expectedTargetIdHash = String(argv[++index] || '').trim();
    else if (value === '--normalized-checksum') options.normalizedChecksum = String(argv[++index] || '').trim().toLowerCase();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function validateManifest(options) {
  assert(options.input === path.resolve(MANIFEST_PATH), 'only the approved Step 3B private manifest is accepted', 'MANIFEST_PATH_REJECTED');
  const manifest = readJson(options.input, 'ACTIVATION_MANIFEST_MISSING');
  assert(manifest.mode === 'FINAL_RELEASE_STEP_3B_ACTIVATION_MANIFEST' && manifest.schemaVersion === 1, 'activation manifest schema is invalid', 'ACTIVATION_MANIFEST_INVALID');
  assert(manifest.safeToApply === true && Array.isArray(manifest.issues) && manifest.issues.length === 0, 'activation manifest is not safe to apply', 'ACTIVATION_MANIFEST_UNSAFE');
  assert(manifest.targetCount === EXPECTED_TARGET_COUNT && manifest.targets.length === EXPECTED_TARGET_COUNT, 'activation manifest count drifted', 'ACTIVATION_MANIFEST_INVALID');
  assert(manifest.targetStatus === 'pending' && manifest.targetOfficialStatus === 'valid', 'activation manifest status scope drifted', 'ACTIVATION_MANIFEST_INVALID');
  assert(stableStringify(manifest.mutation) === stableStringify({ from: 'pending', to: 'active', allowedFields: ['platformStatus', 'updatedAt'] }), 'activation manifest mutation scope drifted', 'ACTIVATION_MANIFEST_INVALID');
  const ids = manifest.targets.map((target) => target._id);
  assert(new Set(ids).size === EXPECTED_TARGET_COUNT, 'activation manifest contains duplicate IDs', 'ACTIVATION_MANIFEST_INVALID');
  assert(sha256(ids.join('\n')) === manifest.targetIdSha256, 'activation manifest ID hash drifted', 'ACTIVATION_MANIFEST_INVALID');
  assert(options.expectedTargetCount === EXPECTED_TARGET_COUNT, 'exact --expected-target-count 2950 is required', 'TARGET_COUNT_CONFIRMATION_REQUIRED');
  assert(options.expectedTargetIdHash === manifest.targetIdSha256, 'exact target ID hash confirmation is required', 'TARGET_HASH_CONFIRMATION_REQUIRED');
  assert(options.normalizedChecksum === EXPECTED_NORMALIZED_SHA256 && manifest.normalizedSha256 === EXPECTED_NORMALIZED_SHA256, 'normalized checksum confirmation is required', 'NORMALIZED_CHECKSUM_CONFIRMATION_REQUIRED');
  return manifest;
}

function officialHash(record) {
  return sha256(JSON.stringify(officialProjection(record)));
}

function assertTargetRecord(record, target, expectedStatus) {
  assert(record, 'approved school disappeared', 'ACTIVATION_TARGET_MISSING');
  assert(record._id === target._id && record.officialCode === target.officialCode, 'approved school identity drifted', 'ACTIVATION_TARGET_DRIFT');
  assert(record.officialStatus === 'valid', 'approved school officialStatus drifted', 'ACTIVATION_TARGET_DRIFT');
  assert(record.platformStatus === expectedStatus, `approved school status is ${record.platformStatus}, expected ${expectedStatus}`, 'ACTIVATION_TARGET_STATUS_DRIFT');
  assert(officialHash(record) === target.officialFieldSha256, 'approved school official fields drifted', 'ACTIVATION_TARGET_DRIFT');
}

function buildUpdateCommand(targets) {
  assert(Array.isArray(targets) && targets.length > 0 && targets.length <= BATCH_SIZE, `activation batch must contain 1..${BATCH_SIZE} targets`, 'ACTIVATION_BATCH_INVALID');
  return {
    TableName: 'schools',
    CommandType: 'UPDATE',
    Command: JSON.stringify({
      update: 'schools',
      updates: targets.map((target) => ({
        q: {
          _id: target._id,
          officialCode: target.officialCode,
          officialStatus: 'valid',
          platformStatus: 'pending'
        },
        u: {
          $set: { platformStatus: 'active' },
          $currentDate: { updatedAt: true }
        },
        multi: false,
        upsert: false
      })),
      ordered: true
    })
  };
}

function initialState(manifest, environment) {
  return {
    schemaVersion: 1,
    mode: 'FINAL_RELEASE_STEP_3B_ACTIVATION_STATE',
    runId: `step3b-${manifest.targetIdSha256.slice(0, 16)}-${Date.now()}`,
    manifestSha256: sha256(fs.readFileSync(MANIFEST_PATH)),
    targetIdSha256: manifest.targetIdSha256,
    environment: environment.environmentId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completed: [],
    completedDetails: [],
    inFlight: null,
    checkpoints: [],
    errors: [],
    schoolMutations: 0,
    otherCollectionMutations: 0,
    productMutations: 0,
    productRemoves: 0,
    finished: false
  };
}

function loadOrCreateState(manifest, environment) {
  if (!fs.existsSync(STATE_PATH)) {
    const state = initialState(manifest, environment);
    safeWriteJson(STATE_PATH, state);
    return state;
  }
  const state = readJson(STATE_PATH, 'ACTIVATION_STATE_INVALID');
  assert(state.mode === 'FINAL_RELEASE_STEP_3B_ACTIVATION_STATE' && state.schemaVersion === 1, 'activation state schema is invalid', 'ACTIVATION_STATE_INVALID');
  assert(state.manifestSha256 === sha256(fs.readFileSync(MANIFEST_PATH)), 'activation state manifest hash drifted', 'ACTIVATION_STATE_DRIFT');
  assert(state.targetIdSha256 === manifest.targetIdSha256, 'activation state target hash drifted', 'ACTIVATION_STATE_DRIFT');
  assert(state.environment === environment.environmentId, 'activation state environment drifted', 'ACTIVATION_STATE_DRIFT');
  assert(Array.isArray(state.completed) && new Set(state.completed).size === state.completed.length, 'activation state completed IDs are invalid', 'ACTIVATION_STATE_INVALID');
  assert(state.schoolMutations === state.completed.length, 'activation state mutation count drifted', 'ACTIVATION_STATE_INVALID');
  return state;
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  safeWriteJson(STATE_PATH, state);
}

function checkpoint(environmentId, manifest, before, state, threshold) {
  const normalized = loadNormalized();
  const schools = readAllSchools(environmentId);
  const integrity = compareProductionSchools(normalized, schools);
  assertProductionIntegrity(integrity);
  const active = Number(integrity.statusCounts.active || 0);
  const pending = Number(integrity.statusCounts.pending || 0);
  assert(active === 2 + state.completed.length, 'checkpoint active count drifted', 'CHECKPOINT_STATUS_DRIFT');
  assert(pending === EXPECTED_TARGET_COUNT - state.completed.length, 'checkpoint pending count drifted', 'CHECKPOINT_STATUS_DRIFT');
  const business = readBusinessSnapshot(environmentId);
  for (const [name, summary] of Object.entries(before.business.collections)) {
    assert(business.collections[name].count === summary.count, `${name} count changed during activation`, 'UNEXPECTED_BUSINESS_MUTATION');
    assert(business.collections[name].sha256 === summary.sha256, `${name} changed during activation`, 'UNEXPECTED_BUSINESS_MUTATION');
  }
  const query = invokeSchoolQuery(environmentId, { action: 'list', pageSize: 20 }).result;
  assert(query.success === true && query.code === 'OK' && query.data.items.every((item) => item.platformStatus === 'active'), 'checkpoint query smoke failed', 'CHECKPOINT_QUERY_FAILED');
  const result = {
    threshold,
    completed: state.completed.length,
    active,
    pending,
    errorCount: state.errors.length,
    unexpectedStatus: 0,
    officialFieldDrift: integrity.different,
    querySmoke: true,
    publicMarketZero: business.products.publicMarketZero,
    checkedAt: new Date().toISOString()
  };
  state.checkpoints.push(result);
  saveState(state);
  process.stderr.write(`[STEP3B][CHECKPOINT] ${JSON.stringify(result)}\n`);
  return result;
}

function validateResumeState(environmentId, manifest, state) {
  const completed = new Set(state.completed);
  const live = readAllSchools(environmentId);
  const liveById = new Map(live.map((record) => [record._id, record]));
  for (const target of manifest.targets) {
    const record = liveById.get(target._id);
    if (completed.has(target._id)) assertTargetRecord(record, target, 'active');
    else assertTargetRecord(record, target, 'pending');
  }
  assert(!state.inFlight, 'unresolved in-flight batch requires manual review', 'ACTIVATION_INFLIGHT_UNRESOLVED');
}

function run(options) {
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  const manifest = validateManifest(options);
  const preflight = runPreflight({
    environmentName: 'production',
    action: options.write ? 'cleanup' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: options.write
  });
  if (options.write) assert(options.authorization === AUTHORIZATION_PHRASE, 'exact Step 3B authorization phrase is required', 'OWNER_AUTHORIZATION_REQUIRED');
  const before = readJson(BEFORE_PATH, 'ACTIVATION_SNAPSHOT_MISSING');
  assert(before.schools.targetIdSha256 === manifest.targetIdSha256, 'before snapshot target hash drifted', 'ACTIVATION_SNAPSHOT_DRIFT');
  assert(before.source.normalizedSha256 === EXPECTED_NORMALIZED_SHA256, 'before snapshot normalized checksum drifted', 'ACTIVATION_SNAPSHOT_DRIFT');
  if (!options.write) {
    const live = readAllSchools(preflight.environmentId);
    const integrity = compareProductionSchools(loadNormalized(), live);
    assertProductionIntegrity(integrity);
    assert(Number(integrity.statusCounts.active || 0) === 2 && Number(integrity.statusCounts.pending || 0) === EXPECTED_TARGET_COUNT, 'dry-run production state drifted', 'PRODUCTION_STATUS_DRIFT');
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      targetCount: manifest.targetCount,
      targetIdSha256: manifest.targetIdSha256,
      normalizedSha256: manifest.normalizedSha256,
      batchSize: BATCH_SIZE,
      checkpoints: CHECKPOINTS,
      write: false,
      safeToApply: true
    };
  }
  const state = loadOrCreateState(manifest, preflight);
  if (state.finished) {
    return {
      mode: 'already-complete',
      environment: publicSummary(preflight),
      runId: state.runId,
      schoolMutations: state.schoolMutations,
      completed: state.completed.length,
      finished: true
    };
  }
  validateResumeState(preflight.environmentId, manifest, state);
  const completed = new Set(state.completed);
  const remaining = manifest.targets.filter((target) => !completed.has(target._id));
  for (let offset = 0; offset < remaining.length; offset += BATCH_SIZE) {
    const batch = remaining.slice(offset, offset + BATCH_SIZE);
    const liveBefore = queryByIds(preflight.environmentId, batch.map((target) => target._id));
    const liveBeforeById = new Map(liveBefore.map((record) => [record._id, record]));
    for (const target of batch) assertTargetRecord(liveBeforeById.get(target._id), target, 'pending');
    state.inFlight = {
      ids: batch.map((target) => target._id),
      startedAt: new Date().toISOString()
    };
    saveState(state);
    let writeError = null;
    try {
      runNoSql(preflight.environmentId, [buildUpdateCommand(batch)]);
    } catch (error) {
      writeError = error;
    }
    const liveAfter = queryByIds(preflight.environmentId, batch.map((target) => target._id));
    const liveAfterById = new Map(liveAfter.map((record) => [record._id, record]));
    const succeeded = [];
    const pending = [];
    for (const target of batch) {
      const record = liveAfterById.get(target._id);
      assert(record && officialHash(record) === target.officialFieldSha256, 'post-write official field drift', 'ACTIVATION_POST_WRITE_DRIFT');
      if (record.platformStatus === 'active') succeeded.push(target);
      else if (record.platformStatus === 'pending') pending.push(target);
      else throw Object.assign(new Error(`unexpected post-write status ${record.platformStatus}`), { code: 'ACTIVATION_POST_WRITE_DRIFT' });
    }
    for (const target of succeeded) {
      if (!completed.has(target._id)) {
        completed.add(target._id);
        state.completed.push(target._id);
        state.completedDetails.push({ _id: target._id, completedAt: new Date().toISOString(), reconciledAfterError: Boolean(writeError) });
      }
    }
    state.schoolMutations = state.completed.length;
    state.inFlight = null;
    if (writeError || pending.length > 0 || succeeded.length !== batch.length) {
      const writeErrorMessage = writeError
        ? String(writeError && writeError.message || writeError).slice(0, 2000)
        : '';
      state.errors.push({
        at: new Date().toISOString(),
        code: writeError && (writeError.code || 'CLOUD_CLI_FAILED') || 'BATCH_PARTIAL_FAILURE',
        message: writeErrorMessage,
        batchSize: batch.length,
        succeeded: succeeded.length,
        pending: pending.length
      });
      saveState(state);
      const error = new Error(`activation batch stopped: succeeded=${succeeded.length}, pending=${pending.length}${writeErrorMessage ? `; ${writeErrorMessage}` : ''}`);
      error.code = writeError ? 'ACTIVATION_WRITE_OUTCOME_RECONCILED_STOP' : 'ACTIVATION_BATCH_PARTIAL_FAILURE';
      throw error;
    }
    saveState(state);
    for (const threshold of CHECKPOINTS) {
      if (state.completed.length >= threshold && !state.checkpoints.some((item) => item.threshold === threshold)) {
        checkpoint(preflight.environmentId, manifest, before, state, threshold);
      }
    }
    if (state.completed.length % 100 === 0 || state.completed.length === EXPECTED_TARGET_COUNT) {
      process.stderr.write(`[STEP3B][PROGRESS] completed=${state.completed.length} remaining=${EXPECTED_TARGET_COUNT - state.completed.length}\n`);
    }
  }
  assert(state.completed.length === EXPECTED_TARGET_COUNT, 'activation did not complete all targets', 'ACTIVATION_INCOMPLETE');
  state.finished = true;
  state.finishedAt = new Date().toISOString();
  saveState(state);
  return {
    mode: 'activation-complete',
    environment: publicSummary(preflight),
    runId: state.runId,
    schoolMutations: state.schoolMutations,
    exactTargetCount: state.schoolMutations === EXPECTED_TARGET_COUNT,
    completed: state.completed.length,
    remaining: 0,
    batches: Math.ceil(EXPECTED_TARGET_COUNT / BATCH_SIZE),
    checkpointCount: state.checkpoints.length,
    errorCount: state.errors.length,
    productMutations: state.productMutations,
    productRemoves: state.productRemoves,
    otherCollectionMutations: state.otherCollectionMutations,
    finished: state.finished,
    privateState: 'tmp/final-release-step-3b-operation-state.json'
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    let message = String(error && error.message || error);
    try {
      const targets = require('../config/cloud.targets.private');
      for (const id of Object.values(targets).filter(Boolean)) message = message.split(id).join(maskIdentifier(id));
    } catch (ignored) {
      // Environment configuration failures are already fail-closed.
    }
    process.stderr.write(`${error.code || 'STEP3B_ACTIVATION_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BATCH_SIZE,
  parseArguments,
  validateManifest,
  assertTargetRecord,
  buildUpdateCommand,
  checkpoint,
  validateResumeState,
  run
};
