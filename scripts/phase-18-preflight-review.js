const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadEnvironmentId,
  maskEnvironmentId
} = require('./schools/cloud-cli');
const orphanReview = require('./phase-18-orphan-reserved-review');

const MODE = 'phase-18-preflight-read-only';
const TEST_PATTERN = /(?:阶段\s*\d+|测试|验收|验证|test|demo|mock)/i;
const PUBLIC_LIST_STATUSES = new Set(['available', 'reserved']);
const PUBLIC_DETAIL_STATUSES = new Set(['available', 'reserved', 'sold']);
const ACTIVE_APPOINTMENT_STATUSES = new Set(['pending', 'accepted']);
const TARGET_DIGEST = 'p#56853a8ed6';
const TARGET_MUTATION_DIGEST = 'm#81248774c14c';
const EXPECTED_OTHER_PRODUCTS_DIGEST =
  'b9496176ead65cc3f3fc2c3163be371a25001923c4f0f5b239a436ba7a437e04';

const ROLLOUT_DECISIONS = {
  recommendedControl: 'G4_server_code_fixed_allowlist',
  alternativeControl: 'G3_server_readonly_config_default_off',
  identityField: 'deterministic_server_user_id',
  schoolScopedMarketEnabled: false,
  modes: ['legacy_market', 'school_scoped_market'],
  clientChoosesMode: false,
  newModeFallsBackToLegacy: false,
  emptyAllowlistBehavior: 'all_users_remain_legacy',
  configFailureBehavior: 'default_off_and_log_redacted_error',
  schoolContextFailureBehavior: 'explicit_error_no_legacy_fallback',
  cursorFailureBehavior: 'reject_no_first_page_or_legacy_fallback',
  missingIndexBehavior: 'explicit_error_keep_school_filter',
  requiresNewCollection: false,
  requiresProductQueryDeploymentWhenImplemented: true
};

const CURSOR_PROTOCOL = {
  version: 1,
  fields: [
    'version',
    'marketMode',
    'scopeSchoolId',
    'action',
    'categoryId',
    'normalizedKeywordDigest',
    'sortBy',
    'statuses',
    'pageSize',
    'snapshotAt',
    'lastSortValues',
    'lastItemId'
  ],
  encoding: 'base64url_json_plus_hmac_sha256',
  base64IsSecurity: false,
  scopeMismatch: 'INVALID_CURSOR_SCOPE',
  queryMismatch: 'INVALID_CURSOR_SCOPE',
  invalidCursorFallback: false,
  seek: {
    default: [
      'favoriteCount < last.favoriteCount',
      'favoriteCount = last.favoriteCount AND viewCount < last.viewCount',
      'favoriteCount = last.favoriteCount AND viewCount = last.viewCount AND createdAt < last.createdAt',
      'favoriteCount = last.favoriteCount AND viewCount = last.viewCount AND createdAt = last.createdAt AND _id > last._id'
    ],
    newest: [
      'createdAt < last.createdAt',
      'createdAt = last.createdAt AND _id > last._id'
    ],
    priceAsc: [
      'price > last.price',
      'price = last.price AND createdAt < last.createdAt',
      'price = last.price AND createdAt = last.createdAt AND _id > last._id'
    ],
    priceDesc: [
      'price < last.price',
      'price = last.price AND createdAt < last.createdAt',
      'price = last.price AND createdAt = last.createdAt AND _id > last._id'
    ]
  }
};

const INDEX_PLAN = [
  {
    name: 'idx_school_status_createdAt_id',
    fields: 'schoolId ASC, status ASC, createdAt DESC, _id ASC',
    sort: 'newest',
    category: false,
    required: true
  },
  {
    name: 'idx_school_status_favorite_view_createdAt_id',
    fields:
      'schoolId ASC, status ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC',
    sort: 'default',
    category: false,
    required: true
  },
  {
    name: 'idx_school_status_price_asc_createdAt_id',
    fields:
      'schoolId ASC, status ASC, price ASC, createdAt DESC, _id ASC',
    sort: 'priceAsc',
    category: false,
    required: true
  },
  {
    name: 'idx_school_status_price_desc_createdAt_id',
    fields:
      'schoolId ASC, status ASC, price DESC, createdAt DESC, _id ASC',
    sort: 'priceDesc',
    category: false,
    required: true
  },
  {
    name: 'idx_school_status_category_createdAt_id',
    fields:
      'schoolId ASC, status ASC, categoryId ASC, createdAt DESC, _id ASC',
    sort: 'newest',
    category: true,
    required: true
  },
  {
    name: 'idx_school_status_category_favorite_view_createdAt_id',
    fields:
      'schoolId ASC, status ASC, categoryId ASC, favoriteCount DESC, viewCount DESC, createdAt DESC, _id ASC',
    sort: 'default',
    category: true,
    required: true
  },
  {
    name: 'idx_school_status_category_price_asc_createdAt_id',
    fields:
      'schoolId ASC, status ASC, categoryId ASC, price ASC, createdAt DESC, _id ASC',
    sort: 'priceAsc',
    category: true,
    required: true
  },
  {
    name: 'idx_school_status_category_price_desc_createdAt_id',
    fields:
      'schoolId ASC, status ASC, categoryId ASC, price DESC, createdAt DESC, _id ASC',
    sort: 'priceDesc',
    category: true,
    required: true
  }
];

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function mutationDigest(value) {
  return `m#${sha256(value).slice(0, 12)}`;
}

function safeDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
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

function stableHash(records) {
  const ordered = [...records].sort((left, right) => (
    normalizeText(left && left._id).localeCompare(
      normalizeText(right && right._id)
    )
  ));
  return sha256(JSON.stringify(canonicalize(ordered)));
}

function countDistinct(values) {
  return new Set(values.filter(hasValue)).size;
}

function schoolState(record, schoolById) {
  const schoolId = normalizeText(record && record.schoolId);
  const school = schoolById[schoolId];
  const authoritative = Boolean(
    schoolId
    && school
    && school.officialStatus === 'valid'
    && school.platformStatus === 'active'
    && normalizeText(school.name)
    && normalizeText(record.schoolName) === normalizeText(school.name)
  );
  return {
    authoritative,
    missing: !schoolId,
    name: authoritative ? normalizeText(school.name) : ''
  };
}

function findSeller(product, users) {
  return users.find((user) => (
    hasValue(product.sellerId) && user._id === product.sellerId
  )) || users.find((user) => (
    hasValue(product.sellerOpenid)
    && user.openid === product.sellerOpenid
  )) || null;
}

function classifyTitle(product) {
  const title = normalizeText(product.title);
  const digest = orphanReview.productDigest(product._id);
  if (digest === TARGET_DIGEST) {
    return '[阶段4初始化种子商品]';
  }
  if (/(?:预约|预定)/i.test(title)) {
    return '[预约验收商品]';
  }
  if (/(?:聊天|会话|商品卡片)/i.test(title)) {
    return '[聊天商品卡片测试]';
  }
  if (/(?:媒体|图片|视频|语音)/i.test(title)) {
    return '[媒体功能验收商品]';
  }
  const phase = title.match(/阶段\s*(\d+)/i);
  if (phase) {
    return `[阶段${phase[1]}验收商品]`;
  }
  if (normalizeText(product.schoolId) && product.status === 'deleted') {
    return '[阶段17学校绑定测试商品]';
  }
  return '[测试或验收商品]';
}

function recognitionReasons(product) {
  const title = normalizeText(product.title);
  const reasons = [];
  if (orphanReview.productDigest(product._id) === TARGET_DIGEST) {
    reasons.push('fixed_seed_fingerprint');
  }
  if (/阶段\s*\d+/i.test(title)) {
    reasons.push('phase_marker');
  }
  if (/(?:测试|验收|验证|test|demo|mock)/i.test(title)) {
    reasons.push('test_text_marker');
  }
  if (product.status === 'deleted') {
    reasons.push('soft_deleted_test_record');
  }
  if (normalizeText(product.schoolId)) {
    reasons.push('school_binding_test_context');
  }
  return reasons;
}

function classifyCandidate(candidate) {
  if (candidate.status === 'deleted') {
    return {
      classification: 'T5',
      suggestion: '保持软删除并保留历史引用。',
      risk: candidate.hasHistoricalRelationship
        ? '物理清理会破坏历史关系。'
        : '无需重复删除；仍应保留审计记录。'
    };
  }
  if (candidate.activeAppointments > 0) {
    return {
      classification: 'T4',
      suggestion: '保持原状，先人工处理有效预约。',
      risk: '存在有效预约，禁止进入清理候选。'
    };
  }
  if (candidate.hasHistoricalRelationship) {
    return {
      classification: 'T2',
      suggestion: candidate.publicVisible
        ? '保留历史记录；后续另行确认是否转为 offline。'
        : '保持当前非公开状态并长期保留历史关系。',
      risk: '会话、消息、预约或快照需要持续可追溯。'
    };
  }
  if (
    candidate.status === 'sold'
    || candidate.favoriteRelations > 0
    || candidate.viewRelations > 0
    || candidate.hasProductMedia
  ) {
    return {
      classification: 'T4',
      suggestion: '保持原状，等待人工确认用途。',
      risk: '状态、轻量关系或媒体使纯测试清理证据不足。'
    };
  }
  return {
    classification: 'T3',
    suggestion: '仅列入后续安全软删除候选，本轮不删除。',
    risk: candidate.realSeller
      ? '真实账号仍可能管理，软删除必须再次授权。'
      : '虽无业务关系，仍需独立删除授权。'
  };
}

