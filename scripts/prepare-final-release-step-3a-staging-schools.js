const fs = require('fs');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert,
  maskIdentifier
} = require('./environment-preflight');
const schoolCore = require('./schools/core');
const {
  readAllSchools,
  runNoSql
} = require('./schools/cloud-cli');
const {
  insertDocuments
} = require('./phase-24-staging-core');

const EXPECTED_COUNT = 2952;
const EXPECTED_SOURCE_SHA256 = 'a0ceb41a15f335c0adfb2d0239137b879b1c58d1b57a322d3e1794866de7d09c';
const EXPECTED_NORMALIZED_SHA256 = 'cf69adbecbeda6d7de3150a8fc19616bd09c2d9cdc2d0fac5e90d55ae2a2fcd3';
const BATCH_CAP = 20;
const WRITE_BATCH_SIZE = 20;
const AUTHORIZATION_PHRASE = 'AUTHORIZE FINAL RELEASE STEP 3A STAGING SCHOOLS';
const PHASES = new Set(['import', 'activate', 'audit']);

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    expectedCount: 0,
    normalizedHash: '',
    phase: '',
    apply: false,
    authorization: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--expected-count') options.expectedCount = Number(argv[++index]);
    else if (value === '--normalized-hash') options.normalizedHash = String(argv[++index] || '').trim();
    else if (value === '--phase') options.phase = String(argv[++index] || '').trim();
    else if (value === '--authorization') options.authorization = String(argv[++index] || '');
    else if (value === '--apply') options.apply = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function loadLockedSource() {
  const parsed = schoolCore.parseSource();
  const normalized = schoolCore.normalizeSource(parsed);
  const validation = schoolCore.validateSchools(normalized.records, normalized.errors);
  const normalizedHash = schoolCore.normalizedChecksum(normalized.records);
  const disk = JSON.parse(fs.readFileSync(schoolCore.NORMALIZED_JSON_PATH, 'utf8'));
  assert(parsed.checksum === EXPECTED_SOURCE_SHA256, 'immutable XLS checksum drifted', 'SOURCE_CHECKSUM_DRIFT');
  assert(normalizedHash === EXPECTED_NORMALIZED_SHA256, 'normalized checksum drifted', 'NORMALIZED_CHECKSUM_DRIFT');
  assert(normalized.records.length === EXPECTED_COUNT, 'normalized count drifted', 'NORMALIZED_COUNT_DRIFT');
  assert(validation.valid && validation.p0.length === 0, 'normalized source validation failed', 'NORMALIZED_VALIDATION_FAILED');
  assert(JSON.stringify(normalized.records) === JSON.stringify(disk), 'normalized JSON is not the exact XLS-derived output', 'NORMALIZED_JSON_DRIFT');
  return { records: normalized.records, validation, sourceHash: parsed.checksum, normalizedHash };
}

