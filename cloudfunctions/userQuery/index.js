const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const users = db.collection('users');
const products = db.collection('products');
const schools = db.collection('schools');
const command = db.command;
const PUBLIC_PRODUCT_STATUSES = ['available', 'reserved'];
const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const SCHOOL_ID_PATTERN = /^s_[a-f0-9]{32}$/;
const MAX_PAGE = 100;
const MAX_PAGE_SIZE = 20;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  SCHOOL_REQUIRED: 'SCHOOL_REQUIRED',
  SCHOOL_UNAVAILABLE: 'SCHOOL_UNAVAILABLE',
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

function normalizeSchoolId(value) {
  const schoolId = normalizeText(value);
  return SCHOOL_ID_PATTERN.test(schoolId) ? schoolId : '';
}

function normalizeSchoolVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

function createUserId(appId, openId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex');
  return `u_${digest.slice(0, 32)}`;
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

async function getDocumentOrNull(document) {
  try {
    return extractRecord(await document.get());
  } catch (error) {
    const code = String(error && (error.errCode || error.code || ''))
      .toLowerCase();
    const message = String(error && error.message || '').toLowerCase();
    if (
      code.includes('not_found')
      || code.includes('not found')
      || message.includes('not found')
      || message.includes('does not exist')
    ) {
      return null;
    }
    throw error;
  }
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

async function resolveViewerContext(context) {
  const openId = normalizeText(context && context.OPENID);
  const appId = normalizeText(context && context.APPID);
  if (!openId || !appId) {
    return {
      error: failure(ERROR_CODES.UNAUTHORIZED, '登录状态已失效，请重新登录')
    };
  }
  const user = await getDocumentOrNull(users.doc(createUserId(appId, openId)));
  if (!user || user.status === 'disabled' || user.openid !== openId) {
    return {
      error: failure(ERROR_CODES.UNAUTHORIZED, '登录状态已失效，请重新登录')
    };
  }
  if (user.profileCompleted !== true) {
    return {
      error: failure(ERROR_CODES.PROFILE_INCOMPLETE, '请先完善个人资料')
    };
  }
  const schoolId = normalizeSchoolId(user.schoolId);
  if (!schoolId) {
    return {
      error: failure(ERROR_CODES.SCHOOL_REQUIRED, '请先选择学校')
    };
  }
  const school = await getDocumentOrNull(schools.doc(schoolId));
  if (
    !school
    || school.platformStatus !== 'active'
    || school.officialStatus !== 'valid'
    || !normalizeText(school.name)
  ) {
    return {
      error: failure(ERROR_CODES.SCHOOL_UNAVAILABLE, '当前学校暂不可用，请重新选择')
    };
  }
  return {
    user,
    schoolId,
    schoolName: normalizeText(school.name),
    schoolVersion: normalizeSchoolVersion(user.schoolVersion)
  };
}

function toViewerScope(viewer) {
  return {
    schoolId: viewer.schoolId,
    schoolName: viewer.schoolName,
    schoolVersion: viewer.schoolVersion
  };
}

async function publicProfile(data, viewer) {
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
    schoolId: viewer.schoolId,
    status: command.in(PUBLIC_PRODUCT_STATUSES)
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
    },
    scope: toViewerScope(viewer)
  });
}

async function publicProducts(data, viewer) {
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
    schoolId: viewer.schoolId,
    status: command.in(PUBLIC_PRODUCT_STATUSES)
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
    hasMore: offset + list.length < total,
    scope: toViewerScope(viewer)
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
    const viewer = await resolveViewerContext(cloud.getWXContext());
    if (viewer.error) {
      return viewer.error;
    }
    return action === 'publicProfile'
      ? await publicProfile(data, viewer)
      : await publicProducts(data, viewer);
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
