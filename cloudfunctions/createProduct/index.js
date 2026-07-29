const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const users = db.collection('users');
const schools = db.collection('schools');
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
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
const MAX_VIDEO_DURATION = 60;
const MAX_VIDEO_DIMENSION = 16384;
const MAX_LOCATION_NAME_LENGTH = 80;
const MAX_LOCATION_ADDRESS_LENGTH = 120;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{12,80}$/;
const IMAGE_FILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,160}\.(?:jpg|jpeg|png|gif|webp)$/i;
const VIDEO_FILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,160}\.(?:mp4|mov|m4v)$/i;
const VIDEO_FIELDS = new Set([
  'fileID',
  'posterFileID',
  'duration',
  'width',
  'height',
  'size'
]);
const LOCATION_DETAIL_FIELDS = new Set([
  'name',
  'address',
  'latitude',
  'longitude'
]);

const ERROR_CODES = {
  OK: 'OK',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_LOCATION_DETAIL: 'INVALID_LOCATION_DETAIL',
  AUTH_CONTEXT_MISSING: 'AUTH_CONTEXT_MISSING',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DISABLED: 'USER_DISABLED',
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  SCHOOL_SELECTION_REQUIRED: 'SCHOOL_SELECTION_REQUIRED',
  SCHOOL_UNAVAILABLE: 'SCHOOL_UNAVAILABLE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function success(productId, reused, school = {}) {
  return {
    success: true,
    code: ERROR_CODES.OK,
    message: '',
    data: {
      productId,
      reused: reused === true,
      schoolId: normalizeText(school.schoolId),
      schoolName: normalizeText(school.schoolName)
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

function normalizeSchoolId(value) {
  const schoolId = normalizeText(value);
  return SCHOOL_ID_PATTERN.test(schoolId) ? schoolId : '';
}

function isProfileComplete(user) {
  return Boolean(
    user
    && user.profileCompleted === true
    && normalizeText(user.nickname)
    && normalizeText(user.nickname) !== '微信用户'
    && normalizeText(user.avatarUrl)
  );
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

function isOwnedProductVideo(fileID, userId) {
  const filePath = getCloudFilePath(fileID);
  const segments = filePath.split('/');
  return segments.length === 4
    && segments[0] === 'products'
    && segments[1] === userId
    && /^\d{8}$/.test(segments[2])
    && VIDEO_FILE_NAME_PATTERN.test(segments[3]);
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

function normalizeVideo(value, userId) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).some((field) => !VIDEO_FIELDS.has(field))
  ) {
    return undefined;
  }
  const fileID = typeof value.fileID === 'string' ? value.fileID : '';
  const posterFileID = typeof value.posterFileID === 'string'
    ? value.posterFileID
    : '';
  const duration = Number(value.duration);
  const width = Number(value.width);
  const height = Number(value.height);
  const size = Number(value.size);
  if (
    !isOwnedProductVideo(fileID, userId)
    || (posterFileID && !isOwnedProductImage(posterFileID, userId))
    || !Number.isFinite(duration)
    || duration <= 0
    || duration > MAX_VIDEO_DURATION
    || !Number.isFinite(size)
    || size <= 0
    || size > MAX_VIDEO_SIZE
    || !Number.isFinite(width)
    || width < 0
    || width > MAX_VIDEO_DIMENSION
    || !Number.isFinite(height)
    || height < 0
    || height > MAX_VIDEO_DIMENSION
  ) {
    return undefined;
  }
  return {
    fileID,
    posterFileID,
    duration: Math.ceil(duration),
    width: Math.floor(width),
    height: Math.floor(height),
    size: Math.floor(size)
  };
}

function normalizeLocationDetail(value, location) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).some((field) => !LOCATION_DETAIL_FIELDS.has(field))
  ) {
    return undefined;
  }
  const name = normalizeText(value.name);
  const address = normalizeText(value.address);
  const latitude = typeof value.latitude === 'number' ? value.latitude : NaN;
  const longitude = typeof value.longitude === 'number' ? value.longitude : NaN;
  if (
    !name
    || name !== location
    || name.length > MAX_LOCATION_NAME_LENGTH
    || !address
    || address.length > MAX_LOCATION_ADDRESS_LENGTH
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
    || (latitude === 0 && longitude === 0)
  ) {
    return undefined;
  }
  return {
    name,
    address,
    latitude,
    longitude
  };
}

function normalizeProductLocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const location = normalizeText(value.location);
  if (location.length < 2 || location.length > MAX_LOCATION_NAME_LENGTH) {
    return null;
  }
  const locationDetail = normalizeLocationDetail(
    value.locationDetail,
    location
  );
  if (!locationDetail) {
    return null;
  }
  return {
    location,
    locationDetail
  };
}

