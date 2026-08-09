const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const orphanReview = require('./phase-18-orphan-reserved-review');
const migrationCore = require('./phase-18-data-migration-core');
const cutoverCore = require('./phase-18-final-cutover-core');

const MODE = 'phase-22-finalization-read-only';
const PUBLIC_STATUSES = new Set(['available', 'reserved']);
const KNOWN_STATUSES = ['available', 'reserved', 'offline', 'sold', 'deleted', 'draft'];
const TEST_PATTERN = /(?:阶段\s*\d+|测试|验收|验证|test|demo|mock)/i;
const REQUIRED_PRODUCT_INDEXES = [
  'idx_school_status_createdAt_id',
  'idx_school_status_favorite_view_createdAt_id',
  'idx_school_status_price_asc_createdAt_id',
  'idx_school_status_price_desc_createdAt_id',
  'idx_school_status_category_createdAt_id',
  'idx_school_status_category_favorite_view_createdAt_id',
  'idx_school_status_category_price_asc_createdAt_id',
  'idx_school_status_category_price_desc_createdAt_id',
  'idx_seller_school_status_createdAt_id'
];

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stableHash(records) {
  return sha256(JSON.stringify([...records].sort((left, right) => (
    normalizeText(left && left._id).localeCompare(normalizeText(right && right._id))
  ))));
}

function countBy(records, getter) {
  return records.reduce((result, record) => {
    const key = getter(record);
    result[key] = Number(result[key] || 0) + 1;
    return result;
  }, {});
}

function schoolState(record, schoolById, options = {}) {
  const schoolId = normalizeText(record && record.schoolId);
  const schoolName = normalizeText(record && record.schoolName);
  const school = schoolById.get(schoolId);
  const referenceValid = Boolean(
    /^s_[0-9a-f]{32}$/.test(schoolId)
    && school
    && school.platformStatus === 'active'
    && school.officialStatus === 'valid'
    && normalizeText(school.name)
  );
  const namePresent = Boolean(schoolName);
  const nameMatches = Boolean(
    referenceValid && schoolName === normalizeText(school.name)
  );
  return {
    schoolId,
    schoolName,
    school,
    missing: !schoolId,
    referenceValid,
    namePresent,
    nameMatches,
    ready: Boolean(
      referenceValid
      && namePresent
      && (options.requireCurrentName !== true || nameMatches)
    )
  };
}

function findSeller(product, snapshot) {
  return snapshot.users.find((user) => (
    normalizeText(product.sellerId) && user._id === product.sellerId
  )) || snapshot.users.find((user) => (
    normalizeText(product.sellerOpenid) && user.openid === product.sellerOpenid
  )) || null;
}

