const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runNoSql,
  extractCommandResults,
  extractDocuments,
  decodeExtendedJson
} = require('./schools/cloud-cli');
const review = require('./phase-18-orphan-reserved-review');

const MODE = 'phase-18-orphan-reserved-to-offline-maintenance';
const OPERATION_TYPE = 'orphan_reserved_to_offline';
const TARGET_DIGEST = 'p#56853a8ed6';
const MUTATION_ID_PATTERN =
  /^maintenance-phase18-orphan-reserved-offline-[0-9a-f]{24,64}$/;
const AUTHORIZED_FIELDS = new Set([
  'status',
  'offlineAt',
  'updatedAt',
  'version',
  'maintenance'
]);
const FORBIDDEN_ARGUMENTS = new Set([
  '--status',
  '--available',
  '--sold',
  '--deleted',
  '--soft-delete',
  '--product-id',
  '--product-ids',
  '--filter',
  '--query',
  '--batch',
  '--migrate'
]);
const PRODUCT_FINGERPRINT_FIELDS = [
  '_id',
  'title',
  'description',
  'price',
  'originalPrice',
  'categoryId',
  'condition',
  'status',
  'favoriteCount',
  'viewCount',
  'createdAt',
  'updatedAt'
];

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function mutationDigest(mutationId) {
  return `m#${sha256(mutationId).slice(0, 12)}`;
}

function hasOwn(record, field) {
  return Object.prototype.hasOwnProperty.call(record || {}, field);
}

function safeDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mongoDate(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    throw new Error('invalid date precondition');
  }
  return {
    $date: {
      $numberLong: String(time)
    }
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key])
    ])
  );
}

