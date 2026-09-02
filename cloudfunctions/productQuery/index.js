const cloud = require('wx-server-sdk');
const MarketCore = require('./market-core');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const products = db.collection('products');

const PUBLIC_LIST_STATUSES = ['available', 'reserved'];
const PUBLIC_DETAIL_STATUSES = ['available', 'reserved', 'sold'];
const MY_PRODUCT_STATUSES = ['available', 'reserved', 'offline', 'sold'];
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
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
const MAX_VIDEO_DURATION = 60;
const MAX_VIDEO_DIMENSION = 16384;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const SCHOOL_SCOPED_MARKET_ENABLED = true;
const SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL = true;
const MARKET_ACCESS_REQUIRES_AUTH = true;
const SCHOOL_SCOPED_MARKET_ALLOWLIST = Object.freeze([]);
const CURSOR_SECRET_ENV_NAME = 'PRODUCT_QUERY_CURSOR_HMAC_SECRET';
const DETAIL_ACCESS_MODE = Object.freeze({
  ANONYMOUS: 'anonymous',
  ACCOUNT_NOT_READY: 'accountNotReady',
  SAME_SCHOOL: 'sameSchool',
  CROSS_SCHOOL_READONLY: 'crossSchoolReadonly',
  OWNER: 'owner'
});

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INVALID_CURSOR_SCOPE: 'INVALID_CURSOR_SCOPE',
  CURSOR_SECRET_UNAVAILABLE: 'CURSOR_SECRET_UNAVAILABLE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_INACTIVE: 'USER_INACTIVE',
  SCHOOL_REQUIRED: 'SCHOOL_REQUIRED',
  SCHOOL_INVALID: 'SCHOOL_INVALID',
  SCHOOL_UNAVAILABLE: 'SCHOOL_UNAVAILABLE',
  SCHOOL_CONTEXT_MISMATCH: 'SCHOOL_CONTEXT_MISMATCH',
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