function classifyUnassignedProduct(product, snapshot, schoolById) {
  const audit = orphanReview.buildProductAudit(product, snapshot);
  const seller = findSeller(product, snapshot);
  const sellerSchool = schoolState(seller || {}, schoolById, {
    requireCurrentName: true
  });
  const campus = normalizeText(product.campus);
  const createdAt = product.createdAt ? new Date(product.createdAt).getTime() : NaN;
  const selectedAt = seller && seller.schoolSelectedAt
    ? new Date(seller.schoolSelectedAt).getTime()
    : NaN;
  const relationships = audit.relationships;
  const relationCounts = {
    favorites: relationships.favorites.records,
    conversations: relationships.conversations.records,
    messages: relationships.messages.records,
    appointments: relationships.appointments.records,
    productViews: relationships.views.records
  };
  const hasHistoricalRelation = Boolean(
    relationCounts.favorites
    || relationCounts.conversations
    || relationCounts.messages
    || relationCounts.appointments
  );
  const isHistoricalSeed = audit.immutableHistoricalSeedFingerprint.exactMatch
    || audit.maintenance.authorizedOffline;
  const isRecognizableTest = isHistoricalSeed
    || TEST_PATTERN.test(normalizeText(product.title));
  const hasMedia = Boolean(audit.media.imageCount || audit.media.videoPresent);
  const evidenceConflict = Boolean(
    sellerSchool.ready && campus && campus !== normalizeText(sellerSchool.school.name)
  );
  const createdBeforeSelection = Boolean(
    Number.isFinite(createdAt)
    && Number.isFinite(selectedAt)
    && createdAt < selectedAt
  );

  let classification = 'T1';
  let decision = 'preserve-unassigned';
  if (product.status === 'deleted') {
    classification = 'T5';
    decision = 'preserve-soft-deleted';
  } else if (hasHistoricalRelation) {
    classification = 'T2';
    decision = 'preserve-unassigned-with-history';
  } else if (isHistoricalSeed && !hasMedia && relationCounts.productViews === 0) {
    classification = 'T3';
    decision = 'cleanup-candidate-only-no-delete-authority';
  } else if (
    isRecognizableTest
    || product.status === 'sold'
    || hasMedia
    || relationCounts.productViews > 0
    || evidenceConflict
  ) {
    classification = 'T4';
    decision = 'preserve-unassigned-needs-human-evidence';
  }

  return {
    digest: orphanReview.productDigest(product._id),
    status: KNOWN_STATUSES.includes(product.status) ? product.status : 'other',
    classification,
    public: PUBLIC_STATUSES.has(product.status),
    relationCounts,
    hasHistoricalRelation,
    hasMedia,
    recognizableTestOrFixture: isRecognizableTest,
    evidence: evidenceConflict
      ? 'conflicting-non-authoritative-clues'
      : (createdBeforeSelection
        ? 'owner-current-school-is-later-than-product'
        : 'insufficient-authoritative-history'),
    deterministicSchoolEvidence: false,
    migrationCandidate: false,
    decision
  };
}

function buildHistoricalMigrationAudit(snapshot, schoolById, privateEvidence) {
  const userCandidates = privateEvidence
    && privateEvidence.users
    && Array.isArray(privateEvidence.users.candidates)
    ? privateEvidence.users.candidates
    : [];
  const productCandidates = privateEvidence
    && privateEvidence.products
    && Array.isArray(privateEvidence.products.candidates)
    ? privateEvidence.products.candidates
    : [];
  const userById = new Map(snapshot.users.map((item) => [item._id, item]));
  const productById = new Map(snapshot.products.map((item) => [item._id, item]));
  const targetSchoolId = normalizeText(
    privateEvidence && privateEvidence.targetSchool && privateEvidence.targetSchool.id
  );
  const targetSchoolName = normalizeText(
    privateEvidence && privateEvidence.targetSchool && privateEvidence.targetSchool.name
  );
  const users = userCandidates.map((candidate) => userById.get(candidate.userId)).filter(Boolean);
  const products = productCandidates.map((candidate) => productById.get(candidate.productId)).filter(Boolean);
  const userStates = users.map((user) => schoolState(user, schoolById, {
    requireCurrentName: true
  }));
  const productStates = products.map((product) => schoolState(product, schoolById));
  return {
    privateEvidencePresent: Boolean(privateEvidence),
    targetSchool: {
      id: targetSchoolId ? migrationCore.maskId(targetSchoolId) : '',
      name: targetSchoolName,
      stillActiveAndValid: Boolean(
        targetSchoolId
        && schoolById.get(targetSchoolId)
        && schoolById.get(targetSchoolId).platformStatus === 'active'
        && schoolById.get(targetSchoolId).officialStatus === 'valid'
      )
    },
    users: {
      authorized: migrationCore.EXPECTED_MISSING_USERS,
      evidenceCandidates: userCandidates.length,
      present: users.length,
      currentValidSchool: userStates.filter((state) => state.ready).length,
      currentAtOriginalMigrationSchool: users.filter((user) => (
        normalizeText(user.schoolId) === targetSchoolId
      )).length,
      laterLegitimateSchoolChanges: users.filter((user) => (
        schoolState(user, schoolById, { requireCurrentName: true }).ready
        && normalizeText(user.schoolId) !== targetSchoolId
      )).length,
      schoolVersionAtLeastOne: users.filter((user) => Number(user.schoolVersion) >= 1).length,
      changed: 0,
      writesExecuted: false
    },
    products: {
      authorized: migrationCore.EXPECTED_PUBLIC_PRODUCTS,
      evidenceCandidates: productCandidates.length,
      present: products.length,
      fixedAtOriginalMigrationSchool: products.filter((product) => (
        normalizeText(product.schoolId) === targetSchoolId
        && normalizeText(product.schoolName) === targetSchoolName
      )).length,
      currentSchoolReferenceValid: productStates.filter((state) => state.ready).length,
      statusCounts: countBy(products, (product) => (
        KNOWN_STATUSES.includes(product.status) ? product.status : 'other'
      )),
      changed: 0,
      skipped: products.length,
      writesExecuted: false
    }
  };
}