function buildCandidate(product, snapshot, schoolById) {
  const audit = orphanReview.buildProductAudit(product, snapshot);
  const seller = findSeller(product, snapshot.users);
  const sellerSchool = schoolState(seller || {}, schoolById);
  const productSchool = schoolState(product, schoolById);
  const appointmentCounts = audit.relationships.appointments.byStatus;
  const activeAppointments = audit.relationships.appointments.active;
  const historicalSnapshots =
    audit.relationships.conversations.historicalProductSnapshots
    + audit.relationships.messages.productCardMessages;
  const mediaReferences = audit.relationships.mediaReferences.total;
  const hasHistoricalRelationship = Boolean(
    audit.relationships.conversations.records
    || audit.relationships.messages.records
    || audit.relationships.appointments.records
    || historicalSnapshots
    || mediaReferences
  );
  const sellerSelectedAt = seller && seller.schoolSelectedAt
    ? new Date(seller.schoolSelectedAt).getTime()
    : NaN;
  const createdAt = product.createdAt
    ? new Date(product.createdAt).getTime()
    : NaN;
  const candidate = {
    digest: orphanReview.productDigest(product._id),
    titleClass: classifyTitle(product),
    descriptionDigest: `d#${sha256(product.description).slice(0, 10)}`,
    status: normalizeText(product.status) || 'unknown',
    publicVisible: PUBLIC_LIST_STATUSES.has(product.status),
    publicDetailReachable: PUBLIC_DETAIL_STATUSES.has(product.status),
    authoritativeSchool: productSchool.authoritative,
    schoolName: productSchool.name,
    missingSchool: productSchool.missing,
    realSeller: Boolean(seller),
    sellerOpenidPresent: hasValue(product.sellerOpenid),
    sellerActive: Boolean(seller && seller.status === 'active'),
    sellerProfileComplete: Boolean(seller && seller.profileCompleted === true),
    sellerAuthoritativeSchool: sellerSchool.authoritative,
    manageableByRealAccount: Boolean(
      seller
      && seller.status === 'active'
      && hasValue(product.sellerOpenid)
      && seller.openid === product.sellerOpenid
      && product.status !== 'deleted'
    ),
    sellerOtherProductCount: seller
      ? snapshot.products.filter((item) => (
        item._id !== product._id
        && (
          item.sellerId === seller._id
          || (
            hasValue(seller.openid)
            && item.sellerOpenid === seller.openid
          )
        )
      )).length
      : 0,
    createdDate: safeDate(product.createdAt),
    updatedDate: safeDate(product.updatedAt),
    createdBeforeSellerFirstSchoolSelection: Boolean(
      Number.isFinite(createdAt)
      && Number.isFinite(sellerSelectedAt)
      && createdAt < sellerSelectedAt
    ),
    softDeleted: product.status === 'deleted' || hasValue(product.deletedAt),
    favoriteRelations: audit.relationships.favorites.records,
    favoriteUsers: audit.relationships.favorites.distinctUsers,
    favoriteCount: audit.relationships.favorites.productFavoriteCount,
    favoriteCountMatches: audit.relationships.favorites.countMatches,
    conversations: audit.relationships.conversations.records,
    conversationSnapshots:
      audit.relationships.conversations.historicalProductSnapshots,
    messages: audit.relationships.messages.records,
    messageTypes: audit.relationships.messages.byType,
    productCardMessages: audit.relationships.messages.productCardMessages,
    appointmentSystemMessages:
      audit.relationships.messages.appointmentSystemMessages,
    statusChangeSystemMessages:
      audit.relationships.messages.statusChangeSystemMessages,
    appointments: audit.relationships.appointments.records,
    appointmentStatusCounts: appointmentCounts,
    activeAppointments,
    viewRelations: audit.relationships.views.records,
    viewUsers: audit.relationships.views.distinctUsers,
    viewCount: audit.relationships.views.productViewCount,
    viewCountMatches: audit.relationships.views.countMatches,
    imageCount: audit.media.imageCount,
    videoPresent: audit.media.videoPresent,
    mediaCleanupStatus: audit.media.cleanupStatus,
    mediaCleanupTaskPending: audit.media.cleanupTaskPending,
    historicalSnapshots,
    mediaReferences,
    hasProductMedia: Boolean(
      audit.media.imageCount || audit.media.videoPresent
    ),
    hasHistoricalRelationship,
    recognitionReasons: recognitionReasons(product),
    currentReachability: {
      publicList: PUBLIC_LIST_STATUSES.has(product.status),
      publicDetail: PUBLIC_DETAIL_STATUSES.has(product.status),
      myProducts: Boolean(
        seller
        && hasValue(product.sellerOpenid)
        && seller.openid === product.sellerOpenid
        && ['available', 'reserved', 'offline', 'sold'].includes(product.status)
      ),
      historicalConversation: audit.relationships.conversations.records > 0
    }
  };
  return Object.assign(candidate, classifyCandidate(candidate));
}

