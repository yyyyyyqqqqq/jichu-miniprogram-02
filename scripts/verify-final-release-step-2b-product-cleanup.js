const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runner = require('./final-release-step-2b-product-cleanup');

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert(condition, message);
}

function expectedError(action, code) {
  checks += 1;
  assert.throws(action, (error) => error && error.code === code);
}

expectedError(() => runner.parseArguments([]), 'PRODUCTION_TARGET_REQUIRED');
expectedError(() => runner.parseArguments(['--env', 'staging', '--batch', '1']), 'PRODUCTION_TARGET_REQUIRED');
expectedError(() => runner.parseArguments(['--env', 'production']), 'BATCH_REQUIRED');
expectedError(() => runner.parseArguments(['--env', 'production', '--batch', '3']), 'BATCH_REQUIRED');
expectedError(() => runner.parseArguments(['--env', 'production', '--batch', '1', '--manifest', 'other.json']), 'MANIFEST_PATH_REJECTED');
expectedError(() => runner.parseArguments(['--env', 'production', '--batch', '1', '--state', 'other.json']), 'STATE_PATH_REJECTED');
expectedError(() => runner.parseArguments(['--env', 'production', '--batch', '1', '--unknown']), 'INVALID_ARGUMENT');

const dryOptions = runner.parseArguments(['--env', 'production', '--batch', '1']);
check(dryOptions.write === false, 'runner must default to write=false');
check(runner.validateWriteAuthorization(dryOptions) === false, 'dry-run authorization should remain false');

for (const missing of ['count', 'hash', 'authorization', 'confirmation']) {
  const options = {
    write: true,
    expectedCount: missing === 'count' ? 0 : 32,
    targetHash: missing === 'hash' ? '' : runner.APPROVED_TARGET_HASH,
    authorization: missing === 'authorization' ? '' : runner.AUTHORIZATION_PHRASE,
    confirmTarget: missing === 'confirmation' ? '' : 'cloud1***6d8e'
  };
  expectedError(
    () => runner.validateWriteAuthorization(options),
    missing === 'count' ? 'EXPECTED_COUNT_REQUIRED'
      : missing === 'hash' ? 'TARGET_HASH_REQUIRED'
        : missing === 'authorization' ? 'PROJECT_OWNER_AUTHORIZATION_REQUIRED'
          : 'TARGET_CONFIRMATION_REQUIRED'
  );
}
check(runner.validateWriteAuthorization({
  write: true,
  expectedCount: 32,
  targetHash: runner.APPROVED_TARGET_HASH,
  authorization: runner.AUTHORIZATION_PHRASE,
  confirmTarget: 'cloud1***6d8e'
}) === true, 'complete authorization should validate');

const missingVersionTarget = {
  productId: 'product-seed',
  schoolId: 's_school',
  currentStatus: 'available',
  expectedVersion: null,
  sourceVersionPresent: false
};
const missingVersionProduct = {
  _id: 'product-seed',
  schoolId: 's_school',
  status: 'available',
  title: 'seed'
};
const seedCommand = runner.buildUpdateCommand(missingVersionProduct, missingVersionTarget);
check(runner.assertUpdateCommand(seedCommand, missingVersionTarget), 'seed update command was rejected');
const seedBody = JSON.parse(seedCommand.Command).updates[0];
check(seedBody.q.version.$exists === false, 'missing version is not locked as absent');
check(seedBody.u.$set.status === 'offline' && seedBody.u.$set.version === 1, 'missing version does not transition to version 1');
check(seedBody.u.$currentDate.offlineAt === true && seedBody.u.$currentDate.updatedAt === true, 'timestamps are not server-side currentDate');
check(seedBody.multi === false && seedBody.upsert === false, 'single-record limits are missing');