function summarizeFunction(detail, localSource) {
  const remoteSource = String(detail && detail.CodeInfo || '');
  return {
    status: detail && detail.Status || '',
    runtime: detail && detail.Runtime || '',
    handler: detail && detail.Handler || '',
    timeout: Number(detail && detail.Timeout || 0),
    memorySize: Number(detail && detail.MemorySize || 0),
    localSha256: cutoverCore.sha256(localSource),
    remoteSha256: remoteSource ? cutoverCore.sha256(remoteSource) : '',
    hashMatches: Boolean(remoteSource)
      && cutoverCore.sha256(localSource) === cutoverCore.sha256(remoteSource)
  };
}

function buildNoWriteProof(before, after) {
  const names = Object.keys(orphanReview.COLLECTION_PROJECTIONS);
  const countsBefore = Object.fromEntries(names.map((name) => [name, before[name].length]));
  const countsAfter = Object.fromEntries(names.map((name) => [name, after[name].length]));
  const digestsBefore = Object.fromEntries(names.map((name) => [name, stableHash(before[name])]));
  const digestsAfter = Object.fromEntries(names.map((name) => [name, stableHash(after[name])]));
  return {
    countsBefore,
    countsAfter,
    projectedSnapshotDigestsBefore: digestsBefore,
    projectedSnapshotDigestsAfter: digestsAfter,
    countsUnchanged: names.every((name) => countsBefore[name] === countsAfter[name]),
    projectedSnapshotsUnchanged: names.every((name) => digestsBefore[name] === digestsAfter[name]),
    databaseWriteApiCalled: false,
    transactionExecuted: false,
    migrationApplied: false,
    fixtureCreated: false,
    dataDeleted: false
  };
}

