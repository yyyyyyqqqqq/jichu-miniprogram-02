const { CLOUD_CONFIG } = require('../config/cloud');
const {
  PRODUCT_PUBLISH_LIMITS,
  PRODUCT_CONDITIONS,
  PRODUCT_PUBLISH_CATEGORIES
} = require('../constants/product-publish');

const CATEGORY_MAP = PRODUCT_PUBLISH_CATEGORIES.reduce((result, category) => {
  result[category.id] = category.name;
  return result;
}, {});
const CONDITION_SET = new Set(PRODUCT_CONDITIONS);
const AMBIGUOUS_ERROR_CODES = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'UNKNOWN_ERROR'
]);
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp'
]);
const IMAGE_FILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,160}\.(?:jpg|jpeg|png|gif|webp)$/i;

const ERROR_MESSAGES = {
  TITLE_REQUIRED: '请填写商品标题',
  TITLE_LENGTH_INVALID: '商品标题应为 2～40 个字符',
  DESCRIPTION_REQUIRED: '请填写商品描述',
  DESCRIPTION_LENGTH_INVALID: '商品描述应为 5～1000 个字符',
  PRICE_REQUIRED: '请填写商品价格',
  PRICE_INVALID: '请输入大于 0 且最多两位小数的价格',
  PRICE_TOO_LARGE: '商品价格不能超过 999999.99 元',
  CATEGORY_REQUIRED: '请选择商品分类',
  CONDITION_REQUIRED: '请选择新旧程度',
  LOCATION_REQUIRED: '请填写交易地点',
  LOCATION_LENGTH_INVALID: '交易地点应为 2～80 个字符',
  IMAGE_REQUIRED: '请至少选择一张商品图片',
  IMAGE_COUNT_INVALID: '商品图片最多选择 6 张',
  IMAGE_TYPE_INVALID: '请选择有效的图片文件',
  IMAGE_SIZE_INVALID: '图片文件大小无效，请重新选择',
  IMAGE_TOO_LARGE: '单张图片不能超过 10MB',
  INVALID_PARAMS: '商品信息不完整，请检查后重试',
  AUTH_CONTEXT_MISSING: '登录状态已失效，请重新登录',
  USER_NOT_FOUND: '用户记录不存在，请重新登录',
  USER_DISABLED: '当前账户暂不可发布商品',
  DUPLICATE_REQUEST: '该商品已经发布，请勿重复提交',
  UPLOAD_FAILED: '图片上传失败，请稍后重试',
  UPLOAD_TIMEOUT: '图片上传超时，请检查网络后重试',
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  TIMEOUT: '发布请求超时，请确认发布结果后重试',
  CLOUD_NOT_READY: '商品发布服务暂不可用',
  DATABASE_ERROR: '商品保存失败，请稍后重试',
  INTERNAL_ERROR: '商品发布服务暂不可用',
  INVALID_RESPONSE: '商品发布服务返回异常',
  OPERATION_CANCELLED: '发布操作已取消',
  UNKNOWN_ERROR: '商品发布失败，请稍后重试'
};

class ProductPublishError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'ProductPublishError';
    this.code = code || 'UNKNOWN_ERROR';
    this.uploadedFileIds = [];
  }
}

