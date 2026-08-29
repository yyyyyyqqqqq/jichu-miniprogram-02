const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tool = require('./final-release-product-cleanup-dry-run');

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert(condition, message);
}

function expectedError(action, code) {
  checks += 1;
  assert.throws(action, (error) => error && error.code === code);
}

function loadMocks() {
  const { PRODUCTS } = require('../mock/products');
  return PRODUCTS.map(tool.normalizeMockProduct);
}

function makeSnapshot() {
  const [schoolA, schoolB] = tool.TARGET_SCHOOLS;
  const mocks = loadMocks();
  const users = Array.from({ length: 19 }, (_, index) => ({
    _id: `u_valid_${index}`,
    openid: `o_valid_${index}`,
    status: 'active'
  }));
  const targets = [];
  for (let index = 0; index < 32; index += 1) {
    if (index < 13) {
      const mock = mocks[index];
      targets.push({
        ...mock,
        schoolId: index < 2 ? schoolA.id : schoolB.id,
        schoolName: index < 2 ? schoolA.name : schoolB.name,
        status: 'available',
        version: 1
      });
    } else {
      const user = users[index - 13];
      targets.push({
        _id: `p_valid_${index}`,
        title: `Phase25 test ${index}`,
        description: 'controlled historical fixture',
        categoryId: 'other',
        price: index,
        sellerId: user._id,
        sellerOpenid: user.openid,
        schoolId: schoolB.id,
        schoolName: schoolB.name,
        status: 'available',
        version: 2
      });
    }
  }
  const make = (prefix, count, status, schoolId) => Array.from({ length: count }, (_, index) => ({
    _id: `${prefix}_${index}`,
    status,
    schoolId,
    version: 1
  }));
  return {
    schools: [
      { _id: schoolA.id, name: schoolA.name, platformStatus: 'active' },
      { _id: schoolB.id, name: schoolB.name, platformStatus: 'active' },
      { _id: 's_pending', name: '待开放学校', platformStatus: 'pending' }
    ],
    users,
    products: [
      ...targets,
      ...make('a_offline', 8, 'offline', schoolA.id),
      ...make('b_offline', 14, 'offline', schoolB.id),
      ...make('b_sold', 1, 'sold', schoolB.id),
      ...make('b_deleted', 1, 'deleted', schoolB.id),
      ...make('legacy_offline', 3, 'offline', ''),
      ...make('legacy_sold', 11, 'sold', ''),
      ...make('legacy_deleted', 2, 'deleted', '')
    ],
    favorites: [{ _id: 'f1', productId: targets[0]._id }],
    conversations: [{ _id: 'c1', productId: targets[0]._id, status: 'active' }],
    messages: [{ _id: 'm1', productId: targets[0]._id, product: { productId: targets[0]._id } }],
    appointments: [{ _id: 'a1', productId: targets[0]._id }],
    productViews: [{ _id: 'v1', productId: targets[0]._id }]
  };
}

function environment() {
  return {
    label: '[ENV] PRODUCTION',
    environmentName: 'production',
    environmentId: 'production-environment',
    environmentIdMasked: 'produc***ment',
    appId: 'wx-test-app',
    appIdMasked: 'wx-tes***-app',
    action: 'audit',
    write: false,
    activeTargetMatches: true,
    targetsDistinct: true
  };
}

expectedError(() => tool.parseArguments([]), 'PRODUCTION_TARGET_REQUIRED');
expectedError(() => tool.parseArguments(['--env', 'staging']), 'PRODUCTION_TARGET_REQUIRED');
for (const flag of ['--write', '--apply', '--execute', '--allow-production-write']) {
  expectedError(() => tool.parseArguments(['--env', 'production', flag]), 'WRITE_MODE_FORBIDDEN');
}
expectedError(() => tool.parseArguments(['--env', 'production', '--unknown']), 'INVALID_ARGUMENT');
check(tool.parseArguments(['--env', 'production']).write === false, 'write must always be false');

const snapshot = makeSnapshot();
const manifest = tool.buildManifest(snapshot, environment(), loadMocks(), '2026-08-25T00:00:00.000Z');
check(manifest.write === false, 'manifest is not zero-write');
check(manifest.safeToApply === true, `valid snapshot was rejected: ${manifest.issues.join(', ')}`);
check(manifest.cleanupTarget.targetAvailableCount === 32, 'target count lock is wrong');
check(manifest.cleanupTarget.invalidSellerCount === 13, 'invalid seller count is wrong');
check(manifest.cleanupTarget.perProduct.filter((item) => item.origin === 'seed/mock').length === 13, 'mock origin classification failed');
check(manifest.expectedPostState.productsTotal === 72, 'post-state product count changed');
check(manifest.expectedPostState.availableTotal === 0, 'post-state available count is not zero');
check(manifest.expectedPostState.statusCounts.offline === 57, 'post-state offline count is wrong');
check(manifest.cleanupTarget.relationTotals.activeConversations === 1, 'active conversation relation was not counted');
check(manifest.cleanupTarget.relationTotals.directProductMessages === 1, 'direct message relation was not counted');
check(manifest.cleanupTarget.relationTotals.productContextOrCardMessages === 1, 'product card relation was not counted');

const countDrift = makeSnapshot();
countDrift.products.find((item) => item.status === 'available').status = 'offline';
check(tool.buildManifest(countDrift, environment(), loadMocks()).safeToApply === false, 'target count drift did not fail closed');

const unknownOrigin = makeSnapshot();
unknownOrigin.products[0].title = 'unmatched production record';
check(tool.buildManifest(unknownOrigin, environment(), loadMocks()).issues.includes('INVALID_SELLER_ORIGIN_UNKNOWN'), 'unknown invalid seller origin did not fail closed');

const schoolDrift = makeSnapshot();
schoolDrift.schools[0].platformStatus = 'pending';
check(tool.buildManifest(schoolDrift, environment(), loadMocks()).issues.includes('ACTIVE_SCHOOL_SCOPE_DRIFT'), 'school drift did not fail closed');

const orphan = makeSnapshot();
orphan.appointments.push({ _id: 'orphan', productId: 'missing-product' });
check(tool.buildManifest(orphan, environment(), loadMocks()).issues.includes('PREEXISTING_RELATIONSHIP_ORPHAN'), 'relationship orphan did not fail closed');

const source = fs.readFileSync(path.join(__dirname, 'final-release-product-cleanup-dry-run.js'), 'utf8');
check(!/CommandType:\s*['"](?:UPDATE|INSERT|DELETE|COMMAND)['"]/.test(source), 'dry-run contains a non-query database command');
check(!/\.collection\s*\([^)]*\)[\s\S]{0,200}\.(?:update|remove|add|set)\s*\(/.test(source), 'dry-run contains a database mutation method');
check(!/runTransaction\s*\(/.test(source), 'dry-run contains a transaction');
check(source.includes("CommandType: 'QUERY'"), 'dry-run does not explicitly allowlist QUERY');
check(source.includes("action: 'audit'"), 'dry-run does not use read-only preflight');

process.stdout.write(`Final release product cleanup dry-run verification passed (${checks} checks).\n`);