function createReport(before, after, context) {
  const schoolById = new Map(before.schools.map((school) => [school._id, school]));
  const users = before.users.map((user) => ({
    user,
    state: schoolState(user, schoolById, { requireCurrentName: true })
  }));
  const products = before.products.map((product) => ({
    product,
    state: schoolState(product, schoolById)
  }));
  const publicProducts = products.filter(({ product }) => PUBLIC_STATUSES.has(product.status));
  const unassignedProducts = products.filter(({ state }) => !state.ready);
  const unassignedIds = new Set(unassignedProducts.map(({ product }) => product._id));
  const unassignedCandidates = unassignedProducts
    .map(({ product }) => classifyUnassignedProduct(product, before, schoolById))
    .sort((left, right) => left.digest.localeCompare(right.digest));
  const activeUnassignedAppointments = before.appointments.filter((appointment) => (
    appointment.isDeleted !== true
    && ['pending', 'accepted'].includes(appointment.status)
    && unassignedIds.has(appointment.productId)
  )).length;
  const historicalMigrations = buildHistoricalMigrationAudit(
    before,
    schoolById,
    context.privateEvidence
  );
  const noWriteProof = buildNoWriteProof(before, after);
  const indexNames = new Set(context.productIndexes.map((index) => index.name));
  const blockers = [];
  const publicReady = publicProducts.every(({ state }) => state.ready);
  if (!publicReady) blockers.push('PUBLIC_PRODUCT_NOT_STRICT_READY');
  if (activeUnassignedAppointments > 0) blockers.push('ACTIVE_APPOINTMENT_ON_UNASSIGNED_PRODUCT');
  if (users.some(({ user, state }) => user.status === 'active' && !state.ready)) {
    blockers.push('ACTIVE_USER_SCHOOL_NOT_READY');
  }
  if (unassignedCandidates.some((candidate) => candidate.migrationCandidate)) {
    blockers.push('NEW_MIGRATION_CANDIDATE_REQUIRES_AUTHORIZATION');
  }
  if (!noWriteProof.countsUnchanged || !noWriteProof.projectedSnapshotsUnchanged) {
    blockers.push('PRODUCTION_PROJECTION_CHANGED_DURING_AUDIT');
  }
  if (
    historicalMigrations.users.evidenceCandidates !== migrationCore.EXPECTED_MISSING_USERS
    || historicalMigrations.users.present !== migrationCore.EXPECTED_MISSING_USERS
    || historicalMigrations.users.currentValidSchool !== migrationCore.EXPECTED_MISSING_USERS
    || historicalMigrations.products.evidenceCandidates !== migrationCore.EXPECTED_PUBLIC_PRODUCTS
    || historicalMigrations.products.present !== migrationCore.EXPECTED_PUBLIC_PRODUCTS
    || historicalMigrations.products.fixedAtOriginalMigrationSchool !== migrationCore.EXPECTED_PUBLIC_PRODUCTS
  ) {
    blockers.push('HISTORICAL_MIGRATION_EVIDENCE_INCONSISTENT');
  }
  if (!REQUIRED_PRODUCT_INDEXES.every((name) => indexNames.has(name))) {
    blockers.push('REQUIRED_PRODUCT_INDEX_MISSING');
  }
  if (context.productsAcl !== 'ADMINONLY') blockers.push('PRODUCTS_ACL_NOT_ADMINONLY');
  if (!context.productQueryConfigMatchesFinal) blockers.push('STRICT_CONFIG_NOT_FINAL');
  if (!context.functions.productQuery.hashMatches) blockers.push('PRODUCT_QUERY_REMOTE_HASH_MISMATCH');
  if (!context.functions.manageProduct.hashMatches) blockers.push('MANAGE_PRODUCT_REMOTE_HASH_MISMATCH');

  return {
    schemaVersion: 1,
    mode: MODE,
    generatedAt: new Date().toISOString(),
    target: `cloud:${context.targetMasked}`,
    privacy: 'aggregate-and-stable-digest-only; no raw ids, identities, content, locations or media URLs',
    collections: noWriteProof.countsBefore,
    schools: {
      total: before.schools.length,
      platformStatusCounts: countBy(before.schools, (school) => normalizeText(school.platformStatus) || 'missing'),
      activeAndOfficialValid: before.schools.filter((school) => (
        school.platformStatus === 'active' && school.officialStatus === 'valid'
      )).length
    },
    users: {
      total: users.length,
      active: users.filter(({ user }) => user.status === 'active').length,
      validCurrentSchool: users.filter(({ state }) => state.ready).length,
      invalidOrMissingCurrentSchool: users.filter(({ state }) => !state.ready).length,
      schoolNameMismatch: users.filter(({ state }) => state.referenceValid && !state.nameMatches).length
    },
    products: {
      total: products.length,
      statusCounts: countBy(products, ({ product }) => (
        KNOWN_STATUSES.includes(product.status) ? product.status : 'other'
      )),
      public: publicProducts.length,
      publicStrictReady: publicProducts.filter(({ state }) => state.ready).length,
      publicNotStrictReady: publicProducts.filter(({ state }) => !state.ready).length,
      nonPublic: products.length - publicProducts.length,
      withValidSchool: products.filter(({ state }) => state.ready).length,
      withoutValidSchool: unassignedProducts.length,
      schoolNameSnapshotMismatch: products.filter(({ state }) => (
        state.referenceValid && state.namePresent && !state.nameMatches
      )).length
    },
    remainingUnassigned: {
      total: unassignedCandidates.length,
      public: unassignedCandidates.filter((item) => item.public).length,
      statusCounts: countBy(unassignedCandidates, (item) => item.status),
      classificationCounts: countBy(unassignedCandidates, (item) => item.classification),
      productsWithHistoricalRelations: unassignedCandidates.filter((item) => item.hasHistoricalRelation).length,
      activeAppointments: activeUnassignedAppointments,
      deterministicSchoolEvidence: unassignedCandidates.filter((item) => item.deterministicSchoolEvidence).length,
      migrationCandidates: unassignedCandidates.filter((item) => item.migrationCandidate).length,
      candidates: unassignedCandidates,
      decision: 'preserve non-public records without authoritative school evidence'
    },
    historicalMigrations,
    strictMarket: {
      publicReadinessRatio: publicProducts.length
        ? Number((publicProducts.filter(({ state }) => state.ready).length / publicProducts.length).toFixed(6))
        : 1,
      config: context.productQueryConfig,
      configMatchesFinal: context.productQueryConfigMatchesFinal,
      productIndexCount: context.productIndexes.length,
      requiredIndexesPresent: REQUIRED_PRODUCT_INDEXES.every((name) => indexNames.has(name)),
      productsAcl: context.productsAcl
    },
    functions: context.functions,
    noWriteProof,
    dataImpact: {
      usersChanged: 0,
      productsChanged: 0,
      favoritesChanged: 0,
      conversationsChanged: 0,
      messagesChanged: 0,
      appointmentsChanged: 0,
      productViewsChanged: 0,
      schoolsChanged: 0,
      fixturesCreated: 0,
      migrationsApplied: 0,
      aclChanged: false,
      indexesChanged: false
    },
    completionGate: {
      blockers,
      passed: blockers.length === 0
    }
  };
}