function createError(code, message) {
  return new ProductPublishError(
    code,
    message || ERROR_MESSAGES[code]
  );
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeDescription(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validatePrice(value) {
  const text = typeof value === 'string' ? value.trim() : String(value || '');
  if (!text) {
    throw createError('PRICE_REQUIRED');
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    throw createError('PRICE_INVALID');
  }

  const price = Number(text);
  if (!Number.isFinite(price) || price <= 0) {
    throw createError('PRICE_INVALID');
  }
  if (price > PRODUCT_PUBLISH_LIMITS.MAX_PRICE) {
    throw createError('PRICE_TOO_LARGE');
  }
  return price;
}

function validateProductFields(draft) {
  const value = draft && typeof draft === 'object' ? draft : {};
  const title = normalizeText(value.title);
  if (!title) {
    throw createError('TITLE_REQUIRED');
  }
  if (
    title.length < PRODUCT_PUBLISH_LIMITS.TITLE_MIN_LENGTH
    || title.length > PRODUCT_PUBLISH_LIMITS.TITLE_MAX_LENGTH
  ) {
    throw createError('TITLE_LENGTH_INVALID');
  }

  const description = normalizeDescription(value.description);
  if (!description) {
    throw createError('DESCRIPTION_REQUIRED');
  }
  if (
    description.length < PRODUCT_PUBLISH_LIMITS.DESCRIPTION_MIN_LENGTH
    || description.length > PRODUCT_PUBLISH_LIMITS.DESCRIPTION_MAX_LENGTH
  ) {
    throw createError('DESCRIPTION_LENGTH_INVALID');
  }

  const categoryId = normalizeText(value.categoryId);
  const categoryName = CATEGORY_MAP[categoryId];
  if (!categoryName) {
    throw createError('CATEGORY_REQUIRED');
  }

  const condition = normalizeText(value.condition);
  if (!CONDITION_SET.has(condition)) {
    throw createError('CONDITION_REQUIRED');
  }

  const location = normalizeText(value.location);
  if (!location) {
    throw createError('LOCATION_REQUIRED');
  }
  if (
    location.length < PRODUCT_PUBLISH_LIMITS.LOCATION_MIN_LENGTH
    || location.length > PRODUCT_PUBLISH_LIMITS.LOCATION_MAX_LENGTH
  ) {
    throw createError('LOCATION_LENGTH_INVALID');
  }

  return {
    title,
    description,
    price: validatePrice(value.price),
    categoryId,
    categoryName,
    condition,
    location
  };
}

function validateLocalImages(localImages, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  if (!Array.isArray(localImages) || (!allowEmpty && localImages.length === 0)) {
    throw createError('IMAGE_REQUIRED');
  }
  if (localImages.length > PRODUCT_PUBLISH_LIMITS.MAX_IMAGES) {
    throw createError('IMAGE_COUNT_INVALID');
  }
  localImages.forEach((image) => {
    const tempFilePath = image && typeof image.tempFilePath === 'string'
      ? image.tempFilePath
      : '';
    const size = Number(image && image.size);
    const mediaType = image && typeof image.fileType === 'string'
      ? image.fileType.toLowerCase()
      : '';
    if (!tempFilePath || (mediaType && mediaType !== 'image')) {
      throw createError('IMAGE_TYPE_INVALID');
    }
    if (!normalizeFileExtension(tempFilePath)) {
      throw createError('IMAGE_TYPE_INVALID');
    }
    if (!Number.isFinite(size) || size <= 0) {
      throw createError('IMAGE_SIZE_INVALID');
    }
    if (size > PRODUCT_PUBLISH_LIMITS.MAX_IMAGE_SIZE) {
      throw createError('IMAGE_TOO_LARGE');
    }
  });
  return localImages;
}

function validateProductDraft(draft, localImages) {
  const normalized = validateProductFields(draft);
  validateLocalImages(localImages);
  return normalized;
}

function randomToken(length = 10) {
  let value = '';
  while (value.length < length) {
    value += Math.random().toString(36).slice(2);
  }
  return value.slice(0, length);
}

function createSubmissionId() {
  return `req_${Date.now().toString(36)}_${randomToken(12)}`;
}

function normalizeUserId(value) {
  const userId = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9_-]{3,64}$/.test(userId) ? userId : '';
}

function normalizeFileExtension(tempFilePath) {
  const path = typeof tempFilePath === 'string'
    ? tempFilePath.split('?')[0]
    : '';
  const match = path.match(/\.([a-zA-Z0-9]{2,5})$/);
  const extension = match ? match[1].toLowerCase() : '';
  return ALLOWED_IMAGE_EXTENSIONS.has(extension) ? extension : '';
}

function formatDateFolder(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function buildCloudPath(userId, tempFilePath, index) {
  const extension = normalizeFileExtension(tempFilePath);
  if (!extension) {
    throw createError('IMAGE_TYPE_INVALID');
  }
  return [
    'products',
    userId,
    formatDateFolder(),
    `${Date.now()}-${index}-${randomToken(10)}.${extension}`
  ].join('/');
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
  const normalizedUserId = normalizeUserId(userId);
  const segments = getCloudFilePath(fileID).split('/');
  return Boolean(normalizedUserId)
    && segments.length === 4
    && segments[0] === 'products'
    && segments[1] === normalizedUserId
    && /^\d{8}$/.test(segments[2])
    && IMAGE_FILE_NAME_PATTERN.test(segments[3]);
}

function validateImageDecoding(tempFilePath) {
  if (
    typeof wx === 'undefined'
    || typeof wx.getImageInfo !== 'function'
  ) {
    return Promise.reject(createError('CLOUD_NOT_READY'));
  }

  let timeoutId;
  const request = new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: tempFilePath,
      success: resolve,
      fail() {
        reject(createError('IMAGE_TYPE_INVALID'));
      }
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError('IMAGE_TYPE_INVALID'));
    }, CLOUD_CONFIG.productImageValidationTimeoutMs);
  });

  return Promise.race([request, timeout])
    .then((result) => {
      const width = Number(result && result.width);
      const height = Number(result && result.height);
      if (
        !Number.isFinite(width)
        || width <= 0
        || !Number.isFinite(height)
        || height <= 0
      ) {
        throw createError('IMAGE_TYPE_INVALID');
      }
      return true;
    })
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
}

