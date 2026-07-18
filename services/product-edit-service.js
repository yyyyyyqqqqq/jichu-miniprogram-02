const { CLOUD_CONFIG } = require('../config/cloud');
const ProductPublishService = require('./product-publish-service');
const { PRODUCT_STATUS } = require('../constants/product');
const {
  PRODUCT_PUBLISH_LIMITS
} = require('../constants/product-publish');

const EDITABLE_STATUSES = new Set([
  PRODUCT_STATUS.AVAILABLE,
  PRODUCT_STATUS.OFFLINE
]);
const AMBIGUOUS_ERROR_CODES = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'UNKNOWN_ERROR'
]);

const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  TIMEOUT: '商品编辑请求超时，请确认结果后重试',
  CLOUD_NOT_READY: '商品编辑服务暂不可用',
  INVALID_ACTION: '商品编辑操作不受支持',
  INVALID_PARAMS: '商品编辑参数不正确',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  PRODUCT_NOT_FOUND: '商品不存在',
  PRODUCT_FORBIDDEN: '无权编辑该商品',
  PRODUCT_DELETED: '商品已被删除',
  PRODUCT_NOT_EDITABLE: '当前商品状态不允许编辑',
  PRODUCT_VERSION_CONFLICT: '商品信息已在其他页面发生变化，请刷新后重新编辑',
  INVALID_PRODUCT_FIELD: '商品信息不完整或格式不正确',
  INVALID_IMAGE_LIST: '请保留至少一张且最多六张有效商品图片',
  UPDATE_FAILED: '商品更新失败，请稍后重试',
  DELETE_FAILED: '商品删除失败，请稍后重试',
  IMAGE_CLEANUP_PARTIAL_FAILED: '商品已更新，部分旧图片正在清理，不影响正常使用',
  DATABASE_ERROR: '商品数据暂不可用，请稍后重试',
  INTERNAL_ERROR: '商品编辑服务暂不可用',
  INVALID_RESPONSE: '商品编辑服务返回异常',
  OPERATION_CANCELLED: '编辑操作已取消',
  UNKNOWN_ERROR: '商品编辑服务暂不可用'
};

class ProductEditError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'ProductEditError';
    this.code = code || 'UNKNOWN_ERROR';
    this.uploadedFileIds = [];
    this.outcomeUnknown = false;
  }
}

function createError(code, message) {
  return new ProductEditError(
    code,
    message || ERROR_MESSAGES[code]
  );
}

function normalizeProductId(value) {
  const productId = value === null || value === undefined
    ? ''
    : String(value).trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(productId) ? productId : '';
}

function normalizeVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : 0;
}

