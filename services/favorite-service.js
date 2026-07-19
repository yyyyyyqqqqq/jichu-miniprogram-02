const { CLOUD_CONFIG } = require('../config/cloud');
const ProductService = require('./product-service');

const DEFAULT_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 20;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  TIMEOUT: '收藏请求超时，请重新尝试',
  CLOUD_NOT_READY: '收藏服务暂不可用',
  INVALID_ACTION: '收藏操作不受支持',
  INVALID_PARAMS: '收藏参数不正确',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  PRODUCT_NOT_FOUND: '商品不存在或已删除',
  PRODUCT_NOT_FAVORITABLE: '当前商品暂不可收藏',
  CANNOT_FAVORITE_OWN_PRODUCT: '不能收藏自己发布的商品',
  FAVORITE_FAILED: '收藏失败，请稍后重试',
  UNFAVORITE_FAILED: '取消收藏失败，请稍后重试',
  DATABASE_ERROR: '收藏数据暂不可用，请稍后重试',
  INTERNAL_ERROR: '收藏服务暂不可用',
  INVALID_RESPONSE: '收藏服务返回异常',
  UNKNOWN_ERROR: '收藏服务暂不可用'
};

class FavoriteError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'FavoriteError';
    this.code = code || 'UNKNOWN_ERROR';
  }
}

function createError(code, message) {
  return new FavoriteError(code, message || ERROR_MESSAGES[code]);
}

function normalizeProductId(value) {
  const productId = value === null || value === undefined
    ? ''
    : String(value).trim();
  return PRODUCT_ID_PATTERN.test(productId) ? productId : '';
}

function normalizePositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.floor(number), maximum);
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function mapTransportError(error) {
  if (error instanceof FavoriteError) {
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

function callFavoriteFunction(action, data) {
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
      name: CLOUD_CONFIG.favoriteProductFunctionName,
      data: { action, data },
      success: resolve,
      fail: reject
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError('TIMEOUT'));
    }, CLOUD_CONFIG.favoriteProductTimeoutMs);
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

function normalizeFavoriteState(data) {
  return {
    isFavorited: data.isFavorited === true,
    favoriteCount: normalizeCount(data.favoriteCount),
    canFavorite: data.canFavorite === true,
    isOwnProduct: data.isOwnProduct === true
  };
}

async function getFavoriteStatus(productId) {
  const normalizedProductId = normalizeProductId(productId);
  if (!normalizedProductId) {
    throw createError('INVALID_PARAMS');
  }
  return normalizeFavoriteState(await callFavoriteFunction('getFavoriteStatus', {
    productId: normalizedProductId
  }));
}

async function mutateFavorite(action, productId) {
  const normalizedProductId = normalizeProductId(productId);
  if (!normalizedProductId) {
    throw createError('INVALID_PARAMS');
  }
  return normalizeFavoriteState(await callFavoriteFunction(action, {
    productId: normalizedProductId
  }));
}

function addFavorite(productId) {
  return mutateFavorite('addFavorite', productId);
}

function removeFavorite(productId) {
  return mutateFavorite('removeFavorite', productId);
}

async function listMyFavorites(options = {}) {
  const page = normalizePositiveInteger(options.page, 1, 100);
  const pageSize = normalizePositiveInteger(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const data = await callFavoriteFunction('listMyFavorites', {
    page,
    pageSize
  });

  let list;
  try {
    list = ProductService.normalizeProductList(data.list).map((product, index) => ({
      ...product,
      favoritedAt: data.list[index] && data.list[index].favoritedAt
        ? String(data.list[index].favoritedAt)
        : ''
    }));
  } catch (error) {
    throw createError('INVALID_RESPONSE');
  }

  return {
    list,
    total: normalizeCount(data.total),
    page: normalizePositiveInteger(data.page, page, 100),
    pageSize: normalizePositiveInteger(data.pageSize, pageSize, MAX_PAGE_SIZE),
    hasMore: data.hasMore === true
  };
}

module.exports = {
  FavoriteError,
  getFavoriteStatus,
  addFavorite,
  removeFavorite,
  listMyFavorites
};