function mapTransportError(error, fallbackCode) {
  if (error instanceof ProductPublishError) {
    return error;
  }

  const message = error && typeof error.errMsg === 'string'
    ? error.errMsg.toLowerCase()
    : '';
  if (message.includes('timeout')) {
    return createError(fallbackCode === 'UPLOAD_FAILED' ? 'UPLOAD_TIMEOUT' : 'TIMEOUT');
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
  return createError(fallbackCode || 'UNKNOWN_ERROR');
}

function uploadSingleImage(tempFilePath, cloudPath) {
  if (
    typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.uploadFile !== 'function'
  ) {
    return Promise.reject(createError('CLOUD_NOT_READY'));
  }

  let timeoutId;
  let uploadTask;
  let settled = false;

  return new Promise((resolve, reject) => {
    function finish(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      callback(value);
    }

    uploadTask = wx.cloud.uploadFile({
      cloudPath,
      filePath: tempFilePath,
      success(response) {
        const fileID = response && typeof response.fileID === 'string'
          ? response.fileID
          : '';
        if (!fileID || getCloudFilePath(fileID) !== cloudPath) {
          finish(reject, createError('UPLOAD_FAILED'));
          return;
        }
        finish(resolve, fileID);
      },
      fail(error) {
        finish(reject, mapTransportError(error, 'UPLOAD_FAILED'));
      }
    });

    timeoutId = setTimeout(() => {
      if (uploadTask && typeof uploadTask.abort === 'function') {
        uploadTask.abort();
      }
      finish(reject, createError('UPLOAD_TIMEOUT'));
    }, CLOUD_CONFIG.productUploadTimeoutMs);
    if (settled) {
      clearTimeout(timeoutId);
    }
  });
}

async function uploadLocalImages(options = {}) {
  const localImages = Array.isArray(options.localImages)
    ? options.localImages
    : [];
  validateLocalImages(localImages, { allowEmpty: true });
  const userId = normalizeUserId(options.userId);
  if (!userId) {
    throw createError('AUTH_CONTEXT_MISSING');
  }
  const shouldContinue = typeof options.shouldContinue === 'function'
    ? options.shouldContinue
    : () => true;
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : () => {};
  const uploadedFileIds = [];

  try {
    for (let index = 0; index < localImages.length; index += 1) {
      if (!shouldContinue()) {
        throw createError('OPERATION_CANCELLED');
      }
      const image = localImages[index];
      const tempFilePath = image && typeof image.tempFilePath === 'string'
        ? image.tempFilePath
        : '';
      if (!tempFilePath) {
        throw createError('INVALID_PARAMS');
      }
      await validateImageDecoding(tempFilePath);
      onProgress({
        stage: 'uploading',
        completed: index,
        total: localImages.length
      });
      const fileID = await uploadSingleImage(
        tempFilePath,
        buildCloudPath(userId, tempFilePath, index)
      );
      uploadedFileIds.push(fileID);
    }
    return uploadedFileIds;
  } catch (error) {
    const normalizedError = error instanceof ProductPublishError
      ? error
      : mapTransportError(error, 'UPLOAD_FAILED');
    normalizedError.uploadedFileIds = uploadedFileIds.slice();
    throw normalizedError;
  }
}

function normalizeCloudFileIds(value, userId) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((fileID, index, list) => (
    isOwnedProductImage(fileID, userId)
    && list.indexOf(fileID) === index
  ));
}