function stableHash(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function omitAuthorizedFields(product) {
  return Object.fromEntries(
    Object.entries(product || {}).filter(
      ([field]) => !AUTHORIZED_FIELDS.has(field)
    )
  );
}

function collectionHashes(snapshot) {
  return Object.fromEntries(
    Object.keys(review.COLLECTION_PROJECTIONS).map((name) => [
      name,
      stableHash(
        [...snapshot[name]].sort((left, right) => (
          normalizeText(left && left._id).localeCompare(
            normalizeText(right && right._id)
          )
        ))
      )
    ])
  );
}

function collectionCounts(snapshot) {
  return Object.fromEntries(
    Object.keys(review.COLLECTION_PROJECTIONS).map((name) => [
      name,
      snapshot[name].length
    ])
  );
}

function findTarget(snapshot, targetDigest) {
  return snapshot.products.filter(
    (product) => review.productDigest(product._id) === targetDigest
  );
}

function relationshipTotal(productAudit) {
  const relationships = productAudit.relationships;
  return relationships.favorites.records
    + relationships.conversations.records
    + relationships.messages.records
    + relationships.appointments.records
    + relationships.views.records
    + productAudit.media.imageCount
    + (productAudit.media.videoPresent ? 1 : 0)
    + productAudit.media.cleanupFileCount;
}

function activeAppointmentCount(snapshot) {
  return snapshot.appointments.filter((appointment) => (
    appointment.isDeleted !== true
    && ['pending', 'accepted'].includes(appointment.status)
  )).length;
}

function createPreflight(snapshot, targetDigest, mutationId) {
  const matches = findTarget(snapshot, targetDigest);
  if (matches.length !== 1) {
    const error = new Error(
      `target digest must match exactly one product; matched ${matches.length}`
    );
    error.code = 'TARGET_DIGEST_NOT_UNIQUE';
    throw error;
  }
  const product = matches[0];
  const productAudit = review.buildProductAudit(product, snapshot);
  const fingerprint = review.fingerprintAudit(product);
  const broader = review.findBroaderInconsistencies(snapshot, product._id);
  const reasons = [];
  const mustBeAbsent = [
    'version',
    'reservedAppointmentId',
    'reservedAt',
    'offlineAt',
    'soldAt',
    'deletedAt',
    'lastMutationId',
    'maintenance',
    'sellerOpenid',
    'schoolId',
    'schoolName'
  ];

  if (!fingerprint.exactMatch) {
    reasons.push('HISTORICAL_SEED_FINGERPRINT_MISMATCH');
  }
  if (product.status !== 'reserved') {
    reasons.push('TARGET_STATUS_NOT_RESERVED');
  }
  mustBeAbsent.forEach((field) => {
    if (hasOwn(product, field)) {
      reasons.push(`FIELD_MUST_BE_ABSENT:${field}`);
    }
  });
  if (relationshipTotal(productAudit) !== 0) {
    reasons.push('TARGET_RELATIONSHIP_BASELINE_CHANGED');
  }
  if (productAudit.seller.recordExists) {
    reasons.push('REAL_SELLER_APPEARED');
  }
  if (productAudit.relationships.messages.appointmentAcceptedMessages > 0) {
    reasons.push('APPOINTMENT_ACCEPTED_MESSAGE_APPEARED');
  }
  if (activeAppointmentCount(snapshot) !== 0) {
    reasons.push('GLOBAL_ACTIVE_APPOINTMENT_APPEARED');
  }
  if (productAudit.relationships.appointments.records !== 0) {
    reasons.push('TARGET_APPOINTMENT_HISTORY_APPEARED');
  }
  if (!broader.targetIsOnlyOrphan) {
    reasons.push('ORPHAN_RESERVED_SCOPE_CHANGED');
  }
  if (broader.acceptedWithoutMatchingReservedCount !== 0) {
    reasons.push('OTHER_APPOINTMENT_PRODUCT_INCONSISTENCY');
  }

  const safe = {
    targetDigest,
    mutationDigest: mutationDigest(mutationId),
    uniqueness: {
      matchedRecords: matches.length,
      unique: matches.length === 1
    },
    fingerprint: {
      matchedFields: fingerprint.matchedFields,
      totalFields: fingerprint.totalFields,
      exactMatch: fingerprint.exactMatch
    },
    target: {
      status: product.status,
      versionFieldAbsent: !hasOwn(product, 'version'),
      reservedAppointmentIdAbsent:
        !hasOwn(product, 'reservedAppointmentId'),
      reservedAtAbsent: !hasOwn(product, 'reservedAt'),
      offlineAtAbsent: !hasOwn(product, 'offlineAt'),
      soldAtAbsent: !hasOwn(product, 'soldAt'),
      deletedAtAbsent: !hasOwn(product, 'deletedAt'),
      maintenanceAbsent: !hasOwn(product, 'maintenance'),
      sellerOpenidAbsent: !hasOwn(product, 'sellerOpenid'),
      sellerRecordAbsent: !productAudit.seller.recordExists,
      schoolFieldsAbsent:
        !hasOwn(product, 'schoolId') && !hasOwn(product, 'schoolName'),
      favoriteCount: Number(product.favoriteCount),
      viewCount: Number(product.viewCount),
      images: productAudit.media.imageCount,
      videoPresent: productAudit.media.videoPresent,
      mediaCleanupTasks: productAudit.media.cleanupFileCount
        + (productAudit.media.cleanupTaskPending ? 1 : 0)
    },
    relationships: {
      favorites: productAudit.relationships.favorites.records,
      conversations: productAudit.relationships.conversations.records,
      messages: productAudit.relationships.messages.records,
      appointments: productAudit.relationships.appointments.records,
      productViews: productAudit.relationships.views.records,
      appointmentAcceptedMessages:
        productAudit.relationships.messages.appointmentAcceptedMessages
    },
    globalConsistency: {
      activeAppointments: activeAppointmentCount(snapshot),
      orphanReserved: broader.orphanReservedCount,
      targetIsOnlyOrphan: broader.targetIsOnlyOrphan,
      acceptedWithoutMatchingReserved:
        broader.acceptedWithoutMatchingReservedCount
    },
    writeReady: reasons.length === 0,
    rejectionReasons: reasons
  };
  return {
    product,
    productAudit,
    safe
  };
}

function buildSnapshot(snapshot, targetProduct, targetDigest, mutationId) {
  const counts = collectionCounts(snapshot);
  const hashes = collectionHashes(snapshot);
  const otherProducts = snapshot.products.filter(
    (product) => product._id !== targetProduct._id
  );
  return {
    capturedAt: new Date().toISOString(),
    targetDigest,
    mutationDigest: mutationDigest(mutationId),
    collectionCounts: counts,
    projectedCollectionDigests: hashes,
    targetNonAuthorizedFieldsDigest:
      stableHash(omitAuthorizedFields(targetProduct)),
    otherProductsDigest: stableHash(
      [...otherProducts].sort((left, right) => (
        normalizeText(left._id).localeCompare(normalizeText(right._id))
      ))
    ),
    plan: {
      operationType: OPERATION_TYPE,
      allowedFields: [...AUTHORIZED_FIELDS],
      targetStatus: 'offline',
      singleDocument: true
    }
  };
}

function safeSnapshotFileName(label, mutationId) {
  return [
    'phase-18-orphan-reserved-fix',
    label,
    mutationDigest(mutationId).replace('#', '-'),
    '.json'
  ].join('-').replace('-.json', '.json');
}

function writeSafeSnapshot(label, safeSnapshot, mutationId) {
  const fileName = safeSnapshotFileName(label, mutationId);
  const targetPath = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(
    targetPath,
    `${JSON.stringify(safeSnapshot, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600
    }
  );
  return {
    location: 'system-temp',
    fileName,
    containsSensitiveIdentifiers: false
  };
}

function buildAtomicUpdateCommand(product, mutationId) {
  const query = {
    _id: product._id,
    status: 'reserved',
    version: { $exists: false },
    reservedAppointmentId: { $exists: false },
    reservedAt: { $exists: false },
    offlineAt: { $exists: false },
    soldAt: { $exists: false },
    deletedAt: { $exists: false },
    lastMutationId: { $exists: false },
    maintenance: { $exists: false },
    sellerOpenid: { $exists: false },
    schoolId: { $exists: false },
    schoolName: { $exists: false },
    title: product.title,
    description: product.description,
    price: product.price,
    originalPrice: product.originalPrice,
    categoryId: product.categoryId,
    condition: product.condition,
    favoriteCount: product.favoriteCount,
    viewCount: product.viewCount,
    createdAt: mongoDate(product.createdAt),
    updatedAt: mongoDate(product.updatedAt)
  };
  const update = {
    $set: {
      status: 'offline',
      version: 1,
      'maintenance.type': OPERATION_TYPE,
      'maintenance.mutationId': mutationId,
      'maintenance.source': 'phase_4_seed_fixture',
      'maintenance.reason': 'orphan_reserved_test_product'
    },
    $currentDate: {
      offlineAt: true,
      updatedAt: true,
      'maintenance.appliedAt': true
    }
  };
  return {
    TableName: 'products',
    CommandType: 'UPDATE',
    Command: JSON.stringify({
      update: 'products',
      updates: [{
        q: query,
        u: update,
        multi: false,
        upsert: false
      }],
      ordered: true
    })
  };
}

function assertAtomicUpdateCommand(command) {
  if (
    !command
    || command.TableName !== 'products'
    || command.CommandType !== 'UPDATE'
  ) {
    throw new Error('maintenance command is outside the single update allowlist');
  }
  const parsed = JSON.parse(command.Command);
  if (
    parsed.update !== 'products'
    || !Array.isArray(parsed.updates)
    || parsed.updates.length !== 1
  ) {
    throw new Error('maintenance command must contain one product update');
  }
  const operation = parsed.updates[0];
  if (operation.multi !== false || operation.upsert !== false) {
    throw new Error('maintenance update must be non-multi and non-upsert');
  }
  const setFields = Object.keys(operation.u && operation.u.$set || {});
  const currentDateFields = Object.keys(
    operation.u && operation.u.$currentDate || {}
  );
  const allowedPaths = new Set([
    'status',
    'version',
    'maintenance.type',
    'maintenance.mutationId',
    'maintenance.source',
    'maintenance.reason',
    'offlineAt',
    'updatedAt',
    'maintenance.appliedAt'
  ]);
  if (
    [...setFields, ...currentDateFields].some(
      (field) => !allowedPaths.has(field)
    )
  ) {
    throw new Error('maintenance update contains a non-whitelisted field');
  }
  if (
    operation.u.$set.status !== 'offline'
    || operation.u.$set.version !== 1
    || operation.u.$set['maintenance.type'] !== OPERATION_TYPE
  ) {
    throw new Error('maintenance update contains an invalid target state');
  }
  if (
    !operation.q
    || operation.q.status !== 'reserved'
    || !operation.q._id
    || operation.q.version.$exists !== false
    || operation.q.reservedAppointmentId.$exists !== false
    || operation.q.reservedAt.$exists !== false
  ) {
    throw new Error('maintenance update lacks strict preconditions');
  }
  return true;
}

function decodeCandidate(value) {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return decodeExtendedJson(JSON.parse(value));
  } catch (error) {
    return value;
  }
}

function findNumericUpdateCount(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }
  const decoded = decodeCandidate(value);
  if (decoded !== value) {
    return findNumericUpdateCount(decoded, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const count = findNumericUpdateCount(item, depth + 1);
      if (count !== null) {
        return count;
      }
    }
    return null;
  }
  if (typeof value !== 'object') {
    return null;
  }
  for (const key of [
    'updated',
    'modified',
    'nModified',
    'modifiedCount',
    'matchedCount',
    'n'
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(value, key)
      && Number.isFinite(Number(value[key]))
    ) {
      return Number(value[key]);
    }
  }
  for (const key of ['stats', 'result', 'Result', 'data', 'Data']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const count = findNumericUpdateCount(value[key], depth + 1);
      if (count !== null) {
        return count;
      }
    }
  }
  return null;
}

function extractUpdateCount(response) {
  const results = extractCommandResults(response);
  const candidates = results.length > 0 ? results : [response];
  for (const candidate of candidates) {
    const count = findNumericUpdateCount(candidate);
    if (count !== null) {
      return count;
    }
  }
  const error = new Error('unable to determine atomic update count');
  error.code = 'UPDATE_RESULT_UNREADABLE';
  throw error;
}

function compareAfter(beforeSnapshot, afterSnapshot, beforeProduct, afterProduct) {
  const beforeCounts = collectionCounts(beforeSnapshot);
  const afterCounts = collectionCounts(afterSnapshot);
  const beforeHashes = collectionHashes(beforeSnapshot);
  const afterHashes = collectionHashes(afterSnapshot);
  const otherBefore = beforeSnapshot.products.filter(
    (product) => product._id !== beforeProduct._id
  );
  const otherAfter = afterSnapshot.products.filter(
    (product) => product._id !== afterProduct._id
  );
  const unchangedCollections = Object.keys(beforeCounts).filter(
    (name) => name !== 'products'
  );
  const allowedFieldChanges = {
    status: {
      before: beforeProduct.status,
      after: afterProduct.status,
      valid: beforeProduct.status === 'reserved'
        && afterProduct.status === 'offline'
    },
    offlineAt: {
      beforePresent: hasOwn(beforeProduct, 'offlineAt'),
      afterPresent: Boolean(safeDate(afterProduct.offlineAt)),
      valid: !hasOwn(beforeProduct, 'offlineAt')
        && Boolean(safeDate(afterProduct.offlineAt))
    },
    updatedAt: {
      before: safeDate(beforeProduct.updatedAt),
      after: safeDate(afterProduct.updatedAt),
      changed: safeDate(beforeProduct.updatedAt)
        !== safeDate(afterProduct.updatedAt)
    },
    version: {
      beforePresent: hasOwn(beforeProduct, 'version'),
      after: afterProduct.version,
      valid: !hasOwn(beforeProduct, 'version')
        && Number(afterProduct.version) === 1
    },
    maintenance: {
      beforePresent: hasOwn(beforeProduct, 'maintenance'),
      afterPresent: Boolean(afterProduct.maintenance),
      valid: !hasOwn(beforeProduct, 'maintenance')
        && Boolean(afterProduct.maintenance)
    }
  };
  const result = {
    collectionCountsBefore: beforeCounts,
    collectionCountsAfter: afterCounts,
    collectionCountsUnchanged: Object.keys(beforeCounts).every(
      (name) => beforeCounts[name] === afterCounts[name]
    ),
    collectionDigestChanges: Object.fromEntries(
      Object.keys(beforeHashes).map((name) => [
        name,
        beforeHashes[name] === afterHashes[name] ? 'unchanged' : 'changed'
      ])
    ),
    nonProductCollectionDigestsUnchanged:
      unchangedCollections.every(
        (name) => beforeHashes[name] === afterHashes[name]
      ),
    otherProductsDigestUnchanged:
      stableHash(otherBefore) === stableHash(otherAfter),
    targetNonAuthorizedFieldsDigestUnchanged:
      stableHash(omitAuthorizedFields(beforeProduct))
        === stableHash(omitAuthorizedFields(afterProduct)),
    allowedFieldChanges
  };
  result.whitelistPassed = Boolean(
    result.collectionCountsUnchanged
    && result.nonProductCollectionDigestsUnchanged
    && result.otherProductsDigestUnchanged
    && result.targetNonAuthorizedFieldsDigestUnchanged
    && Object.values(allowedFieldChanges).every((item) => (
      item.valid !== false
      && (
        !Object.prototype.hasOwnProperty.call(item, 'changed')
        || item.changed === true
      )
    ))
  );
  return result;
}

function alreadyApplied(product, mutationId) {
  return Boolean(
    product
    && product.status === 'offline'
    && Number(product.version) === 1
    && product.maintenance
    && product.maintenance.type === OPERATION_TYPE
    && product.maintenance.mutationId === mutationId
    && safeDate(product.offlineAt)
    && safeDate(product.updatedAt)
  );
}

function safeAlreadyAppliedReport(
  snapshotBefore,
  snapshotAfter,
  product,
  options,
  targetMasked
) {
  const beforeHashes = collectionHashes(snapshotBefore);
  const afterHashes = collectionHashes(snapshotAfter);
  const countsBefore = collectionCounts(snapshotBefore);
  const countsAfter = collectionCounts(snapshotAfter);
  const currentSafeSnapshot = buildSnapshot(
    snapshotAfter,
    product,
    options.productDigest,
    options.mutationId
  );
  const priorSnapshotPath = path.join(
    os.tmpdir(),
    safeSnapshotFileName('before', options.mutationId)
  );
  let priorSafeSnapshot = null;
  if (fs.existsSync(priorSnapshotPath)) {
    try {
      priorSafeSnapshot = JSON.parse(
        fs.readFileSync(priorSnapshotPath, 'utf8')
      );
    } catch (error) {
      priorSafeSnapshot = null;
    }
  }
  const nonProductCollections = Object.keys(countsAfter).filter(
    (name) => name !== 'products'
  );
  const reconciliation = priorSafeSnapshot ? {
    beforeSnapshotFound: true,
    collectionCountsUnchanged: Object.keys(countsAfter).every(
      (name) => (
        Number(priorSafeSnapshot.collectionCounts[name])
          === Number(countsAfter[name])
      )
    ),
    nonProductCollectionDigestsUnchanged:
      nonProductCollections.every((name) => (
        priorSafeSnapshot.projectedCollectionDigests[name]
          === currentSafeSnapshot.projectedCollectionDigests[name]
      )),
    otherProductsDigestUnchanged:
      priorSafeSnapshot.otherProductsDigest
        === currentSafeSnapshot.otherProductsDigest,
    targetNonAuthorizedFieldsDigestUnchanged:
      priorSafeSnapshot.targetNonAuthorizedFieldsDigest
        === currentSafeSnapshot.targetNonAuthorizedFieldsDigest
  } : {
    beforeSnapshotFound: false,
    collectionCountsUnchanged: null,
    nonProductCollectionDigestsUnchanged: null,
    otherProductsDigestUnchanged: null,
    targetNonAuthorizedFieldsDigestUnchanged: null
  };
  reconciliation.whitelistPassed = Boolean(
    reconciliation.beforeSnapshotFound
    && reconciliation.collectionCountsUnchanged
    && reconciliation.nonProductCollectionDigestsUnchanged
    && reconciliation.otherProductsDigestUnchanged
    && reconciliation.targetNonAuthorizedFieldsDigestUnchanged
  );
  const afterSnapshotFile = writeSafeSnapshot(
    'after',
    currentSafeSnapshot,
    options.mutationId
  );
  return {
    schemaVersion: 1,
    mode: MODE,
    code: 'ALREADY_APPLIED',
    generatedAt: new Date().toISOString(),
    target: `cloud:${targetMasked}`,
    targetDigest: options.productDigest,
    mutationDigest: mutationDigest(options.mutationId),
    status: product.status,
    version: Number(product.version),
    originalAtomicUpdateCount: reconciliation.whitelistPassed ? 1 : null,
    updateCountEvidence: reconciliation.whitelistPassed
      ? 'single exact-id non-multi update plus observed authorized transition and preserved before snapshot'
      : 'not inferred because the preserved before snapshot could not be reconciled',
    secondWriteExecuted: false,
    timestampsPresent: {
      offlineAt: Boolean(safeDate(product.offlineAt)),
      updatedAt: Boolean(safeDate(product.updatedAt)),
      maintenanceAppliedAt: Boolean(
        safeDate(product.maintenance && product.maintenance.appliedAt)
      )
    },
    countsBefore,
    countsAfter,
    countsUnchanged: Object.keys(countsBefore).every(
      (name) => countsBefore[name] === countsAfter[name]
    ),
    projectedSnapshotsUnchanged: Object.keys(beforeHashes).every(
      (name) => beforeHashes[name] === afterHashes[name]
    ),
    reconciliation,
    beforeSnapshotFile: {
      location: 'system-temp',
      fileName: safeSnapshotFileName('before', options.mutationId),
      containsSensitiveIdentifiers: false
    },
    afterSnapshotFile
  };
}

function parseArguments(argv) {
  const options = {
    describeTarget: false,
    confirmTarget: '',
    productDigest: '',
    mutationId: '',
    dryRun: false,
    apply: false,
    output: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (FORBIDDEN_ARGUMENTS.has(value)) {
      const error = new Error(`forbidden maintenance argument: ${value}`);
      error.code = 'FORBIDDEN_ARGUMENT';
      throw error;
    }
    if (value === '--describe-target') {
      options.describeTarget = true;
    } else if (value === '--confirm-target') {
      options.confirmTarget = normalizeText(argv[++index]);
    } else if (value === '--product-digest') {
      options.productDigest = normalizeText(argv[++index]);
    } else if (value === '--mutation-id') {
      options.mutationId = normalizeText(argv[++index]);
    } else if (value === '--dry-run') {
      options.dryRun = true;
    } else if (value === '--apply') {
      options.apply = true;
    } else if (value === '--output') {
      options.output = normalizeText(argv[++index]);
    } else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  if (options.dryRun && options.apply) {
    const error = new Error('dry-run and apply are mutually exclusive');
    error.code = 'INVALID_MODE';
    throw error;
  }
  return options;
}

function validateExecutionOptions(options, targetMasked) {
  if (options.confirmTarget !== targetMasked) {
    const error = new Error('explicit masked target confirmation is required');
    error.code = 'TARGET_ENV_CONFIRMATION_REQUIRED';
    throw error;
  }
  if (options.productDigest !== TARGET_DIGEST) {
    const error = new Error('the single authorized product digest is required');
    error.code = 'PRODUCT_DIGEST_REQUIRED';
    throw error;
  }
  if (!MUTATION_ID_PATTERN.test(options.mutationId)) {
    const error = new Error('a valid one-time mutation id is required');
    error.code = 'MUTATION_ID_REQUIRED';
    throw error;
  }
  if (!options.dryRun && !options.apply) {
    const error = new Error('explicit --dry-run or --apply is required');
    error.code = 'EXECUTION_MODE_REQUIRED';
    throw error;
  }
}

function runMaintenance(options = {}) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  if (options.describeTarget) {
    return {
      schemaVersion: 1,
      mode: MODE,
      target: `cloud:${targetMasked}`,
      confirmationRequired: true,
      productDigestRequired: true,
      mutationIdRequired: true,
      applyRequiredForWrite: true,
      databaseAccessed: false,
      writeExecuted: false
    };
  }
  validateExecutionOptions(options, targetMasked);

  const snapshotBefore = review.readSnapshot(environmentId);
  const matches = findTarget(snapshotBefore, options.productDigest);
  if (matches.length !== 1) {
    const error = new Error(
      `target digest must match exactly one product; matched ${matches.length}`
    );
    error.code = 'TARGET_DIGEST_NOT_UNIQUE';
    throw error;
  }
  const currentProduct = matches[0];
  if (alreadyApplied(currentProduct, options.mutationId)) {
    const snapshotAfter = review.readSnapshot(environmentId);
    return safeAlreadyAppliedReport(
      snapshotBefore,
      snapshotAfter,
      currentProduct,
      options,
      targetMasked
    );
  }
  if (currentProduct.status !== 'reserved') {
    const error = new Error(
      'target state changed or a different maintenance operation was applied'
    );
    error.code = 'PRECONDITION_FAILED';
    throw error;
  }

  const preflight = createPreflight(
    snapshotBefore,
    options.productDigest,
    options.mutationId
  );
  const beforeSafeSnapshot = buildSnapshot(
    snapshotBefore,
    preflight.product,
    options.productDigest,
    options.mutationId
  );
  const baseReport = {
    schemaVersion: 1,
    mode: MODE,
    code: options.dryRun ? 'DRY_RUN_OK' : 'APPLY_PENDING',
    generatedAt: new Date().toISOString(),
    target: `cloud:${targetMasked}`,
    operationType: OPERATION_TYPE,
    targetDigest: options.productDigest,
    mutationDigest: mutationDigest(options.mutationId),
    preflight: preflight.safe,
    plan: {
      allowedFields: [...AUTHORIZED_FIELDS],
      targetStatus: 'offline',
      versionAfter: 1,
      singleDocument: true,
      atomicConditionUpdate: true,
      unsupportedTargets: ['available', 'sold', 'deleted'],
      relationWrites: false,
      mediaAccessOrCleanup: false
    },
    beforeSnapshot: beforeSafeSnapshot
  };
  if (!preflight.safe.writeReady) {
    const error = new Error(
      `preconditions failed: ${preflight.safe.rejectionReasons.join(',')}`
    );
    error.code = 'PRECONDITION_FAILED';
    throw error;
  }
  if (options.dryRun) {
    return {
      ...baseReport,
      code: 'DRY_RUN_OK',
      applyAllowed: true,
      writeExecuted: false
    };
  }

  const beforeSnapshotFile = writeSafeSnapshot(
    'before',
    beforeSafeSnapshot,
    options.mutationId
  );
  const updateCommand = buildAtomicUpdateCommand(
    preflight.product,
    options.mutationId
  );
  assertAtomicUpdateCommand(updateCommand);
  const updateResponse = runNoSql(environmentId, [updateCommand]);
  const updateCount = extractUpdateCount(updateResponse);
  if (updateCount !== 1) {
    const error = new Error(
      `atomic update must affect exactly one record; affected ${updateCount}`
    );
    error.code = updateCount === 0
      ? 'PRECONDITION_FAILED'
      : 'UPDATE_CARDINALITY_VIOLATION';
    throw error;
  }

  const snapshotAfter = review.readSnapshot(environmentId);
  const afterMatches = findTarget(snapshotAfter, options.productDigest);
  if (afterMatches.length !== 1) {
    const error = new Error('target uniqueness changed after maintenance');
    error.code = 'POST_WRITE_VERIFICATION_FAILED';
    throw error;
  }
  const afterProduct = afterMatches[0];
  const comparison = compareAfter(
    snapshotBefore,
    snapshotAfter,
    preflight.product,
    afterProduct
  );
  if (
    !alreadyApplied(afterProduct, options.mutationId)
    || !comparison.whitelistPassed
  ) {
    const error = new Error(
      'post-write target or whitelist verification failed'
    );
    error.code = 'POST_WRITE_VERIFICATION_FAILED';
    throw error;
  }
  const afterProductAudit = review.buildProductAudit(
    afterProduct,
    snapshotAfter
  );
  const broaderAfter = review.findBroaderInconsistencies(
    snapshotAfter,
    afterProduct._id
  );
  const afterConsistency = {
    activeAppointments: activeAppointmentCount(snapshotAfter),
    orphanReserved: broaderAfter.orphanReservedCount,
    acceptedWithoutMatchingReserved:
      broaderAfter.acceptedWithoutMatchingReservedCount,
    targetRelationships: relationshipTotal(afterProductAudit),
    targetStatus: afterProduct.status,
    targetVersion: Number(afterProduct.version),
    targetMediaCleanupTasks:
      afterProductAudit.media.cleanupFileCount
      + (afterProductAudit.media.cleanupTaskPending ? 1 : 0)
  };
  if (
    afterConsistency.activeAppointments !== 0
    || afterConsistency.orphanReserved !== 0
    || afterConsistency.acceptedWithoutMatchingReserved !== 0
    || afterConsistency.targetRelationships !== 0
    || afterConsistency.targetStatus !== 'offline'
    || afterConsistency.targetVersion !== 1
    || afterConsistency.targetMediaCleanupTasks !== 0
  ) {
    const error = new Error('post-write global consistency check failed');
    error.code = 'POST_WRITE_CONSISTENCY_FAILED';
    throw error;
  }

  const afterSafeSnapshot = buildSnapshot(
    snapshotAfter,
    afterProduct,
    options.productDigest,
    options.mutationId
  );
  const afterSnapshotFile = writeSafeSnapshot(
    'after',
    afterSafeSnapshot,
    options.mutationId
  );
  return {
    ...baseReport,
    code: 'APPLIED',
    applied: true,
    updateCount,
    singleDocument: true,
    partialFailure: false,
    beforeSnapshotFile,
    afterSnapshotFile,
    comparison,
    afterConsistency,
    writeBoundary: {
      productsUpdated: 1,
      otherCollectionsUpdated: 0,
      deploymentExecuted: false,
      indexChanged: false,
      permissionChanged: false,
      mediaAccessedOrDeleted: false
    }
  };
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = runMaintenance(options);
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
      code: error.code || 'PHASE_18_ORPHAN_FIX_FAILED',
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
  OPERATION_TYPE,
  TARGET_DIGEST,
  MUTATION_ID_PATTERN,
  AUTHORIZED_FIELDS,
  PRODUCT_FINGERPRINT_FIELDS,
  mutationDigest,
  mongoDate,
  omitAuthorizedFields,
  createPreflight,
  buildSnapshot,
  buildAtomicUpdateCommand,
  assertAtomicUpdateCommand,
  extractUpdateCount,
  compareAfter,
  alreadyApplied,
  parseArguments,
  validateExecutionOptions,
  runMaintenance
};
