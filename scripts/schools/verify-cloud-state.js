const fs = require('fs');
const path = require('path');
const {
  NORMALIZED_JSON_PATH,
  REPORT_DIR,
  stableJson
} = require('./core');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  readAllSchools
} = require('./cloud-cli');
const {
  maskSchoolId
} = require('./set-platform-status');

const TARGET_NAMES = ['上海工程技术大学', '上海财经大学浙江学院'];
const EXPECTED_OPERATION_ID = 'school-status-d0bb73feb64b8ba9b7b31d0a';
const OFFICIAL_FIELDS = [
  '_id',
  'officialCode',
  'name',
  'nameNormalized',
  'province',
  'city',
  'educationLevel',
  'authority',
  'remark',
  'officialStatus',
  'dataSource',
  'sourceYear',
  'sourceVersion',
  'sourceRow'
];

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = 'CLOUD_STATE_VERIFICATION_FAILED';
    throw error;
  }
}

function countBy(records, field) {
  return records.reduce((counts, record) => {
    const value = record[field] || 'missing';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function duplicateValues(records, field) {
  const counts = countBy(records, field);
  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }));
}

function main() {
  const environmentId = loadEnvironmentId();
  const normalized = JSON.parse(fs.readFileSync(NORMALIZED_JSON_PATH, 'utf8'));
  const cloud = readAllSchools(environmentId);
  const statusCounts = countBy(cloud, 'platformStatus');
  const duplicateIds = duplicateValues(cloud, '_id');
  const duplicateCodes = duplicateValues(cloud, 'officialCode');
  const legacyNoteCount = cloud.filter(
    (record) => Object.prototype.hasOwnProperty.call(record, 'note')
  ).length;
  const targets = TARGET_NAMES.map((name) => {
    const expected = normalized.find((record) => record.name === name);
    const actual = cloud.find((record) => record.name === name);
    assert(expected && actual, `target school missing: ${name}`);
    const changedOfficialFields = OFFICIAL_FIELDS.filter((field) => (
      (expected[field] === undefined ? null : expected[field])
      !== (actual[field] === undefined ? null : actual[field])
    ));
    return {
      schoolId: maskSchoolId(actual._id),
      officialCode: actual.officialCode,
      name: actual.name,
      province: actual.province,
      city: actual.city,
      educationLevel: actual.educationLevel,
      officialStatus: actual.officialStatus,
      platformStatus: actual.platformStatus,
      deterministicIdUnchanged: actual._id === expected._id,
      changedOfficialFields,
      operationId: actual.platformStatusOperationId,
      previousStatus: actual.platformStatusPrevious,
      reason: actual.platformStatusReason,
      toolVersion: actual.platformStatusToolVersion,
      hasUpdatedAt: Boolean(actual.updatedAt),
      hasPlatformStatusUpdatedAt: Boolean(actual.platformStatusUpdatedAt),
      hasActivatedAt: Boolean(actual.activatedAt)
    };
  });
  const report = {
    target: `cloud:${maskEnvironmentId(environmentId)}`,
    total: cloud.length,
    statusCounts: {
      pending: statusCounts.pending || 0,
      active: statusCounts.active || 0,
      inactive: statusCounts.inactive || 0,
      merged: statusCounts.merged || 0
    },
    uniqueIds: duplicateIds.length === 0,
    uniqueOfficialCodes: duplicateCodes.length === 0,
    duplicateIds,
    duplicateOfficialCodes: duplicateCodes,
    legacyNoteCount,
    remarkFieldUnified: legacyNoteCount === 0,
    targets
  };
  assert(report.total === 2952, 'cloud school count changed');
  assert(report.statusCounts.active === 2, 'active school count is not 2');
  assert(report.statusCounts.pending === 2950, 'pending school count is not 2950');
  assert(report.statusCounts.inactive === 0 && report.statusCounts.merged === 0, 'unexpected inactive or merged schools');
  assert(report.uniqueIds && report.uniqueOfficialCodes, 'cloud school identifiers are not unique');
  assert(report.legacyNoteCount === 0, 'legacy note field exists in cloud schools');
  assert(targets.every((record) => (
    record.officialStatus === 'valid'
    && record.platformStatus === 'active'
    && record.deterministicIdUnchanged
    && record.changedOfficialFields.length === 0
    && record.operationId === EXPECTED_OPERATION_ID
    && record.previousStatus === 'pending'
    && record.hasUpdatedAt
    && record.hasPlatformStatusUpdatedAt
    && record.hasActivatedAt
  )), 'target school state or audit verification failed');
  fs.writeFileSync(
    path.join(REPORT_DIR, 'phase-15-cloud-state.json'),
    stableJson(report),
    'utf8'
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code || 'CLOUD_STATE_VERIFICATION_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  countBy,
  duplicateValues
};
