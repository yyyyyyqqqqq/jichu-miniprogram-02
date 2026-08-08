const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  readFunctionDetail,
  queryCollection,
  assert
} = require('./phase-18-canary-core');
const {
  loadDualAccountPrivate,
  maskId
} = require('./phase-18-dual-account-core');
const {
  FINAL_CONFIG,
  sourceConfig,
  assertConfig,
  environmentMap
} = require('./phase-18-final-cutover-core');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function verify() {
  const environmentId = loadEnvironmentId();
  const privateData = loadDualAccountPrivate();
  assert(privateData.accountA.schoolId !== privateData.accountB.schoolId, 'account schools must differ');
  const sourcePath = path.join(ROOT, 'cloudfunctions', 'productQuery', 'index.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  assertConfig(sourceConfig(source), FINAL_CONFIG, 'final source');

  const detail = readFunctionDetail(environmentId, 'productQuery');
  const environment = environmentMap(detail);
  assert(detail.Status === 'Active', 'productQuery is not Active');
  assert(detail.Runtime === 'Nodejs16.13' && detail.Handler === 'index.main', 'productQuery runtime/handler changed');
  assert(Number(detail.Timeout) === 10 && Number(detail.MemorySize) === 256, 'productQuery resources changed');
  assert(sha256(String(detail.CodeInfo || '')) === sha256(source), 'local and remote productQuery hashes differ');
  assert((environment.PRODUCT_QUERY_CURSOR_HMAC_SECRET || '').length >= 32, 'cursor HMAC environment is invalid');
  assert(environment.PRODUCT_SEED_ENABLED === 'false', 'product seed must remain disabled');

  const userIds = [privateData.accountA.userId, privateData.accountB.userId];
  const users = queryCollection(environmentId, 'users', {
    filter: { _id: { $in: userIds } },
    projection: {
      _id: 1,
      status: 1,
      profileCompleted: 1,
      schoolId: 1,
      schoolName: 1,
      schoolVersion: 1
    },
    limit: 10
  });
  assert(users.length === 2, 'authoritative users A/B were not both found');
  for (const account of [privateData.accountA, privateData.accountB]) {
    const user = users.find((item) => item._id === account.userId);
    assert(user && user.status === 'active' && user.profileCompleted === true, 'account is not active/profile-complete');
    assert(user.schoolId === account.schoolId && user.schoolName === account.schoolName, 'private account school is stale');
    const schools = queryCollection(environmentId, 'schools', {
      filter: { _id: account.schoolId },
      projection: { _id: 1, name: 1, platformStatus: 1, officialStatus: 1 },
      limit: 2
    });
    assert(schools.length === 1, 'authoritative school does not resolve uniquely');
    assert(schools[0].name === account.schoolName, 'authoritative school name differs');
    assert(
      schools[0].platformStatus === 'active' && schools[0].officialStatus === 'valid',
      'authoritative school is not active/valid'
    );
  }

  const publicWithoutSchool = queryCollection(environmentId, 'products', {
    filter: {
      status: { $in: ['available', 'reserved'] },
      $or: [{ schoolId: { $exists: false } }, { schoolId: '' }, { schoolId: null }]
    },
    projection: { _id: 1 },
    limit: 5
  });
  assert(publicWithoutSchool.length === 0, 'public product without school still exists');
  return {
    passed: true,
    checks: 18,
    allowlistCount: 0,
    strictForAll: true,
    accessRequiresAuth: true,
    accounts: [privateData.accountA, privateData.accountB].map((account) => ({
      userId: maskId(account.userId),
      schoolId: maskId(account.schoolId),
      schoolName: account.schoolName,
      status: account.status,
      profileCompleted: account.profileCompleted
    })),
    schoolsDiffer: true,
    productQueryActive: true,
    localRemoteHashMatches: true,
    cursorHmacPreserved: true,
    productSeedEnabled: false,
    publicWithoutSchool: 0
  };
}

try {
  process.stdout.write(`${JSON.stringify(verify(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.code || 'PHASE18_DUAL_ACCOUNT_VERIFY_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
}