function businessError(code, message) {
  const error = new Error(message);
  error.businessCode = code;
  throw error;
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

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function getIdentity() {
  const context = cloud.getWXContext();
  const openId = context && normalizeText(context.OPENID);
  const appId = context && normalizeText(context.APPID);
  return {
    openId,
    appId,
    userId: MarketCore.createUserId(appId, openId)
  };
}

function getDefaultRolloutConfig() {
  return {
    enabled: SCHOOL_SCOPED_MARKET_ENABLED,
    strictForAll: SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL,
    accessRequiresAuth: MARKET_ACCESS_REQUIRES_AUTH,
    allowlist: SCHOOL_SCOPED_MARKET_ALLOWLIST
  };
}

function decideListMarket(identity, rolloutConfig = getDefaultRolloutConfig()) {
  return MarketCore.decideMarketMode({
    enabled: rolloutConfig.enabled,
    strictForAll: rolloutConfig.strictForAll,
    allowlist: rolloutConfig.allowlist,
    userId: identity && identity.userId
  });
}

async function findOne(collection, condition) {
  const result = await collection.where(condition).limit(1).get();
  return Array.isArray(result.data) ? result.data[0] || null : null;
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
  const message = String(error && (error.message || error.errMsg) || '').toLowerCase();
  return code.includes('not_found')
    || code.includes('not found')
    || message.includes('not found')
    || message.includes('not exist')
    || message.includes('does not exist');
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

async function assertActiveUser(identity, dependencies = {}) {
  if (!identity || !identity.openId || !identity.appId || !identity.userId) {
    businessError(ERROR_CODES.AUTH_REQUIRED, '请先登录');
  }
  const userCollection = dependencies.usersCollection || db.collection('users');
  const user = await getDocumentOrNull(userCollection.doc(identity.userId));
  if (!user) {
    businessError(ERROR_CODES.USER_NOT_FOUND, '当前用户记录不存在');
  }
  if (typeof user.openid !== 'string' || user.openid !== identity.openId) {
    businessError(
      ERROR_CODES.SCHOOL_CONTEXT_MISMATCH,
      '无法确认当前用户身份'
    );
  }
  if (user.status !== 'active') {
    businessError(ERROR_CODES.USER_INACTIVE, '当前账户暂不可用');
  }
  return user;
}

async function resolveMarketSchoolContext(identity, dependencies = {}) {
  if (!identity || !identity.openId || !identity.appId || !identity.userId) {
    businessError(ERROR_CODES.AUTH_REQUIRED, '请先登录并选择学校');
  }
  const userCollection = dependencies.usersCollection || db.collection('users');
  const schoolCollection = dependencies.schoolsCollection || db.collection('schools');
  const user = await findOne(userCollection, {
    _id: identity.userId
  });
  if (!user) {
    businessError(ERROR_CODES.USER_NOT_FOUND, '当前用户记录不存在');
  }
  if (user.status !== 'active') {
    businessError(ERROR_CODES.USER_INACTIVE, '当前账户暂不可用');
  }
  if (
    typeof user.openid !== 'string'
    || user.openid !== identity.openId
  ) {
    businessError(
      ERROR_CODES.SCHOOL_CONTEXT_MISMATCH,
      '无法确认当前用户的校园市场身份'
    );
  }
  const storedSchoolId = normalizeText(user.schoolId);
  if (!storedSchoolId) {
    businessError(ERROR_CODES.SCHOOL_REQUIRED, '请先选择学校');
  }
  if (!SCHOOL_ID_PATTERN.test(storedSchoolId)) {
    businessError(ERROR_CODES.SCHOOL_INVALID, '当前学校信息无效');
  }
  const school = await findOne(schoolCollection, {
    _id: storedSchoolId
  });
  if (
    !school
    || school.platformStatus !== 'active'
    || school.officialStatus !== 'valid'
    || !normalizeText(school.name)
  ) {
    businessError(ERROR_CODES.SCHOOL_UNAVAILABLE, '当前学校暂不可用');
  }
  return {
    userId: identity.userId,
    schoolId: storedSchoolId,
    schoolName: normalizeText(school.name)
  };
}

async function resolveDetailAccess(product, identity, dependencies = {}) {
  const productSchoolId = normalizeText(product && product.schoolId);
  const isOwner = Boolean(
    identity
    && identity.openId
    && normalizeText(product && product.sellerOpenid) === identity.openId
  );
  if (isOwner) {
    return {
      mode: DETAIL_ACCESS_MODE.OWNER,
      canCreateRelation: false,
      isCrossSchool: false,
      isOwner: true
    };
  }
  if (!identity || !identity.openId || !identity.appId || !identity.userId) {
    return {
      mode: DETAIL_ACCESS_MODE.ANONYMOUS,
      canCreateRelation: false,
      isCrossSchool: false,
      isOwner: false
    };
  }

  const userCollection = dependencies.usersCollection || db.collection('users');
  const user = await findOne(userCollection, { _id: identity.userId });
  const userSchoolId = normalizeText(user && user.schoolId);
  const accountReady = Boolean(
    user
    && user.status === 'active'
    && user.openid === identity.openId
    && SCHOOL_ID_PATTERN.test(userSchoolId)
  );
  if (!accountReady || !SCHOOL_ID_PATTERN.test(productSchoolId)) {
    return {
      mode: DETAIL_ACCESS_MODE.ACCOUNT_NOT_READY,
      canCreateRelation: false,
      isCrossSchool: false,
      isOwner: false
    };
  }

  const isCrossSchool = userSchoolId !== productSchoolId;
  return {
    mode: isCrossSchool
      ? DETAIL_ACCESS_MODE.CROSS_SCHOOL_READONLY
      : DETAIL_ACCESS_MODE.SAME_SCHOOL,
    canCreateRelation: !isCrossSchool,
    isCrossSchool,
    isOwner: false
  };
}

function getCursorSecret(dependencies = {}) {
  if (typeof dependencies.cursorSecret === 'string') {
    return dependencies.cursorSecret;
  }
  return typeof process.env[CURSOR_SECRET_ENV_NAME] === 'string'
    ? process.env[CURSOR_SECRET_ENV_NAME]
    : '';
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
    return PUBLIC_LIST_STATUSES;
  }
  return [...new Set(value.filter((status) => PUBLIC_LIST_STATUSES.includes(status)))];
}

function normalizeMyStatuses(value) {
  if (value === undefined || value === null || value === '') {
    return MY_PRODUCT_STATUSES;
  }
  const statuses = Array.isArray(value) ? value : [value];
  const normalized = statuses.filter(
    (status) => MY_PRODUCT_STATUSES.includes(status)
  );
  if (normalized.includes('available')) {
    normalized.push('reserved');
  }
  return [...new Set(normalized)];
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

function buildSchoolScopedCondition(options) {
  const conditions = [
    buildQueryCondition({
      categoryId: options.categoryId,
      keyword: options.keyword,
      statuses: PUBLIC_LIST_STATUSES
    }),
    {
      schoolId: options.schoolId
    },
    {
      createdAt: command.lte(new Date(options.snapshotAt))
    }
  ];
  if (options.cursorPayload) {
    conditions.push(MarketCore.buildSeekCondition(
      command,
      options.sortBy,
      options.cursorPayload.lastSortValues,
      options.cursorPayload.lastItemId
    ));
  }
  return command.and(conditions);
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

function normalizeMediaStrings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item, index, list) => (
    typeof item === 'string'
    && item.trim()
    && list.indexOf(item) === index
  )).map((item) => item.trim());
}

