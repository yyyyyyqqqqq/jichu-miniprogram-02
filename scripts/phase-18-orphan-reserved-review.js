const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runCloudBase,
  runNoSql,
  extractCommandResults,
  extractDocuments
} = require('./schools/cloud-cli');

const MODE = 'phase-18-orphan-reserved-read-only';
const PAGE_SIZE = 1000;
const MAX_RECORDS = 50000;
const TARGET_DIGEST_PATTERN = /^p#[0-9a-f]{10}$/;
const ACTIVE_APPOINTMENT_STATUSES = new Set(['pending', 'accepted']);
const APPOINTMENT_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'cancelled',
  'completed'
];
const CLOUD_FUNCTIONS = [
  'appointmentAction',
  'appointmentQuery',
  'manageProduct',
  'productQuery'
];
const COLLECTION_PROJECTIONS = {
  users: {
    _id: 1,
    openid: 1,
    status: 1,
    profileCompleted: 1,
    schoolId: 1,
    schoolName: 1,
    schoolSelectedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    lastLoginAt: 1
  },
  products: {
    _id: 1,
    title: 1,
    description: 1,
    price: 1,
    originalPrice: 1,
    categoryId: 1,
    condition: 1,
    status: 1,
    version: 1,
    sellerId: 1,
    sellerOpenid: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: 1,
    offlineAt: 1,
    relistedAt: 1,
    soldAt: 1,
    reservedAppointmentId: 1,
    reservedAt: 1,
    lastActionType: 1,
    lastMutationId: 1,
    lastMutationType: 1,
    publishRequestId: 1,
    schoolId: 1,
    schoolName: 1,
    campus: 1,
    location: 1,
    locationDetail: 1,
    'images.0': 1,
    'images.1': 1,
    'images.2': 1,
    'images.3': 1,
    'images.4': 1,
    'images.5': 1,
    'imageUrls.0': 1,
    'imageUrls.1': 1,
    'imageUrls.2': 1,
    'imageUrls.3': 1,
    'imageUrls.4': 1,
    'imageUrls.5': 1,
    coverImage: 1,
    coverUrl: 1,
    image: 1,
    video: 1,
    favoriteCount: 1,
    viewCount: 1,
    imageCleanupStatus: 1,
    imageCleanupFiles: 1,
    imageCleanupFailedCount: 1,
    imageCleanupUpdatedAt: 1,
    maintenance: 1
  },
  favorites: {
    _id: 1,
    productId: 1,
    userOpenid: 1,
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
    updatedAt: 1,
    isDeleted: 1
  },
  messages: {
    _id: 1,
    conversationId: 1,
    senderOpenid: 1,
    type: 1,
    eventType: 1,
    appointmentId: 1,
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
    activeKey: 1,
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

const HISTORICAL_SEED_FINGERPRINT = {
  productIdSha256:
    '56853a8ed64f9d408bbe3041293e8b915471d81707efd64cd59ebe1bd1fa08f2',
  titleSha256:
    '6092b18e21c2dd34af0b53451a259a736a3344e2246cb60a6b0416ba7d67a017',
  descriptionSha256:
    'a2f64cc8ab3fc03dd97ededfcb3ea3e7a8bffb886a603d1369271b0ad4c047ef',
  price: 68,
  originalPrice: 158,
  categoryId: 'sports',
  condition: '八成新',
  status: 'reserved',
  favoriteCount: 18,
  viewCount: 412,
  createdAt: '2026-07-13T07:30:00.000Z',
  updatedAt: '2026-07-13T07:30:00.000Z'
};

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function productDigest(productId) {
  return `p#${sha256(productId).slice(0, 10)}`;
}

function safeDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hasValue(value) {
  return value !== undefined
    && value !== null
    && !(typeof value === 'string' && value.trim() === '');
}

function stableHash(records) {
  const normalized = [...records].sort((left, right) => (
    normalizeText(left && left._id).localeCompare(
      normalizeText(right && right._id)
    )
  ));
  return sha256(JSON.stringify(normalized));
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

function assertReadOnlyCommand(command) {
  if (!command || command.CommandType !== 'QUERY') {
    throw new Error('orphan review command is not query-only');
  }
  const parsed = JSON.parse(command.Command);
  if (
    parsed.find !== command.TableName
    || !parsed.projection
    || parsed.limit > PAGE_SIZE
  ) {
    throw new Error('orphan review query is outside the allowlist');
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
    const command = buildFindCommand(collection, projection, skip);
    assertReadOnlyCommand(command);
    const page = extractQueryDocuments(runNoSql(environmentId, [command]));
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

function noWriteProof(before, after) {
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
    projectedSnapshotDigestsBefore: hashesBefore,
    projectedSnapshotDigestsAfter: hashesAfter,
    projectedSnapshotsUnchanged: collections.every(
      (name) => hashesBefore[name] === hashesAfter[name]
    ),
    databaseWriteApiCalled: false,
    transactionExecuted: false,
    deploymentExecuted: false,
    indexCreatedOrChanged: false,
    permissionChanged: false,
    mediaAccessedOrDeleted: false,
    limitation:
      'proves this tool has no write or media path and compares selected projections; unrelated external writes outside the projections or time window are not excluded'
  };
}

function normalizeFunctionDetail(detail) {
  return detail && (detail.data || detail.Response || detail) || {};
}

function readFunctionState(environmentId, rootDirectory) {
  return CLOUD_FUNCTIONS.map((functionName) => {
    const detail = normalizeFunctionDetail(runCloudBase([
      'fn',
      'detail',
      functionName,
      '--envId',
      environmentId,
      '--json'
    ], {
      timeoutMs: 180000
    }));
    const localCode = fs.readFileSync(
      path.join(
        rootDirectory,
        'cloudfunctions',
        functionName,
        'index.js'
      ),
      'utf8'
    );
    const remoteCode = detail.CodeInfo || detail.codeInfo || '';
    const localSha256 = sha256(localCode);
    const remoteSha256 = remoteCode ? sha256(remoteCode) : '';
    return {
      functionName,
      status: detail.Status || detail.status || '',
      runtime: detail.Runtime || detail.runtime || '',
      handler: detail.Handler || detail.handler || '',
      timeoutSeconds: Number(detail.Timeout || detail.timeout || 0),
      memoryMb: Number(detail.MemorySize || detail.memorySize || 0),
      localSha256,
      remoteSha256,
      hashAvailable: Boolean(remoteCode),
      hashMatches: Boolean(remoteCode) && localSha256 === remoteSha256
    };
  });
}

function statusCounter(records) {
  const result = Object.fromEntries(
    APPOINTMENT_STATUSES.map((status) => [status, 0])
  );
  result.deleted = 0;
  result.other = 0;
  records.forEach((record) => {
    if (record.isDeleted === true) {
      result.deleted += 1;
    } else if (APPOINTMENT_STATUSES.includes(record.status)) {
      result[record.status] += 1;
    } else {
      result.other += 1;
    }
  });
  return result;
}

function countImages(product) {
  const candidates = [];
  if (Array.isArray(product.images)) {
    candidates.push(...product.images);
  } else if (Array.isArray(product.imageUrls)) {
    candidates.push(...product.imageUrls);
  }
  [
    product.coverImage,
    product.coverUrl,
    product.image
  ].forEach((value) => {
    if (normalizeText(value) && !candidates.includes(value)) {
      candidates.push(value);
    }
  });
  return candidates.filter((value) => normalizeText(value)).length;
}

function hasVideo(product) {
  return Boolean(
    product.video
    && typeof product.video === 'object'
    && normalizeText(product.video.fileID)
  );
}

function fingerprintAudit(product) {
  const checks = {
    productIdSha256:
      sha256(product._id) === HISTORICAL_SEED_FINGERPRINT.productIdSha256,
    titleSha256:
      sha256(product.title) === HISTORICAL_SEED_FINGERPRINT.titleSha256,
    descriptionSha256:
      sha256(product.description)
        === HISTORICAL_SEED_FINGERPRINT.descriptionSha256,
    price: Number(product.price) === HISTORICAL_SEED_FINGERPRINT.price,
    originalPrice:
      Number(product.originalPrice)
        === HISTORICAL_SEED_FINGERPRINT.originalPrice,
    categoryId:
      product.categoryId === HISTORICAL_SEED_FINGERPRINT.categoryId,
    condition: product.condition === HISTORICAL_SEED_FINGERPRINT.condition,
    status: product.status === HISTORICAL_SEED_FINGERPRINT.status,
    favoriteCount:
      Number(product.favoriteCount)
        === HISTORICAL_SEED_FINGERPRINT.favoriteCount,
    viewCount:
      Number(product.viewCount) === HISTORICAL_SEED_FINGERPRINT.viewCount,
    createdAt:
      safeDate(product.createdAt) === HISTORICAL_SEED_FINGERPRINT.createdAt,
    updatedAt:
      safeDate(product.updatedAt) === HISTORICAL_SEED_FINGERPRINT.updatedAt
  };
  return {
    matchedFields: Object.values(checks).filter(Boolean).length,
    totalFields: Object.keys(checks).length,
    exactMatch: Object.values(checks).every(Boolean),
    checks
  };
}

function immutableFingerprintAudit(product) {
  const full = fingerprintAudit(product);
  const checks = Object.fromEntries(
    Object.entries(full.checks).filter(
      ([field]) => !['status', 'updatedAt'].includes(field)
    )
  );
  return {
    matchedFields: Object.values(checks).filter(Boolean).length,
    totalFields: Object.keys(checks).length,
    exactMatch: Object.values(checks).every(Boolean),
    checks
  };
}

function schoolIsAuthoritative(product, snapshot) {
  const schoolId = normalizeText(product.schoolId);
  const schoolName = normalizeText(product.schoolName);
  const school = snapshot.schools.find((item) => item._id === schoolId);
  return Boolean(
    schoolId
    && schoolName
    && school
    && school.platformStatus === 'active'
    && school.officialStatus === 'valid'
    && normalizeText(school.name) === schoolName
  );
}

function buildSellerAudit(product, snapshot) {
  const seller = snapshot.users.find((user) => (
    (product.sellerId && user._id === product.sellerId)
    || (
      product.sellerOpenid
      && user.openid === product.sellerOpenid
    )
  ));
  const sellerProducts = snapshot.products.filter((item) => (
    item._id !== product._id
    && (
      (product.sellerId && item.sellerId === product.sellerId)
      || (
        product.sellerOpenid
        && item.sellerOpenid === product.sellerOpenid
      )
    )
  ));
  const productStatuses = [
    'available',
    'reserved',
    'offline',
    'sold',
    'deleted'
  ];
  const statusCounts = Object.fromEntries(
    productStatuses.map((status) => [
      status,
      sellerProducts.filter((item) => item.status === status).length
    ])
  );
  const threshold = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const openId = seller && seller.openid || product.sellerOpenid;
  const recentSignals = {
    userUpdated: Boolean(
      seller && new Date(seller.updatedAt || seller.lastLoginAt).getTime()
        >= threshold
    ),
    productUpdates: sellerProducts.filter(
      (item) => new Date(item.updatedAt).getTime() >= threshold
    ).length,
    conversations: openId
      ? snapshot.conversations.filter((item) => (
        [
          item.participantAOpenid,
          item.participantBOpenid
        ].includes(openId)
        && new Date(item.updatedAt || item.lastMessageAt).getTime() >= threshold
      )).length
      : 0,
    messages: openId
      ? snapshot.messages.filter((item) => (
        item.senderOpenid === openId
        && new Date(item.createdAt).getTime() >= threshold
      )).length
      : 0
  };
  const selectedAt = seller && safeDate(seller.schoolSelectedAt);
  const createdAt = safeDate(product.createdAt);
  return {
    recordExists: Boolean(seller),
    active: Boolean(seller && seller.status !== 'disabled'),
    profileComplete: Boolean(seller && seller.profileCompleted === true),
    currentAuthoritativeSchool: Boolean(
      seller && schoolIsAuthoritative(seller, snapshot)
    ),
    createdBeforeFirstSchoolSelection: Boolean(
      selectedAt && createdAt && new Date(createdAt) < new Date(selectedAt)
    ),
    firstSchoolSelectionKnown: Boolean(selectedAt),
    otherProductCount: sellerProducts.length,
    otherProductStatusCounts: statusCounts,
    recentActivitySignals: recentSignals,
    recentBusinessActivity: Object.values(recentSignals).some((value) => (
      value === true || Number(value) > 0
    )),
    myProductsAccessible: Boolean(
      seller
      && normalizeText(seller.openid)
      && normalizeText(product.sellerOpenid)
      && seller.openid === product.sellerOpenid
      && product.status !== 'deleted'
    ),
    currentUiActions: {
      edit: false,
      takeOffline: false,
      relist: false,
      markSold: false,
      softDelete: false,
      reason:
        'reserved items are shown in My Products without management actions'
    }
  };
}

function buildRelationshipAudit(product, snapshot) {
  const favorites = snapshot.favorites.filter(
    (item) => item.productId === product._id
  );
  const conversations = snapshot.conversations.filter(
    (item) => item.productId === product._id
  );
  const conversationIds = new Set(
    conversations.map((item) => item._id)
  );
  const messages = snapshot.messages.filter((item) => (
    item.productId === product._id
    || conversationIds.has(item.conversationId)
    || (
      item.product
      && item.product.productId === product._id
    )
  ));
  const appointments = snapshot.appointments.filter(
    (item) => item.productId === product._id
  );
  const views = snapshot.productViews.filter(
    (item) => item.productId === product._id
  );
  const sellerExists = snapshot.users.some((user) => (
    (product.sellerId && user._id === product.sellerId)
    || (
      product.sellerOpenid
      && user.openid === product.sellerOpenid
    )
  ));
  const types = ['text', 'system', 'product', 'image', 'voice', 'location'];
  const messageTypeCounts = Object.fromEntries(
    types.map((type) => [
      type,
      messages.filter((item) => item.type === type).length
    ])
  );
  const appointmentEventTypes = new Set([
    'appointment_created',
    'appointment_accepted',
    'appointment_rejected',
    'appointment_cancelled',
    'appointment_completed',
    'appointment_auto_cancelled'
  ]);
  const appointmentSystemMessages = messages.filter((item) => (
    item.type === 'system'
    && appointmentEventTypes.has(item.eventType)
  ));
  const acceptedMessages = appointmentSystemMessages.filter(
    (item) => item.eventType === 'appointment_accepted'
  );
  const productSnapshotMediaReferences = conversations.filter((item) => (
    item.productSnapshot
    && (
      normalizeText(item.productSnapshot.coverImage)
      || (
        Array.isArray(item.productSnapshot.images)
        && item.productSnapshot.images.some((value) => normalizeText(value))
      )
    )
  )).length;
  const productCardMediaReferences = messages.filter((item) => (
    item.type === 'product'
    && item.product
    && item.product.productId === product._id
    && normalizeText(item.product.coverImage)
  )).length;
  const latestConversationAt = conversations
    .map((item) => safeDate(
      item.updatedAt || item.lastMessageAt || item.createdAt
    ))
    .filter(Boolean)
    .sort()
    .pop() || null;
  return {
    favorites: {
      records: favorites.length,
      distinctUsers: new Set(
        favorites.map((item) => item.userOpenid).filter(Boolean)
      ).size,
      productFavoriteCount: Number(product.favoriteCount) || 0,
      countMatches: favorites.length === (Number(product.favoriteCount) || 0),
      effectiveRecords: favorites.length
    },
    conversations: {
      records: conversations.length,
      readableExisting: conversations.filter(
        (item) => item.isDeleted !== true
      ).length,
      latestUpdatedAt: latestConversationAt,
      historicalProductSnapshots: conversations.filter(
        (item) => item.productSnapshot
          && typeof item.productSnapshot === 'object'
      ).length,
      canContinueExisting:
        conversations.some((item) => item.isDeleted !== true),
      productStatusAllowsCreate: ['available', 'reserved'].includes(
        product.status
      ),
      sellerIdentityAllowsCreate: sellerExists,
      canCreateNew:
        ['available', 'reserved'].includes(product.status) && sellerExists
    },
    messages: {
      records: messages.length,
      byType: messageTypeCounts,
      appointmentSystemMessages: appointmentSystemMessages.length,
      appointmentAcceptedMessages: acceptedMessages.length,
      statusChangeSystemMessages: appointmentSystemMessages.length,
      mediaMessages:
        messageTypeCounts.image + messageTypeCounts.voice,
      productCardMessages: messageTypeCounts.product
    },
    appointments: {
      records: appointments.length,
      byStatus: statusCounter(appointments),
      active: appointments.filter((item) => (
        item.isDeleted !== true
        && ACTIVE_APPOINTMENT_STATUSES.has(item.status)
      )).length,
      acceptedMessageWithoutAppointment:
        acceptedMessages.length > 0 && appointments.length === 0
    },
    views: {
      records: views.length,
      distinctUsers: new Set(
        views.map((item) => item.viewerOpenid).filter(Boolean)
      ).size,
      productViewCount: Number(product.viewCount) || 0,
      countMatches: views.length === (Number(product.viewCount) || 0)
    },
    mediaReferences: {
      conversationSnapshots: productSnapshotMediaReferences,
      productCardSnapshots: productCardMediaReferences,
      total:
        productSnapshotMediaReferences + productCardMediaReferences
    }
  };
}

function buildProductAudit(product, snapshot) {
  const relationships = buildRelationshipAudit(product, snapshot);
  const immutableFingerprint = immutableFingerprintAudit(product);
  const imageCount = countImages(product);
  const videoPresent = hasVideo(product);
  const cleanupFiles = Array.isArray(product.imageCleanupFiles)
    ? product.imageCleanupFiles.filter((item) => normalizeText(item))
    : [];
  return {
    digest: productDigest(product._id),
    titleClass: immutableFingerprint.exactMatch
      ? '[历史初始化测试商品]'
      : '[标题已脱敏]',
    status: product.status,
    version: Number.isFinite(Number(product.version))
      ? Number(product.version)
      : null,
    createdAt: safeDate(product.createdAt),
    updatedAt: safeDate(product.updatedAt),
    softDeleted: product.status === 'deleted' || Boolean(product.deletedAt),
    reservation: {
      hasReservedAppointmentId: hasValue(product.reservedAppointmentId),
      hasReservedAt: hasValue(product.reservedAt),
      hasOtherReservationFields: false
    },
    mutationEvidence: {
      hasLastActionType: hasValue(product.lastActionType),
      hasLastMutationId: hasValue(product.lastMutationId),
      hasLastMutationType: hasValue(product.lastMutationType),
      hasPublishRequestId: hasValue(product.publishRequestId),
      statusTimestamps: {
        offlineAt: Boolean(safeDate(product.offlineAt)),
        relistedAt: Boolean(safeDate(product.relistedAt)),
        soldAt: Boolean(safeDate(product.soldAt)),
        deletedAt: Boolean(safeDate(product.deletedAt)),
        reservedAt: Boolean(safeDate(product.reservedAt))
      }
    },
    school: {
      hasSchoolId: hasValue(product.schoolId),
      hasSchoolName: hasValue(product.schoolName),
      authoritative: schoolIsAuthoritative(product, snapshot)
    },
    sellerReference: {
      hasSellerId: hasValue(product.sellerId),
      hasSellerOpenid: hasValue(product.sellerOpenid)
    },
    location: {
      present: Boolean(
        hasValue(product.location)
        || (
          product.locationDetail
          && typeof product.locationDetail === 'object'
        )
      ),
      structured: Boolean(
        product.locationDetail
        && typeof product.locationDetail === 'object'
      )
    },
    media: {
      imageCount,
      videoPresent,
      cleanupStatus: normalizeText(product.imageCleanupStatus) || 'absent',
      cleanupFileCount: cleanupFiles.length,
      cleanupFailedCount:
        Number(product.imageCleanupFailedCount) || 0,
      cleanupTaskPending:
        cleanupFiles.length > 0
        || ['pending', 'partial_failed'].includes(
          normalizeText(product.imageCleanupStatus)
        ),
      actualFilesAccessed: false,
      snapshotReferenceCount: relationships.mediaReferences.total
    },
    counts: {
      favoriteCount: Number(product.favoriteCount) || 0,
      viewCount: Number(product.viewCount) || 0
    },
    accessByCurrentCode: {
      publicDetail: ['available', 'reserved', 'sold'].includes(product.status),
      publicList: ['available', 'reserved'].includes(product.status),
      myProducts: ['available', 'reserved', 'offline', 'sold'].includes(
        product.status
      )
    },
    historicalSeedFingerprint: fingerprintAudit(product),
    immutableHistoricalSeedFingerprint: immutableFingerprint,
    maintenance: {
      present: Boolean(product.maintenance),
      type: normalizeText(product.maintenance && product.maintenance.type),
      authorizedOffline: Boolean(
        product.status === 'offline'
        && Number(product.version) === 1
        && product.maintenance
        && product.maintenance.type === 'orphan_reserved_to_offline'
        && normalizeText(product.maintenance.mutationId)
        && safeDate(product.maintenance.appliedAt)
      ),
      mutationDigest: product.maintenance
        && normalizeText(product.maintenance.mutationId)
        ? `m#${crypto.createHash('sha256')
          .update(product.maintenance.mutationId)
          .digest('hex')
          .slice(0, 12)}`
        : '',
      appliedAtPresent: Boolean(
        safeDate(product.maintenance && product.maintenance.appliedAt)
      )
    },
    seller: buildSellerAudit(product, snapshot),
    relationships
  };
}

function findBroaderInconsistencies(snapshot, targetId) {
  const activeAppointments = snapshot.appointments.filter((item) => (
    item.isDeleted !== true
    && ACTIVE_APPOINTMENT_STATUSES.has(item.status)
  ));
  const acceptedByProduct = Object.fromEntries(
    snapshot.products.map((product) => [
      product._id,
      activeAppointments.filter((item) => (
        item.productId === product._id && item.status === 'accepted'
      )).length
    ])
  );
  const orphanReserved = snapshot.products.filter((product) => (
    product.status === 'reserved'
    && !hasValue(product.reservedAppointmentId)
    && !hasValue(product.reservedAt)
    && Number(acceptedByProduct[product._id] || 0) === 0
  ));
  const acceptedWithoutReserved = activeAppointments.filter((appointment) => {
    if (appointment.status !== 'accepted') {
      return false;
    }
    const product = snapshot.products.find(
      (item) => item._id === appointment.productId
    );
    return !product
      || product.status !== 'reserved'
      || product.reservedAppointmentId !== appointment._id;
  });
  return {
    orphanReservedCount: orphanReserved.length,
    targetIsOnlyOrphan: (
      orphanReserved.length === 1
      && orphanReserved[0]._id === targetId
    ),
    acceptedWithoutMatchingReservedCount: acceptedWithoutReserved.length
  };
}

function createReview(
  snapshotBefore,
  snapshotAfter,
  functions,
  targetDigest,
  targetMasked
) {
  const matches = snapshotBefore.products.filter(
    (product) => productDigest(product._id) === targetDigest
  );
  if (matches.length !== 1) {
    const error = new Error(
      `product digest must match exactly one record; matched ${matches.length}`
    );
    error.code = 'TARGET_DIGEST_NOT_UNIQUE';
    throw error;
  }
  const product = matches[0];
  const productAudit = buildProductAudit(product, snapshotBefore);
  const broader = findBroaderInconsistencies(snapshotBefore, product._id);
  const stopReasons = [];
  const authorizedOffline = productAudit.maintenance.authorizedOffline;
  if (product.status !== 'reserved' && !authorizedOffline) {
    stopReasons.push('TARGET_STATUS_CHANGED');
  }
  if (productAudit.relationships.appointments.active > 0) {
    stopReasons.push('TARGET_HAS_ACTIVE_APPOINTMENT');
  }
  if (productAudit.reservation.hasReservedAppointmentId) {
    stopReasons.push('TARGET_HAS_RESERVED_APPOINTMENT_ID');
  }
  if (
    productAudit.relationships.appointments
      .acceptedMessageWithoutAppointment
  ) {
    stopReasons.push('ACCEPTED_MESSAGE_WITHOUT_APPOINTMENT');
  }
  if (
    !authorizedOffline
    && !broader.targetIsOnlyOrphan
  ) {
    stopReasons.push('BROADER_ORPHAN_RESERVED_PROBLEM');
  }
  if (
    authorizedOffline
    && broader.orphanReservedCount !== 0
  ) {
    stopReasons.push('ORPHAN_RESERVED_REMAINS_AFTER_MAINTENANCE');
  }
  if (broader.acceptedWithoutMatchingReservedCount > 0) {
    stopReasons.push('OTHER_APPOINTMENT_PRODUCT_INCONSISTENCY');
  }
  if (functions.some((item) => (
    item.status !== 'Active'
    || !item.hashAvailable
    || !item.hashMatches
  ))) {
    stopReasons.push('REMOTE_FUNCTION_MISMATCH');
  }
  return {
    schemaVersion: 1,
    mode: MODE,
    generatedAt: new Date().toISOString(),
    target: `cloud:${targetMasked}`,
    privacy:
      'single-product aggregate output; no raw product/user/openid/message/location/media values',
    uniqueness: {
      algorithm:
        'p# + first 10 lowercase hex chars of SHA-256 over the complete product _id',
      requestedDigest: targetDigest,
      matchedRecords: matches.length,
      unique: matches.length === 1
    },
    product: productAudit,
    broaderConsistency: {
      ...broader,
      authorizedTargetOffline: authorizedOffline,
      resolvedTargetNoLongerOrphan:
        authorizedOffline && broader.orphanReservedCount === 0
    },
    cloudFunctions: functions,
    safetyGate: {
      passed: stopReasons.length === 0,
      stopReasons
    },
    noWriteProof: noWriteProof(snapshotBefore, snapshotAfter)
  };
}

function parseArguments(argv) {
  const options = {
    describeTarget: false,
    confirmTarget: '',
    productDigest: '',
    output: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--describe-target') {
      options.describeTarget = true;
    } else if (value === '--confirm-target') {
      options.confirmTarget = normalizeText(argv[++index]);
    } else if (value === '--product-digest') {
      options.productDigest = normalizeText(argv[++index]);
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

function runReview(options = {}) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  if (options.describeTarget) {
    return {
      schemaVersion: 1,
      mode: MODE,
      target: `cloud:${targetMasked}`,
      confirmationRequired: true,
      productDigestRequired: true,
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
  if (!TARGET_DIGEST_PATTERN.test(options.productDigest)) {
    const error = new Error('a valid product digest is required');
    error.code = 'PRODUCT_DIGEST_REQUIRED';
    throw error;
  }
  const rootDirectory = path.resolve(__dirname, '..');
  const snapshotBefore = readSnapshot(environmentId);
  const functions = readFunctionState(environmentId, rootDirectory);
  const snapshotAfter = readSnapshot(environmentId);
  return createReview(
    snapshotBefore,
    snapshotAfter,
    functions,
    options.productDigest,
    targetMasked
  );
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = runReview(options);
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
      code: error.code || 'PHASE_18_ORPHAN_REVIEW_FAILED',
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
  TARGET_DIGEST_PATTERN,
  COLLECTION_PROJECTIONS,
  HISTORICAL_SEED_FINGERPRINT,
  productDigest,
  buildFindCommand,
  assertReadOnlyCommand,
  readCollection,
  readSnapshot,
  fingerprintAudit,
  immutableFingerprintAudit,
  buildProductAudit,
  findBroaderInconsistencies,
  createReview,
  parseArguments,
  runReview
};
