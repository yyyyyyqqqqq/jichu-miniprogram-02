const { CLOUD_CONFIG } = require('../config/cloud');
const ProductService = require('./product-service');
const ProductEditService = require('./product-edit-service');
const { PRODUCT_STATUS } = require('../constants/product');

const DEFAULT_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 20;
const MY_PRODUCT_STATUSES = new Set([
  PRODUCT_STATUS.AVAILABLE,
  PRODUCT_STATUS.OFFLINE,
  PRODUCT_STATUS.SOLD
]);
const MANAGE_ACTIONS = new Set([
  'takeOffline',
  'relist',
  'markSold'
]);

const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  TIMEOUT: '商品管理请求超时，请重新尝试',
  CLOUD_NOT_READY: '商品管理服务暂不可用',
  INVALID_ACTION: '商品管理操作不受支持',
  INVALID_PARAMS: '商品管理参数不正确',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  PRODUCT_NOT_FOUND: '商品不存在',
  PRODUCT_FORBIDDEN: '无权管理该商品',
  PRODUCT_DELETED: '商品已被删除',
  PRODUCT_NOT_EDITABLE: '当前商品状态不支持此操作',
  PRODUCT_VERSION_CONFLICT: '商品信息已在其他页面发生变化，请刷新后重试',
  INVALID_STATUS_TRANSITION: '当前商品状态不支持此操作',
  DATABASE_ERROR: '商品数据暂不可用，请稍后重试',
  INTERNAL_ERROR: '商品管理服务暂不可用',
  INVALID_RESPONSE: '商品管理服务返回异常',
  UNKNOWN_ERROR: '商品管理服务暂不可用'
};

class MyProductsError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'MyProductsError';
    this.code = code || 'UNKNOWN_ERROR';
  }
}

function createError(code, message) {
  return new MyProductsError(
    code,
    message || ERROR_MESSAGES[code]
  );
}

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.floor(number), maximum);
}

function normalizeStatus(value) {
  return MY_PRODUCT_STATUSES.has(value)
    ? value
    : PRODUCT_STATUS.AVAILABLE;
}

function normalizeProductId(value) {
  const productId = value === null || value === undefined
    ? ''
    : String(value).trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(productId) ? productId : '';
}

function mapTransportError(error) {
  if (error instanceof MyProductsError) {
    return error;
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

function callCloudFunction(functionName, data, timeoutMs) {
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
      name: functionName,
      data,
      success: resolve,
      fail: reject
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError('TIMEOUT'));
    }, timeoutMs);
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

async function getMyProducts(options = {}) {
  const status = normalizeStatus(options.status);
  const page = normalizePositiveInteger(options.page, 1, 100);
  const pageSize = normalizePositiveInteger(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const data = await callCloudFunction(
    CLOUD_CONFIG.productFunctionName,
    {
      action: 'myProducts',
      data: {
        status,
        page,
        pageSize
      }
    },
    CLOUD_CONFIG.productTimeoutMs
  );

  let list;
  try {
    list = ProductService.normalizeProductList(data.list);
  } catch (error) {
    throw createError('INVALID_RESPONSE');
  }
  const total = Number(data.total);

  return {
    list,
    total: Number.isFinite(total) && total >= 0 ? total : 0,
    page: normalizePositiveInteger(data.page, page, 100),
    pageSize: normalizePositiveInteger(data.pageSize, pageSize, MAX_PAGE_SIZE),
    hasMore: data.hasMore === true
  };
}

async function manageProduct(action, productId) {
  if (!MANAGE_ACTIONS.has(action)) {
    throw createError('INVALID_ACTION');
  }
  const normalizedProductId = normalizeProductId(productId);
  if (!normalizedProductId) {
    throw createError('INVALID_PARAMS');
  }

  const data = await callCloudFunction(
    CLOUD_CONFIG.manageProductFunctionName,
    {
      action,
      productId: normalizedProductId
    },
    CLOUD_CONFIG.manageProductTimeoutMs
  );

  if (
    data.productId !== normalizedProductId
    || !MY_PRODUCT_STATUSES.has(data.status)
  ) {
    throw createError('INVALID_RESPONSE');
  }

  return {
    productId: data.productId,
    status: data.status,
    version: normalizePositiveInteger(data.version, 1, Number.MAX_SAFE_INTEGER),
    reused: data.reused === true
  };
}

function softDelete(productId, expectedVersion, mutationId) {
  return ProductEditService.softDelete({
    productId,
    expectedVersion,
    mutationId
  });
}

module.exports = {
  MyProductsError,
  getMyProducts,
  manageProduct,
  softDelete
};