function getProductImages(record) {
  const images = normalizeMediaStrings(record.images);
  if (images.length > 0) {
    return images;
  }
  const legacyArrays = normalizeMediaStrings(record.imageUrls);
  if (legacyArrays.length > 0) {
    return legacyArrays;
  }
  const fallback = [record.coverImage, record.coverUrl, record.image].find(
    (value) => typeof value === 'string' && value.trim()
  );
  return fallback ? [fallback.trim()] : [];
}

function getProductCover(record) {
  const images = getProductImages(record);
  return images[0] || '';
}

function normalizeProductVideo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const fileID = typeof value.fileID === 'string' && value.fileID.startsWith('cloud://')
    ? value.fileID
    : '';
  const duration = Number(value.duration);
  const size = Number(value.size);
  const width = Number(value.width);
  const height = Number(value.height);
  if (
    !fileID
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
    return null;
  }
  return {
    fileID,
    posterFileID: typeof value.posterFileID === 'string'
      && value.posterFileID.startsWith('cloud://')
      ? value.posterFileID
      : '',
    duration,
    width,
    height,
    size
  };
}

function toPublicProduct(record, includeMedia = false) {
  const product = {
    _id: String(record._id || ''),
    title: record.title,
    description: record.description,
    price: record.price,
    originalPrice: record.originalPrice,
    categoryId: record.categoryId,
    categoryName: record.categoryName,
    condition: record.condition,
    coverImage: getProductCover(record),
    coverLabel: record.coverLabel,
    coverTone: record.coverTone,
    location: record.location,
    campus: record.campus,
    schoolId: normalizeText(record.schoolId),
    schoolName: normalizeText(record.schoolName),
    distanceText: record.distanceText,
    sellerPublicUserId: record.sellerId,
    sellerName: record.sellerName,
    sellerAvatar: record.sellerAvatar,
    sellerVerified: record.sellerVerified === true,
    status: record.status,
    tags: record.tags,
    viewCount: record.viewCount,
    favoriteCount: normalizeNonNegativeInteger(record.favoriteCount),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
  if (includeMedia) {
    product.images = getProductImages(record);
    product.video = normalizeProductVideo(record.video);
  }
  return product;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : 0;
}

function toMyProduct(record) {
  return Object.assign({}, toPublicProduct(record), {
    version: Number.isInteger(Number(record.version))
      && Number(record.version) >= 1
      ? Number(record.version)
      : 1,
    offlineAt: record.offlineAt,
    soldAt: record.soldAt,
    relistedAt: record.relistedAt
  });
}

async function listLegacyProducts(data) {
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
      hasMore: false,
      nextCursor: '',
      marketMode: MarketCore.RESPONSE_MARKET_MODE.LEGACY,
      scope: {
        schoolId: '',
        schoolName: ''
      }
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
    ? result.data.map((record) => toPublicProduct(record))
    : [];

  return success({
    list,
    total,
    page,
    pageSize,
    hasMore: offset + list.length < total,
    nextCursor: '',
    marketMode: MarketCore.RESPONSE_MARKET_MODE.LEGACY,
    scope: {
      schoolId: '',
      schoolName: ''
    }
  });
}

async function listSchoolScopedProducts(data, identity, dependencies = {}) {
  const categoryId = normalizeCategoryId(data.categoryId);
  const sortBy = normalizeSortBy(data.sortBy);
  if (!categoryId || !sortBy) {
    return failure(ERROR_CODES.INVALID_PARAMS, '商品查询参数不正确');
  }
  const pageSize = normalizePositiveInteger(data.pageSize, 6, MAX_PAGE_SIZE);
  const keyword = normalizeKeyword(data.keyword);
  const schoolContext = dependencies.schoolContext || await resolveMarketSchoolContext(
    identity,
    dependencies
  );
  const normalizedKeywordDigest = MarketCore.createKeywordDigest(
    keyword,
    categoryId
  );
  const cursorSecret = getCursorSecret(dependencies);
  MarketCore.assertCursorSecret(cursorSecret);
  const nowMs = Number.isFinite(dependencies.nowMs)
    ? dependencies.nowMs
    : Date.now();
  const expectedCursorScope = {
    marketMode: MarketCore.MARKET_MODE.SCHOOL_SCOPED,
    scopeSchoolId: schoolContext.schoolId,
    action: MarketCore.CURSOR_ACTION,
    categoryId,
    normalizedKeywordDigest,
    sortBy,
    statuses: PUBLIC_LIST_STATUSES,
    pageSize
  };
  let cursorPayload = null;
  if (data.cursor !== undefined && data.cursor !== null && data.cursor !== '') {
    if (typeof data.cursor !== 'string') {
      businessError(ERROR_CODES.INVALID_CURSOR_SCOPE, '分页游标无效');
    }
    cursorPayload = MarketCore.parseCursor(
      data.cursor.trim(),
      cursorSecret,
      expectedCursorScope,
      nowMs
    );
  }
  const snapshotAt = cursorPayload
    ? cursorPayload.snapshotAt
    : new Date(nowMs).toISOString();
  const condition = buildSchoolScopedCondition({
    schoolId: schoolContext.schoolId,
    categoryId,
    keyword,
    sortBy,
    snapshotAt,
    cursorPayload
  });
  const productCollection = dependencies.productsCollection || products;
  const query = applySort(productCollection.where(condition), sortBy);
  const result = await query.limit(pageSize + 1).get();
  const records = Array.isArray(result.data) ? result.data : [];
  const visibleRecords = records.slice(0, pageSize);
  const hasMore = records.length > pageSize;
  let nextCursor = '';
  if (hasMore && visibleRecords.length > 0) {
    nextCursor = MarketCore.createCursor(
      MarketCore.buildCursorPayload({
        scopeSchoolId: schoolContext.schoolId,
        categoryId,
        normalizedKeywordDigest,
        sortBy,
        pageSize,
        snapshotAt,
        lastRecord: visibleRecords[visibleRecords.length - 1]
      }),
      cursorSecret,
      nowMs
    );
  }

  return success({
    list: visibleRecords.map((record) => toPublicProduct(record)),
    total: null,
    page: null,
    pageSize,
    hasMore,
    nextCursor,
    marketMode: MarketCore.RESPONSE_MARKET_MODE.SCHOOL_SCOPED,
    scope: {
      schoolId: schoolContext.schoolId,
      schoolName: schoolContext.schoolName
    }
  });
}

async function listProducts(data, identity = getIdentity(), dependencies = {}) {
  const rolloutConfig = dependencies.rolloutConfig || getDefaultRolloutConfig();
  const schoolContext = rolloutConfig.accessRequiresAuth === true
    ? await resolveMarketSchoolContext(identity, dependencies)
    : null;
  const marketMode = decideListMarket(
    identity,
    rolloutConfig
  );
  if (marketMode === MarketCore.MARKET_MODE.SCHOOL_SCOPED) {
    return listSchoolScopedProducts(data, identity, Object.assign({}, dependencies, {
      schoolContext
    }));
  }
  return listLegacyProducts(data);
}

async function getProductDetail(data, identity = getIdentity(), dependencies = {}) {
  const productId = normalizeProductId(data.productId);
  if (!productId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }

  const productCollection = dependencies.productsCollection || products;
  const result = await productCollection.where({
    _id: productId,
    status: command.in(PUBLIC_DETAIL_STATUSES)
  }).limit(1).get();
  const product = result.data && result.data[0];

  if (!product) {
    return failure(
      ERROR_CODES.PRODUCT_NOT_FOUND,
      '商品不存在或已下架'
    );
  }

  return success({
    product: toPublicProduct(product, true),
    access: await resolveDetailAccess(product, identity, dependencies)
  });
}

async function listMyProducts(data, openId) {
  const statuses = normalizeMyStatuses(data.status);
  if (statuses.length === 0) {
    return failure(ERROR_CODES.INVALID_PARAMS, '商品状态筛选参数不正确');
  }

  const page = normalizePositiveInteger(data.page, 1, MAX_PAGE);
  const pageSize = normalizePositiveInteger(data.pageSize, 6, MAX_PAGE_SIZE);
  const condition = {
    sellerOpenid: openId,
    status: command.in(statuses)
  };
  const offset = (page - 1) * pageSize;
  const countResult = await products.where(condition).count();
  const total = Number(countResult.total) || 0;
  const result = await products
    .where(condition)
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'asc')
    .skip(offset)
    .limit(pageSize)
    .get();
  const list = Array.isArray(result.data)
    ? result.data.map(toMyProduct)
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
  const action = typeof request.action === 'string'
    ? request.action.trim()
    : '';
  const data = request.data
    && typeof request.data === 'object'
    && !Array.isArray(request.data)
    ? request.data
    : {};

  if (!['list', 'detail', 'myProducts'].includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的商品操作');
  }

  try {
    if (action === 'list') {
      return await listProducts(data);
    }
    if (action === 'detail') {
      return await getProductDetail(data, getIdentity());
    }

    const identity = getIdentity();
    if (!identity.openId || !identity.appId || !identity.userId) {
      return failure(ERROR_CODES.UNAUTHORIZED, '登录状态已失效，请重新登录');
    }
    await assertActiveUser(identity);
    return await listMyProducts(data, identity.openId);
  } catch (error) {
    if (error && error.businessCode) {
      return failure(error.businessCode, error.message);
    }
    if (error instanceof MarketCore.MarketCoreError) {
      return failure(error.code, error.message);
    }
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

exports.__test = Object.freeze({
  getDefaultRolloutConfig,
  decideListMarket,
  resolveMarketSchoolContext,
  listLegacyProducts,
  listSchoolScopedProducts,
  listProducts,
  buildSchoolScopedCondition,
  getProductDetail,
  resolveDetailAccess,
  createUserId: MarketCore.createUserId,
  assertActiveUser,
  DETAIL_ACCESS_MODE
});
