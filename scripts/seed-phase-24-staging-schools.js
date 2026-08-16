const fs = require('fs');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const {
  sha256,
  queryCollection,
  insertDocuments
} = require('./phase-24-staging-core');

const OFFICIAL_CODE_ALLOWLIST = Object.freeze(['4131010856', '4133014207']);
const EXPECTED_NAMES = Object.freeze({
  '4131010856': '上海工程技术大学',
  '4133014207': '上海财经大学浙江学院'
});
const RECORD_FIELDS = Object.freeze([
  '_id', 'officialCode', 'name', 'nameNormalized', 'province', 'city',
  'educationLevel', 'authority', 'officialStatus', 'platformStatus',
  'dataSource', 'sourceYear', 'sourceVersion', 'sourceRow', 'remark'
]);

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', expectedCount: 0, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--expected-count') options.expectedCount = Number(argv[++index]);
    else if (value === '--apply') options.apply = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function loadDesiredSchools() {
  const filePath = path.join(ROOT, 'data', 'schools', 'generated', 'schools.normalized.json');
  const source = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const selected = source.filter((item) => OFFICIAL_CODE_ALLOWLIST.includes(String(item.officialCode)));
  assert(selected.length === OFFICIAL_CODE_ALLOWLIST.length, 'officialCode allowlist did not select exactly two schools', 'SCHOOL_ALLOWLIST_MISMATCH');
  return OFFICIAL_CODE_ALLOWLIST.map((officialCode) => {
    const sourceRecord = selected.find((item) => String(item.officialCode) === officialCode);
    assert(sourceRecord.name === EXPECTED_NAMES[officialCode], `officialCode ${officialCode} name mismatch`, 'SCHOOL_IDENTITY_MISMATCH');
    assert(sourceRecord.officialStatus === 'valid', `${sourceRecord.name} is not official valid`, 'SCHOOL_STATUS_INVALID');
    const record = Object.fromEntries(RECORD_FIELDS.map((field) => [field, sourceRecord[field]]));
    record.platformStatus = 'active';
    return record;
  });
}

function comparable(record) {
  return Object.fromEntries(RECORD_FIELDS.map((field) => [field, record[field]]));
}

function recordFingerprint(record) {
  return sha256(JSON.stringify(comparable(record))).slice(0, 16);
}

async function run(options) {
  assert(options.expectedCount === 2, '--expected-count 2 is required', 'EXPECTED_COUNT_REQUIRED');
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.apply ? 'seed' : 'audit',
    confirmTarget: options.confirmTarget
  });
  assert(preflight.environmentName === 'staging', 'school seed only supports staging', 'PRODUCTION_WRITE_REJECTED');
  const desired = loadDesiredSchools();
  const existing = queryCollection(preflight.environmentId, 'schools', {}, 10);
  assert(existing.length <= 2, `staging schools contains ${existing.length} records`, 'UNEXPECTED_SCHOOL_COUNT');
  const desiredByCode = new Map(desired.map((item) => [item.officialCode, item]));
  for (const item of existing) {
    const expected = desiredByCode.get(String(item.officialCode));
    assert(expected, 'staging schools contains a non-allowlisted officialCode', 'UNEXPECTED_SCHOOL');
    assert(
      JSON.stringify(comparable(item)) === JSON.stringify(comparable(expected)),
      `${expected.name} differs from the reviewed staging record`,
      'SCHOOL_FIELD_DRIFT'
    );
  }
  const missing = desired.filter((item) => !existing.some((current) => current._id === item._id));
  const publicRecords = desired.map((item) => ({
    officialCode: item.officialCode,
    name: item.name,
    idMasked: `${item._id.slice(0, 8)}***${item._id.slice(-4)}`,
    platformStatus: item.platformStatus,
    officialStatus: item.officialStatus,
    fingerprint: recordFingerprint(item)
  }));
  if (!options.apply) {
    return {
      mode: 'dry-run',
      preflight: publicSummary(preflight),
      expectedCount: 2,
      existingCount: existing.length,
      wouldInsert: missing.length,
      records: publicRecords,
      source: 'data/schools/generated/schools.normalized.json',
      selection: 'fixed-officialCode-allowlist'
    };
  }
  if (missing.length) insertDocuments(preflight.environmentId, 'schools', missing);
  const after = queryCollection(preflight.environmentId, 'schools', {}, 10);
  assert(after.length === 2, `school seed readback count is ${after.length}`, 'SCHOOL_SEED_COUNT_MISMATCH');
  for (const expected of desired) {
    const actual = after.find((item) => item._id === expected._id);
    assert(actual, `${expected.name} readback is missing`, 'SCHOOL_SEED_READBACK_MISSING');
    assert(JSON.stringify(comparable(actual)) === JSON.stringify(comparable(expected)), `${expected.name} readback differs`, 'SCHOOL_SEED_READBACK_DRIFT');
  }
  return {
    mode: missing.length ? 'applied-and-verified' : 'verified-idempotent',
    preflight: publicSummary(preflight),
    inserted: missing.length,
    count: after.length,
    records: publicRecords
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'PHASE24_STAGING_SEED_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  OFFICIAL_CODE_ALLOWLIST,
  EXPECTED_NAMES,
  RECORD_FIELDS,
  parseArguments,
  loadDesiredSchools,
  run
};
