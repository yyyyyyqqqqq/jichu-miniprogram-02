const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const staging = require('./prepare-final-release-step-3a-staging-schools');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const source = staging.loadLockedSource();
assert.strictEqual(source.records.length, 2952);
assert.strictEqual(source.normalizedHash, staging.EXPECTED_NORMALIZED_SHA256);

const pending = source.records.slice(0, 20).map((record) => ({ ...record, platformStatus: 'pending' }));
const command = staging.buildActivationCommand(pending);
const body = JSON.parse(command.Command);
assert.strictEqual(command.TableName, 'schools');
assert.strictEqual(command.CommandType, 'UPDATE');
assert.strictEqual(body.updates.length, 1);
assert.strictEqual(body.updates[0].q._id.$in.length, 20);
assert(
  body.updates[0].multi === true
  && body.updates[0].upsert === false
  && body.updates[0].q.platformStatus === 'pending'
  && body.updates[0].q.officialStatus === 'valid'
  && body.updates[0].u.$set.platformStatus === 'active'
);
assert.throws(() => staging.buildActivationCommand(source.records.slice(0, 21)), /batch cap/i);

const active = source.records.map((record) => ({ ...record, platformStatus: 'active' }));
const assessment = staging.assess(source.records, active);
staging.assertInventorySafe(assessment);
assert.strictEqual(assessment.active.length, 2952);
assert.strictEqual(assessment.pending.length, 0);

const page = read('pages/school-select/index.js');
const template = read('pages/school-select/index.wxml');
const query = read('cloudfunctions/schoolQuery/index.js');
assert(/MAX_RETAINED_SCHOOLS\s*=\s*100/.test(page));
assert(/SCHOOL_PAGE_SIZE\s*=\s*20/.test(page));
assert(/seenCursors/.test(page) && /requestVersion/.test(page));
assert(/onReachBottom/.test(page) && /onLoadMore/.test(page));
assert(/keyword,\s*province,\s*pageSize/.test(page));
assert(/bindchange="onProvinceChange"/.test(template));
assert(/SCHOOL_QUERY_CURSOR_HMAC_SECRET/.test(query));
assert(/timingSafeEqual/.test(query));
assert(!/\.skip\s*\(/.test(query));

assert.throws(() => staging.run({
  environmentName: 'production',
  phase: 'audit',
  expectedCount: 2952,
  normalizedHash: staging.EXPECTED_NORMALIZED_SHA256
}), /staging|required|forbidden/i);

process.stdout.write('Final Release Step 3A verification passed.\n');
