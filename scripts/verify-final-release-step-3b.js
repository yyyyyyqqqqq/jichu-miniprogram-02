const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  EXPECTED_XLS_SHA256,
  EXPECTED_NORMALIZED_SHA256,
  EXPECTED_TOTAL,
  EXPECTED_TARGET_COUNT,
  AUTHORIZATION_PHRASE,
  REQUIRED_INDEXES,
  validateSource
} = require('./final-release-step-3b-core');
const {
  BATCH_SIZE,
  buildUpdateCommand
} = require('./final-release-step-3b-production-activation');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const { result: source } = validateSource();
check(source.sourceSha256 === EXPECTED_XLS_SHA256, 'XLS checksum lock failed');
check(source.normalizedSha256 === EXPECTED_NORMALIZED_SHA256, 'normalized checksum lock failed');
check(source.records === EXPECTED_TOTAL, 'source count lock failed');
check(source.missing === 0 && source.extra === 0 && source.different === 0, 'source reconstruction drifted');
check(source.duplicateId === 0 && source.duplicateOfficialCode === 0 && source.duplicateNormalizedName === 0, 'source duplicate gate failed');
check(source.requiredMissing === 0 && source.p0 === 0 && source.p1 === 0, 'source validation gate failed');
check(EXPECTED_TARGET_COUNT === 2950 && BATCH_SIZE > 0 && BATCH_SIZE <= 20, 'activation count or batch cap drifted');
check(AUTHORIZATION_PHRASE === 'FINAL RELEASE STEP 3B PRODUCTION NATIONWIDE SCHOOL ACTIVATION', 'authorization phrase drifted');
check(REQUIRED_INDEXES.length === 3, 'required index count drifted');
check(REQUIRED_INDEXES.some((item) => item.name === 'idx_officialCode_unique' && item.unique), 'officialCode unique index missing');
check(REQUIRED_INDEXES.some((item) => item.name === 'idx_school_active_name_id'), 'active name index missing');
check(REQUIRED_INDEXES.some((item) => item.name === 'idx_school_active_province_name_id'), 'active province index missing');

const target = (index) => ({
  _id: `s_${String(index).padStart(32, '0')}`,
  officialCode: String(4100000000 + index),
  officialFieldSha256: 'a'.repeat(64)
});
const command = buildUpdateCommand(Array.from({ length: BATCH_SIZE }, (_, index) => target(index + 1)));
const body = JSON.parse(command.Command);
check(command.CommandType === 'UPDATE' && command.TableName === 'schools', 'runner command scope drifted');
check(body.update === 'schools' && body.updates.length === BATCH_SIZE && body.ordered === true, 'runner batch shape drifted');
check(body.updates.every((item) => (
  typeof item.q._id === 'string'
  && typeof item.q.officialCode === 'string'
  && item.q.officialStatus === 'valid'
  && item.q.platformStatus === 'pending'
  && item.u.$set.platformStatus === 'active'
  && Object.keys(item.u.$set).length === 1
  && item.u.$currentDate.updatedAt === true
  && Object.keys(item.u.$currentDate).length === 1
  && item.multi === false
  && item.upsert === false
)), 'runner mutation is broader than pending -> active + updatedAt');
check(!/(insert|remove|delete|drop)/i.test(command.Command), 'runner contains forbidden mutation primitive');
assert.throws(() => buildUpdateCommand(Array.from({ length: BATCH_SIZE + 1 }, (_, index) => target(index + 1))), /activation batch/);
checks += 1;

const runnerSource = fs.readFileSync(path.join(ROOT, 'scripts', 'final-release-step-3b-production-activation.js'), 'utf8');
const deploySource = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy-final-release-step-3b-school-query.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-final-release-step-3b-production-indexes.js'), 'utf8');
check(/--expected-target-count/.test(runnerSource) && /--expected-target-id-hash/.test(runnerSource), 'runner exact confirmation gates missing');
check(/normalized-checksum/.test(runnerSource) && /MANIFEST_PATH_REJECTED/.test(runnerSource), 'runner checksum or manifest gate missing');
check(/allowProductionWrite: options\.write/.test(runnerSource), 'runner production write preflight missing');
check(/state\.inFlight/.test(runnerSource) && /ACTIVATION_INFLIGHT_UNRESOLVED/.test(runnerSource), 'runner in-flight reconciliation gate missing');
check(/production-secret-configured-and-verified/.test(deploySource), 'secret configuration verification missing');
check(/sourceUnchanged: true/.test(deploySource), 'secret-only configuration source guard missing');
check(/staging\.sourceSha256 === localSourceSha256/.test(deploySource), 'staging approved source hash gate missing');
check(/createIndexes\(preflight\.environmentId, 'schools', \[definition\]\)/.test(indexSource), 'indexes are not created sequentially');
check(/waitUntilOperational/.test(indexSource) && /querySmoke/.test(indexSource), 'index readiness/query smoke missing');

process.stdout.write(`Final Release Step 3B verification succeeded: ${checks} checks passed.\n`);
