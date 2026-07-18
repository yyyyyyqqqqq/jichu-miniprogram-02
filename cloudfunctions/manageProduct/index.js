const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const products = db.collection('products');

const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MUTATION_ID_PATTERN = /^[a-zA-Z0-9_-]{12,80}$/;
const IMAGE_FILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,160}\.(?:jpg|jpeg|png|gif|webp)$/i;
const MAX_IMAGES = 6;
const MAX_PRICE = 999999.99;
const CATEGORY_MAP = {
  digital: '数码',
  books: '书籍',
  life: '生活',
  clothing: '服饰',
  sports: '运动',
  other: '其他'
};
const CATEGORY_TONES = {
  digital: 'mint',
  books: 'blue',
  life: 'sand',
  clothing: 'rose',
  sports: 'lime',
  other: 'orange'
};
const VALID_CONDITIONS = new Set([
  '全新',
  '九成新',
  '八成新',
  '七成新',
  '六成及以下'
]);
const EDITABLE_STATUSES = new Set(['available', 'offline']);
const DELETABLE_STATUSES = new Set(['available', 'offline', 'sold']);
const ALLOWED_UPDATE_FIELDS = new Set([
  'title',
  'description',
  'price',
  'categoryId',
  'categoryName',
  'condition',
  'location',
  'images'
]);

const ACTIONS = {
  TAKE_OFFLINE: 'takeOffline',
  RELIST: 'relist',
  MARK_SOLD: 'markSold',
  GET_EDITABLE_PRODUCT: 'getEditableProduct',
  UPDATE_PRODUCT: 'updateProduct',
  SOFT_DELETE: 'softDelete',
  RETRY_IMAGE_CLEANUP: 'retryImageCleanup'
};
const TRANSITIONS = {
  [ACTIONS.TAKE_OFFLINE]: {
    from: 'available',
    to: 'offline',
    marker: 'offlineAt'
  },
  [ACTIONS.RELIST]: {
    from: 'offline',
    to: 'available',
    marker: 'relistedAt'
  },
  [ACTIONS.MARK_SOLD]: {
    from: 'available',
    to: 'sold',
    marker: 'soldAt'
  }
};

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_FORBIDDEN: 'PRODUCT_FORBIDDEN',
  PRODUCT_DELETED: 'PRODUCT_DELETED',
  PRODUCT_NOT_EDITABLE: 'PRODUCT_NOT_EDITABLE',
  PRODUCT_VERSION_CONFLICT: 'PRODUCT_VERSION_CONFLICT',
  INVALID_PRODUCT_FIELD: 'INVALID_PRODUCT_FIELD',
  INVALID_IMAGE_LIST: 'INVALID_IMAGE_LIST',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  UPDATE_FAILED: 'UPDATE_FAILED',
  DELETE_FAILED: 'DELETE_FAILED',
  IMAGE_CLEANUP_PARTIAL_FAILED: 'IMAGE_CLEANUP_PARTIAL_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

function success(data) {
  return {
    success: true,
    code: ERROR_CODES.OK,
    message: '',
    data
  };
}

function failure(code, message) {
  return {
    success: false,
    code,
    message,
    data: null
  };
}

function businessError(code, message) {
  throw new BusinessError(code, message);
}

function normalizeProductId(value) {
  const productId = value === null || value === undefined
    ? ''
    : String(value).trim();
  return PRODUCT_ID_PATTERN.test(productId) ? productId : '';
}

function normalizeMutationId(value) {
  const mutationId = typeof value === 'string' ? value.trim() : '';
  return MUTATION_ID_PATTERN.test(mutationId) ? mutationId : '';
}

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : 0;
}

function getProductVersion(product) {
  return normalizeVersion(product && product.version) || 1;
}

