const fs = require('fs');
const path = require('path');
const {
  ROOT,
  USER_ID_PATTERN,
  SCHOOL_ID_PATTERN,
  PRODUCT_ID_PATTERN,
  maskId,
  assert,
  loadJson,
  writePrivateJson
} = require('./phase-18-canary-core');

const PRIVATE_DUAL_ACCOUNT_PATH = path.join(
  ROOT,
  'tmp',
  'phase-18-dual-account-private.json'
);
const FINAL_FIXTURE_PREFIX = '阶段18双账号终验-';

function loadDualAccountPrivate(filePath = PRIVATE_DUAL_ACCOUNT_PATH) {
  assert(fs.existsSync(filePath), 'private dual-account result is missing');
  const value = loadJson(filePath);
  for (const key of ['accountA', 'accountB']) {
    const account = value[key];
    assert(account && USER_ID_PATTERN.test(String(account.userId || '')), `private ${key} userId is invalid`);
    assert(SCHOOL_ID_PATTERN.test(String(account.schoolId || '')), `private ${key} schoolId is invalid`);
    assert(typeof account.schoolName === 'string' && account.schoolName.trim(), `private ${key} schoolName is invalid`);
  }
  assert(value.accountA.userId !== value.accountB.userId, 'dual-account users must differ');
  if (value.fixtureAId) assert(PRODUCT_ID_PATTERN.test(value.fixtureAId), 'fixture A id is invalid');
  if (value.fixtureBId) assert(PRODUCT_ID_PATTERN.test(value.fixtureBId), 'fixture B id is invalid');
  return value;
}

module.exports = {
  PRIVATE_DUAL_ACCOUNT_PATH,
  FINAL_FIXTURE_PREFIX,
  loadDualAccountPrivate,
  maskId,
  assert,
  writePrivateJson
};
