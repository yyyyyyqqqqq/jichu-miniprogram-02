const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runPreflight, publicSummary, assert } = require('./environment-preflight');
const { runNoSql, extractCommandResults, extractDocuments } = require('./schools/cloud-cli');
const { extractUpdateCount } = require('./phase-18-fix-orphan-reserved-product');
const {
  EXPECTED_TARGET_COUNT,
  TARGET_SCHOOLS,
  stableStringify
} = require('./final-release-product-cleanup-dry-run');

const ROOT = path.resolve(__dirname, '..');
const APPROVED_MANIFEST = path.join(ROOT, 'tmp', 'final-release-product-cleanup-manifest.json');
const DEFAULT_STATE = path.join(ROOT, 'tmp', 'final-release-step-2b-operation-state.json');
const AUTHORIZATION_PHRASE = 'AUTHORIZE FINAL RELEASE STEP 2B PRODUCTION PRODUCT CLEANUP';
const APPROVED_TARGET_HASH = '0f2fced4111aa70f3254ba951a8a348d132cbbc9d8e6154b2d89b3e00627fb38';
const BATCH_CAP = 20;
const MANIFEST_MAX_AGE_MS = 60 * 60 * 1000;
const ALLOWED_MUTATION_FIELDS = new Set(['status', 'offlineAt', 'updatedAt', 'version']);

function fail(message, code = 'STEP_2B_CLEANUP_FAILED') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

function safePath(candidate, expected, code) {
  const resolved = path.resolve(ROOT, normalizeText(candidate));
  if (resolved !== expected) fail('only the fixed private Step 2B path is allowed', code);
  return resolved;
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    manifestPath: APPROVED_MANIFEST,
    statePath: DEFAULT_STATE,
    expectedCount: 0,
    targetHash: '',
    authorization: '',
    confirmTarget: '',
    batch: 0,
    write: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env') options.environmentName = normalizeText(argv[++index]);
    else if (argument === '--manifest') options.manifestPath = normalizeText(argv[++index]);
    else if (argument === '--state') options.statePath = normalizeText(argv[++index]);
    else if (argument === '--expected-count') options.expectedCount = Number(argv[++index]);
    else if (argument === '--target-hash') options.targetHash = normalizeText(argv[++index]);
    else if (argument === '--authorization') options.authorization = normalizeText(argv[++index]);
    else if (argument === '--confirm-target') options.confirmTarget = normalizeText(argv[++index]);
    else if (argument === '--batch') options.batch = Number(argv[++index]);
    else if (argument === '--write') options.write = true;
    else fail(`unsupported argument: ${argument}`, 'INVALID_ARGUMENT');
  }
  if (options.environmentName !== 'production') fail('explicit --env production is required', 'PRODUCTION_TARGET_REQUIRED');
  if (![1, 2].includes(options.batch)) fail('explicit --batch 1|2 is required', 'BATCH_REQUIRED');
  options.manifestPath = safePath(options.manifestPath, APPROVED_MANIFEST, 'MANIFEST_PATH_REJECTED');
  options.statePath = safePath(options.statePath, DEFAULT_STATE, 'STATE_PATH_REJECTED');
  return options;
}

function validateWriteAuthorization(options) {
  if (!options.write) return false;
  assert(options.expectedCount === EXPECTED_TARGET_COUNT, 'write requires --expected-count 32', 'EXPECTED_COUNT_REQUIRED');
  assert(options.targetHash === APPROVED_TARGET_HASH, `write requires --target-hash ${APPROVED_TARGET_HASH}`, 'TARGET_HASH_REQUIRED');
  assert(options.authorization === AUTHORIZATION_PHRASE, `write requires --authorization "${AUTHORIZATION_PHRASE}"`, 'PROJECT_OWNER_AUTHORIZATION_REQUIRED');
  assert(Boolean(options.confirmTarget), 'write requires explicit masked --confirm-target', 'TARGET_CONFIRMATION_REQUIRED');
  return true;
}