function getOpenId() {
  const context = cloud.getWXContext();
  return context && typeof context.OPENID === 'string'
    ? context.OPENID
    : '';
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeDescription(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidPrice(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= MAX_PRICE
    && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}

function getCloudFilePath(fileID) {
  if (
    typeof fileID !== 'string'
    || fileID.length > 1024
    || !fileID.startsWith('cloud://')
  ) {
    return '';
  }
  const match = fileID.match(/^cloud:\/\/[^/]+\/(.+)$/);
  return match ? match[1] : '';
}

function isOwnedProductImage(fileID, userId) {
  const segments = getCloudFilePath(fileID).split('/');
  return typeof userId === 'string'
    && /^[a-zA-Z0-9_-]{3,64}$/.test(userId)
    && segments.length === 4
    && segments[0] === 'products'
    && segments[1] === userId
    && /^\d{8}$/.test(segments[2])
    && IMAGE_FILE_NAME_PATTERN.test(segments[3]);
}

function normalizeImages(value, userId) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IMAGES) {
    return [];
  }
  const images = value.filter((fileID, index, list) => (
    isOwnedProductImage(fileID, userId)
    && list.indexOf(fileID) === index
  ));
  return images.length === value.length ? images : [];
}

function normalizeCleanupFiles(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((fileID, index, list) => (
    typeof fileID === 'string'
    && fileID.startsWith('cloud://')
    && list.indexOf(fileID) === index
  ));
}

function extractProduct(result) {
  const data = result && result.data;
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  return data && typeof data === 'object' ? data : null;
}

async function findProduct(productId) {
  const result = await products.where({
    _id: productId
  }).limit(1).get();
  return extractProduct(result);
}

function assertProductAccess(product, openId) {
  if (!product) {
    businessError(ERROR_CODES.PRODUCT_NOT_FOUND, '商品不存在');
  }
  if (product.sellerOpenid !== openId) {
    businessError(ERROR_CODES.PRODUCT_FORBIDDEN, '无权管理该商品');
  }
}

function toEditableProduct(product) {
  return {
    id: String(product._id || ''),
    title: product.title,
    description: product.description,
    price: product.price,
    categoryId: product.categoryId,
    condition: product.condition,
    location: product.location,
    images: Array.isArray(product.images) ? product.images.slice() : [],
    status: product.status
  };
}

function validateProductUpdate(value, userId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    businessError(ERROR_CODES.INVALID_PRODUCT_FIELD, '商品信息格式不正确');
  }
  if (
    Object.keys(value).some((field) => !ALLOWED_UPDATE_FIELDS.has(field))
  ) {
    businessError(ERROR_CODES.INVALID_PRODUCT_FIELD, '商品包含不可编辑字段');
  }

  const title = normalizeText(value.title);
  const description = normalizeDescription(value.description);
  const categoryId = normalizeText(value.categoryId);
  const categoryName = CATEGORY_MAP[categoryId];
  const condition = normalizeText(value.condition);
  const location = normalizeText(value.location);
  const images = normalizeImages(value.images, userId);

  if (
    title.length < 2
    || title.length > 40
    || description.length < 5
    || description.length > 1000
    || !isValidPrice(value.price)
    || !categoryName
    || !VALID_CONDITIONS.has(condition)
    || location.length < 2
    || location.length > 80
  ) {
    businessError(
      ERROR_CODES.INVALID_PRODUCT_FIELD,
      '商品信息不完整或格式不正确'
    );
  }
  if (images.length === 0) {
    businessError(
      ERROR_CODES.INVALID_IMAGE_LIST,
      '商品图片数量或路径不正确'
    );
  }

  return {
    title,
    description,
    price: value.price,
    originalPrice: null,
    categoryId,
    categoryName,
    condition,
    images,
    coverImage: images[0],
    coverLabel: title.slice(0, 4),
    coverTone: CATEGORY_TONES[categoryId] || 'mint',
    location,
    distanceText: '校内面交',
    tags: []
  };
}

async function runProductTransaction(callback) {
  const response = await db.runTransaction(async (transaction) => {
    return callback(transaction);
  });
  if (
    response
    && typeof response === 'object'
    && Object.prototype.hasOwnProperty.call(response, 'result')
  ) {
    return response.result;
  }
  return response;
}