const versionedTarget = { ...missingVersionTarget, productId: 'p_versioned', expectedVersion: 6, sourceVersionPresent: true };
const versionedProduct = { ...missingVersionProduct, _id: 'p_versioned', version: 6 };
const versionedCommand = runner.buildUpdateCommand(versionedProduct, versionedTarget);
const versionedBody = JSON.parse(versionedCommand.Command).updates[0];
check(versionedBody.q.version === 6 && versionedBody.u.$set.version === 7, 'versioned transition is not exact');

expectedError(() => runner.validateBeforeProduct({ ...versionedProduct, status: 'offline' }, versionedTarget), 'PRODUCT_BEFORE_DRIFT');
expectedError(() => runner.validateBeforeProduct({ ...versionedProduct, schoolId: 's_other' }, versionedTarget), 'PRODUCT_BEFORE_DRIFT');
expectedError(() => runner.validateBeforeProduct({ ...versionedProduct, version: 7 }, versionedTarget), 'PRODUCT_BEFORE_DRIFT');

const after = {
  ...versionedProduct,
  status: 'offline',
  version: 7,
  offlineAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z'
};
check(runner.validateAfterProduct(versionedProduct, after, versionedTarget), 'valid after state was rejected');
expectedError(() => runner.validateAfterProduct(versionedProduct, { ...after, title: 'changed' }, versionedTarget), 'POST_WRITE_VERIFICATION_FAILED');

const protectedBase = { _id: 'p', title: 'same', status: 'available', version: 1, updatedAt: 'before' };
const allowedChange = { ...protectedBase, status: 'offline', version: 2, offlineAt: 'after', updatedAt: 'after' };
check(runner.productProtectedHash(protectedBase) === runner.productProtectedHash(allowedChange), 'allowed mutation fields changed protected hash');
check(runner.productProtectedHash(protectedBase) !== runner.productProtectedHash({ ...allowedChange, price: 1 }), 'protected field change was not detected');

const badBody = JSON.parse(versionedCommand.Command);
badBody.updates[0].multi = true;
expectedError(() => runner.assertUpdateCommand({ ...versionedCommand, Command: JSON.stringify(badBody) }, versionedTarget), 'MUTATION_COMMAND_REJECTED');
badBody.updates[0].multi = false;
badBody.updates[0].u.$set.title = 'forbidden';
expectedError(() => runner.assertUpdateCommand({ ...versionedCommand, Command: JSON.stringify(badBody) }, versionedTarget), 'MUTATION_COMMAND_REJECTED');

const targets = Array.from({ length: 32 }, (_, index) => ({ productId: `p_${String(index).padStart(2, '0')}` }));
const batches = { cleanupTarget: { perProduct: targets } };
check(runner.batchTargets(batches, 1).length === 20, 'batch 1 cap is not 20');
check(runner.batchTargets(batches, 2).length === 12, 'batch 2 size is not 12');
check(new Set([...runner.batchTargets(batches, 1), ...runner.batchTargets(batches, 2)].map((item) => item.productId)).size === 32, 'batch scope overlaps or omits targets');

const manifestPath = path.join(__dirname, '..', 'tmp', 'final-release-product-cleanup-manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check(runner.validateManifest(manifest), 'fresh approved manifest was rejected');
}

const source = fs.readFileSync(path.join(__dirname, 'final-release-step-2b-product-cleanup.js'), 'utf8');
check(source.includes("CommandType: 'UPDATE'"), 'runner lacks an explicit update command');
check(source.includes("CommandType: 'QUERY'"), 'runner lacks explicit readback queries');
check(!/CommandType:\s*['"](?:INSERT|DELETE|COMMAND)['"]/.test(source), 'runner contains a forbidden command type');
check(!/\.remove\s*\(|\.delete\s*\(|\bdrop\s*\(/.test(source), 'runner contains a destructive database method');
check(!/TableName:\s*['"](?!products['"])/.test(source), 'runner update/query table scope is not products-only');
check(source.includes('$currentDate'), 'runner does not use server-side timestamps');
check(source.includes('affected === 1'), 'runner does not require exactly one affected document');

process.stdout.write(`Final release Step 2B product cleanup verification passed (${checks} checks).\n`);