function statusCounts(records) {
  return records.reduce((result, record) => {
    const status = String(record.platformStatus || '<empty>');
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
}

function assess(desired, existing) {
  const desiredIds = new Set(desired.map((record) => record._id));
  const extras = existing.filter((record) => !desiredIds.has(record._id));
  const diff = schoolCore.diffSchools(desired, existing);
  return {
    extras,
    diff,
    statuses: statusCounts(existing),
    active: existing.filter((record) => record.platformStatus === 'active'),
    pending: existing.filter((record) => record.platformStatus === 'pending'),
    invalidStatus: existing.filter((record) => !['active', 'pending'].includes(record.platformStatus))
  };
}

function assertInventorySafe(assessment) {
  assert(assessment.extras.length === 0, 'staging contains schools outside the locked nationwide dataset', 'STAGING_EXTRA_SCHOOLS');
  assert(assessment.diff.conflicts.length === 0, 'staging school identity conflicts exist', 'STAGING_SCHOOL_CONFLICT');
  assert(assessment.diff.updates.length === 0, 'staging official school fields differ from normalized JSON', 'STAGING_OFFICIAL_FIELD_DRIFT');
  assert(assessment.invalidStatus.length === 0, 'staging school status is outside active/pending', 'STAGING_STATUS_DRIFT');
}

function chunk(values, size) {
  const batches = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}

function buildActivationCommand(records) {
  assert(records.length >= 1 && records.length <= BATCH_CAP, 'activation batch cap exceeded', 'ACTIVATION_BATCH_LIMIT');
  return {
    TableName: 'schools',
    CommandType: 'UPDATE',
    Command: JSON.stringify({
      update: 'schools',
      updates: [{
        q: {
          _id: { $in: records.map((record) => record._id) },
          officialStatus: 'valid',
          platformStatus: 'pending'
        },
        u: {
          $set: {
            platformStatus: 'active',
            platformStatusPrevious: 'pending',
            platformStatusReason: 'final_release_step_3a_staging_nationwide_validation',
            platformStatusOperationId: `step3a-${EXPECTED_NORMALIZED_SHA256.slice(0, 16)}`,
            platformStatusToolVersion: '1.0.0'
          },
          $currentDate: {
            activatedAt: true,
            platformStatusUpdatedAt: true,
            updatedAt: true
          }
        },
        multi: true,
        upsert: false
      }],
      ordered: true
    })
  };
}

function activateBatches(environmentId, pending) {
  let activated = 0;
  const batches = chunk(pending, WRITE_BATCH_SIZE);
  batches.forEach((batch, index) => {
    runNoSql(environmentId, [buildActivationCommand(batch)]);
    activated += batch.length;
    process.stderr.write(`[STEP3A][STAGING] activation batch ${index + 1}/${batches.length} submitted (${activated}/${pending.length})\n`);
  });
  return activated;
}

function insertPendingBatches(environmentId, additions) {
  let inserted = 0;
  const batches = chunk(additions, WRITE_BATCH_SIZE);
  batches.forEach((batch, index) => {
    insertDocuments(environmentId, 'schools', batch.map((record) => ({
      ...record,
      platformStatus: 'pending'
    })));
    inserted += batch.length;
    process.stderr.write(`[STEP3A][STAGING] import batch ${index + 1}/${batches.length} submitted (${inserted}/${additions.length})\n`);
  });
  return inserted;
}

function run(options) {
  assert(options.environmentName === 'staging', '--env staging is required', 'PRODUCTION_WRITE_REJECTED');
  assert(PHASES.has(options.phase), '--phase import|activate|audit is required', 'PHASE_REQUIRED');
  assert(options.expectedCount === EXPECTED_COUNT, `--expected-count ${EXPECTED_COUNT} is required`, 'COUNT_LOCK_REQUIRED');
  assert(options.normalizedHash === EXPECTED_NORMALIZED_SHA256, 'exact --normalized-hash lock is required', 'CHECKSUM_LOCK_REQUIRED');
  if (options.apply) {
    assert(options.phase !== 'audit', 'audit phase is read-only', 'INVALID_ARGUMENT');
    assert(options.authorization === AUTHORIZATION_PHRASE, 'exact staging authorization phrase is required', 'AUTHORIZATION_REQUIRED');
  }
  const preflight = runPreflight({
    environmentName: 'staging',
    action: options.apply ? 'seed' : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !options.apply,
    allowInactiveStagingWrite: options.apply
  });
  assert(preflight.environmentName === 'staging', 'production is forbidden', 'PRODUCTION_WRITE_REJECTED');
  const source = loadLockedSource();
  let existing = readAllSchools(preflight.environmentId, 4000);
  let assessment = assess(source.records, existing);
  assertInventorySafe(assessment);

  if (!options.apply) {
    return {
      mode: 'dry-run',
      phase: options.phase,
      environment: publicSummary(preflight),
      sourceCount: source.records.length,
      sourceSha256: source.sourceHash,
      normalizedSha256: source.normalizedHash,
      existingCount: existing.length,
      statusCounts: assessment.statuses,
      wouldInsertPending: assessment.diff.additions.length,
      wouldActivate: assessment.pending.length + assessment.diff.additions.length,
      batchCap: BATCH_CAP,
      writeBatchSize: WRITE_BATCH_SIZE,
      exactOfficialFields: assessment.diff.updates.length === 0,
      productionWrites: 0,
      productWrites: 0
    };
  }

  let inserted = 0;
  let activated = 0;
  if (options.phase === 'import') {
    inserted = insertPendingBatches(preflight.environmentId, assessment.diff.additions);
  } else {
    assert(existing.length === EXPECTED_COUNT && assessment.diff.additions.length === 0, 'activation requires all 2952 schools imported first', 'STAGING_IMPORT_INCOMPLETE');
    activated = activateBatches(preflight.environmentId, assessment.pending);
  }

  existing = readAllSchools(preflight.environmentId, 4000);
  assessment = assess(source.records, existing);
  assertInventorySafe(assessment);
  assert(existing.length === EXPECTED_COUNT, 'post-write staging count is not 2952', 'STAGING_COUNT_MISMATCH');
  if (options.phase === 'activate') {
    assert(assessment.active.length === EXPECTED_COUNT && assessment.pending.length === 0, 'staging nationwide activation is incomplete', 'STAGING_ACTIVATION_INCOMPLETE');
  }
  return {
    mode: 'applied-and-verified',
    phase: options.phase,
    environment: publicSummary(preflight),
    inserted,
    activated,
    count: existing.length,
    statusCounts: assessment.statuses,
    normalizedSha256: source.normalizedHash,
    exactOfficialFields: true,
    batchCap: BATCH_CAP,
    writeBatchSize: WRITE_BATCH_SIZE,
    productionWrites: 0,
    productWrites: 0
  };
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    let message = String(error && error.message || error);
    try {
      const targets = require('../config/cloud.targets.private');
      for (const id of Object.values(targets).filter(Boolean)) message = message.split(id).join(maskIdentifier(id));
    } catch (ignored) {
      // Private target configuration failures are already fail-closed.
    }
    process.stderr.write(`${error.code || 'STEP3A_STAGING_SCHOOLS_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  EXPECTED_COUNT,
  EXPECTED_SOURCE_SHA256,
  EXPECTED_NORMALIZED_SHA256,
  BATCH_CAP,
  WRITE_BATCH_SIZE,
  AUTHORIZATION_PHRASE,
  parseArguments,
  loadLockedSource,
  statusCounts,
  assess,
  assertInventorySafe,
  buildActivationCommand,
  insertPendingBatches,
  run
};