function buildTransitionData(action, version) {
  const currentTime = db.serverDate();
  const data = {
    status: TRANSITIONS[action].to,
    updatedAt: currentTime,
    version: version + 1
  };
  if (action === ACTIONS.TAKE_OFFLINE) {
    data.offlineAt = currentTime;
  } else if (action === ACTIONS.RELIST) {
    data.offlineAt = null;
    data.relistedAt = currentTime;
  } else if (action === ACTIONS.MARK_SOLD) {
    data.soldAt = currentTime;
  }
  return data;
}

async function performTransition(productId, openId, action) {
  return runProductTransaction(async (transaction) => {
    const document = transaction.collection('products').doc(productId);
    const product = extractProduct(await document.get());
    assertProductAccess(product, openId);
    if (product.status === 'deleted') {
      businessError(ERROR_CODES.PRODUCT_DELETED, '商品已被删除');
    }

    const transition = TRANSITIONS[action];
    const version = getProductVersion(product);
    if (
      product.status === transition.to
      && Boolean(product[transition.marker])
    ) {
      return {
        productId,
        status: transition.to,
        version,
        reused: true
      };
    }
    if (product.status !== transition.from) {
      businessError(
        ERROR_CODES.INVALID_STATUS_TRANSITION,
        '当前商品状态不支持此操作'
      );
    }

    await document.update({
      data: buildTransitionData(action, version)
    });
    return {
      productId,
      status: transition.to,
      version: version + 1,
      reused: false
    };
  });
}

async function getEditableProduct(productId, openId) {
  const product = await findProduct(productId);
  assertProductAccess(product, openId);
  if (product.status === 'deleted') {
    businessError(ERROR_CODES.PRODUCT_DELETED, '商品已被删除');
  }
  if (!EDITABLE_STATUSES.has(product.status)) {
    businessError(ERROR_CODES.PRODUCT_NOT_EDITABLE, '当前商品状态不允许编辑');
  }
  return {
    product: toEditableProduct(product),
    version: getProductVersion(product)
  };
}

async function updateProduct(productId, openId, request) {
  const expectedVersion = normalizeVersion(request.expectedVersion);
  const mutationId = normalizeMutationId(request.mutationId);
  if (!expectedVersion || !mutationId) {
    businessError(ERROR_CODES.INVALID_PARAMS, '缺少有效并发版本或请求 ID');
  }

  return runProductTransaction(async (transaction) => {
    const document = transaction.collection('products').doc(productId);
    const product = extractProduct(await document.get());
    assertProductAccess(product, openId);
    if (product.status === 'deleted') {
      businessError(ERROR_CODES.PRODUCT_DELETED, '商品已被删除');
    }
    if (
      product.lastMutationId === mutationId
      && product.lastMutationType === ACTIONS.UPDATE_PRODUCT
    ) {
      return {
        productId,
        version: getProductVersion(product),
        reused: true,
        cleanupFiles: normalizeCleanupFiles(product.imageCleanupFiles),
        sellerId: product.sellerId
      };
    }
    if (!EDITABLE_STATUSES.has(product.status)) {
      businessError(ERROR_CODES.PRODUCT_NOT_EDITABLE, '当前商品状态不允许编辑');
    }

    const version = getProductVersion(product);
    if (version !== expectedVersion) {
      businessError(
        ERROR_CODES.PRODUCT_VERSION_CONFLICT,
        '商品信息已在其他页面发生变化，请刷新后重新编辑'
      );
    }

    const updateData = validateProductUpdate(request.product, product.sellerId);
    const oldImages = normalizeCleanupFiles(product.images);
    const finalImageSet = new Set(updateData.images);
    const cleanupFiles = oldImages.filter((fileID) => !finalImageSet.has(fileID));
    const nextVersion = version + 1;

    await document.update({
      data: Object.assign({}, updateData, {
        updatedAt: db.serverDate(),
        version: nextVersion,
        lastMutationId: mutationId,
        lastMutationType: ACTIONS.UPDATE_PRODUCT,
        imageCleanupStatus: cleanupFiles.length > 0 ? 'pending' : 'completed',
        imageCleanupFiles: cleanupFiles,
        imageCleanupFailedCount: 0,
        imageCleanupUpdatedAt: db.serverDate()
      })
    });
    return {
      productId,
      version: nextVersion,
      reused: false,
      cleanupFiles,
      sellerId: product.sellerId
    };
  });
}

