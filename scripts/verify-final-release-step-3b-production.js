const fs = require('fs');
const {
  ROOT,
  EXPECTED_TOTAL,
  EXPECTED_TARGET_COUNT,
  BEFORE_PATH,
  MANIFEST_PATH,
  STATE_PATH,
  FINAL_AUDIT_PATH,
  QUERY_AUDIT_PATH,
  sha256,
  validateSource,
  compareProductionSchools,
  assertProductionIntegrity,
  readAllSchools,
  readBusinessSnapshot,
  readUserProtection,
  functionSummary,
  allFunctionSummaries,
  readIndexes,
  assertRequiredIndexes,
  readJson,
  safeWriteJson,
  publicSummary,
  assert,
  stableStringify
} = require('./final-release-step-3b-core');
const { runPreflight, maskIdentifier } = require('./environment-preflight');

function parseArguments(argv) {
  const options = { environmentName: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

async function run(options) {
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  const preflight = runPreflight({ environmentName: 'production', action: 'audit' });
  const before = readJson(BEFORE_PATH, 'ACTIVATION_SNAPSHOT_MISSING');
  const manifest = readJson(MANIFEST_PATH, 'ACTIVATION_MANIFEST_MISSING');
  const state = readJson(STATE_PATH, 'ACTIVATION_STATE_MISSING');
  const queryAudit = readJson(QUERY_AUDIT_PATH, 'NATIONWIDE_QUERY_AUDIT_MISSING');
  assert(state.finished === true && state.schoolMutations === EXPECTED_TARGET_COUNT && state.completed.length === EXPECTED_TARGET_COUNT, 'activation state is incomplete', 'ACTIVATION_INCOMPLETE');
  assert(state.targetIdSha256 === manifest.targetIdSha256 && state.manifestSha256 === sha256(fs.readFileSync(MANIFEST_PATH)), 'activation state evidence drifted', 'ACTIVATION_STATE_DRIFT');
  assert(new Set(state.completed).size === EXPECTED_TARGET_COUNT, 'activation state has duplicate completed IDs', 'ACTIVATION_STATE_DRIFT');
  const { result: source, records: normalized } = validateSource();
  const schools = readAllSchools(preflight.environmentId);
  const integrity = compareProductionSchools(normalized, schools);
  assertProductionIntegrity(integrity);
  assert(schools.length === EXPECTED_TOTAL, 'final school total drifted', 'FINAL_SCHOOL_COUNT_DRIFT');
  assert(Number(integrity.statusCounts.active || 0) === EXPECTED_TOTAL, 'final active count drifted', 'FINAL_SCHOOL_COUNT_DRIFT');
  assert(Number(integrity.statusCounts.pending || 0) === 0, 'final pending count drifted', 'FINAL_SCHOOL_COUNT_DRIFT');
  assert(sha256(schools.map((record) => record._id).sort().join('\n')) === before.schools.allIdSha256, 'final school ID set drifted', 'FINAL_SCHOOL_ID_DRIFT');

  const business = readBusinessSnapshot(preflight.environmentId);
  for (const [name, summary] of Object.entries(before.business.collections)) {
    assert(business.collections[name].count === summary.count, `${name} count changed`, 'UNEXPECTED_BUSINESS_MUTATION');
    assert(business.collections[name].sha256 === summary.sha256, `${name} changed`, 'UNEXPECTED_BUSINESS_MUTATION');
  }
  const users = readUserProtection(preflight.environmentId);
  assert(users.count === before.existingUsers.count, 'user count changed', 'EXISTING_USER_DRIFT');
  assert(users.fullSha256 === before.existingUsers.fullSha256, 'users changed during activation', 'EXISTING_USER_DRIFT');
  assert(users.protectedSha256 === before.existingUsers.protectedSha256, 'user school protection fields changed', 'EXISTING_USER_DRIFT');
  assert(stableStringify(users.referencesBySchool) === stableStringify(before.existingUsers.referencesBySchool), 'user school references changed', 'EXISTING_USER_DRIFT');

  const indexes = await readIndexes(preflight.environmentId, 'schools');
  assertRequiredIndexes(indexes);
  const schoolQuery = functionSummary(preflight.environmentId);
  const localSourceSha256 = sha256(fs.readFileSync(`${ROOT}/cloudfunctions/schoolQuery/index.js`, 'utf8'));
  assert(schoolQuery.status === 'Active' && schoolQuery.availableStatus === 'Available', 'schoolQuery unavailable', 'SCHOOL_QUERY_UNAVAILABLE');
  assert(schoolQuery.sourceSha256 === localSourceSha256, 'schoolQuery source hash drifted', 'SCHOOL_QUERY_HASH_DRIFT');
  assert(schoolQuery.schoolSecretPresent, 'schoolQuery secret is missing', 'SCHOOL_QUERY_SECRET_MISSING');
  const functions = allFunctionSummaries(preflight.environmentId);
  for (const [name, summary] of Object.entries(before.functions)) {
    if (name === 'schoolQuery') continue;
    assert(stableStringify(functions[name]) === stableStringify(summary), `${name} changed during Step 3B`, 'UNEXPECTED_FUNCTION_MUTATION');
  }
  assert(queryAudit.mode === 'nationwide' && queryAudit.passed === true, 'nationwide query audit failed', 'NATIONWIDE_QUERY_AUDIT_FAILED');
  assert(queryAudit.nationwide.count === EXPECTED_TOTAL && queryAudit.nationwide.duplicate === 0 && queryAudit.nationwide.cursorDuplicate === 0, 'nationwide pagination proof failed', 'NATIONWIDE_QUERY_AUDIT_FAILED');

  const targetIds = new Set(manifest.targets.map((target) => target._id));
  const targetUserReferences = Object.entries(users.referencesBySchool)
    .filter(([schoolId]) => targetIds.has(schoolId))
    .reduce((total, [, count]) => total + Number(count || 0), 0);
  const rollbackReady = targetUserReferences === 0
    && business.products.publicMarketZero
    && Object.entries(before.business.collections).every(([name, summary]) => business.collections[name].sha256 === summary.sha256);
  const report = {
    schemaVersion: 1,
    mode: 'FINAL_RELEASE_STEP_3B_FINAL_AUDIT',
    completedAt: new Date().toISOString(),
    environment: publicSummary(preflight),
    source,
    schoolMutations: state.schoolMutations,
    exactMutationCount: state.schoolMutations === EXPECTED_TARGET_COUNT,
    schoolCounts: {
      total: schools.length,
      active: Number(integrity.statusCounts.active || 0),
      pending: Number(integrity.statusCounts.pending || 0)
    },
    officialFieldDrift: integrity.different,
    identityConflicts: integrity.identityConflicts,
    schoolIdSetUnchanged: true,
    schoolQuery,
    indexes: indexes.map((index) => index.name),
    queryAudit,
    existingUsers: {
      count: users.count,
      changed: false,
      protectedFieldsChanged: false,
      targetSchoolReferences: targetUserReferences
    },
    publicMarket: business.products,
    businessCollectionsChanged: false,
    otherFunctionsChanged: false,
    mutationSummary: {
      schoolPendingToActive: state.schoolMutations,
      schoolInsert: 0,
      schoolRemove: 0,
      officialFieldMutation: 0,
      users: 0,
      products: 0,
      favorites: 0,
      conversations: 0,
      messages: 0,
      appointments: 0,
      productViews: 0,
      otherCloudFunctions: 0,
      acl: 0
    },
    rollbackReadiness: {
      readyForConditionalActiveToPending: rollbackReady,
      targetIdSetPreserved: true,
      beforeStatusSnapshotPreserved: true,
      targetUserReferences,
      businessReferencesChanged: false,
      automaticRollbackExecuted: false
    },
    passed: true
  };
  assert(rollbackReady, 'conditional rollback preconditions are not preserved', 'ROLLBACK_READINESS_FAILED');
  safeWriteJson(FINAL_AUDIT_PATH, report);
  return report;
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
    process.stderr.write(`${error.code || 'STEP3B_FINAL_VERIFY_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, run };
