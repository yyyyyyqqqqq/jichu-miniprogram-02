const fs = require('fs');
const path = require('path');
const { runPreflight, publicSummary, assert } = require('./environment-preflight');
const {
  loadSnapshot,
  relationCounts,
  TARGET_SCHOOLS,
  stableStringify
} = require('./final-release-product-cleanup-dry-run');

const ROOT = path.resolve(__dirname, '..');
const BEFORE_PATH = path.join(ROOT, 'tmp', 'final-release-step-2b-before-snapshot.json');
const STATE_PATH = path.join(ROOT, 'tmp', 'final-release-step-2b-operation-state.json');
const INTEGRITY_PATH = path.join(ROOT, 'tmp', 'final-release-step-2b-after-integrity-audit.json');
const OUTPUT_PATH = path.join(ROOT, 'tmp', 'final-release-step-2b-post-audit.json');
const PUBLIC_STATUSES = new Set(['available', 'reserved']);

function readJson(filePath) {
  assert(fs.existsSync(filePath), `${path.basename(filePath)} is unavailable`, 'POST_AUDIT_INPUT_MISSING');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

function messageProductIds(message) {
  const product = message && typeof message.product === 'object' ? message.product : {};
  return new Set([
    normalizeText(message.productId),
    normalizeText(message.contextProductId),
    normalizeText(product.productId),
    normalizeText(product._id)
  ].filter(Boolean));
}

function snapshotProductId(value) {
  return value && typeof value === 'object'
    ? normalizeText(value.productId || value._id)
    : '';
}

function countByStatus(products) {
  return products.reduce((counts, product) => {
    const status = normalizeText(product.status) || '(missing)';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function relationReadFailures(snapshot) {
  const productIds = new Set(snapshot.products.map((product) => normalizeText(product._id)));
  return {
    favoriteOrphan: snapshot.favorites.filter((row) => normalizeText(row.productId) && !productIds.has(normalizeText(row.productId))).length,
    conversationProductContextFailure: snapshot.conversations.filter((row) => {
      const productId = normalizeText(row.lastProductId) || normalizeText(row.productId);
      const fallback = snapshotProductId(row.lastProductSnapshot) || snapshotProductId(row.productSnapshot);
      return productId && !productIds.has(productId) && !fallback;
    }).length,
    messageProductContextFailure: snapshot.messages.filter((row) => [...messageProductIds(row)].some((id) => !productIds.has(id))).length,
    appointmentProductMissing: snapshot.appointments.filter((row) => normalizeText(row.productId) && !productIds.has(normalizeText(row.productId))).length,
    productViewOrphan: snapshot.productViews.filter((row) => normalizeText(row.productId) && !productIds.has(normalizeText(row.productId))).length
  };
}

function run() {
  const preflight = runPreflight({ environmentName: 'production', action: 'audit' });
  assert(preflight.write === false, 'post-audit preflight is not read-only', 'POST_AUDIT_NOT_READ_ONLY');
  const before = readJson(BEFORE_PATH);
  const state = readJson(STATE_PATH);
  const integrity = readJson(INTEGRITY_PATH);
  const snapshot = loadSnapshot(preflight.environmentId);
  const productsById = new Map(snapshot.products.map((product) => [normalizeText(product._id), product]));
  const beforeTargets = before.cleanupTarget.perProduct;
  const targetResults = beforeTargets.map((target) => {
    const product = productsById.get(target.productId);
    assert(product, 'approved product disappeared', 'POST_PRODUCT_MISSING');
    assert(product.schoolId === target.schoolId, 'approved product school changed', 'POST_PRODUCT_DRIFT');
    assert(product.status === 'offline', 'approved product is not offline', 'POST_PRODUCT_DRIFT');
    const beforeVersion = target.sourceVersionPresent ? Number(target.expectedVersion) : 0;
    assert(normalizeVersion(product.version) === beforeVersion + 1, 'approved product version is wrong', 'POST_PRODUCT_DRIFT');
    const relationsAfter = relationCounts(target.productId, snapshot);
    assert(stableStringify(relationsAfter) === stableStringify(target.relations), 'target relationship counts drifted', 'POST_RELATION_DRIFT');
    return { productId: target.productId, schoolId: target.schoolId, status: product.status, relations: relationsAfter };
  });
  const counts = countByStatus(snapshot.products);
  const publicProducts = snapshot.products.filter((product) => PUBLIC_STATUSES.has(normalizeText(product.status)));
  const noSchoolAvailable = snapshot.products.filter((product) => !normalizeText(product.schoolId) && normalizeText(product.status) === 'available').length;
  const invalidSellerAvailable = beforeTargets.filter((target) => target.sellerUserAvailable === false)
    .filter((target) => productsById.get(target.productId).status === 'available').length;
  const schoolPublic = Object.fromEntries(TARGET_SCHOOLS.map((school) => [school.id, {
    available: snapshot.products.filter((product) => product.schoolId === school.id && product.status === 'available').length,
    reserved: snapshot.products.filter((product) => product.schoolId === school.id && product.status === 'reserved').length,
    visible: snapshot.products.filter((product) => product.schoolId === school.id && PUBLIC_STATUSES.has(product.status)).length
  }]));
  const failures = relationReadFailures(snapshot);
  assert(snapshot.products.length === 72, 'products total is not 72', 'POST_COUNT_FAILED');
  assert(Number(counts.available || 0) === 0 && Number(counts.reserved || 0) === 0, 'public product status is not zero', 'POST_COUNT_FAILED');
  assert(Number(counts.offline || 0) === 57 && Number(counts.sold || 0) === 12 && Number(counts.deleted || 0) === 3, 'final product status counts are wrong', 'POST_COUNT_FAILED');
  assert(publicProducts.length === 0 && Object.values(schoolPublic).every((item) => item.visible === 0), 'public market is not zero', 'PUBLIC_MARKET_ZERO_FAILED');
  assert(noSchoolAvailable === 0 && invalidSellerAvailable === 0, 'available integrity blocker remains', 'POST_SELLER_FAILED');
  assert(Object.values(failures).every((count) => count === 0), 'relationship read failure remains', 'POST_RELATION_FAILED');
  assert(integrity.readinessGate && integrity.readinessGate.passed === true, 'Phase 25 integrity gate failed', 'POST_INTEGRITY_GATE_FAILED');
  assert(integrity.conversations.aliasCanonicalDangling === 0 && integrity.messages.orphanMessage === 0 && integrity.appointments.productMissing === 0, 'canonical/message/appointment integrity failed', 'POST_INTEGRITY_GATE_FAILED');
  assert(state.productMutations === 32 && state.productRemoves === 0 && state.otherCollectionMutations === 0 && state.results.length === 32 && !state.pending, 'operation state is incomplete', 'POST_OPERATION_STATE_FAILED');
  const report = {
    schemaVersion: 1,
    mode: 'FINAL_RELEASE_STEP_2B_PRODUCTION_POST_AUDIT',
    completedAt: new Date().toISOString(),
    environment: publicSummary(preflight),
    write: false,
    products: { total: snapshot.products.length, statusCounts: counts },
    operation: {
      productMutations: state.productMutations,
      productRemoves: state.productRemoves,
      otherCollectionMutations: state.otherCollectionMutations,
      verifiedTargets: targetResults.length
    },
    publicMarket: {
      statuses: [...PUBLIC_STATUSES],
      globallyVisible: publicProducts.length,
      exactSchools: schoolPublic,
      homepage: 0,
      category: 0,
      search: 0,
      sellerPublicProducts: 0,
      sellerPublicActiveCount: 0
    },
    invalidSellerAvailable,
    noSchoolAvailable,
    relationshipReadFailures: failures,
    canonicalIntegrity: integrity.conversations,
    messageIntegrity: integrity.messages,
    appointmentIntegrity: integrity.appointments,
    targetRelationshipCountsPreserved: true,
    publicMarketZero: true,
    passed: true
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return report;
}

if (require.main === module) {
  try {
    const report = run();
    process.stdout.write(`${JSON.stringify({
      completedAt: report.completedAt,
      environment: report.environment,
      write: report.write,
      products: report.products,
      operation: report.operation,
      publicMarket: report.publicMarket,
      invalidSellerAvailable: report.invalidSellerAvailable,
      noSchoolAvailable: report.noSchoolAvailable,
      relationshipReadFailures: report.relationshipReadFailures,
      publicMarketZero: report.publicMarketZero,
      passed: report.passed,
      privateOutput: path.relative(ROOT, OUTPUT_PATH).replace(/\\/g, '/')
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'STEP_2B_POST_AUDIT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { countByStatus, relationReadFailures, run };
