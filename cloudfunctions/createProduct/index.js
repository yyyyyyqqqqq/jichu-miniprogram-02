const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const users = db.collection('users');
const products = db.collection('products');

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
const MAX_PRICE = 999999.99;
const MAX_IMAGES = 6;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{12,80}$/;
const IMAGE_FILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,160}\.(?:jpg|jpeg|png|gif|webp)$/i;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_PARAMS: 'INVALID_PARAMS',
  AUTH_CONTEXT_MISSING: 'AUTH_CONTEXT_MISSING',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DISABLED: 'USER_DISABLED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function success(productId, reused) {
  return {
    success: true,
    code: ERROR_CODES.OK,
    message: '',
    data: {
      productId,
      reused: reused === true
    }
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

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeDescription(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidPrice(value) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
    || value > MAX_PRICE
  ) {
    return false;
  }
  return Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
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
  const filePath = getCloudFilePath(fileID);
  const segments = filePath.split('/');
  return segments.length === 4
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

function createUserId(appId, openId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${appId || 'wechat-app'}:${openId}`)
    .digest('hex')
    .slice(0, 32);
  return `u_${digest}`;
}

function createProductId(userId, requestId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${userId}:${requestId}`)
    .digest('hex')
    .slice(0, 32);
  return `p_${digest}`;
}

function getIdentity() {
  const context = cloud.getWXContext();
  if (!context || !context.OPENID) {
    return null;
  }
  return {
    openId: context.OPENID,
    appId: context.APPID || ''
  };
}

async function findUser(userId) {
  const result = await users.where({
    _id: userId
  }).limit(1).get();
  return result.data && result.data.length > 0 ? result.data[0] : null;
}

async function findProduct(productId) {
  const result = await products.where({
    _id: productId
  }).limit(1).get();
  return result.data && result.data.length > 0 ? result.data[0] : null;
}

function validateProduct(value, userId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
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
    || images.length === 0
  ) {
    return null;
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

function toSellerFields(user, identity, userId) {
  return {
    sellerId: userId,
    sellerOpenid: identity.openId,
    sellerName: normalizeText(user.nickname) || '微信用户',
    sellerAvatar: typeof user.avatarUrl === 'string' ? user.avatarUrl : '',
    sellerVerified: false,
    campus: normalizeText(user.campus) || '校内'
  };
}

exports.main = async (event = {}) => {
  const request = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const requestId = typeof request.requestId === 'string'
    ? request.requestId.trim()
    : '';
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return failure(ERROR_CODES.INVALID_PARAMS, '发布请求参数不正确');
  }

  const identity = getIdentity();
  if (!identity) {
    return failure(ERROR_CODES.AUTH_CONTEXT_MISSING, '登录状态已失效，请重新登录');
  }

  const userId = createUserId(identity.appId, identity.openId);

  try {
    const user = await findUser(userId);
    if (!user) {
      return failure(ERROR_CODES.USER_NOT_FOUND, '用户记录不存在，请重新登录');
    }
    if (user.status !== 'active') {
      return failure(ERROR_CODES.USER_DISABLED, '当前账户暂不可发布商品');
    }

    const product = validateProduct(request.product, userId);
    if (!product) {
      return failure(ERROR_CODES.INVALID_PARAMS, '商品信息不完整或格式不正确');
    }

    const productId = createProductId(userId, requestId);
    const existing = await findProduct(productId);
    if (existing) {
      if (existing.sellerId !== userId) {
        return failure(ERROR_CODES.INVALID_PARAMS, '发布请求冲突');
      }
      return success(productId, true);
    }

    await products.doc(productId).set({
      data: Object.assign(
        {},
        product,
        toSellerFields(user, identity, userId),
        {
          publishRequestId: requestId,
          status: 'available',
          viewCount: 0,
          favoriteCount: 0,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      )
    });

    return success(productId, false);
  } catch (error) {
    console.error('[createProduct] request failed', {
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
        ? '商品保存失败，请稍后重试'
        : '商品发布服务暂不可用'
    );
  }
};
