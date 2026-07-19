const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const users = db.collection('users');
const products = db.collection('products');
const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const MAX_PAGE = 100;
const MAX_PAGE_SIZE = 20;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  PUBLIC_PROFILE_UNAVAILABLE: 'PUBLIC_PROFILE_UNAVAILABLE',
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

function normalizePublicUserId(value) {
  const id = value === null || value === undefined ? '' : String(value).trim();
  return PUBLIC_USER_ID_PATTERN.test(id) ? id : '';
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

function normalizeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
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
    sellerPublicUserId: record.sellerId,
    sellerName: record.sellerName,
    sellerAvatar: record.sellerAvatar,
    sellerVerified: record.sellerVerified === true,
    status: 'available',
    tags: record.tags,
    viewCount: normalizeCount(record.viewCount),
    favoriteCount: normalizeCount(record.favoriteCount),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function findPublicUser(publicUserId) {
  const result = await users.where({
    _id: publicUserId
  }).limit(1).get();
  const user = extractRecord(result);
  if (!user || user.status === 'disabled' || !user.openid) {
    return null;
  }
  return user;
}

async function publicProfile(data) {
  const publicUserId = normalizePublicUserId(data.publicUserId);
  if (!publicUserId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效用户 ID');
  }
  const user = await findPublicUser(publicUserId);
  if (!user) {
    return failure(ERROR_CODES.USER_NOT_FOUND, '该用户不存在');
  }
  const countResult = await products.where({
    sellerOpenid: user.openid,
    status: 'available'
  }).count();
  return success({
    profile: {
      publicUserId,
      nickname: normalizeText(user.nickname, '即出用户'),
      avatarUrl: normalizeText(user.avatarUrl),
      campus: normalizeText(user.campus, '校园信息待完善'),
      bio: normalizeText(user.bio, '这个用户还没有填写简介'),
      joinDate: toIsoString(user.createdAt),
      activeProductCount: normalizeCount(countResult.total)
    }
  });
}

async function publicProducts(data) {
  const publicUserId = normalizePublicUserId(data.publicUserId);
  if (!publicUserId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效用户 ID');
  }
  const user = await findPublicUser(publicUserId);
  if (!user) {
    return failure(ERROR_CODES.USER_NOT_FOUND, '该用户不存在');
  }
  const page = normalizePositiveInteger(data.page, 1, MAX_PAGE);
  const pageSize = normalizePositiveInteger(data.pageSize, 6, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const condition = {
    sellerOpenid: user.openid,
    status: 'available'
  };
  const countResult = await products.where(condition).count();
  const total = normalizeCount(countResult.total);
  const result = await products
    .where(condition)
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'asc')
    .skip(offset)
    .limit(pageSize)
    .get();
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
  if (!['publicProfile', 'publicProducts'].includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的用户主页操作');
  }

  try {
    return action === 'publicProfile'
      ? await publicProfile(data)
      : await publicProducts(data);
  } catch (error) {
    console.error('[userQuery] request failed', {
      action,
      code: error && (error.errCode || error.code || '')
    });
    const code = String(error && (error.errCode || error.code || '')).toLowerCase();
    const message = String(error && error.message || '').toLowerCase();
    const isDatabaseError = Boolean(
      error && error.errCode
      || code.includes('database')
      || message.includes('database')
      || message.includes('collection')
    );
    return failure(
      isDatabaseError ? ERROR_CODES.DATABASE_ERROR : ERROR_CODES.INTERNAL_ERROR,
      isDatabaseError
        ? '用户主页数据暂不可用，请稍后重试'
        : '用户主页服务暂不可用，请稍后重试'
    );
  }
};