function createUserId(appId, openId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
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
  if (!context || !context.OPENID || !context.APPID) {
    return null;
  }
  return {
    openId: context.OPENID,
    appId: context.APPID
  };
}

async function findUser(userId) {
  const result = await users.where({
    _id: userId
  }).limit(1).get();
  return result.data && result.data.length > 0 ? result.data[0] : null;
}

async function findSchool(schoolId) {
  const result = await schools.where({
    _id: schoolId
  }).limit(1).get();
  return result.data && result.data.length > 0 ? result.data[0] : null;
}

async function findProduct(productId) {
  const result = await products.where({
    _id: productId
  }).limit(1).get();
  return result.data && result.data.length > 0 ? result.data[0] : null;
}

function getActiveSchoolSummary(school) {
  if (
    !school
    || school.platformStatus !== 'active'
    || school.officialStatus !== 'valid'
  ) {
    return null;
  }
  const schoolId = normalizeSchoolId(school._id);
  const schoolName = normalizeText(school.name);
  if (!schoolId || !schoolName) {
    return null;
  }
  return {
    schoolId,
    schoolName
  };
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
  const productLocation = normalizeProductLocation(value);
  const images = normalizeImages(value.images, userId);
  const video = normalizeVideo(value.video, userId);

  if (
    title.length < 2
    || title.length > 40
    || description.length < 5
    || description.length > 1000
    || !isValidPrice(value.price)
    || !categoryName
    || !VALID_CONDITIONS.has(condition)
    || !productLocation
    || images.length === 0
    || video === undefined
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
    video,
    coverLabel: title.slice(0, 4),
    coverTone: CATEGORY_TONES[categoryId] || 'mint',
    location: productLocation.location,
    locationDetail: productLocation.locationDetail,
    distanceText: '校内面交',
    tags: []
  };
}

function toSellerFields(user, identity, userId) {
  const sellerName = normalizeText(user.nickname);
  return {
    sellerId: userId,
    sellerOpenid: identity.openId,
    sellerName: sellerName === '微信用户' ? '' : sellerName,
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
    if (!user || user.openid !== identity.openId) {
      return failure(ERROR_CODES.USER_NOT_FOUND, '用户记录不存在，请重新登录');
    }
    if (user.status !== 'active') {
      return failure(ERROR_CODES.USER_DISABLED, '当前账户暂不可发布商品');
    }
    if (!isProfileComplete(user)) {
      return failure(ERROR_CODES.PROFILE_INCOMPLETE, '请先完善个人资料');
    }

    const productId = createProductId(userId, requestId);
    const existing = await findProduct(productId);
    if (existing) {
      if (existing.sellerId !== userId) {
        return failure(ERROR_CODES.INVALID_PARAMS, '发布请求冲突');
      }
      return success(productId, true, {
        schoolId: existing.schoolId,
        schoolName: existing.schoolName
      });
    }

    const storedSchoolId = normalizeText(user.schoolId);
    if (!storedSchoolId) {
      return failure(
        ERROR_CODES.SCHOOL_SELECTION_REQUIRED,
        '请先完成学校选择后再发布商品'
      );
    }
    const schoolId = normalizeSchoolId(storedSchoolId);
    if (!schoolId) {
      return failure(
        ERROR_CODES.SCHOOL_UNAVAILABLE,
        '当前学校暂不可用，请重新确认学校信息'
      );
    }
    const school = await findSchool(schoolId);
    const schoolSummary = getActiveSchoolSummary(school);
    if (!schoolSummary) {
      return failure(
        ERROR_CODES.SCHOOL_UNAVAILABLE,
        '当前学校暂不可用，请重新确认学校信息'
      );
    }

    if (
      request.product
      && typeof request.product === 'object'
      && !Array.isArray(request.product)
      && !normalizeProductLocation(request.product)
    ) {
      return failure(
        ERROR_CODES.INVALID_LOCATION_DETAIL,
        '交易地点信息无效，请重新选择'
      );
    }

    const product = validateProduct(request.product, userId);
    if (!product) {
      return failure(ERROR_CODES.INVALID_PARAMS, '商品信息不完整或格式不正确');
    }

    await products.doc(productId).set({
      data: Object.assign(
        {},
        product,
        toSellerFields(user, identity, userId),
        schoolSummary,
        {
          publishRequestId: requestId,
          status: 'available',
          version: 1,
          viewCount: 0,
          favoriteCount: 0,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      )
    });

    return success(productId, false, schoolSummary);
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