function readJson(filePath, code) {
  if (!fs.existsSync(filePath)) fail(`${path.basename(filePath)} is unavailable`, code);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${path.basename(filePath)} is invalid JSON`, code);
  }
}

function statusCount(manifest, status) {
  return Number(manifest.inventory && manifest.inventory.statusCounts && manifest.inventory.statusCounts[status] || 0);
}

function validateManifest(manifest, nowMs = Date.now()) {
  const issues = [];
  if (!manifest || manifest.schemaVersion !== 1) issues.push('MANIFEST_SCHEMA_INVALID');
  if (manifest.write !== false) issues.push('MANIFEST_NOT_ZERO_WRITE');
  if (!manifest.environment || manifest.environment.environmentName !== 'production') issues.push('MANIFEST_ENVIRONMENT_INVALID');
  if (manifest.environment && manifest.environment.write !== false) issues.push('MANIFEST_PREFLIGHT_NOT_READ_ONLY');
  if (!manifest.environment || manifest.environment.targetsDistinct !== true) issues.push('MANIFEST_ENVIRONMENT_ROLES_AMBIGUOUS');
  if (Number(manifest.inventory && manifest.inventory.productsTotal) !== 72) issues.push('PRODUCT_TOTAL_DRIFT');
  if (statusCount(manifest, 'available') !== 32) issues.push('AVAILABLE_TOTAL_DRIFT');
  if (statusCount(manifest, 'reserved') !== 0) issues.push('RESERVED_TOTAL_DRIFT');
  if (statusCount(manifest, 'offline') !== 25 || statusCount(manifest, 'sold') !== 12 || statusCount(manifest, 'deleted') !== 3) issues.push('PRODUCT_STATUS_BASELINE_DRIFT');
  if (!manifest.cleanupTarget || Number(manifest.cleanupTarget.targetAvailableCount) !== 32) issues.push('TARGET_COUNT_DRIFT');
  if (!manifest.cleanupTarget || manifest.cleanupTarget.targetIdsSha256 !== APPROVED_TARGET_HASH) issues.push('TARGET_HASH_DRIFT');
  if (!manifest.cleanupTarget || Number(manifest.cleanupTarget.invalidSellerCount) !== 13) issues.push('INVALID_SELLER_COUNT_DRIFT');
  if (!manifest.cleanupTarget || !Array.isArray(manifest.cleanupTarget.perProduct) || manifest.cleanupTarget.perProduct.length !== 32) issues.push('TARGET_MANIFEST_INVALID');
  if (manifest.safeToApply !== true || !Array.isArray(manifest.issues) || manifest.issues.length !== 0) issues.push('MANIFEST_NOT_SAFE');
  const generatedAtMs = new Date(manifest.generatedAt).getTime();
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs + 60_000 || nowMs - generatedAtMs > MANIFEST_MAX_AGE_MS) issues.push('MANIFEST_NOT_FRESH');
  const targetSchoolIds = new Set(TARGET_SCHOOLS.map((school) => school.id));
  if (manifest.cleanupTarget && Array.isArray(manifest.cleanupTarget.perProduct)) {
    if (manifest.cleanupTarget.perProduct.some((product) => !targetSchoolIds.has(normalizeText(product.schoolId)))) issues.push('TARGET_SCHOOL_SCOPE_DRIFT');
    if (manifest.cleanupTarget.perProduct.some((product) => normalizeText(product.currentStatus) !== 'available')) issues.push('TARGET_STATUS_DRIFT');
    const ids = manifest.cleanupTarget.perProduct.map((product) => normalizeText(product.productId)).sort();
    if (new Set(ids).size !== 32 || sha256(ids.join('\n')) !== APPROVED_TARGET_HASH) issues.push('TARGET_ID_SET_INVALID');
    const invalidSeller = manifest.cleanupTarget.perProduct.filter((product) => product.sellerUserAvailable === false);
    if (invalidSeller.length !== 13 || invalidSeller.some((product) => product.origin !== 'seed/mock')) issues.push('SELLER_CLASSIFICATION_DRIFT');
  }
  if (issues.length > 0) fail(issues.join(', '), 'MANIFEST_VALIDATION_FAILED');
  return true;
}

function query(environmentId, collectionName, filter, projection) {
  const commandBody = { find: collectionName, filter, limit: filter && filter._id ? 2 : 1000 };
  if (projection) commandBody.projection = projection;
  const command = {
    TableName: collectionName,
    CommandType: 'QUERY',
    Command: JSON.stringify(commandBody)
  };
  const response = runNoSql(environmentId, [command]);
  const results = extractCommandResults(response);
  return results.length > 0
    ? results.flatMap((item) => extractDocuments(item))
    : extractDocuments(response);
}

function queryProduct(environmentId, productId) {
  const rows = query(environmentId, 'products', { _id: productId });
  if (rows.length !== 1) fail('approved product lookup cardinality changed', 'PRODUCT_LOOKUP_DRIFT');
  return rows[0];
}

function queryProductInventory(environmentId) {
  const rows = query(environmentId, 'products', {}, { _id: 1, status: 1, schoolId: 1, version: 1 });
  if (rows.length !== 72) fail(`products total drifted to ${rows.length}`, 'PRODUCT_TOTAL_DRIFT');
  return rows;
}

function productProtectedHash(product) {
  const protectedProduct = Object.fromEntries(
    Object.entries(product).filter(([key]) => !ALLOWED_MUTATION_FIELDS.has(key))
  );
  return sha256(stableStringify(protectedProduct));
}

function manifestTargetById(manifest) {
  return new Map(manifest.cleanupTarget.perProduct.map((product) => [normalizeText(product.productId), product]));
}

function expectedVersion(target) {
  return target.sourceVersionPresent === true ? Number(target.expectedVersion) : 0;
}

function validateBeforeProduct(product, target) {
  assert(product._id === target.productId, 'product ID drift', 'PRODUCT_BEFORE_DRIFT');
  assert(product.schoolId === target.schoolId, 'product school drift', 'PRODUCT_BEFORE_DRIFT');
  assert(product.status === 'available', 'product is no longer available', 'PRODUCT_BEFORE_DRIFT');
  assert(normalizeVersion(product.version) === expectedVersion(target), 'product version drift', 'PRODUCT_BEFORE_DRIFT');
  assert((Object.prototype.hasOwnProperty.call(product, 'version')) === target.sourceVersionPresent, 'product version presence drift', 'PRODUCT_BEFORE_DRIFT');
  return true;
}

function validateAfterProduct(before, after, target) {
  assert(after._id === target.productId && after.schoolId === target.schoolId, 'product identity/school changed', 'POST_WRITE_VERIFICATION_FAILED');
  assert(after.status === 'offline', 'product did not become offline', 'POST_WRITE_VERIFICATION_FAILED');
  assert(normalizeVersion(after.version) === expectedVersion(target) + 1, 'product version did not increment once', 'POST_WRITE_VERIFICATION_FAILED');
  assert(Boolean(after.offlineAt) && Boolean(after.updatedAt), 'server timestamps are missing', 'POST_WRITE_VERIFICATION_FAILED');
  assert(productProtectedHash(before) === productProtectedHash(after), 'a protected product field changed', 'POST_WRITE_VERIFICATION_FAILED');
  return true;
}

function buildUpdateCommand(product, target) {
  validateBeforeProduct(product, target);
  const versionCondition = target.sourceVersionPresent
    ? Number(target.expectedVersion)
    : { $exists: false };
  return {
    TableName: 'products',
    CommandType: 'UPDATE',
    Command: JSON.stringify({
      update: 'products',
      updates: [{
        q: {
          _id: target.productId,
          schoolId: target.schoolId,
          status: 'available',
          version: versionCondition
        },
        u: {
          $set: { status: 'offline', version: expectedVersion(target) + 1 },
          $currentDate: { offlineAt: true, updatedAt: true }
        },
        multi: false,
        upsert: false
      }],
      ordered: true
    })
  };
}

function assertUpdateCommand(command, target) {
  assert(command.TableName === 'products' && command.CommandType === 'UPDATE', 'mutation is outside products UPDATE allowlist', 'MUTATION_COMMAND_REJECTED');
  const body = JSON.parse(command.Command);
  assert(body.update === 'products' && Array.isArray(body.updates) && body.updates.length === 1, 'mutation must contain exactly one product update', 'MUTATION_COMMAND_REJECTED');
  const operation = body.updates[0];
  assert(operation.multi === false && operation.upsert === false, 'multi/upsert is forbidden', 'MUTATION_COMMAND_REJECTED');
  assert(operation.q._id === target.productId && operation.q.schoolId === target.schoolId && operation.q.status === 'available', 'mutation preconditions drifted', 'MUTATION_COMMAND_REJECTED');
  const setKeys = Object.keys(operation.u.$set || {}).sort();
  const dateKeys = Object.keys(operation.u.$currentDate || {}).sort();
  assert(stableStringify(setKeys) === stableStringify(['status', 'version']), 'mutation $set field allowlist failed', 'MUTATION_COMMAND_REJECTED');
  assert(stableStringify(dateKeys) === stableStringify(['offlineAt', 'updatedAt']), 'mutation $currentDate field allowlist failed', 'MUTATION_COMMAND_REJECTED');
  assert(!/remove|delete|drop/i.test(command.Command), 'delete/remove/drop is forbidden', 'MUTATION_COMMAND_REJECTED');
  return true;
}

function emptyState(manifest) {
  return {
    schemaVersion: 1,
    operationId: `final_release_step_2b_${manifest.cleanupTarget.targetIdsSha256.slice(0, 16)}`,
    manifestGeneratedAt: manifest.generatedAt,
    targetIdsSha256: manifest.cleanupTarget.targetIdsSha256,
    beforeSnapshotSha256: manifest.cleanupTarget.beforeSnapshotSha256,
    expectedCount: 32,
    productMutations: 0,
    productRemoves: 0,
    otherCollectionMutations: 0,
    pending: null,
    results: [],
    startedAt: new Date().toISOString(),
    completedAt: null
  };
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
}

function loadState(filePath, manifest, create) {
  if (!fs.existsSync(filePath)) return create ? emptyState(manifest) : null;
  const state = readJson(filePath, 'OPERATION_STATE_INVALID');
  assert(state.schemaVersion === 1 && state.targetIdsSha256 === manifest.cleanupTarget.targetIdsSha256 && state.beforeSnapshotSha256 === manifest.cleanupTarget.beforeSnapshotSha256, 'operation state does not match manifest', 'OPERATION_STATE_DRIFT');
  assert(state.productRemoves === 0 && state.otherCollectionMutations === 0, 'operation state records forbidden mutations', 'OPERATION_STATE_DRIFT');
  return state;
}

function completedIds(state) {
  return new Set((state && state.results || []).map((result) => result.productId));
}

function batchTargets(manifest, batch) {
  const targets = [...manifest.cleanupTarget.perProduct].sort((left, right) => left.productId.localeCompare(right.productId));
  return batch === 1 ? targets.slice(0, BATCH_CAP) : targets.slice(BATCH_CAP);
}

function validateInventoryForProgress(products, manifest, state) {
  const completed = completedIds(state);
  const byId = new Map(products.map((product) => [product._id, product]));
  for (const target of manifest.cleanupTarget.perProduct) {
    const product = byId.get(target.productId);
    assert(product, 'approved target disappeared', 'PRODUCT_BEFORE_DRIFT');
    if (completed.has(target.productId)) {
      assert(product.status === 'offline' && normalizeVersion(product.version) === expectedVersion(target) + 1, 'completed target state drifted', 'PRODUCT_BEFORE_DRIFT');
    } else {
      validateBeforeProduct(product, target);
    }
  }
  const counts = products.reduce((result, product) => {
    result[product.status] = (result[product.status] || 0) + 1;
    return result;
  }, {});
  assert(Number(counts.available || 0) === 32 - completed.size, 'available count does not match operation progress', 'PRODUCT_STATUS_DRIFT');
  assert(Number(counts.reserved || 0) === 0, 'reserved public product appeared', 'RESERVED_PRODUCT_DRIFT');
  assert(Number(counts.offline || 0) === 25 + completed.size && Number(counts.sold || 0) === 12 && Number(counts.deleted || 0) === 3, 'non-target status counts drifted', 'PRODUCT_STATUS_DRIFT');
  return counts;
}

function recoverPending(environmentId, manifest, state, statePath) {
  if (!state.pending) return state;
  const target = manifestTargetById(manifest).get(state.pending.productId);
  assert(target, 'pending target is not approved', 'OPERATION_STATE_DRIFT');
  const product = queryProduct(environmentId, target.productId);
  if (product.status === 'available') {
    validateBeforeProduct(product, target);
    assert(productProtectedHash(product) === state.pending.protectedHashBefore, 'pending before state drifted', 'PRODUCT_BEFORE_DRIFT');
    return state;
  }
  assert(product.status === 'offline' && normalizeVersion(product.version) === expectedVersion(target) + 1, 'pending product has an unexpected state', 'PARTIAL_RUN_BLOCKED');
  assert(productProtectedHash(product) === state.pending.protectedHashBefore, 'pending product protected fields changed', 'POST_WRITE_VERIFICATION_FAILED');
  state.results.push({
    productId: target.productId,
    batch: state.pending.batch,
    outcome: 'recovered-after-readback',
    beforeProtectedSha256: state.pending.protectedHashBefore,
    afterProtectedSha256: productProtectedHash(product),
    nextVersion: expectedVersion(target) + 1,
    verifiedAt: new Date().toISOString()
  });
  state.productMutations += 1;
  state.pending = null;
  writePrivateJson(statePath, state);
  return state;
}

function run(options) {
  validateWriteAuthorization(options);
  const manifest = readJson(options.manifestPath, 'MANIFEST_MISSING');
  validateManifest(manifest);
  const preflight = runPreflight({
    environmentName: 'production',
    action: options.write ? 'cleanup' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: options.write
  });
  assert(options.targetHash === '' || options.targetHash === manifest.cleanupTarget.targetIdsSha256, 'CLI target hash differs from manifest', 'TARGET_HASH_DRIFT');
  assert(options.expectedCount === 0 || options.expectedCount === manifest.cleanupTarget.targetAvailableCount, 'CLI expected count differs from manifest', 'TARGET_COUNT_DRIFT');

  let state = loadState(options.statePath, manifest, options.write);
  if (state) state = recoverPending(preflight.environmentId, manifest, state, options.statePath);
  const completed = completedIds(state);
  const firstBatchIds = new Set(batchTargets(manifest, 1).map((target) => target.productId));
  if (options.batch === 1) assert([...completed].every((id) => firstBatchIds.has(id)), 'batch 2 progress exists before batch 1 invocation', 'BATCH_ORDER_VIOLATION');
  if (options.batch === 2) assert([...firstBatchIds].every((id) => completed.has(id)), 'batch 1 is not fully verified', 'BATCH_ORDER_VIOLATION');

  const inventoryBefore = queryProductInventory(preflight.environmentId);
  const countsBefore = validateInventoryForProgress(inventoryBefore, manifest, state);
  const selected = batchTargets(manifest, options.batch);
  const remaining = selected.filter((target) => !completed.has(target.productId));
  if (!options.write) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      write: false,
      batch: options.batch,
      batchSize: selected.length,
      alreadyCompleted: selected.length - remaining.length,
      wouldMutate: remaining.length,
      targetIdsSha256: manifest.cleanupTarget.targetIdsSha256,
      beforeSnapshotSha256: manifest.cleanupTarget.beforeSnapshotSha256,
      countsBefore,
      productRemoves: 0,
      otherCollectionMutations: 0
    };
  }

  writePrivateJson(options.statePath, state);
  for (const target of remaining) {
    const before = queryProduct(preflight.environmentId, target.productId);
    validateBeforeProduct(before, target);
    const protectedHashBefore = productProtectedHash(before);
    state.pending = { productId: target.productId, batch: options.batch, protectedHashBefore, startedAt: new Date().toISOString() };
    writePrivateJson(options.statePath, state);
    const command = buildUpdateCommand(before, target);
    assertUpdateCommand(command, target);
    const updateResponse = runNoSql(preflight.environmentId, [command]);
    let affected = null;
    try {
      affected = extractUpdateCount(updateResponse);
    } catch (error) {
      if (!error || error.code !== 'UPDATE_RESULT_UNREADABLE') throw error;
    }
    assert(affected === null || affected === 1, `single update affected ${affected} records`, affected === 0 ? 'MUTATION_PRECONDITION_FAILED' : 'MUTATION_CARDINALITY_FAILED');
    const after = queryProduct(preflight.environmentId, target.productId);
    validateAfterProduct(before, after, target);
    state.results.push({
      productId: target.productId,
      batch: options.batch,
      outcome: 'updated-and-verified',
      beforeProtectedSha256: protectedHashBefore,
      afterProtectedSha256: productProtectedHash(after),
      nextVersion: expectedVersion(target) + 1,
      verifiedAt: new Date().toISOString()
    });
    state.productMutations += 1;
    state.pending = null;
    writePrivateJson(options.statePath, state);
  }

  const inventoryAfter = queryProductInventory(preflight.environmentId);
  const countsAfter = validateInventoryForProgress(inventoryAfter, manifest, state);
  const nowCompleted = completedIds(state);
  assert(selected.every((target) => nowCompleted.has(target.productId)), 'batch is not completely verified', 'BATCH_POST_AUDIT_FAILED');
  if (options.batch === 2) {
    assert(state.productMutations === 32 && nowCompleted.size === 32, 'final mutation count is not exactly 32', 'FINAL_MUTATION_COUNT_FAILED');
    state.completedAt = new Date().toISOString();
    writePrivateJson(options.statePath, state);
  }
  return {
    mode: 'applied',
    environment: publicSummary(preflight),
    write: true,
    batch: options.batch,
    batchSize: selected.length,
    mutatedThisInvocation: remaining.length,
    completedTotal: nowCompleted.size,
    productMutations: state.productMutations,
    productRemoves: state.productRemoves,
    otherCollectionMutations: state.otherCollectionMutations,
    countsAfter,
    operationId: state.operationId,
    state: path.relative(ROOT, options.statePath).replace(/\\/g, '/')
  };
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'STEP_2B_CLEANUP_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  AUTHORIZATION_PHRASE,
  APPROVED_TARGET_HASH,
  ALLOWED_MUTATION_FIELDS,
  parseArguments,
  validateWriteAuthorization,
  validateManifest,
  productProtectedHash,
  validateBeforeProduct,
  validateAfterProduct,
  buildUpdateCommand,
  assertUpdateCommand,
  batchTargets,
  emptyState,
  run
};
