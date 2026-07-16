const { CLOUD_CONFIG } = require('../config/cloud');
const {
  PRODUCT_STATUS,
  PRODUCT_STATUS_META,
  PUBLIC_PRODUCT_STATUSES,
  PRODUCT_SORT
} = require('../constants/product');
const {
  formatPrice,
  formatPublishedTime,
  formatCount
} = require('../utils/format');

const DEFAULT_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 20;
const PUBLIC_STATUS_SET = new Set(PUBLIC_PRODUCT_STATUSES);
const SORT_SET = new Set(Object.values(PRODUCT_SORT));
const CATEGORY_TONES = {
  digital: 'mint',
  books: 'blue',
  life: 'sand',
  clothing: 'rose',
  sports: 'lime',
  other: 'orange'
};

const PRODUCT_ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  TIMEOUT: '商品请求超时，请重新尝试',
  CLOUD_NOT_READY: '商品服务暂不可用',
  INVALID_ACTION: '商品请求不受支持',
  INVALID_PARAMS: '商品查询参数不正确',
  PRODUCT_NOT_FOUND: '商品不存在或已下架',
  DATABASE_ERROR: '商品数据暂不可用，请稍后重试',
  INTERNAL_ERROR: '商品服务暂不可用，请稍后重试',
  INVALID_RESPONSE: '商品服务返回异常',
  UNKNOWN_ERROR: '商品服务暂不可用'
};

class ProductError extends Error {
  constructor(code, message) {
    super(message || PRODUCT_ERROR_MESSAGES[code] || PRODUCT_ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'ProductError';
    this.code = code || 'UNKNOWN_ERROR';
  }
}

function createProductError(code, message) {
  return new ProductError(
    code,
    message || PRODUCT_ERROR_MESSAGES[code]
  );
}

function normalizePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.floor(number), maximum);
}

function normalizeKeyword(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeCategoryId(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : 'all';
}

function normalizeSortBy(value) {
  return SORT_SET.has(value) ? value : PRODUCT_SORT.DEFAULT;
}

function normalizeRequestedStatuses(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const requested = Array.isArray(value) ? value : [value];
  return requested
    .map((status) => status === 'published' ? PRODUCT_STATUS.AVAILABLE : status)
    .filter((status) => PUBLIC_STATUS_SET.has(status));
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeNullablePrice(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function normalizeDateValue(value) {
  if (!value) {
    return '';
  }

  let candidate = value;
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function') {
      candidate = value.toDate();
    } else if (Object.prototype.hasOwnProperty.call(value, '$date')) {
      candidate = value.$date;
    }
  }

  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeStatus(value) {
  const status = value === 'published' ? PRODUCT_STATUS.AVAILABLE : value;
  return PUBLIC_STATUS_SET.has(status) ? status : PRODUCT_STATUS.OFFLINE;
}

function buildCoverLabel(title, value) {
  const label = normalizeString(value);
  if (label) {
    return label.slice(0, 4);
  }
  return normalizeString(title, '闲置').slice(0, 4);
}

function normalizeSeller(record) {
  const rawSeller = record && typeof record.seller === 'object'
    ? record.seller
    : {};
  const nickname = normalizeString(
    record.sellerName || rawSeller.nickname,
    '校园用户'
  );

  return {
    id: normalizeString(record.sellerId || rawSeller.id),
    nickname,
    avatar: normalizeString(
      record.sellerAvatar || rawSeller.avatar || rawSeller.avatarUrl
    ),
    verified: record.sellerVerified === true || rawSeller.verified === true,
    initial: nickname.slice(0, 1) || '校'
  };
}

function normalizeProduct(record) {
  if (!record || typeof record !== 'object') {
    throw createProductError('INVALID_RESPONSE');
  }

  const id = normalizeString(record._id || record.id);
  if (!id) {
    throw createProductError('INVALID_RESPONSE');
  }

  const title = normalizeString(record.title, '未命名闲置');
  const price = normalizeNumber(record.price);
  const priceText = formatPrice(price);
  const originalPrice = normalizeNullablePrice(record.originalPrice);
  const hasOriginalPrice = originalPrice !== null && originalPrice > price;
  const images = normalizeStringArray(record.images);
  const coverImage = normalizeString(record.coverImage, images[0] || '');
  const categoryId = normalizeString(record.categoryId, 'other');
  const status = normalizeStatus(record.status);
  const statusMeta = PRODUCT_STATUS_META[status]
    || PRODUCT_STATUS_META[PRODUCT_STATUS.OFFLINE];
  const createdAt = normalizeDateValue(record.createdAt || record.publishedAt);
  const locationName = normalizeString(
    record.location || record.locationName,
    '校内公共区域'
  );
  const tags = normalizeStringArray(record.tags);

  return {
    id,
    title,
    description: normalizeString(record.description, '卖家暂未填写物品描述'),
    price,
    priceText,
    priceDisplay: priceText === '免费送' ? priceText : `¥${priceText}`,
    originalPrice,
    originalPriceText: hasOriginalPrice ? formatPrice(originalPrice) : '',
    originalPriceDisplay: hasOriginalPrice ? `¥${formatPrice(originalPrice)}` : '',
    hasOriginalPrice,
    categoryId,
    categoryName: normalizeString(record.categoryName, '其他'),
    condition: normalizeString(record.condition, '成色未填写'),
    images,
    coverImage,
    coverLabel: buildCoverLabel(title, record.coverLabel),
    coverTone: normalizeString(record.coverTone, CATEGORY_TONES[categoryId] || 'mint'),
    tags,
    displayTags: tags.slice(0, 2),
    campus: normalizeString(record.campus, '校内'),
    location: locationName,
    locationName,
    distanceText: normalizeString(record.distanceText, '校内面交'),
    seller: normalizeSeller(record),
    status,
    statusText: statusMeta.text,
    statusClass: statusMeta.className,
    isReserved: status === PRODUCT_STATUS.RESERVED,
    isSold: status === PRODUCT_STATUS.SOLD,
    viewCount: normalizeNumber(record.viewCount),
    favoriteCount: normalizeNumber(record.favoriteCount),
    viewCountText: formatCount(record.viewCount),
    favoriteCountText: formatCount(record.favoriteCount),
    createdAt,
    updatedAt: normalizeDateValue(record.updatedAt),
    publishedAt: createdAt,
    publishedAtText: formatPublishedTime(createdAt)
  };
}

function normalizeProductList(value) {
  if (!Array.isArray(value)) {
    throw createProductError('INVALID_RESPONSE');
  }
  return value.map(normalizeProduct);
}

function mapCloudFailure(error) {
  if (error instanceof ProductError) {
    return error;
  }

  const message = error && typeof error.errMsg === 'string'
    ? error.errMsg.toLowerCase()
    : '';

  if (message.includes('timeout')) {
    return createProductError('TIMEOUT');
  }
  if (message.includes('network') || message.includes('request:fail')) {
    return createProductError('NETWORK_ERROR');
  }
  if (
    message.includes('cloud')
    || message.includes('environment')
    || message.includes('function not found')
  ) {
    return createProductError('CLOUD_NOT_READY');
  }

  return createProductError('UNKNOWN_ERROR');
}

function callProductQuery(action, data) {
  if (
    typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.callFunction !== 'function'
  ) {
    return Promise.reject(createProductError('CLOUD_NOT_READY'));
  }

  let timeoutId;
  const request = new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: CLOUD_CONFIG.productFunctionName,
      data: {
        action,
        data
      },
      success: resolve,
      fail: reject
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createProductError('TIMEOUT'));
    }, CLOUD_CONFIG.productTimeoutMs);
  });

  return Promise.race([request, timeout])
    .then((response) => {
      const payload = response && response.result;
      if (!payload || typeof payload !== 'object' || typeof payload.success !== 'boolean') {
        throw createProductError('INVALID_RESPONSE');
      }
      return payload;
    })
    .catch((error) => {
      throw mapCloudFailure(error);
    })
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
}

