const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runNoSql,
  extractCommandResults,
  extractDocuments,
  decodeExtendedJson
} = require('./schools/cloud-cli');

const MODE = 'dry-run-read-only';
const PAGE_SIZE = 1000;
const MAX_RECORDS = 50000;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const PUBLIC_STATUSES = new Set(['available', 'reserved']);
const PRODUCT_STATUSES = [
  'available',
  'reserved',
  'offline',
  'sold',
  'deleted',
  'draft'
];
const APPOINTMENT_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'cancelled',
  'completed'
];
const COLLECTION_PROJECTIONS = {
  users: {
    _id: 1,
    openid: 1,
    status: 1,
    schoolId: 1,
    schoolName: 1,
    schoolSelectedAt: 1,
    schoolUpdatedAt: 1,
    schoolVersion: 1,
    createdAt: 1,
    updatedAt: 1
  },
  products: {
    _id: 1,
    status: 1,
    schoolId: 1,
    schoolName: 1,
    sellerId: 1,
    sellerOpenid: 1,
    campus: 1,
    title: 1,
    createdAt: 1,
    updatedAt: 1
  },
  favorites: {
    _id: 1,
    userOpenid: 1,
    productId: 1,
    createdAt: 1,
    updatedAt: 1
  },
  conversations: {
    _id: 1,
    productId: 1,
    participantAOpenid: 1,
    participantBOpenid: 1,
    productSnapshot: 1,
    lastMessageAt: 1,
    createdAt: 1,
    updatedAt: 1
  },
  messages: {
    _id: 1,
    conversationId: 1,
    senderOpenid: 1,
    type: 1,
    productId: 1,
    product: 1,
    createdAt: 1
  },
  appointments: {
    _id: 1,
    productId: 1,
    buyerOpenid: 1,
    sellerOpenid: 1,
    status: 1,
    isDeleted: 1,
    createdAt: 1,
    updatedAt: 1
  },
  productViews: {
    _id: 1,
    productId: 1,
    viewerOpenid: 1,
    createdAt: 1,
    updatedAt: 1
  },
  schools: {
    _id: 1,
    name: 1,
    officialStatus: 1,
    platformStatus: 1,
    createdAt: 1,
    updatedAt: 1
  }
};

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasOwn(record, field) {
  return Object.prototype.hasOwnProperty.call(record || {}, field);
}

function toTime(value) {
  if (!value) {
    return NaN;
  }
  const date = new Date(value);
  return date.getTime();
}

