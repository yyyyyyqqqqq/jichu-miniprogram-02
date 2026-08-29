const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runPreflight, publicSummary } = require('./environment-preflight');
const { runNoSql, extractCommandResults, extractDocuments } = require('./schools/cloud-cli');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'tmp', 'final-release-product-cleanup-manifest.json');
const PAGE_SIZE = 1000;
const MAXIMUM_RECORDS = 10000;
const EXPECTED_TARGET_COUNT = 32;
const PUBLIC_STATUSES = Object.freeze(['available', 'reserved']);
const TARGET_SCHOOLS = Object.freeze([
  Object.freeze({ id: 's_2639dd0d2bb01fb6a317e43e771a6f30', name: '上海财经大学浙江学院' }),
  Object.freeze({ id: 's_e5ca127017371b84bec8b1a67137b898', name: '上海工程技术大学' })
]);
const PROJECTIONS = Object.freeze({
  schools: { _id: 1, name: 1, platformStatus: 1, officialStatus: 1 },
  users: { _id: 1, openid: 1, status: 1 },
  products: {
    _id: 1, title: 1, description: 1, categoryId: 1, price: 1,
    sellerId: 1, sellerOpenid: 1, schoolId: 1, schoolName: 1, status: 1,
    version: 1, publishRequestId: 1, phase18CanaryFixture: 1,
    phase18FixtureClosure: 1, maintenance: 1
  },
  favorites: { _id: 1, productId: 1 },
  conversations: {
    _id: 1, productId: 1, lastProductId: 1, status: 1,
    mergedInto: 1, canonicalConversationId: 1,
    productSnapshot: 1, lastProductSnapshot: 1
  },
  messages: { _id: 1, productId: 1, contextProductId: 1, product: 1 },
  appointments: { _id: 1, productId: 1 },
  productViews: { _id: 1, productId: 1 }
});

