const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const products = db.collection('products');

const PUBLIC_STATUSES = ['available', 'reserved', 'sold'];
const VALID_CATEGORIES = new Set([
  'all',
  'digital',
  'books',
  'life',
  'clothing',
  'sports',
  'other'
]);
const VALID_SORTS = new Set([
  'default',
  'newest',
  'priceAsc',
  'priceDesc'
]);
const MAX_PAGE_SIZE = 20;
const MAX_PAGE = 100;
const MAX_KEYWORD_LENGTH = 40;
const MAX_SEARCH_TOKENS = 5;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function success(data) {
  return {
    success: true,
    data,
    code: ERROR_CODES.OK,
    message: ''
  };
}

function failure(code, message) {
  return {
    success: false,
    data: null,
    code,
    message
  };
}

function normalizePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.floor(number), maximum);
}

function normalizeKeyword(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_KEYWORD_LENGTH);
}

function normalizeCategoryId(value) {
  if (value === undefined || value === null || value === '') {
    return 'all';
  }
  const categoryId = typeof value === 'string' ? value.trim() : '';
  return VALID_CATEGORIES.has(categoryId) ? categoryId : '';
}

function normalizeSortBy(value) {
  if (value === undefined || value === null || value === '') {
    return 'default';
  }
  return VALID_SORTS.has(value) ? value : '';
}

function normalizeStatuses(value) {
  if (!Array.isArray(value)) {
    return PUBLIC_STATUSES;
  }
  return [...new Set(value.filter((status) => PUBLIC_STATUSES.includes(status)))];
}

function normalizeProductId(value) {
  const productId = value === null || value === undefined
    ? ''
    : String(value).trim();
  return PRODUCT_ID_PATTERN.test(productId) ? productId : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQueryCondition(options) {
  const conditions = [{
    status: command.in(options.statuses)
  }];

  if (options.categoryId !== 'all') {
    conditions.push({
      categoryId: options.categoryId
    });
  }

  if (options.keyword) {
    const tokens = options.keyword.split(' ').slice(0, MAX_SEARCH_TOKENS);
    tokens.forEach((token) => {
      const expression = db.RegExp({
        regexp: escapeRegExp(token),
        options: 'i'
      });
      conditions.push(command.or([
        { title: expression },
        { description: expression },
        { categoryName: expression },
        { condition: expression },
        { location: expression },
        { tags: expression }
      ]));
    });
  }

  return conditions.length === 1
    ? conditions[0]
    : command.and(conditions);
}

function applySort(query, sortBy) {
  if (sortBy === 'newest') {
    return query.orderBy('createdAt', 'desc').orderBy('_id', 'asc');
  }
  if (sortBy === 'priceAsc') {
    return query
      .orderBy('price', 'asc')
      .orderBy('createdAt', 'desc')
      .orderBy('_id', 'asc');
  }
  if (sortBy === 'priceDesc') {
    return query
      .orderBy('price', 'desc')
      .orderBy('createdAt', 'desc')
      .orderBy('_id', 'asc');
  }
  return query
    .orderBy('favoriteCount', 'desc')
    .orderBy('viewCount', 'desc')
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'asc');
}

function toPublicProduct(record) {
  return {
    _id: String(record._id || ''),
    title: record.title,
    description: record.description,
    price: record.price,
    originalPrice: record.originalPrice,
    categoryId: record.categoryId,
    categoryName: record.categoryName,
    condition: record.condition,
    images: record.images,
    coverImage: record.coverImage,
    coverLabel: record.coverLabel,
    coverTone: record.coverTone,
    location: record.location,
    campus: record.campus,
    distanceText: record.distanceText,
    sellerId: record.sellerId,
    sellerName: record.sellerName,
    sellerAvatar: record.sellerAvatar,
    sellerVerified: record.sellerVerified === true,
    status: record.status,
    tags: record.tags,
    viewCount: record.viewCount,
    favoriteCount: record.favoriteCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function listProducts(data) {
  const categoryId = normalizeCategoryId(data.categoryId);
  const sortBy = normalizeSortBy(data.sortBy);
  if (!categoryId || !sortBy) {
    return failure(ERROR_CODES.INVALID_PARAMS, '商品查询参数不正确');
  }

  const page = normalizePositiveInteger(data.page, 1, MAX_PAGE);
  const pageSize = normalizePositiveInteger(data.pageSize, 6, MAX_PAGE_SIZE);
  const keyword = normalizeKeyword(data.keyword);
  const statuses = normalizeStatuses(data.statuses);

  if (statuses.length === 0) {
    return success({
      list: [],
      total: 0,
      page,
      pageSize,
      hasMore: false
    });
  }

  const condition = buildQueryCondition({
    categoryId,
    keyword,
    statuses
  });
  const offset = (page - 1) * pageSize;
  const countResult = await products.where(condition).count();
  const total = Number(countResult.total) || 0;
  const query = applySort(products.where(condition), sortBy);
  const result = await query.skip(offset).limit(pageSize).get();
  const list = Array.isArray(result.data)
    ? result.data.map(toPublicProduct)
    : [];

  return success({
    list,
    total,
    page,
    pageSize,
    hasMore: offset + list.length < total
  });
}

async function getProductDetail(data) {
  const productId = normalizeProductId(data.productId);
  if (!productId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }

  const result = await products.where({
    _id: productId,
    status: command.in(PUBLIC_STATUSES)
  }).limit(1).get();
  const product = result.data && result.data[0];

  if (!product) {
    return failure(
      ERROR_CODES.PRODUCT_NOT_FOUND,
      '商品不存在或已下架'
    );
  }

  return success({
    product: toPublicProduct(product)
  });
}

exports.main = async (event = {}) => {
  const request = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const action = typeof request.action === 'string'
    ? request.action.trim()
    : '';
  const data = request.data
    && typeof request.data === 'object'
    && !Array.isArray(request.data)
    ? request.data
    : {};

  if (!['list', 'detail'].includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的商品操作');
  }

  try {
    if (action === 'list') {
      return await listProducts(data);
    }
    return await getProductDetail(data);
  } catch (error) {
    console.error('[productQuery] request failed', {
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
    );
    return failure(
      isDatabaseError ? ERROR_CODES.DATABASE_ERROR : ERROR_CODES.INTERNAL_ERROR,
      isDatabaseError
        ? '商品数据暂不可用，请稍后重试'
        : '商品服务暂不可用，请稍后重试'
    );
  }
};