function parseArguments(argv) {
  const options = { describeTarget: false, confirmTarget: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--describe-target') options.describeTarget = true;
    else if (value === '--confirm-target') options.confirmTarget = normalizeText(argv[++index]);
    else if (value === '--output') options.output = normalizeText(argv[++index]);
    else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

async function runAudit(options = {}) {
  const environmentId = cutoverCore.loadEnvironmentId();
  const targetMasked = cutoverCore.maskEnvironmentId(environmentId);
  if (options.describeTarget) {
    return {
      schemaVersion: 1,
      mode: MODE,
      target: `cloud:${targetMasked}`,
      confirmationRequired: true,
      databaseAccessed: false,
      writeCapabilities: false
    };
  }
  if (options.confirmTarget !== targetMasked) {
    const error = new Error('explicit masked target confirmation is required before production reads');
    error.code = 'TARGET_ENV_CONFIRMATION_REQUIRED';
    throw error;
  }

  const root = path.resolve(__dirname, '..');
  const productQuerySource = fs.readFileSync(
    path.join(root, 'cloudfunctions', 'productQuery', 'index.js'),
    'utf8'
  );
  const manageProductSource = fs.readFileSync(
    path.join(root, 'cloudfunctions', 'manageProduct', 'index.js'),
    'utf8'
  );
  const before = orphanReview.readSnapshot(environmentId);
  const [productQueryDetail, manageProductDetail, productsAcl] = await Promise.all([
    cutoverCore.readFunctionDetail(environmentId, 'productQuery'),
    cutoverCore.readFunctionDetail(environmentId, 'manageProduct'),
    cutoverCore.readProductsAcl(environmentId)
  ]);
  const productIndexes = cutoverCore.readProductIndexes(environmentId);
  const after = orphanReview.readSnapshot(environmentId);
  const productQueryConfig = cutoverCore.sourceConfig(productQuerySource);
  return createReport(before, after, {
    targetMasked,
    privateEvidence: migrationCore.loadPrivateResult(),
    productIndexes,
    productsAcl,
    productQueryConfig,
    productQueryConfigMatchesFinal: Object.entries(cutoverCore.FINAL_CONFIG).every(
      ([key, value]) => productQueryConfig[key] === value
    ),
    functions: {
      productQuery: summarizeFunction(productQueryDetail, productQuerySource),
      manageProduct: summarizeFunction(manageProductDetail, manageProductSource)
    }
  });
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await runAudit(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      fs.writeFileSync(path.resolve(options.output), output, {
        encoding: 'utf8',
        mode: 0o600
      });
    }
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      success: false,
      code: error.code || 'PHASE_22_FINALIZATION_AUDIT_FAILED',
      message: error.message
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MODE,
  REQUIRED_PRODUCT_INDEXES,
  schoolState,
  classifyUnassignedProduct,
  buildHistoricalMigrationAudit,
  buildNoWriteProof,
  createReport,
  parseArguments,
  runAudit
};