function fail(message, code = 'CLEANUP_DRY_RUN_FAILED') {
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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseArguments(argv) {
  const options = { environmentName: '', output: DEFAULT_OUTPUT, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env') options.environmentName = normalizeText(argv[++index]);
    else if (argument === '--output') options.output = path.resolve(ROOT, normalizeText(argv[++index]));
    else if (['--write', '--apply', '--execute', '--allow-production-write'].includes(argument)) {
      fail(`${argument} is forbidden: this tool is permanently zero-write`, 'WRITE_MODE_FORBIDDEN');
    } else fail(`unsupported argument: ${argument}`, 'INVALID_ARGUMENT');
  }
  if (options.environmentName !== 'production') {
    fail('explicit --env production is required', 'PRODUCTION_TARGET_REQUIRED');
  }
  if (!options.output || path.extname(options.output).toLowerCase() !== '.json') {
    fail('manifest output must be an explicit JSON path', 'OUTPUT_PATH_INVALID');
  }
  return options;
}

function extractQueryDocuments(response) {
  const results = extractCommandResults(response);
  return results.length > 0
    ? results.flatMap((result) => extractDocuments(result))
    : extractDocuments(response);
}

function queryAll(environmentId, collectionName, projection) {
  const records = [];
  for (let skip = 0; skip < MAXIMUM_RECORDS; skip += PAGE_SIZE) {
    const command = {
      TableName: collectionName,
      CommandType: 'QUERY',
      Command: JSON.stringify({
        find: collectionName,
        filter: {},
        projection,
        sort: { _id: 1 },
        skip,
        limit: PAGE_SIZE
      })
    };
    if (command.CommandType !== 'QUERY') fail('non-query database command rejected', 'WRITE_COMMAND_REJECTED');
    const page = extractQueryDocuments(runNoSql(environmentId, [command]));
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
  fail(`${collectionName} reached the read-only safety limit`, 'READ_ONLY_LIMIT_REACHED');
}

function countBy(records, key) {
  return records.reduce((counts, record) => {
    const value = normalizeText(record[key]) || '(missing)';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function userAvailable(user) {
  return Boolean(user && normalizeText(user.openid) && normalizeText(user.status || 'active') !== 'deleted');
}

function productSellerAvailable(product, usersById, usersByOpenid) {
  return userAvailable(usersById.get(normalizeText(product.sellerId)))
    || userAvailable(usersByOpenid.get(normalizeText(product.sellerOpenid)));
}

function messageProductIds(message) {
  const embedded = message && typeof message.product === 'object' ? message.product : {};
  return new Set([
    normalizeText(message.productId),
    normalizeText(message.contextProductId),
    normalizeText(embedded.productId),
    normalizeText(embedded._id)
  ].filter(Boolean));
}

function snapshotProductId(snapshot) {
  return snapshot && typeof snapshot === 'object'
    ? normalizeText(snapshot.productId || snapshot._id)
    : '';
}

function exactMockMatch(product, mock) {
  return Boolean(mock
    && normalizeText(product._id) === normalizeText(mock._id)
    && normalizeText(product.title) === normalizeText(mock.title)
    && normalizeText(product.description) === normalizeText(mock.description)
    && normalizeText(product.categoryId) === normalizeText(mock.categoryId)
    && Number(product.price) === Number(mock.price)
    && normalizeText(product.sellerId) === normalizeText(mock.sellerId));
}

function normalizeMockProduct(product) {
  return {
    _id: normalizeText(product._id || product.id),
    title: normalizeText(product.title),
    description: normalizeText(product.description),
    categoryId: normalizeText(product.categoryId),
    price: Number(product.price),
    sellerId: normalizeText(product.sellerId || (product.seller && product.seller.id))
  };
}

function classifyOrigin(product, mockById) {
  if (exactMockMatch(product, mockById.get(normalizeText(product._id)))) return 'seed/mock';
  if (product.phase18CanaryFixture || product.phase18FixtureClosure) return 'fixture';
  if (/phase\s*\d+|test|fixture|测试/i.test(normalizeText(product.title))) return 'historical-test';
  if (/phase|test|fixture|canary/i.test(normalizeText(product.publishRequestId))) return 'fixture-request';
  if (normalizeText(product.publishRequestId)) return 'published-record';
  return 'unclassified';
}

function relationCounts(productId, snapshot) {
  const conversations = snapshot.conversations.filter((row) => (
    normalizeText(row.productId) === productId || normalizeText(row.lastProductId) === productId
  ));
  const activeConversations = conversations.filter((row) => (
    !normalizeText(row.mergedInto)
    && !normalizeText(row.canonicalConversationId)
    && !['merged', 'deleted'].includes(normalizeText(row.status))
  ));
  const mergedConversations = conversations.filter((row) => (
    normalizeText(row.status) === 'merged'
    || normalizeText(row.mergedInto)
    || normalizeText(row.canonicalConversationId)
  ));
  const directMessages = snapshot.messages.filter((row) => normalizeText(row.productId) === productId);
  const contextMessages = snapshot.messages.filter((row) => {
    const embedded = row && typeof row.product === 'object' ? row.product : {};
    return normalizeText(row.contextProductId) === productId
      || normalizeText(embedded.productId) === productId
      || normalizeText(embedded._id) === productId;
  });
  return {
    favorites: snapshot.favorites.filter((row) => normalizeText(row.productId) === productId).length,
    activeConversations: activeConversations.length,
    mergedConversations: mergedConversations.length,
    directProductMessages: directMessages.length,
    productContextOrCardMessages: contextMessages.length,
    anyProductMessages: snapshot.messages.filter((row) => messageProductIds(row).has(productId)).length,
    appointments: snapshot.appointments.filter((row) => normalizeText(row.productId) === productId).length,
    productViews: snapshot.productViews.filter((row) => normalizeText(row.productId) === productId).length
  };
}

function buildManifest(snapshot, environment, mockProducts, generatedAt = new Date().toISOString()) {
  const issues = [];
  const targetSchoolIds = new Set(TARGET_SCHOOLS.map((school) => school.id));
  const activeSchools = snapshot.schools.filter((school) => normalizeText(school.platformStatus) === 'active');
  const activeSchoolIds = new Set(activeSchools.map((school) => normalizeText(school._id)));
  const usersById = new Map(snapshot.users.map((user) => [normalizeText(user._id), user]));
  const usersByOpenid = new Map(snapshot.users.map((user) => [normalizeText(user.openid), user]));
  const mockById = new Map(mockProducts.map((product) => [normalizeText(product._id), product]));
  const targets = snapshot.products
    .filter((product) => targetSchoolIds.has(normalizeText(product.schoolId)) && normalizeText(product.status) === 'available')
    .sort((left, right) => normalizeText(left._id).localeCompare(normalizeText(right._id)));

  if (activeSchoolIds.size !== TARGET_SCHOOLS.length
    || TARGET_SCHOOLS.some((school) => !activeSchoolIds.has(school.id))) {
    issues.push('ACTIVE_SCHOOL_SCOPE_DRIFT');
  }
  if (targets.length !== EXPECTED_TARGET_COUNT) issues.push('TARGET_COUNT_DRIFT');
  const perProduct = targets.map((product) => {
    const productId = normalizeText(product._id);
    const relations = relationCounts(productId, snapshot);
    const sellerAvailable = productSellerAvailable(product, usersById, usersByOpenid);
    const origin = classifyOrigin(product, mockById);
    const hasHistory = Object.values(relations).some((count) => count > 0);
    return {
      productId,
      schoolId: normalizeText(product.schoolId),
      currentStatus: normalizeText(product.status),
      expectedVersion: Number.isInteger(Number(product.version)) ? Number(product.version) : null,
      sourceVersionPresent: Number.isInteger(Number(product.version)),
      sellerUserAvailable: sellerAvailable,
      origin,
      relationshipClass: hasHistory ? 'requires-snapshot-preservation' : 'safe-to-offline',
      relations,
      proposedMutation: {
        operation: 'controlled-status-transition',
        from: 'available',
        to: 'offline',
        setOfflineAt: 'serverDate',
        setUpdatedAt: 'serverDate',
        nextVersion: Number.isInteger(Number(product.version)) ? Number(product.version) + 1 : 1
      }
    };
  });
  const invalidSellerTargets = perProduct.filter((product) => !product.sellerUserAvailable);
  if (invalidSellerTargets.length !== 13) issues.push('INVALID_SELLER_TARGET_COUNT_DRIFT');
  if (invalidSellerTargets.some((product) => product.origin !== 'seed/mock')) {
    issues.push('INVALID_SELLER_ORIGIN_UNKNOWN');
  }
  const availableOutsideScope = snapshot.products.filter((product) => (
    normalizeText(product.status) === 'available' && !targetSchoolIds.has(normalizeText(product.schoolId))
  ));
  if (availableOutsideScope.length > 0) issues.push('AVAILABLE_PRODUCT_OUTSIDE_APPROVED_SCOPE');
  const reservedProducts = snapshot.products.filter((product) => normalizeText(product.status) === 'reserved');
  if (reservedProducts.length > 0) issues.push('RESERVED_PUBLIC_PRODUCT_PRESENT');

  const allKnownProductIds = new Set(snapshot.products.map((product) => normalizeText(product._id)));
  const relationshipOrphans = {
    favorites: snapshot.favorites.filter((row) => normalizeText(row.productId) && !allKnownProductIds.has(normalizeText(row.productId))).length,
    conversations: snapshot.conversations.filter((row) => {
      const productId = normalizeText(row.lastProductId) || normalizeText(row.productId);
      const preservedId = snapshotProductId(row.lastProductSnapshot)
        || snapshotProductId(row.productSnapshot);
      return productId && !allKnownProductIds.has(productId) && !preservedId;
    }).length,
    messages: snapshot.messages.filter((row) => [...messageProductIds(row)].some((id) => !allKnownProductIds.has(id))).length,
    appointments: snapshot.appointments.filter((row) => normalizeText(row.productId) && !allKnownProductIds.has(normalizeText(row.productId))).length,
    productViews: snapshot.productViews.filter((row) => normalizeText(row.productId) && !allKnownProductIds.has(normalizeText(row.productId))).length
  };
  const conversationReferenceDiagnostics = snapshot.conversations.reduce((counts, row) => {
    const productId = normalizeText(row.lastProductId) || normalizeText(row.productId);
    if (!productId || allKnownProductIds.has(productId)) return counts;
    counts.missingLiveProduct += 1;
    const lastSnapshotId = snapshotProductId(row.lastProductSnapshot);
    const productSnapshotId = snapshotProductId(row.productSnapshot);
    if (productSnapshotId || lastSnapshotId) counts.snapshotPresent += 1;
    if (productSnapshotId === productId || lastSnapshotId === productId) counts.snapshotMatches += 1;
    if (!productSnapshotId && !lastSnapshotId) counts.snapshotMissing += 1;
    return counts;
  }, { missingLiveProduct: 0, snapshotPresent: 0, snapshotMatches: 0, snapshotMissing: 0 });
  if (Object.values(relationshipOrphans).some((count) => count > 0)) issues.push('PREEXISTING_RELATIONSHIP_ORPHAN');

  const statusCounts = countBy(snapshot.products, 'status');
  const schoolGrouping = TARGET_SCHOOLS.map((school) => {
    const records = snapshot.products.filter((product) => normalizeText(product.schoolId) === school.id);
    return { schoolId: school.id, name: school.name, total: records.length, statusCounts: countBy(records, 'status') };
  });
  const noSchoolProducts = snapshot.products.filter((product) => !normalizeText(product.schoolId));
  const relationTotals = perProduct.reduce((totals, product) => {
    for (const [key, value] of Object.entries(product.relations)) totals[key] = (totals[key] || 0) + value;
    return totals;
  }, {});
  const targetIds = perProduct.map((product) => product.productId);
  const beforeSnapshot = perProduct.map((product) => ({
    productId: product.productId,
    schoolId: product.schoolId,
    status: product.currentStatus,
    version: product.expectedVersion,
    relations: product.relations
  }));
  const expectedStatusCounts = { ...statusCounts };
  expectedStatusCounts.available = 0;
  expectedStatusCounts.offline = Number(statusCounts.offline || 0) + targets.length;

  return {
    schemaVersion: 1,
    mode: 'FINAL_RELEASE_STEP_2A_ZERO_WRITE_DRY_RUN',
    generatedAt,
    write: false,
    environment: {
      ...publicSummary(environment),
      fingerprintSha256: sha256(`production:${environment.environmentId}:${environment.appId}`)
    },
    safety: {
      databaseCommandAllowlist: ['QUERY'],
      expectedTargetCountLock: EXPECTED_TARGET_COUNT,
      exactSchoolScopeLock: TARGET_SCHOOLS,
      batchSizeCapForFutureStep2B: 20,
      hardDeleteAllowed: false,
      relationDeletionAllowed: false,
      publicStatuses: PUBLIC_STATUSES
    },
    inventory: {
      productsTotal: snapshot.products.length,
      statusCounts,
      noSchoolLegacy: { total: noSchoolProducts.length, statusCounts: countBy(noSchoolProducts, 'status') },
      exactSchoolGrouping: schoolGrouping
    },
    cleanupTarget: {
      targetAvailableCount: perProduct.length,
      targetIds,
      targetIdsSha256: sha256(targetIds.join('\n')),
      beforeSnapshotSha256: sha256(stableStringify(beforeSnapshot)),
      invalidSellerCount: invalidSellerTargets.length,
      invalidSellerProductIds: invalidSellerTargets.map((product) => product.productId),
      relationTotals,
      perProduct
    },
    relationshipIntegrity: {
      before: relationshipOrphans,
      conversationReferenceDiagnostics,
      destructiveRelationMutationCount: 0
    },
    expectedPostState: {
      productsTotal: snapshot.products.length,
      statusCounts: expectedStatusCounts,
      availableTotal: 0,
      schoolAvailable: Object.fromEntries(TARGET_SCHOOLS.map((school) => [school.id, 0])),
      invalidSellerAvailable: 0,
      noSchoolLegacyAvailable: 0,
      publicMarketVisibleProducts: 0,
      conversationOrphans: relationshipOrphans.conversations,
      messageProductContextFailures: relationshipOrphans.messages,
      appointmentProductRelationFailures: relationshipOrphans.appointments,
      historicalRelationsPreserved: true
    },
    safeToApply: issues.length === 0,
    issues
  };
}

function loadSnapshot(environmentId) {
  return Object.fromEntries(Object.entries(PROJECTIONS).map(([collectionName, projection]) => [
    collectionName,
    queryAll(environmentId, collectionName, projection)
  ]));
}

function loadMockProducts() {
  const data = require('../mock/products');
  const products = Array.isArray(data) ? data : (data.PRODUCTS || data.products || []);
  return products.map(normalizeMockProduct);
}

function writeManifest(outputPath, manifest) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const environment = runPreflight({ environmentName: 'production', action: 'audit' });
  if (environment.write !== false) fail('preflight did not prove write=false', 'READ_ONLY_PREFLIGHT_FAILED');
  const snapshot = loadSnapshot(environment.environmentId);
  const manifest = buildManifest(snapshot, environment, loadMockProducts());
  writeManifest(options.output, manifest);
  process.stdout.write(`${JSON.stringify({
    environment: publicSummary(environment),
    write: manifest.write,
    productsTotal: manifest.inventory.productsTotal,
    targetAvailableCount: manifest.cleanupTarget.targetAvailableCount,
    targetIdsSha256: manifest.cleanupTarget.targetIdsSha256,
    invalidSellerCount: manifest.cleanupTarget.invalidSellerCount,
    safeToApply: manifest.safeToApply,
    issues: manifest.issues,
    manifest: path.relative(ROOT, options.output).replace(/\\/g, '/')
  }, null, 2)}\n`);
  if (!manifest.safeToApply) process.exitCode = 2;
  return manifest;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code || 'CLEANUP_DRY_RUN_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_OUTPUT,
  EXPECTED_TARGET_COUNT,
  TARGET_SCHOOLS,
  PROJECTIONS,
  queryAll,
  loadSnapshot,
  parseArguments,
  stableStringify,
  normalizeMockProduct,
  exactMockMatch,
  classifyOrigin,
  relationCounts,
  buildManifest,
  main
};