function stableHash(records) {
  const normalized = [...records].sort((left, right) => (
    normalizeText(left && left._id).localeCompare(
      normalizeText(right && right._id)
    )
  ));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

function buildFindCommand(collection, projection, skip, limit = PAGE_SIZE) {
  return {
    TableName: collection,
    CommandType: 'QUERY',
    Command: JSON.stringify({
      find: collection,
      filter: {},
      projection,
      sort: { _id: 1 },
      skip,
      limit
    })
  };
}

function buildListIndexesCommand(collection) {
  return {
    TableName: collection,
    CommandType: 'COMMAND',
    Command: JSON.stringify({
      listIndexes: collection,
      cursor: {}
    })
  };
}

function assertReadOnlyCommand(command) {
  if (!command || !['QUERY', 'COMMAND'].includes(command.CommandType)) {
    throw new Error('audit command is not read-only');
  }
  const parsed = JSON.parse(command.Command);
  const allowed = command.CommandType === 'QUERY'
    ? parsed.find === command.TableName
    : parsed.listIndexes === command.TableName;
  if (!allowed) {
    throw new Error('audit command is outside the read-only allowlist');
  }
  return true;
}

function extractQueryDocuments(response) {
  const results = extractCommandResults(response);
  if (results.length === 0) {
    return extractDocuments(response);
  }
  const documents = [];
  results.forEach((result) => {
    documents.push(...extractDocuments(result));
  });
  return documents;
}

function readCollection(environmentId, collection, projection) {
  const records = [];
  for (let skip = 0; skip < MAX_RECORDS; skip += PAGE_SIZE) {
    const command = buildFindCommand(
      collection,
      projection,
      skip,
      PAGE_SIZE
    );
    assertReadOnlyCommand(command);
    const response = runNoSql(environmentId, [command]);
    const page = extractQueryDocuments(response);
    records.push(...page);
    if (page.length < PAGE_SIZE) {
      return records;
    }
  }
  const error = new Error(`${collection} reached read safety limit`);
  error.code = 'AUDIT_READ_LIMIT';
  throw error;
}

function readSnapshot(environmentId) {
  return Object.fromEntries(
    Object.entries(COLLECTION_PROJECTIONS).map(([collection, projection]) => [
      collection,
      readCollection(environmentId, collection, projection)
    ])
  );
}

function extractIndexArray(response) {
  const results = extractCommandResults(response);
  const candidate = results.length === 1 && Array.isArray(results[0])
    ? results[0]
    : results;
  return candidate.map(decodeExtendedJson).filter((item) => (
    item && typeof item === 'object' && item.name && item.key
  ));
}

function readProductIndexes(environmentId) {
  const command = buildListIndexesCommand('products');
  assertReadOnlyCommand(command);
  const response = runNoSql(environmentId, [command]);
  return extractIndexArray(response).map((index) => ({
    name: normalizeText(index.name),
    fields: Object.entries(index.key || {}).map(([field, direction]) => ({
      field,
      direction: Number(direction) >= 0 ? 'asc' : 'desc'
    })),
    unique: index.name === '_id_' || index.unique === true
  }));
}

function schoolReferenceState(record, schoolById) {
  if (!hasOwn(record, 'schoolId')) {
    return { bucket: 'missing', authoritative: false };
  }
  if (record.schoolId === null) {
    return { bucket: 'null', authoritative: false };
  }
  if (typeof record.schoolId !== 'string') {
    return { bucket: 'wrongType', authoritative: false };
  }
  const schoolId = record.schoolId.trim();
  if (!schoolId) {
    return { bucket: 'empty', authoritative: false };
  }
  if (!SCHOOL_ID_PATTERN.test(schoolId)) {
    return { bucket: 'invalidFormat', authoritative: false };
  }
  const school = schoolById[schoolId];
  if (!school) {
    return { bucket: 'missingSchool', authoritative: false };
  }
  if (school.platformStatus !== 'active') {
    return {
      bucket: 'pendingOrInactiveSchool',
      authoritative: false,
      school
    };
  }
  if (school.officialStatus !== 'valid') {
    return {
      bucket: 'invalidOfficialSchool',
      authoritative: false,
      school
    };
  }
  const schoolName = normalizeText(record.schoolName);
  if (!schoolName || schoolName !== normalizeText(school.name)) {
    return {
      bucket: 'nameMismatch',
      authoritative: false,
      school
    };
  }
  return { bucket: 'authoritative', authoritative: true, school };
}

function createStatusCounter(values) {
  return Object.fromEntries(values.map((status) => [status, 0]));
}

function increment(object, key) {
  object[key] = Number(object[key] || 0) + 1;
}

function countDistinct(values) {
  return new Set(values.filter(Boolean)).size;
}

function buildUserAudit(snapshot, schoolById) {
  const users = snapshot.users;
  const noSchoolUsers = [];
  const schoolBuckets = {};
  const activeSchoolUsers = Object.fromEntries(
    Object.values(schoolById)
      .filter((school) => (
        school.platformStatus === 'active'
        && school.officialStatus === 'valid'
      ))
      .map((school) => [normalizeText(school.name), 0])
  );
  const authoritativeUsers = [];
  users.forEach((user) => {
    const state = schoolReferenceState(user, schoolById);
    increment(schoolBuckets, state.bucket);
    if (state.authoritative) {
      authoritativeUsers.push(user);
      increment(activeSchoolUsers, normalizeText(state.school.name));
    } else {
      noSchoolUsers.push(user);
    }
  });
  const noSchoolIds = new Set(noSchoolUsers.map((user) => user._id));
  const noSchoolOpenids = new Set(
    noSchoolUsers.map((user) => user.openid).filter(Boolean)
  );
  const noSchoolIdByOpenid = Object.fromEntries(
    noSchoolUsers
      .filter((user) => user.openid)
      .map((user) => [user.openid, user._id])
  );
  const userKey = (publicId, openId) => (
    publicId || noSchoolIdByOpenid[openId] || openId
  );
  const involvement = {
    any: new Set(),
    products: new Set(),
    favorites: new Set(),
    conversations: new Set(),
    messages: new Set(),
    appointments: new Set()
  };
  snapshot.products.forEach((record) => {
    if (
      noSchoolIds.has(record.sellerId)
      || noSchoolOpenids.has(record.sellerOpenid)
    ) {
      const key = userKey(record.sellerId, record.sellerOpenid);
      involvement.products.add(key);
      involvement.any.add(key);
    }
  });
  snapshot.favorites.forEach((record) => {
    if (noSchoolOpenids.has(record.userOpenid)) {
      const key = userKey('', record.userOpenid);
      involvement.favorites.add(key);
      involvement.any.add(key);
    }
  });
  snapshot.conversations.forEach((record) => {
    [record.participantAOpenid, record.participantBOpenid].forEach((openId) => {
      if (noSchoolOpenids.has(openId)) {
        const key = userKey('', openId);
        involvement.conversations.add(key);
        involvement.any.add(key);
      }
    });
  });
  snapshot.messages.forEach((record) => {
    if (noSchoolOpenids.has(record.senderOpenid)) {
      const key = userKey('', record.senderOpenid);
      involvement.messages.add(key);
      involvement.any.add(key);
    }
  });
  snapshot.appointments.forEach((record) => {
    [record.buyerOpenid, record.sellerOpenid].forEach((openId) => {
      if (noSchoolOpenids.has(openId)) {
        const key = userKey('', openId);
        involvement.appointments.add(key);
        involvement.any.add(key);
      }
    });
  });
  return {
    total: users.length,
    active: users.filter((user) => user.status === 'active').length,
    nonActive: users.filter((user) => user.status !== 'active').length,
    nonEmptySchoolId: users.filter((user) => (
      typeof user.schoolId === 'string' && user.schoolId.trim()
    )).length,
    schoolIdMissing: schoolBuckets.missing || 0,
    schoolIdNull: schoolBuckets.null || 0,
    schoolIdEmpty: schoolBuckets.empty || 0,
    schoolIdWrongType: schoolBuckets.wrongType || 0,
    schoolIdInvalidFormat: schoolBuckets.invalidFormat || 0,
    schoolNameMissingOrAbnormal: users.filter((user) => (
      typeof user.schoolName !== 'string' || !user.schoolName.trim()
    )).length,
    authoritativeSchoolComplete: authoritativeUsers.length,
    missingSchoolReference: schoolBuckets.missingSchool || 0,
    pendingOrInactiveSchoolReference:
      schoolBuckets.pendingOrInactiveSchool || 0,
    invalidOfficialSchoolReference:
      schoolBuckets.invalidOfficialSchool || 0,
    schoolNameMismatch: schoolBuckets.nameMismatch || 0,
    activeSchoolUsers,
    noAuthoritativeSchool: noSchoolUsers.length,
    noSchoolWithBusinessData: Object.fromEntries(
      Object.entries(involvement).map(([key, values]) => [key, values.size])
    )
  };
}

function productSchoolGroup(state) {
  if (['missing', 'null', 'empty'].includes(state.bucket)) {
    return 'noSchool';
  }
  if (['wrongType', 'invalidFormat'].includes(state.bucket)) {
    return 'invalidSchoolId';
  }
  if (!state.authoritative) {
    return 'invalidReference';
  }
  return 'authoritative';
}

function buildProductAudit(snapshot, schoolById) {
  const statusCounts = createStatusCounter(PRODUCT_STATUSES);
  statusCounts.other = 0;
  const schoolBuckets = {};
  const byStatus = {};
  const activeSchoolProducts = Object.fromEntries(
    Object.values(schoolById)
      .filter((school) => (
        school.platformStatus === 'active'
        && school.officialStatus === 'valid'
      ))
      .map((school) => [
        normalizeText(school.name),
        {
          total: 0,
          ...createStatusCounter(PRODUCT_STATUSES),
          other: 0
        }
      ])
  );
  const noAuthoritativeProductIds = new Set();
  const stateByProduct = {};
  snapshot.products.forEach((product) => {
    const status = PRODUCT_STATUSES.includes(product.status)
      ? product.status
      : 'other';
    increment(statusCounts, status);
    const state = schoolReferenceState(product, schoolById);
    const group = productSchoolGroup(state);
    increment(schoolBuckets, state.bucket);
    if (!byStatus[status]) {
      byStatus[status] = {
        authoritative: 0,
        noSchool: 0,
        invalidSchoolId: 0,
        invalidReference: 0
      };
    }
    increment(byStatus[status], group);
    stateByProduct[product._id] = state;
    if (!state.authoritative) {
      noAuthoritativeProductIds.add(product._id);
    } else {
      const schoolName = normalizeText(state.school.name);
      if (!activeSchoolProducts[schoolName]) {
        activeSchoolProducts[schoolName] = {
          total: 0,
          ...createStatusCounter(PRODUCT_STATUSES),
          other: 0
        };
      }
      increment(activeSchoolProducts[schoolName], 'total');
      increment(activeSchoolProducts[schoolName], status);
    }
  });
  return {
    summary: {
      total: snapshot.products.length,
      statusCounts,
      nonEmptyValidFormatSchoolId: snapshot.products.filter((product) => (
        typeof product.schoolId === 'string'
        && SCHOOL_ID_PATTERN.test(product.schoolId.trim())
      )).length,
      authoritativeSchoolComplete:
        snapshot.products.length - noAuthoritativeProductIds.size,
      schoolIdMissing: schoolBuckets.missing || 0,
      schoolIdNull: schoolBuckets.null || 0,
      schoolIdEmpty: schoolBuckets.empty || 0,
      schoolIdWrongType: schoolBuckets.wrongType || 0,
      schoolIdInvalidFormat: schoolBuckets.invalidFormat || 0,
      schoolNameMissingOrAbnormal: snapshot.products.filter((product) => (
        typeof product.schoolName !== 'string' || !product.schoolName.trim()
      )).length,
      missingSchoolReference: schoolBuckets.missingSchool || 0,
      pendingOrInactiveSchoolReference:
        schoolBuckets.pendingOrInactiveSchool || 0,
      invalidOfficialSchoolReference:
        schoolBuckets.invalidOfficialSchool || 0,
      schoolNameMismatch: schoolBuckets.nameMismatch || 0
    },
    byStatus,
    activeSchoolProducts,
    noAuthoritativeProductIds,
    stateByProduct
  };
}

function buildReferenceAudit(snapshot, noSchoolProductIds) {
  const favoriteRecords = snapshot.favorites.filter((record) => (
    noSchoolProductIds.has(record.productId)
  ));
  const conversationRecords = snapshot.conversations.filter((record) => (
    noSchoolProductIds.has(record.productId)
  ));
  const conversationIds = new Set(
    conversationRecords.map((record) => record._id)
  );
  const recentThreshold = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const conversationMessages = snapshot.messages.filter((record) => (
    conversationIds.has(record.conversationId)
  ));
  const directProductMessages = snapshot.messages.filter((record) => (
    noSchoolProductIds.has(record.productId)
  ));
  const productCardMessages = snapshot.messages.filter((record) => (
    record.type === 'product'
    && record.product
    && noSchoolProductIds.has(record.product.productId)
  ));
  const relatedMessageIds = new Set([
    ...conversationMessages,
    ...directProductMessages,
    ...productCardMessages
  ].map((record) => record._id));
  const appointmentRecords = snapshot.appointments.filter((record) => (
    noSchoolProductIds.has(record.productId)
  ));
  const appointmentByStatus = createStatusCounter(APPOINTMENT_STATUSES);
  appointmentByStatus.other = 0;
  appointmentRecords.forEach((record) => {
    increment(
      appointmentByStatus,
      APPOINTMENT_STATUSES.includes(record.status) ? record.status : 'other'
    );
  });
  const viewRecords = snapshot.productViews.filter((record) => (
    noSchoolProductIds.has(record.productId)
  ));
  return {
    favorites: {
      records: favoriteRecords.length,
      distinctProducts: countDistinct(
        favoriteRecords.map((record) => record.productId)
      ),
      distinctUsers: countDistinct(
        favoriteRecords.map((record) => record.userOpenid)
      )
    },
    conversations: {
      records: conversationRecords.length,
      distinctProducts: countDistinct(
        conversationRecords.map((record) => record.productId)
      ),
      recentWithin30Days: conversationRecords.filter((record) => (
        toTime(record.lastMessageAt || record.updatedAt) >= recentThreshold
      )).length,
      activeDefinition:
        'schema has no active flag; recentWithin30Days is an audit proxy'
    },
    messages: {
      relatedRecords: relatedMessageIds.size,
      conversationMessages: conversationMessages.length,
      directProductMessages: directProductMessages.length,
      productCardMessages: productCardMessages.length,
      historicalSnapshotsPreserved: conversationRecords.filter((record) => (
        record.productSnapshot && typeof record.productSnapshot === 'object'
      )).length
    },
    appointments: {
      records: appointmentRecords.length,
      byStatus: appointmentByStatus,
      effectivePendingOrAccepted: appointmentRecords.filter((record) => (
        record.isDeleted !== true
        && ['pending', 'accepted'].includes(record.status)
      )).length
    },
    productViews: {
      records: viewRecords.length,
      distinctProducts: countDistinct(
        viewRecords.map((record) => record.productId)
      )
    }
  };
}

function buildEvidenceAudit(snapshot, schoolById, productAudit) {
  const userById = Object.fromEntries(
    snapshot.users.map((user) => [user._id, user])
  );
  const userByOpenid = Object.fromEntries(
    snapshot.users
      .filter((user) => user.openid)
      .map((user) => [user.openid, user])
  );
  const counts = {
    sellerCurrentAuthoritativeSchool: 0,
    createdBeforeSellerFirstSelection: 0,
    createdAtOrAfterSellerFirstSelection: 0,
    creationTimeRelationshipUnknown: 0,
    legacyCampusPresent: 0,
    sellerSchoolAndCampusTextConflictCandidate: 0,
    completelyNoSchoolEvidence: 0
  };
  const candidates = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const testPattern = /(?:阶段\s*\d+|测试|验收|验证|test|demo|mock)/i;
  snapshot.products.forEach((product) => {
    if (!productAudit.noAuthoritativeProductIds.has(product._id)) {
      return;
    }
    const seller = userById[product.sellerId]
      || userByOpenid[product.sellerOpenid];
    const sellerState = seller
      ? schoolReferenceState(seller, schoolById)
      : { authoritative: false };
    const campus = normalizeText(product.campus);
    if (sellerState.authoritative) {
      counts.sellerCurrentAuthoritativeSchool += 1;
    }
    if (campus) {
      counts.legacyCampusPresent += 1;
    }
    if (
      sellerState.authoritative
      && campus
      && campus !== normalizeText(sellerState.school.name)
    ) {
      counts.sellerSchoolAndCampusTextConflictCandidate += 1;
    }
    const createdAt = toTime(product.createdAt);
    const selectedAt = toTime(seller && seller.schoolSelectedAt);
    if (Number.isFinite(createdAt) && Number.isFinite(selectedAt)) {
      if (createdAt < selectedAt) {
        counts.createdBeforeSellerFirstSelection += 1;
      } else {
        counts.createdAtOrAfterSellerFirstSelection += 1;
      }
    } else {
      counts.creationTimeRelationshipUnknown += 1;
    }
    if (!sellerState.authoritative && !campus) {
      counts.completelyNoSchoolEvidence += 1;
    }
    if (testPattern.test(normalizeText(product.title))) {
      candidates.D += 1;
    } else if (product.status === 'deleted') {
      candidates.E += 1;
    } else if (
      sellerState.authoritative
      && campus
      && campus !== normalizeText(sellerState.school.name)
    ) {
      candidates.C += 1;
    } else if (
      sellerState.authoritative
      && Number.isFinite(createdAt)
      && Number.isFinite(selectedAt)
      && createdAt >= selectedAt
    ) {
      candidates.A += 1;
    } else {
      candidates.B += 1;
    }
  });
  return {
    counts,
    candidateClasses: candidates,
    rules: {
      A: 'current seller school plus post-selection creation; manual sample only',
      B: 'insufficient evidence; remain unassigned',
      C: 'conflicting non-authoritative clues; manual handling required',
      D: 'test-data pattern candidate; not automatically deletable',
      E: 'deleted or archival record; preserve historical references'
    }
  };
}

function buildTestBoundary(snapshot, noSchoolProductIds) {
  const testPattern = /(?:阶段\s*\d+|测试|验收|验证|test|demo|mock)/i;
  const testProducts = snapshot.products.filter((record) => (
    testPattern.test(normalizeText(record.title))
  ));
  const testProductIds = new Set(testProducts.map((record) => record._id));
  return {
    recognizableProductCandidates: testProducts.length,
    recognizableSoftDeletedProductCandidates: testProducts.filter(
      (record) => record.status === 'deleted'
    ).length,
    recognizableNoSchoolProductCandidates: testProducts.filter(
      (record) => noSchoolProductIds.has(record._id)
    ).length,
    relatedConversationCandidates: snapshot.conversations.filter(
      (record) => testProductIds.has(record.productId)
    ).length,
    relatedAppointmentCandidates: snapshot.appointments.filter(
      (record) => testProductIds.has(record.productId)
    ).length,
    unclassifiedProducts: snapshot.products.length - testProducts.length,
    caution:
      'text patterns are only review candidates and never deletion authority'
  };
}

function buildNoWriteProof(before, after) {
  const collections = Object.keys(COLLECTION_PROJECTIONS);
  const countsBefore = Object.fromEntries(
    collections.map((name) => [name, before[name].length])
  );
  const countsAfter = Object.fromEntries(
    collections.map((name) => [name, after[name].length])
  );
  const hashesBefore = Object.fromEntries(
    collections.map((name) => [name, stableHash(before[name])])
  );
  const hashesAfter = Object.fromEntries(
    collections.map((name) => [name, stableHash(after[name])])
  );
  return {
    countsBefore,
    countsAfter,
    countsUnchanged: collections.every(
      (name) => countsBefore[name] === countsAfter[name]
    ),
    projectedSnapshotsUnchanged: collections.every(
      (name) => hashesBefore[name] === hashesAfter[name]
    ),
    projectedSnapshotDigestsBefore: hashesBefore,
    projectedSnapshotDigestsAfter: hashesAfter,
    writeApiCalled: false,
    transactionExecuted: false,
    limitation:
      'proves this script has no write path and compares projected snapshots; it cannot exclude unrelated external writes outside the projections'
  };
}

function buildStopConditions(productAudit, references) {
  const publicRows = ['available', 'reserved'].reduce((total, status) => {
    const row = productAudit.byStatus[status] || {};
    return total + Object.values(row).reduce(
      (sum, value) => sum + Number(value || 0),
      0
    );
  }, 0);
  const publicAuthoritative = ['available', 'reserved'].reduce(
    (total, status) => total + Number(
      productAudit.byStatus[status]
      && productAudit.byStatus[status].authoritative || 0
    ),
    0
  );
  const publicWithoutAuthoritative = publicRows - publicAuthoritative;
  const ratio = publicRows > 0 ? publicWithoutAuthoritative / publicRows : 0;
  const conditions = [];
  if (ratio >= 0.5) {
    conditions.push('MOST_PUBLIC_PRODUCTS_LACK_AUTHORITATIVE_SCHOOL');
  }
  if (publicRows > 0 && publicAuthoritative === 0) {
    conditions.push('STRICT_FILTER_WOULD_EMPTY_PUBLIC_MARKET');
  }
  if (references.appointments.effectivePendingOrAccepted > 0) {
    conditions.push('ACTIVE_APPOINTMENTS_REFERENCE_UNASSIGNED_PRODUCTS');
  }
  return {
    triggered: conditions.length > 0,
    conditions,
    publicProducts: publicRows,
    publicAuthoritative,
    publicWithoutAuthoritative,
    publicWithoutAuthoritativeRatio: Number(ratio.toFixed(6))
  };
}

function createAudit(snapshotBefore, snapshotAfter, indexes, targetMasked) {
  const schoolById = Object.fromEntries(
    snapshotBefore.schools.map((school) => [school._id, school])
  );
  const users = buildUserAudit(snapshotBefore, schoolById);
  const productInternal = buildProductAudit(snapshotBefore, schoolById);
  const references = buildReferenceAudit(
    snapshotBefore,
    productInternal.noAuthoritativeProductIds
  );
  const evidence = buildEvidenceAudit(
    snapshotBefore,
    schoolById,
    productInternal
  );
  const testDataBoundary = buildTestBoundary(
    snapshotBefore,
    productInternal.noAuthoritativeProductIds
  );
  const stopConditions = buildStopConditions(productInternal, references);
  return {
    schemaVersion: 1,
    mode: MODE,
    generatedAt: new Date().toISOString(),
    target: `cloud:${targetMasked}`,
    privacy: 'aggregate-only-output',
    users,
    products: {
      ...productInternal.summary,
      byStatus: productInternal.byStatus,
      activeSchoolProducts: productInternal.activeSchoolProducts
    },
    references,
    evidence,
    testDataBoundary,
    productIndexes: indexes,
    stopConditions,
    noWriteProof: buildNoWriteProof(snapshotBefore, snapshotAfter)
  };
}

function parseArguments(argv) {
  const options = {
    describeTarget: false,
    confirmTarget: '',
    output: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--describe-target') {
      options.describeTarget = true;
    } else if (value === '--confirm-target') {
      options.confirmTarget = normalizeText(argv[++index]);
    } else if (value === '--output') {
      options.output = normalizeText(argv[++index]);
    } else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

function runAudit(options = {}) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
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
    const error = new Error(
      'explicit masked target confirmation is required before database access'
    );
    error.code = 'TARGET_ENV_CONFIRMATION_REQUIRED';
    throw error;
  }
  const snapshotBefore = readSnapshot(environmentId);
  const indexes = readProductIndexes(environmentId);
  const snapshotAfter = readSnapshot(environmentId);
  return createAudit(snapshotBefore, snapshotAfter, indexes, targetMasked);
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = runAudit(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      const targetPath = path.resolve(options.output);
      fs.writeFileSync(targetPath, output, {
        encoding: 'utf8',
        mode: 0o600
      });
    }
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(JSON.stringify({
      success: false,
      code: error.code || 'PHASE_22A_AUDIT_FAILED',
      message: error.message
    }) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MODE,
  COLLECTION_PROJECTIONS,
  PRODUCT_STATUSES,
  APPOINTMENT_STATUSES,
  buildFindCommand,
  buildListIndexesCommand,
  assertReadOnlyCommand,
  schoolReferenceState,
  createAudit,
  parseArguments,
  runAudit
};