async function softDeleteProduct(productId, openId, request) {
  const expectedVersion = normalizeVersion(request.expectedVersion);
  const mutationId = normalizeMutationId(request.mutationId);
  if (!expectedVersion || !mutationId) {
    businessError(ERROR_CODES.INVALID_PARAMS, '缺少有效并发版本或请求 ID');
  }

  return runProductTransaction(async (transaction) => {
    const document = transaction.collection('products').doc(productId);
    const product = extractProduct(await document.get());
    assertProductAccess(product, openId);
    const version = getProductVersion(product);

    if (product.status === 'deleted') {
      return {
        productId,
        status: 'deleted',
        version,
        reused: true,
        cleanupFiles: normalizeCleanupFiles(product.imageCleanupFiles),
        sellerId: product.sellerId
      };
    }
    if (!DELETABLE_STATUSES.has(product.status)) {
      businessError(ERROR_CODES.PRODUCT_NOT_EDITABLE, '当前商品状态不允许删除');
    }
    if (version !== expectedVersion) {
      businessError(
        ERROR_CODES.PRODUCT_VERSION_CONFLICT,
        '商品信息已在其他页面发生变化，请刷新后重试'
      );
    }

    const cleanupFiles = normalizeCleanupFiles(product.images);
    const nextVersion = version + 1;
    await document.update({
      data: {
        status: 'deleted',
        deletedAt: db.serverDate(),
        deletedBy: 'owner',
        deleteReason: 'user_deleted',
        updatedAt: db.serverDate(),
        version: nextVersion,
        lastMutationId: mutationId,
        lastMutationType: ACTIONS.SOFT_DELETE,
        imageCleanupStatus: cleanupFiles.length > 0 ? 'pending' : 'completed',
        imageCleanupFiles: cleanupFiles,
        imageCleanupFailedCount: 0,
        imageCleanupUpdatedAt: db.serverDate()
      }
    });
    return {
      productId,
      status: 'deleted',
      version: nextVersion,
      reused: false,
      cleanupFiles,
      sellerId: product.sellerId
    };
  });
}

async function isFileStillReferenced(fileID, productId) {
  const result = await products.where({
    images: command.all([fileID])
  }).limit(100).get();
  const records = result && Array.isArray(result.data) ? result.data : [];
  return records.some((record) => (
    record
    && (
      record._id !== productId
      || record.status !== 'deleted'
    )
  ));
}

async function deleteCloudFile(fileID) {
  const response = await cloud.deleteFile({
    fileList: [fileID]
  });
  const item = response && Array.isArray(response.fileList)
    ? response.fileList[0]
    : null;
  return Boolean(
    item
    && (
      item.status === 0
      || item.status === '0'
      || item.success === true
      || /not\s*found|not\s*exist|不存在/i.test(
        String(item.errMsg || item.message || '')
      )
    )
  );
}

async function persistCleanupResult(options) {
  const failedFiles = options.failedFiles;
  const updateResult = await products.where({
    _id: options.productId,
    sellerOpenid: options.openId,
    version: options.version
  }).update({
    data: {
      imageCleanupStatus: failedFiles.length > 0
        ? 'partial_failed'
        : 'completed',
      imageCleanupFiles: failedFiles,
      imageCleanupFailedCount: failedFiles.length,
      imageCleanupUpdatedAt: db.serverDate()
    }
  });
  return Boolean(
    updateResult
    && updateResult.stats
    && Number(updateResult.stats.updated) > 0
  );
}