async function getProductList(options = {}) {
  const page = normalizePositiveInteger(options.page, 1);
  const pageSize = normalizePositiveInteger(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const statuses = normalizeRequestedStatuses(options.status);

  if (statuses && statuses.length === 0) {
    return {
      list: [],
      total: 0,
      page,
      pageSize,
      hasMore: false
    };
  }

  const payload = await callProductQuery('list', {
    keyword: normalizeKeyword(options.keyword),
    categoryId: normalizeCategoryId(options.categoryId),
    sortBy: normalizeSortBy(options.sortBy),
    page,
    pageSize,
    statuses
  });

  if (!payload.success) {
    throw createProductError(payload.code || 'UNKNOWN_ERROR', payload.message);
  }

  const result = payload.data && typeof payload.data === 'object'
    ? payload.data
    : {};
  const list = normalizeProductList(result.list);
  const total = normalizeNumber(result.total);

  return {
    list,
    total,
    page: normalizePositiveInteger(result.page, page),
    pageSize: normalizePositiveInteger(result.pageSize, pageSize, MAX_PAGE_SIZE),
    hasMore: result.hasMore === true
  };
}

async function getProductDetail(productId) {
  const id = normalizeString(productId);
  if (!id) {
    return null;
  }

  const payload = await callProductQuery('detail', {
    productId: id
  });

  if (!payload.success) {
    if (payload.code === 'PRODUCT_NOT_FOUND') {
      return null;
    }
    throw createProductError(payload.code || 'UNKNOWN_ERROR', payload.message);
  }

  return normalizeProduct(payload.data && payload.data.product);
}

async function searchProducts(keyword) {
  return getProductList({
    keyword,
    page: 1,
    pageSize: MAX_PAGE_SIZE
  });
}

module.exports = {
  ProductError,
  getProductList,
  getProductDetail,
  getProducts: getProductList,
  getProductById: getProductDetail,
  searchProducts,
  normalizeProduct,
  normalizeProductList
};