function countCandidateSummary(candidates) {
  const classCounts = { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 };
  candidates.forEach((candidate) => {
    classCounts[candidate.classification] += 1;
  });
  return {
    classifications: classCounts,
    publicVisible: candidates.filter((item) => item.publicVisible).length,
    offline: candidates.filter((item) => item.status === 'offline').length,
    sold: candidates.filter((item) => item.status === 'sold').length,
    deleted: candidates.filter((item) => item.status === 'deleted').length,
    authoritativeSchool:
      candidates.filter((item) => item.authoritativeSchool).length,
    missingSchool: candidates.filter((item) => item.missingSchool).length,
    realSeller: candidates.filter((item) => item.realSeller).length,
    noRealSeller: candidates.filter((item) => !item.realSeller).length,
    withHistoricalRelationship:
      candidates.filter((item) => item.hasHistoricalRelationship).length,
    withoutAnyRelationship: candidates.filter((item) => (
      !item.hasHistoricalRelationship
      && item.favoriteRelations === 0
      && item.viewRelations === 0
    )).length,
    withProductMedia:
      candidates.filter((item) => item.hasProductMedia).length,
    withoutProductMedia:
      candidates.filter((item) => !item.hasProductMedia).length
  };
}

function hasProductRelationship(product, snapshot) {
  const audit = orphanReview.buildProductAudit(product, snapshot);
  return {
    favorite: audit.relationships.favorites.records > 0,
    conversation: audit.relationships.conversations.records > 0,
    message: audit.relationships.messages.records > 0,
    appointment: audit.relationships.appointments.records > 0,
    view: audit.relationships.views.records > 0,
    media: Boolean(
      audit.media.imageCount
      || audit.media.videoPresent
      || audit.relationships.mediaReferences.total
    )
  };
}

function buildNoSchoolAggregate(snapshot, schoolById, candidateIds) {
  const products = snapshot.products.filter(
    (product) => !schoolState(product, schoolById).authoritative
  );
  const statusCounts = {
    available: 0,
    reserved: 0,
    offline: 0,
    sold: 0,
    deleted: 0,
    other: 0
  };
  const relationshipCounts = {
    favorite: 0,
    conversation: 0,
    message: 0,
    appointment: 0,
    view: 0,
    media: 0
  };
  let realSeller = 0;
  let evidenceConflict = 0;
  let strongSchoolEvidence = 0;
  products.forEach((product) => {
    const status = Object.prototype.hasOwnProperty.call(
      statusCounts,
      product.status
    ) ? product.status : 'other';
    statusCounts[status] += 1;
    const seller = findSeller(product, snapshot.users);
    if (seller) {
      realSeller += 1;
    }
    const relations = hasProductRelationship(product, snapshot);
    Object.keys(relationshipCounts).forEach((name) => {
      if (relations[name]) {
        relationshipCounts[name] += 1;
      }
    });
    const sellerSchool = schoolState(seller || {}, schoolById);
    const campus = normalizeText(product.campus);
    const createdAt = product.createdAt
      ? new Date(product.createdAt).getTime()
      : NaN;
    const selectedAt = seller && seller.schoolSelectedAt
      ? new Date(seller.schoolSelectedAt).getTime()
      : NaN;
    const temporalMatch = Number.isFinite(createdAt)
      && Number.isFinite(selectedAt)
      && createdAt >= selectedAt;
    if (
      sellerSchool.authoritative
      && campus
      && campus !== sellerSchool.name
    ) {
      evidenceConflict += 1;
    } else if (
      sellerSchool.authoritative
      && campus === sellerSchool.name
      && temporalMatch
    ) {
      strongSchoolEvidence += 1;
    }
  });
  return {
    total: products.length,
    statusCounts,
    testCandidates: products.filter((item) => candidateIds.has(item._id))
      .length,
    nonTestCandidates: products.filter((item) => !candidateIds.has(item._id))
      .length,
    realSeller,
    noRealSeller: products.length - realSeller,
    productsWithRelations: relationshipCounts,
    strongSchoolEvidence,
    evidenceConflict,
    insufficientEvidence:
      products.length - strongSchoolEvidence - evidenceConflict,
    automaticMigrationCandidates: 0,
    rules: [
      'seller current school cannot backfill historical products',
      'legacy campus is not an authoritative school mapping',
      'location is not school ownership evidence',
      'buyer or conversation participant school is not product ownership evidence'
    ]
  };
}