function createMutationId() {
  return `mut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

function mapTransportError(error) {
  if (error instanceof ProductEditError) {
    return error;
  }
  if (error instanceof ProductPublishService.ProductPublishError) {
    const mapped = createError(error.code, error.message);
    mapped.uploadedFileIds = Array.isArray(error.uploadedFileIds)
      ? error.uploadedFileIds.slice()
      : [];
    return mapped;
  }

  const message = error && typeof error.errMsg === 'string'
    ? error.errMsg.toLowerCase()
    : '';
  if (message.includes('timeout')) {
    return createError('TIMEOUT');
  }
  if (
    message.includes('network')
    || message.includes('request:fail')
    || message.includes('socket')
  ) {
    return createError('NETWORK_ERROR');
  }
  if (
    message.includes('cloud')
    || message.includes('environment')
    || message.includes('function not found')
  ) {
    return createError('CLOUD_NOT_READY');
  }
  return createError('UNKNOWN_ERROR');
}

function callManageProduct(action, data) {
  if (
    typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.callFunction !== 'function'
  ) {
    return Promise.reject(createError('CLOUD_NOT_READY'));
  }

  let timeoutId;
  const request = new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: CLOUD_CONFIG.manageProductFunctionName,
      data: Object.assign({ action }, data),
      success: resolve,
      fail: reject
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError('TIMEOUT'));
    }, CLOUD_CONFIG.manageProductTimeoutMs);
  });

  return Promise.race([request, timeout])
    .then((response) => {
      const payload = response && response.result;
      if (
        !payload
        || typeof payload !== 'object'
        || typeof payload.success !== 'boolean'
      ) {
        throw createError('INVALID_RESPONSE');
      }
      if (!payload.success) {
        throw createError(payload.code || 'UNKNOWN_ERROR', payload.message);
      }
      return payload.data && typeof payload.data === 'object'
        ? payload.data
        : {};
    })
    .catch((error) => {
      throw mapTransportError(error);
    })
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
}

async function getEditableProduct(productId) {
  const id = normalizeProductId(productId);
  if (!id) {
    throw createError('INVALID_PARAMS');
  }
  const data = await callManageProduct('getEditableProduct', {
    productId: id
  });
  const product = data.product && typeof data.product === 'object'
    ? data.product
    : null;
  const version = normalizeVersion(data.version);
  if (
    !product
    || product.id !== id
    || !EDITABLE_STATUSES.has(product.status)
    || !version
    || !Array.isArray(product.images)
    || product.images.length < 1
    || product.images.length > PRODUCT_PUBLISH_LIMITS.MAX_IMAGES
  ) {
    throw createError('INVALID_RESPONSE');
  }

  return {
    product: {
      id,
      title: typeof product.title === 'string' ? product.title : '',
      description: typeof product.description === 'string'
        ? product.description
        : '',
      price: product.price,
      categoryId: typeof product.categoryId === 'string'
        ? product.categoryId
        : '',
      condition: typeof product.condition === 'string'
        ? product.condition
        : '',
      location: typeof product.location === 'string' ? product.location : '',
      images: product.images.slice(),
      status: product.status
    },
    version
  };
}

async function updateProduct(options = {}) {
  const productId = normalizeProductId(options.productId);
  const expectedVersion = normalizeVersion(options.expectedVersion);
  const mutationId = typeof options.mutationId === 'string'
    ? options.mutationId.trim()
    : '';
  const userId = typeof options.userId === 'string'
    ? options.userId.trim()
    : '';
  if (
    !productId
    || !expectedVersion
    || !/^[a-zA-Z0-9_-]{12,80}$/.test(mutationId)
  ) {
    throw createError('INVALID_PARAMS');
  }

  const normalized = ProductPublishService.validateProductFields(options.draft);
  const existingFileIDs = ProductPublishService.normalizeCloudFileIds(
    options.existingFileIDs,
    userId
  );
  if (
    !Array.isArray(options.existingFileIDs)
    || existingFileIDs.length !== options.existingFileIDs.length
  ) {
    throw createError('INVALID_IMAGE_LIST');
  }

  const localImages = Array.isArray(options.localImages)
    ? options.localImages
    : [];
  ProductPublishService.validateLocalImages(localImages, { allowEmpty: true });
  const pendingFileIds = ProductPublishService.normalizeCloudFileIds(
    options.pendingFileIds,
    userId
  );
  let uploadedFileIds = pendingFileIds;
  let uploadedThisAttempt = [];

  try {
    if (uploadedFileIds.length === 0 && localImages.length > 0) {
      uploadedFileIds = await ProductPublishService.uploadLocalImages({
        localImages,
        userId,
        shouldContinue: options.shouldContinue,
        onProgress: options.onProgress
      });
      uploadedThisAttempt = uploadedFileIds.slice();
    }

    const finalImages = [];
    const seenFileIDs = new Set();
    existingFileIDs.concat(uploadedFileIds).forEach((fileID) => {
      if (!seenFileIDs.has(fileID)) {
        seenFileIDs.add(fileID);
        finalImages.push(fileID);
      }
    });
    if (
      finalImages.length < 1
      || finalImages.length > PRODUCT_PUBLISH_LIMITS.MAX_IMAGES
    ) {
      throw createError('INVALID_IMAGE_LIST');
    }

    const data = await callManageProduct('updateProduct', {
      productId,
      expectedVersion,
      mutationId,
      product: Object.assign({}, normalized, {
        images: finalImages
      })
    });
    const version = normalizeVersion(data.version);
    if (data.productId !== productId || !version) {
      throw createError('INVALID_RESPONSE');
    }
    return {
      productId,
      version,
      reused: data.reused === true,
      cleanupPending: data.cleanupPending === true,
      cleanupFailedCount: Number(data.cleanupFailedCount) || 0
    };
  } catch (error) {
    const normalizedError = mapTransportError(error);
    if (
      uploadedThisAttempt.length === 0
      && Array.isArray(normalizedError.uploadedFileIds)
    ) {
      uploadedThisAttempt = normalizedError.uploadedFileIds.slice();
      uploadedFileIds = uploadedThisAttempt.slice();
    }
    if (
      uploadedFileIds.length > 0
      && AMBIGUOUS_ERROR_CODES.has(normalizedError.code)
    ) {
      normalizedError.uploadedFileIds = uploadedFileIds.slice();
      normalizedError.outcomeUnknown = true;
    } else if (uploadedThisAttempt.length > 0) {
      await ProductPublishService.deleteCloudFiles(uploadedThisAttempt, userId);
    }
    throw normalizedError;
  }
}

async function softDelete(options = {}) {
  const productId = normalizeProductId(options.productId);
  const expectedVersion = normalizeVersion(options.expectedVersion);
  const mutationId = typeof options.mutationId === 'string'
    ? options.mutationId.trim()
    : '';
  if (
    !productId
    || !expectedVersion
    || !/^[a-zA-Z0-9_-]{12,80}$/.test(mutationId)
  ) {
    throw createError('INVALID_PARAMS');
  }
  const data = await callManageProduct('softDelete', {
    productId,
    expectedVersion,
    mutationId
  });
  const version = normalizeVersion(data.version);
  if (
    data.productId !== productId
    || data.status !== PRODUCT_STATUS.DELETED
    || !version
  ) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    productId,
    status: data.status,
    version,
    reused: data.reused === true,
    cleanupPending: data.cleanupPending === true,
    cleanupFailedCount: Number(data.cleanupFailedCount) || 0
  };
}

async function retryImageCleanup(productId) {
  const id = normalizeProductId(productId);
  if (!id) {
    throw createError('INVALID_PARAMS');
  }
  return callManageProduct('retryImageCleanup', {
    productId: id
  });
}

module.exports = {
  ProductEditError,
  createMutationId,
  getEditableProduct,
  updateProduct,
  softDelete,
  retryImageCleanup
};
