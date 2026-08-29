const {
  EXPECTED_TOTAL,
  EXPECTED_TARGET_COUNT,
  EXPECTED_NORMALIZED_SHA256,
  BEFORE_PATH,
  MANIFEST_PATH,
  sha256,
  officialProjection,
  validateSource,
  compareProductionSchools,
  assertProductionIntegrity,
  readAllSchools,
  readBusinessSnapshot,
  readUserProtection,
  functionSummary,
  allFunctionSummaries,
  readIndexes,
  gitSummary,
  safeWriteJson,
  publicSummary,
  assert
} = require('./final-release-step-3b-core');
const { runPreflight, maskIdentifier } = require('./environment-preflight');

function parseArguments(argv) {
  const options = { environmentName: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (['--write', '--apply', '--execute', '--deploy'].includes(value)) {
      throw Object.assign(new Error(`${value} is forbidden in the snapshot builder`), { code: 'WRITE_MODE_FORBIDDEN' });
    } else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

async function run(options) {
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  const preflight = runPreflight({ environmentName: 'production', action: 'audit' });
  assert(preflight.activeTargetMatches && preflight.targetsDistinct && !preflight.write, 'production preflight failed', 'PRODUCTION_PREFLIGHT_FAILED');
  const { result: source, records: normalized } = validateSource();
  const schools = readAllSchools(preflight.environmentId);
  const integrity = compareProductionSchools(normalized, schools);
  assertProductionIntegrity(integrity);
  assert(Number(integrity.statusCounts.active || 0) === 2, 'production active school count drifted', 'PRODUCTION_STATUS_DRIFT');
  assert(Number(integrity.statusCounts.pending || 0) === EXPECTED_TARGET_COUNT, 'production pending school count drifted', 'PRODUCTION_STATUS_DRIFT');
  const targets = schools.filter((record) => record.platformStatus === 'pending').sort((a, b) => a._id.localeCompare(b._id));
  assert(targets.length === EXPECTED_TARGET_COUNT, 'activation target count drifted', 'ACTIVATION_TARGET_DRIFT');
  assert(targets.every((record) => record.officialStatus === 'valid'), 'activation target includes invalid official status', 'ACTIVATION_TARGET_DRIFT');
  const targetIds = targets.map((record) => record._id);
  const targetIdSha256 = sha256(targetIds.join('\n'));
  const business = readBusinessSnapshot(preflight.environmentId);
  const users = readUserProtection(preflight.environmentId);
  assert(users.count === 8, 'production user count drifted', 'PRODUCTION_USER_COUNT_DRIFT');
  const indexes = await readIndexes(preflight.environmentId, 'schools');
  const schoolQuery = functionSummary(preflight.environmentId);
  const functions = allFunctionSummaries(preflight.environmentId);
  assert(Object.values(functions).every((item) => item.status === 'Active' && item.availableStatus === 'Available'), 'one or more production functions are unavailable', 'PRODUCTION_FUNCTION_UNAVAILABLE');
  assert(schoolQuery.status === 'Active' && schoolQuery.availableStatus === 'Available', 'production schoolQuery unavailable', 'SCHOOL_QUERY_UNAVAILABLE');
  const generatedAt = new Date().toISOString();
  const snapshot = {
    schemaVersion: 1,
    mode: 'FINAL_RELEASE_STEP_3B_BEFORE_ACTIVATION',
    generatedAt,
    environment: publicSummary(preflight),
    source,
    schools: {
      total: schools.length,
      allIdSha256: sha256(schools.map((record) => record._id).sort().join('\n')),
      targetCount: targets.length,
      targetIdSha256,
      statusCounts: integrity.statusCounts,
      officialFieldChecksum: integrity.officialFieldChecksumProduction,
      integrity,
      records: schools.map((record) => ({
        _id: record._id,
        officialCode: record.officialCode,
        officialStatus: record.officialStatus,
        platformStatus: record.platformStatus,
        officialFieldSha256: sha256(JSON.stringify(officialProjection(record)))
      }))
    },
    existingUsers: users,
    business,
    indexes,
    schoolQuery,
    functions,
    git: gitSummary(),
    publicMarketZero: business.products.publicMarketZero
  };
  const manifest = {
    schemaVersion: 1,
    mode: 'FINAL_RELEASE_STEP_3B_ACTIVATION_MANIFEST',
    generatedAt,
    environment: publicSummary(preflight),
    sourceSha256: source.sourceSha256,
    normalizedSha256: EXPECTED_NORMALIZED_SHA256,
    officialFieldChecksum: integrity.officialFieldChecksumProduction,
    allSchoolIdSha256: snapshot.schools.allIdSha256,
    targetCount: targets.length,
    targetIdSha256,
    targetStatus: 'pending',
    targetOfficialStatus: 'valid',
    mutation: { from: 'pending', to: 'active', allowedFields: ['platformStatus', 'updatedAt'] },
    targets: targets.map((record) => ({
      _id: record._id,
      officialCode: record.officialCode,
      officialFieldSha256: sha256(JSON.stringify(officialProjection(record)))
    })),
    safeToApply: true,
    issues: []
  };
  assert(snapshot.schools.total === EXPECTED_TOTAL, 'snapshot total drifted', 'ACTIVATION_SNAPSHOT_INVALID');
  assert(manifest.targetCount === EXPECTED_TARGET_COUNT && manifest.targets.length === EXPECTED_TARGET_COUNT, 'manifest target count drifted', 'ACTIVATION_MANIFEST_INVALID');
  safeWriteJson(BEFORE_PATH, snapshot);
  safeWriteJson(MANIFEST_PATH, manifest);
  return {
    mode: 'dry-run-private-snapshot-created',
    environment: publicSummary(preflight),
    source,
    schools: {
      total: snapshot.schools.total,
      statusCounts: snapshot.schools.statusCounts,
      officialFieldDrift: integrity.different,
      targetCount: manifest.targetCount,
      targetIdSha256
    },
    users: { count: users.count, protectedSha256: users.protectedSha256 },
    products: business.products,
    schoolQuery,
    indexNames: indexes.map((index) => index.name),
    git: snapshot.git,
    safeToApply: manifest.safeToApply,
    issues: manifest.issues,
    privateOutputs: [
      'tmp/final-release-step-3b-before-activation.json',
      'tmp/final-release-step-3b-activation-manifest.json'
    ]
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    let message = String(error && error.message || error);
    try {
      const targets = require('../config/cloud.targets.private');
      for (const id of Object.values(targets).filter(Boolean)) message = message.split(id).join(maskIdentifier(id));
    } catch (ignored) {
      // Environment configuration failures are already fail-closed.
    }
    process.stderr.write(`${error.code || 'STEP3B_PREPARE_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, run };
