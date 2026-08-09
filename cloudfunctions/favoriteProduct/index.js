const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const products = db.collection('products');
const favorites = db.collection('favorites');
const users = db.collection('users');
const ALLOWED_LIST_STATUSES = new Set([
  'available',
  'reserved',
  'offline',
  'sold'
]);
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const MAX_PAGE = 100;
const MAX_PAGE_SIZE = 20;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_NOT_FAVORITABLE: 'PRODUCT_NOT_FAVORITABLE',
  CANNOT_FAVORITE_OWN_PRODUCT: 'CANNOT_FAVORITE_OWN_PRODUCT',
  CROSS_SCHOOL_RELATION_FORBIDDEN: 'CROSS_SCHOOL_RELATION_FORBIDDEN',
  FAVORITE_FAILED: 'FAVORITE_FAILED',
  UNFAVORITE_FAILED: 'UNFAVORITE_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

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
  const error = new Error(message);
  error.businessCode = code;
  throw error;
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

function createFavoriteId(openId, productId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${openId}:${productId}`)
    .digest('hex');
  return `f_${digest}`;
}

function createUserId(appId, openId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex');
  return `u_${digest.slice(0, 32)}`;
}

function canCreateSchoolRelation(user, openId, product) {
  const userSchoolId = typeof user?.schoolId === 'string'
    ? user.schoolId.trim()
    : '';
  const productSchoolId = typeof product?.schoolId === 'string'
    ? product.schoolId.trim()
    : '';
  return Boolean(
    user
    && user.status === 'active'
    && user.openid === openId
    && SCHOOL_ID_PATTERN.test(userSchoolId)
    && SCHOOL_ID_PATTERN.test(productSchoolId)
    && userSchoolId === productSchoolId
  );
}

function assertCanCreateSchoolRelation(user, openId, product) {
  if (!canCreateSchoolRelation(user, openId, product)) {
    businessError(
      ERROR_CODES.CROSS_SCHOOL_RELATION_FORBIDDEN,
      '暂不支持与其他学校的商品建立新的交易关系'
    );
  }
}

function extractRecord(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  if (result.data && !Array.isArray(result.data)) {
    return result.data;
  }
  return Array.isArray(result.data) && result.data.length > 0
    ? result.data[0]
    : null;
}

function isMissingDocumentError(error) {
  const code = String(error && (error.errCode || error.code || '')).toLowerCase();
  const messages = [
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  return code === 'document_not_found'
    || code === 'database_document_not_exist'
    || messages.some((message) => (
      message.includes('document not exists')
      || message.includes('document does not exist')
      || /^document\.get:fail document with _id .+ does not exist$/.test(message)
    ));
}

function toSafeDiagnosticToken(value) {
  const token = value === null || value === undefined ? '' : String(value);
  return /^[a-zA-Z0-9_.:-]{0,80}$/.test(token) ? token : 'UNSAFE_VALUE';
}

function classifyFailure(error, step) {
  if (typeof step === 'string' && step.includes('.read_')) {
    return 'database_read_failed';
  }
  const text = [
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).join(' ').toLowerCase();
  if (text.includes('permission') || text.includes('authorized')) {
    return 'permission';
  }
  if (text.includes('transaction')) {
    return 'transaction';
  }
  if (text.includes('collection') || text.includes('database')) {
    return 'database';
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return 'timeout';
  }
  if (text.includes('network') || text.includes('socket')) {
    return 'network';
  }
  return 'unknown';
}

function createSafeDiagnostic(error, step) {
  return {
    step,
    name: toSafeDiagnosticToken(error && error.name),
    code: toSafeDiagnosticToken(error && error.code),
    errCode: toSafeDiagnosticToken(error && error.errCode),
    reason: classifyFailure(error, step)
  };
}

async function getDocumentOrNull(document) {
  try {
    return extractRecord(await document.get());
  } catch (error) {
    if (isMissingDocumentError(error)) {
      return null;
    }
    throw error;
  }
}

async function runTransaction(callback) {
  const response = await db.runTransaction(async (transaction) => callback(transaction));
  if (
    response
    && typeof response === 'object'
    && Object.prototype.hasOwnProperty.call(response, 'result')
  ) {
    return response.result;
  }
  return response;
}

function toIsoString(value) {
  if (!value) {
    return '';
  }
  let candidate = value;
  if (value && typeof value.toDate === 'function') {
    candidate = value.toDate();
  } else if (
    value
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, '$date')
  ) {
    candidate = value.$date;
  }
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toFavoriteProduct(record, favoritedAt) {
  return {
    _id: String(record._id || ''),
    title: record.title,
    description: record.description,
    price: record.price,
    originalPrice: record.originalPrice,
    categoryId: record.categoryId,
    categoryName: record.categoryName,
    condition: record.condition,
    coverImage: record.coverImage
      || (Array.isArray(record.images) && record.images[0])
      || record.coverUrl
      || record.image
      || '',
    coverLabel: record.coverLabel,
    coverTone: record.coverTone,
    location: record.location,
    campus: record.campus,
    schoolId: record.schoolId,
    schoolName: record.schoolName,
    distanceText: record.distanceText,
    sellerPublicUserId: record.sellerId,
    sellerName: record.sellerName,
    sellerAvatar: record.sellerAvatar,
    sellerVerified: record.sellerVerified === true,
    status: record.status,
    tags: record.tags,
    viewCount: normalizeCount(record.viewCount),
    favoriteCount: normalizeCount(record.favoriteCount),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    favoritedAt: toIsoString(favoritedAt)
  };
}

async function getFavoriteStatus(data, identity, trace) {
  trace.step = 'status.validate';
  const productId = normalizeProductId(data.productId);
  if (!productId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }
  trace.step = 'status.read_product';
  const product = await getDocumentOrNull(products.doc(productId));
  if (!product || product.status === 'deleted') {
    return failure(ERROR_CODES.PRODUCT_NOT_FOUND, '商品不存在或已删除');
  }
  const favoriteId = createFavoriteId(identity.openId, productId);
  trace.step = 'status.read_relation';
  const relation = await getDocumentOrNull(favorites.doc(favoriteId));
  trace.step = 'status.read_user';
  const currentUser = await getDocumentOrNull(users.doc(identity.userId));
  const isOwnProduct = product.sellerOpenid === identity.openId;
  const sameSchool = canCreateSchoolRelation(
    currentUser,
    identity.openId,
    product
  );
  return success({
    isFavorited: Boolean(relation),
    favoriteCount: normalizeCount(product.favoriteCount),
    canFavorite: !isOwnProduct && product.status === 'available' && sameSchool,
    isOwnProduct,
    isCrossSchool: !isOwnProduct && !sameSchool
  });
}

async function addFavorite(data, identity, trace) {
  trace.step = 'add.validate';
  const productId = normalizeProductId(data.productId);
  if (!productId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }
  const favoriteId = createFavoriteId(identity.openId, productId);
  trace.step = 'add.begin_transaction';
  const result = await runTransaction(async (transaction) => {
    const productDocument = transaction.collection('products').doc(productId);
    trace.step = 'add.read_product';
    const product = await getDocumentOrNull(productDocument);
    if (!product || product.status === 'deleted') {
      businessError(ERROR_CODES.PRODUCT_NOT_FOUND, '商品不存在或已删除');
    }
    if (product.sellerOpenid === identity.openId) {
      businessError(
        ERROR_CODES.CANNOT_FAVORITE_OWN_PRODUCT,
        '不能收藏自己发布的商品'
      );
    }
    const favoriteDocument = transaction.collection('favorites').doc(favoriteId);
    trace.step = 'add.read_relation';
    const existing = await getDocumentOrNull(favoriteDocument);
    const currentCount = normalizeCount(product.favoriteCount);
    if (existing) {
      return {
        isFavorited: true,
        favoriteCount: currentCount,
        canFavorite: true,
        isOwnProduct: false,
        isCrossSchool: false,
        reused: true
      };
    }

    trace.step = 'add.read_user';
    const currentUser = await getDocumentOrNull(
      transaction.collection('users').doc(identity.userId)
    );
    assertCanCreateSchoolRelation(currentUser, identity.openId, product);
    if (product.status !== 'available') {
      businessError(ERROR_CODES.PRODUCT_NOT_FAVORITABLE, '当前商品暂不可收藏');
    }

    trace.step = 'add.write_relation';
    await favoriteDocument.set({
      data: {
        userOpenid: identity.openId,
        productId,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    trace.step = 'add.update_product_count';
    await productDocument.update({
      data: {
        favoriteCount: currentCount + 1,
        updatedAt: db.serverDate()
      }
    });
    return {
      isFavorited: true,
      favoriteCount: currentCount + 1,
      canFavorite: true,
      isOwnProduct: false,
      isCrossSchool: false,
      reused: false
    };
  });
  return success(result);
}

async function removeFavorite(data, identity, trace) {
  trace.step = 'remove.validate';
  const productId = normalizeProductId(data.productId);
  if (!productId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }
  const favoriteId = createFavoriteId(identity.openId, productId);
  trace.step = 'remove.begin_transaction';
  const result = await runTransaction(async (transaction) => {
    const favoriteDocument = transaction.collection('favorites').doc(favoriteId);
    trace.step = 'remove.read_relation';
    const relation = await getDocumentOrNull(favoriteDocument);
    const productDocument = transaction.collection('products').doc(productId);
    trace.step = 'remove.read_product';
    const product = await getDocumentOrNull(productDocument);
    const currentCount = product ? normalizeCount(product.favoriteCount) : 0;
    trace.step = 'remove.read_user';
    const currentUser = await getDocumentOrNull(
      transaction.collection('users').doc(identity.userId)
    );
    const sameSchool = canCreateSchoolRelation(
      currentUser,
      identity.openId,
      product
    );

    if (!relation) {
      return {
        isFavorited: false,
        favoriteCount: currentCount,
        canFavorite: Boolean(
          product
          && product.status === 'available'
          && product.sellerOpenid !== identity.openId
          && sameSchool
        ),
        isOwnProduct: Boolean(product && product.sellerOpenid === identity.openId),
        isCrossSchool: Boolean(
          product
          && product.sellerOpenid !== identity.openId
          && !sameSchool
        ),
        reused: true
      };
    }

    trace.step = 'remove.delete_relation';
    await favoriteDocument.remove();
    const nextCount = Math.max(0, currentCount - 1);
    if (product) {
      trace.step = 'remove.update_product_count';
      await productDocument.update({
        data: {
          favoriteCount: nextCount,
          updatedAt: db.serverDate()
        }
      });
    }
    return {
      isFavorited: false,
      favoriteCount: nextCount,
      canFavorite: Boolean(
        product
        && product.status === 'available'
        && product.sellerOpenid !== identity.openId
        && sameSchool
      ),
      isOwnProduct: Boolean(product && product.sellerOpenid === identity.openId),
      isCrossSchool: Boolean(
        product
        && product.sellerOpenid !== identity.openId
        && !sameSchool
      ),
      reused: false
    };
  });
  return success(result);
}

async function listMyFavorites(data, openId, trace) {
  trace.step = 'list.validate';
  const page = normalizePositiveInteger(data.page, 1, MAX_PAGE);
  const pageSize = normalizePositiveInteger(data.pageSize, 6, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const condition = { userOpenid: openId };
  trace.step = 'list.count_relations';
  const countResult = await favorites.where(condition).count();
  const total = normalizeCount(countResult.total);
  trace.step = 'list.read_relations';
  const relationResult = await favorites
    .where(condition)
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'desc')
    .skip(offset)
    .limit(pageSize)
    .get();
  const relations = Array.isArray(relationResult.data) ? relationResult.data : [];
  const list = [];
  for (const relation of relations) {
    trace.step = 'list.read_products';
    const product = await getDocumentOrNull(products.doc(relation.productId));
    if (product && ALLOWED_LIST_STATUSES.has(product.status)) {
      list.push(toFavoriteProduct(product, relation.createdAt));
    }
  }
  return success({
    list,
    total,
    page,
    pageSize,
    hasMore: offset + relations.length < total
  });
}

exports.main = async (event = {}) => {
  const request = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const action = typeof request.action === 'string' ? request.action.trim() : '';
  const data = request.data
    && typeof request.data === 'object'
    && !Array.isArray(request.data)
    ? request.data
    : {};
  if (![
    'getFavoriteStatus',
    'addFavorite',
    'removeFavorite',
    'listMyFavorites'
  ].includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的收藏操作');
  }

  const context = cloud.getWXContext();
  const openId = context && typeof context.OPENID === 'string'
    ? context.OPENID
    : '';
  const appId = context && typeof context.APPID === 'string'
    ? context.APPID
    : '';
  if (!openId || !appId) {
    return failure(ERROR_CODES.UNAUTHORIZED, '登录状态已失效，请重新登录');
  }
  const identity = {
    openId,
    appId,
    userId: createUserId(appId, openId)
  };

  const trace = { step: 'route_action' };
  try {
    if (action === 'getFavoriteStatus') {
      return await getFavoriteStatus(data, identity, trace);
    }
    if (action === 'addFavorite') {
      return await addFavorite(data, identity, trace);
    }
    if (action === 'removeFavorite') {
      return await removeFavorite(data, identity, trace);
    }
    return await listMyFavorites(data, openId, trace);
  } catch (error) {
    if (error && error.businessCode) {
      return failure(error.businessCode, error.message);
    }
    const diagnostic = createSafeDiagnostic(error, trace.step);
    console.error('[favoriteProduct] request failed', diagnostic);
    const code = String(error && (error.errCode || error.code || '')).toLowerCase();
    const message = String(error && error.message || '').toLowerCase();
    const isDatabaseError = Boolean(
      error && error.errCode
      || code.includes('database')
      || message.includes('database')
      || message.includes('collection')
      || message.includes('transaction')
    );
    return failure(
      isDatabaseError ? ERROR_CODES.DATABASE_ERROR : ERROR_CODES.INTERNAL_ERROR,
      isDatabaseError
        ? '收藏数据暂不可用，请稍后重试'
        : '收藏服务暂不可用，请稍后重试'
    );
  }
};

exports.__test = Object.freeze({
  canCreateSchoolRelation,
  assertCanCreateSchoolRelation,
  createUserId
});