function buildConsistency(snapshot) {
  const activeAppointments = snapshot.appointments.filter((appointment) => (
    appointment.isDeleted !== true
    && ACTIVE_APPOINTMENT_STATUSES.has(appointment.status)
  ));
  const pending = activeAppointments.filter(
    (appointment) => appointment.status === 'pending'
  );
  const accepted = activeAppointments.filter(
    (appointment) => appointment.status === 'accepted'
  );
  const productById = Object.fromEntries(
    snapshot.products.map((product) => [product._id, product])
  );
  const reservedProducts = snapshot.products.filter(
    (product) => product.status === 'reserved'
  );
  const acceptedMismatches = accepted.filter((appointment) => {
    const product = productById[appointment.productId];
    return !product
      || product.status !== 'reserved'
      || product.reservedAppointmentId !== appointment._id;
  });
  const reservedWithoutAccepted = reservedProducts.filter((product) => (
    !accepted.some((appointment) => (
      appointment.productId === product._id
      && (
        !hasValue(product.reservedAppointmentId)
        || product.reservedAppointmentId === appointment._id
      )
    ))
  ));
  const reservedLinkAnomalies = snapshot.products.filter((product) => (
    hasValue(product.reservedAppointmentId)
    && !accepted.some((appointment) => (
      appointment._id === product.reservedAppointmentId
      && appointment.productId === product._id
      && product.status === 'reserved'
    ))
  ));
  const target = snapshot.products.find(
    (product) => orphanReview.productDigest(product._id) === TARGET_DIGEST
  );
  const otherProducts = snapshot.products.filter(
    (product) => orphanReview.productDigest(product._id) !== TARGET_DIGEST
  );
  const targetMutationDigest = target
    && target.maintenance
    && normalizeText(target.maintenance.mutationId)
    ? mutationDigest(target.maintenance.mutationId)
    : '';
  return {
    pending: pending.length,
    accepted: accepted.length,
    activeAppointments: activeAppointments.length,
    reserved: reservedProducts.length,
    orphanReserved: reservedWithoutAccepted.length,
    acceptedProductMismatches: acceptedMismatches.length,
    reservedAppointmentLinkAnomalies: reservedLinkAnomalies.length,
    totalAnomalies:
      reservedWithoutAccepted.length
      + acceptedMismatches.length
      + reservedLinkAnomalies.length,
    maintenanceTarget: {
      matched: target ? 1 : 0,
      status: target ? target.status : 'missing',
      mutationDigest: targetMutationDigest,
      mutationDigestMatches:
        targetMutationDigest === TARGET_MUTATION_DIGEST,
      immutableSeedFingerprintMatches: target
        ? orphanReview.immutableFingerprintAudit(target).exactMatch
        : false
    },
    otherProductsDigest: stableHash(otherProducts),
    otherProductsMatchPostMaintenanceSnapshot:
      stableHash(otherProducts) === EXPECTED_OTHER_PRODUCTS_DIGEST,
    passed: Boolean(
      pending.length === 0
      && accepted.length === 0
      && reservedProducts.length === 0
      && reservedWithoutAccepted.length === 0
      && acceptedMismatches.length === 0
      && reservedLinkAnomalies.length === 0
      && target
      && target.status === 'offline'
      && targetMutationDigest === TARGET_MUTATION_DIGEST
      && orphanReview.immutableFingerprintAudit(target).exactMatch
      && stableHash(otherProducts) === EXPECTED_OTHER_PRODUCTS_DIGEST
    )
  };
}

