const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('./phase-18-data-migration-core');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function check(value, message) {
  assert(value, message);
  checks += 1;
}

const options = core.parseArguments([]);
check(options.apply === false, 'migration default is not dry-run');
check(options.confirmTarget === '', 'migration default unexpectedly confirms an environment');
check(options.output === core.PRIVATE_RESULT_PATH, 'migration private output path changed');
check(core.parseArguments(['--confirm-target', 'cloud***']).confirmTarget === 'cloud***', 'target confirmation parsing failed');
check(core.parseArguments(['--apply']).apply === true, 'apply parsing failed');
assert.throws(() => core.parseArguments(['--unknown']));
checks += 1;

check(core.TARGET_SCHOOL_NAME === '上海工程技术大学', 'authorized target school changed');
check(core.EXPECTED_MISSING_USERS === 4, 'user expected-count gate changed');
check(core.EXPECTED_PUBLIC_PRODUCTS === 20, 'product expected-count gate changed');
check(!Object.prototype.hasOwnProperty.call(core.USER_PROJECTION, 'openid'), 'user projection exposes openid');
check(!Object.prototype.hasOwnProperty.call(core.USER_PROJECTION, '_openid'), 'user projection exposes _openid');

const baseUser = {
  status: 'active',
  profileCompleted: true,
  nickname: '用户',
  avatarUrl: 'cloud://avatar',
  schoolSelectedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  schoolId: '',
  schoolName: '',
  schoolVersion: 0,
  updatedAt: '2026-01-02T00:00:00.000Z'
};
const userFingerprint = core.userProtectedFingerprint(baseUser);
check(
  userFingerprint === core.userProtectedFingerprint({
    ...baseUser,
    schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    schoolName: '上海工程技术大学',
    schoolVersion: 1,
    schoolUpdatedAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z'
  }),
  'allowed user school fields affect the protected fingerprint'
);
check(
  userFingerprint !== core.userProtectedFingerprint({ ...baseUser, status: 'disabled' }),
  'user status is not protected'
);
check(
  userFingerprint !== core.userProtectedFingerprint({ ...baseUser, nickname: '被修改' }),
  'user profile is not protected'
);

const coreSource = fs.readFileSync(path.join(ROOT, 'scripts', 'phase-18-data-migration-core.js'), 'utf8');
const userSource = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate-phase-18-missing-user-schools.js'), 'utf8');
check(/targetMatches\.length === 1/.test(coreSource), 'target school uniqueness is not enforced');
check(/platformStatus === 'active'/.test(coreSource) && /officialStatus === 'valid'/.test(coreSource), 'target school validity is not enforced');
check(/status === 'active'/.test(coreSource) && /state === 'missing'/.test(coreSource), 'missing active user selection is not explicit');
check(/actualCount: plan\.length/.test(userSource), 'user dry-run count is not recorded');
check(/run user migration dry-run before apply/.test(userSource), 'user apply does not require a private dry-run plan');
check(/multi:\s*false/.test(userSource) && /upsert:\s*false/.test(userSource), 'user migration write is multi or upsert');
check(/schoolVersion:\s*1/.test(userSource), 'first school binding version semantics are missing');
check(/\$currentDate:[\s\S]*schoolUpdatedAt:\s*true[\s\S]*updatedAt:\s*true/.test(userSource), 'user migration timestamps are incomplete');
check(!/\$set:[\s\S]{0,300}schoolSelectedAt/.test(userSource), 'user migration fabricates schoolSelectedAt');
check(!/updateMany|multi:\s*true|upsert:\s*true/.test(userSource), 'user migration contains a broad write');
check(!/openid\s*:|_openid\s*:/.test(userSource), 'user migration records or writes openid');
check(/idempotentChangedCount:\s*0/.test(userSource), 'user migration idempotency result is missing');

process.stdout.write(`Phase 18 data migration verification succeeded: ${checks} checks passed.\n`);