async function deleteCloudFiles(fileIDs, userId) {
  const safeFileIDs = normalizeCloudFileIds(fileIDs, userId);
  if (
    safeFileIDs.length === 0
    || typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.deleteFile !== 'function'
  ) {
    return false;
  }

  try {
    let timeoutId;
    const request = new Promise((resolve, reject) => {
      wx.cloud.deleteFile({
        fileList: safeFileIDs,
        success: resolve,
        fail: reject
      });
    });
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(createError('TIMEOUT'));
      }, CLOUD_CONFIG.createProductTimeoutMs);
    });
    const response = await Promise.race([request, timeout]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
    const failedCount = response && Array.isArray(response.fileList)
      ? response.fileList.filter((item) => item && item.status !== 0).length
      : 0;
    if (failedCount > 0) {
      console.warn('[ProductPublishService] orphan cleanup incomplete', {
        failedCount
      });
    }
    return failedCount === 0;
  } catch (error) {
    console.warn('[ProductPublishService] orphan cleanup failed');
    return false;
  }
}

function callCreateProduct(data) {
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
      name: CLOUD_CONFIG.createProductFunctionName,
      data,
      success: resolve,
      fail: reject
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError('TIMEOUT'));
    }, CLOUD_CONFIG.createProductTimeoutMs);
  });

  return Promise.race([request, timeout])
    .then((response) => {
      const payload = response && response.result;
      if (!payload || typeof payload !== 'object' || typeof payload.success !== 'boolean') {
        throw createError('INVALID_RESPONSE');
      }
      if (!payload.success) {
        throw createError(payload.code || 'UNKNOWN_ERROR', payload.message);
      }
      const productId = payload.data && typeof payload.data.productId === 'string'
        ? payload.data.productId
        : '';
      if (!productId) {
        throw createError('INVALID_RESPONSE');
      }
      return {
        productId,
        reused: payload.data.reused === true
      };
    })
    .catch((error) => {
      throw mapTransportError(error, 'UNKNOWN_ERROR');
    })
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
}

async function publishProduct(options = {}) {
  const normalized = validateProductDraft(options.draft, options.localImages);
  const userId = normalizeUserId(options.userId);
  if (!userId) {
    throw createError('AUTH_CONTEXT_MISSING');
  }

  const requestId = typeof options.requestId === 'string'
    ? options.requestId.trim()
    : '';
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId)) {
    throw createError('INVALID_PARAMS');
  }

  const shouldContinue = typeof options.shouldContinue === 'function'
    ? options.shouldContinue
    : () => true;
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : () => {};
  const pendingFileIds = normalizeCloudFileIds(options.pendingFileIds, userId);
  const uploadedThisAttempt = [];
  let fileIDs = pendingFileIds;

  try {
    if (fileIDs.length === 0) {
      fileIDs = await uploadLocalImages({
        localImages: options.localImages,
        userId,
        shouldContinue,
        onProgress
      });
      uploadedThisAttempt.push(...fileIDs);
    }

    if (!shouldContinue()) {
      throw createError('OPERATION_CANCELLED');
    }
    onProgress({
      stage: 'saving',
      completed: fileIDs.length,
      total: fileIDs.length
    });

    const result = await callCreateProduct({
      requestId,
      product: Object.assign({}, normalized, {
        images: fileIDs
      })
    });

    if (result.reused && uploadedThisAttempt.length > 0) {
      await deleteCloudFiles(uploadedThisAttempt, userId);
    }
    return result;
  } catch (error) {
    const normalizedError = error instanceof ProductPublishError
      ? error
      : mapTransportError(error, 'UNKNOWN_ERROR');
    if (
      uploadedThisAttempt.length === 0
      && Array.isArray(normalizedError.uploadedFileIds)
    ) {
      uploadedThisAttempt.push(...normalizedError.uploadedFileIds);
    }
    if (fileIDs.length === 0 && uploadedThisAttempt.length > 0) {
      fileIDs = uploadedThisAttempt.slice();
    }
    if (
      fileIDs.length > 0
      && AMBIGUOUS_ERROR_CODES.has(normalizedError.code)
    ) {
      normalizedError.uploadedFileIds = fileIDs.slice();
    } else if (uploadedThisAttempt.length > 0) {
      await deleteCloudFiles(uploadedThisAttempt, userId);
    }
    throw normalizedError;
  }
}

module.exports = {
  ProductPublishError,
  createSubmissionId,
  validateProductFields,
  validateLocalImages,
  validateProductDraft,
  uploadLocalImages,
  normalizeCloudFileIds,
  publishProduct,
  deleteCloudFiles
};