async function cleanupImages(options) {
  const candidates = normalizeCleanupFiles(options.fileIDs);
  const failedFiles = [];
  let retainedReferenceCount = 0;

  for (const fileID of candidates) {
    if (!isOwnedProductImage(fileID, options.sellerId)) {
      failedFiles.push(fileID);
      continue;
    }
    try {
      if (await isFileStillReferenced(fileID, options.productId)) {
        retainedReferenceCount += 1;
        continue;
      }
      if (!await deleteCloudFile(fileID)) {
        failedFiles.push(fileID);
      }
    } catch (error) {
      failedFiles.push(fileID);
    }
  }

  try {
    await persistCleanupResult({
      productId: options.productId,
      openId: options.openId,
      version: options.version,
      failedFiles
    });
  } catch (error) {
    if (failedFiles.length === 0 && candidates.length > 0) {
      failedFiles.push(...candidates);
    }
  }

  if (failedFiles.length > 0) {
    console.warn('[manageProduct] image cleanup incomplete', {
      failedCount: failedFiles.length,
      retainedReferenceCount
    });
  }
  return {
    cleanupPending: failedFiles.length > 0,
    cleanupFailedCount: failedFiles.length
  };
}

async function retryImageCleanup(productId, openId) {
  const product = await findProduct(productId);
  assertProductAccess(product, openId);
  const cleanupFiles = normalizeCleanupFiles(product.imageCleanupFiles);
  if (cleanupFiles.length === 0) {
    return {
      productId,
      cleanupPending: false,
      cleanupFailedCount: 0
    };
  }
  return Object.assign(
    { productId },
    await cleanupImages({
      productId,
      openId,
      version: getProductVersion(product),
      sellerId: product.sellerId,
      fileIDs: cleanupFiles
    })
  );
}

async function runMutationWithCleanup(result, openId) {
  const cleanupResult = result.cleanupFiles.length > 0
    ? await cleanupImages({
      productId: result.productId,
      openId,
      version: result.version,
      sellerId: result.sellerId,
      fileIDs: result.cleanupFiles
    })
    : {
      cleanupPending: false,
      cleanupFailedCount: 0
    };
  return Object.assign({}, result, cleanupResult, {
    cleanupFiles: undefined,
    sellerId: undefined
  });
}

function mapUnexpectedFailure(error, action) {
  if (error instanceof BusinessError) {
    return failure(error.code, error.message);
  }
  console.error('[manageProduct] request failed', {
    action,
    code: error && (error.errCode || error.code || '')
  });
  const errorCode = error && (error.errCode || error.code || '');
  const errorMessage = error && error.message
    ? String(error.message).toLowerCase()
    : '';
  const isDatabaseError = Boolean(
    error && error.errCode
    || String(errorCode).toLowerCase().includes('database')
    || errorMessage.includes('database')
    || errorMessage.includes('collection')
    || errorMessage.includes('transaction')
  );
  return failure(
    isDatabaseError ? ERROR_CODES.DATABASE_ERROR : ERROR_CODES.INTERNAL_ERROR,
    isDatabaseError
      ? '商品数据更新失败，请稍后重试'
      : '商品管理服务暂不可用'
  );
}

exports.main = async (event = {}) => {
  const request = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const action = typeof request.action === 'string'
    ? request.action.trim()
    : '';
  const productId = normalizeProductId(request.productId);
  const supportedActions = new Set([
    ...Object.keys(TRANSITIONS),
    ACTIONS.GET_EDITABLE_PRODUCT,
    ACTIONS.UPDATE_PRODUCT,
    ACTIONS.SOFT_DELETE,
    ACTIONS.RETRY_IMAGE_CLEANUP
  ]);

  if (!supportedActions.has(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的商品管理操作');
  }
  if (!productId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }

  const openId = getOpenId();
  if (!openId) {
    return failure(ERROR_CODES.UNAUTHORIZED, '登录状态已失效，请重新登录');
  }

  try {
    if (Object.prototype.hasOwnProperty.call(TRANSITIONS, action)) {
      return success(await performTransition(productId, openId, action));
    }
    if (action === ACTIONS.GET_EDITABLE_PRODUCT) {
      return success(await getEditableProduct(productId, openId));
    }
    if (action === ACTIONS.UPDATE_PRODUCT) {
      const result = await updateProduct(productId, openId, request);
      return success(await runMutationWithCleanup(result, openId));
    }
    if (action === ACTIONS.SOFT_DELETE) {
      const result = await softDeleteProduct(productId, openId, request);
      return success(await runMutationWithCleanup(result, openId));
    }
    return success(await retryImageCleanup(productId, openId));
  } catch (error) {
    return mapUnexpectedFailure(error, action);
  }
};