function buildNoWriteProof(before, after) {
  const names = Object.keys(orphanReview.COLLECTION_PROJECTIONS);
  const countsBefore = Object.fromEntries(
    names.map((name) => [name, before[name].length])
  );
  const countsAfter = Object.fromEntries(
    names.map((name) => [name, after[name].length])
  );
  const digestsBefore = Object.fromEntries(
    names.map((name) => [name, stableHash(before[name])])
  );
  const digestsAfter = Object.fromEntries(
    names.map((name) => [name, stableHash(after[name])])
  );
  return {
    countsBefore,
    countsAfter,
    countsUnchanged: names.every(
      (name) => countsBefore[name] === countsAfter[name]
    ),
    projectedSnapshotDigestsBefore: digestsBefore,
    projectedSnapshotDigestsAfter: digestsAfter,
    projectedSnapshotsUnchanged: names.every(
      (name) => digestsBefore[name] === digestsAfter[name]
    ),
    databaseWriteApiCalled: false,
    transactionExecuted: false,
    deploymentExecuted: false,
    indexCreatedOrChanged: false,
    permissionChanged: false,
    productOrAppointmentModified: false,
    dataDeleted: false,
    mediaAccessed: false
  };
}

function createPreflightReview(before, after, targetMasked) {
  const consistency = buildConsistency(before);
  if (!consistency.passed) {
    const error = new Error(
      `state consistency gate failed with ${consistency.totalAnomalies} anomalies`
    );
    error.code = 'STATE_CONSISTENCY_GATE_FAILED';
    error.safeDetails = consistency;
    throw error;
  }
  const schoolById = Object.fromEntries(
    before.schools.map((school) => [school._id, school])
  );
  const products = before.products.filter((product) => (
    TEST_PATTERN.test(normalizeText(product.title))
    || orphanReview.productDigest(product._id) === TARGET_DIGEST
  )).sort((left, right) => (
    orphanReview.productDigest(left._id).localeCompare(
      orphanReview.productDigest(right._id)
    )
  ));
  const candidates = products.map((product, index) => ({
    tc: `TC-${String(index + 1).padStart(3, '0')}`,
    ...buildCandidate(product, before, schoolById)
  }));
  const candidateIds = new Set(products.map((product) => product._id));
  return {
    schemaVersion: 1,
    mode: MODE,
    generatedAt: new Date().toISOString(),
    target: `cloud:${targetMasked}`,
    privacy:
      'redacted candidate metadata only; no raw ids, identities, titles, content, locations or media URLs',
    statusConsistency: consistency,
    candidateBoundary: {
      phase22OriginalCount: 14,
      currentCount: candidates.length,
      change: candidates.length - 14,
      stableOrder: 'product digest ascending',
      targetStillIncluded: candidates.some(
        (candidate) => candidate.digest === TARGET_DIGEST
      ),
      targetAddedAfterFixedSeedSourceReview: true,
      targetStateChangedByMaintenance: true,
      targetClassificationChangedByMaintenance: false,
      newCandidates: 1,
      changeReason:
        'phase 22A used title text only; the later 12/12 fixed seed proof adds the maintained phase 4 seed product'
    },
    candidates,
    candidateSummary: countCandidateSummary(candidates),
    noSchoolProducts: buildNoSchoolAggregate(
      before,
      schoolById,
      candidateIds
    ),
    rolloutDecisions: ROLLOUT_DECISIONS,
    cursorProtocol: CURSOR_PROTOCOL,
    indexPlan: {
      indexes: INDEX_PLAN,
      oldIndexesRetained: true,
      keywordRegexPerformanceGuaranteed: false,
      creationExecuted: false
    },
    noWriteProof: buildNoWriteProof(before, after)
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

function runPreflight(options = {}) {
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
  const before = orphanReview.readSnapshot(environmentId);
  const after = orphanReview.readSnapshot(environmentId);
  return createPreflightReview(before, after, targetMasked);
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = runPreflight(options);
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
      code: error.code || 'PHASE_18_PREFLIGHT_FAILED',
      message: error.message,
      details: error.safeDetails || undefined
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MODE,
  TEST_PATTERN,
  ROLLOUT_DECISIONS,
  CURSOR_PROTOCOL,
  INDEX_PLAN,
  classifyTitle,
  classifyCandidate,
  buildCandidate,
  buildNoSchoolAggregate,
  buildConsistency,
  buildNoWriteProof,
  createPreflightReview,
  parseArguments,
  runPreflight
};
