const crypto = require('crypto');

const MARKET_MODE = Object.freeze({
  LEGACY: 'legacy_market',
  SCHOOL_SCOPED: 'school_scoped_market'
});

const RESPONSE_MARKET_MODE = Object.freeze({
  LEGACY: 'legacy',
  SCHOOL_SCOPED: 'schoolScoped'
});

const CURSOR_VERSION = 1;
const CURSOR_ACTION = 'list';
const CURSOR_MAX_LENGTH = 4096;
const CURSOR_MAX_PAYLOAD_BYTES = 2048;
const CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CURSOR_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ALLOWLIST_HASH_PREFIX = 'sha256:';
const CURSOR_PAYLOAD_KEYS = Object.freeze([
  'version',
  'marketMode',
  'scopeSchoolId',
  'action',
  'categoryId',
  'normalizedKeywordDigest',
  'sortBy',
  'statuses',
  'pageSize',
  'snapshotAt',
  'lastSortValues',
  'lastItemId'
]);
const SORT_VALUE_KEYS = Object.freeze({
  default: ['favoriteCount', 'viewCount', 'createdAt'],
  newest: ['createdAt'],
  priceAsc: ['price', 'createdAt'],
  priceDesc: ['price', 'createdAt']
});

class MarketCoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketCoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MarketCoreError(code, message);
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeDateIso(value) {
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

function createUserId(appId, openId) {
  const normalizedAppId = normalizeText(appId);
  const normalizedOpenId = normalizeText(openId);
  if (!normalizedAppId || !normalizedOpenId) {
    return '';
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${normalizedAppId}:${normalizedOpenId}`)
    .digest('hex')
    .slice(0, 32);
  return `u_${digest}`;
}

function hashAllowlistIdentity(userId) {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) return '';
  return `${ALLOWLIST_HASH_PREFIX}${crypto
    .createHash('sha256')
    .update(normalizedUserId)
    .digest('hex')}`;
}

function decideMarketMode(options = {}) {
  if (options.enabled !== true) {
    return MARKET_MODE.LEGACY;
  }
  if (options.strictForAll === true) {
    return MARKET_MODE.SCHOOL_SCOPED;
  }
  const userId = normalizeText(options.userId);
  const allowlist = Array.isArray(options.allowlist)
    ? options.allowlist
    : [];
  const hashedUserId = hashAllowlistIdentity(userId);
  return userId && (
    allowlist.includes(userId)
    || allowlist.includes(hashedUserId)
  )
    ? MARKET_MODE.SCHOOL_SCOPED
    : MARKET_MODE.LEGACY;
}

function createKeywordDigest(keyword, categoryId) {
  const normalized = normalizeText(keyword).toLocaleLowerCase('zh-CN');
  const tokens = normalized ? normalized.split(' ') : [];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      categoryId: normalizeText(categoryId) || 'all',
      tokens
    }))
    .digest('hex');
}

function assertCursorSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    fail(
      'CURSOR_SECRET_UNAVAILABLE',
      '校园市场分页配置尚未就绪'
    );
  }
  return secret;
}

function assertExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || !value) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validateSortValues(sortBy, values) {
  const expectedKeys = SORT_VALUE_KEYS[sortBy];
  if (!expectedKeys || !assertExactKeys(values, expectedKeys)) {
    return false;
  }
  if (!isValidIsoTimestamp(values.createdAt)) {
    return false;
  }
  if (sortBy === 'default') {
    return [values.favoriteCount, values.viewCount].every((value) => (
      Number.isInteger(value) && value >= 0
    ));
  }
  if (sortBy === 'priceAsc' || sortBy === 'priceDesc') {
    return Number.isFinite(values.price) && values.price >= 0;
  }
  return true;
}

function validateCursorPayload(payload, nowMs = Date.now()) {
  if (!assertExactKeys(payload, CURSOR_PAYLOAD_KEYS)) {
    fail('INVALID_CURSOR_SCOPE', '分页游标结构无效');
  }
  if (
    payload.version !== CURSOR_VERSION
    || payload.marketMode !== MARKET_MODE.SCHOOL_SCOPED
    || payload.action !== CURSOR_ACTION
    || !SCHOOL_ID_PATTERN.test(payload.scopeSchoolId)
    || typeof payload.categoryId !== 'string'
    || !/^[0-9a-f]{64}$/.test(payload.normalizedKeywordDigest)
    || !Object.prototype.hasOwnProperty.call(SORT_VALUE_KEYS, payload.sortBy)
    || !Array.isArray(payload.statuses)
    || payload.statuses.length !== 2
    || payload.statuses[0] !== 'available'
    || payload.statuses[1] !== 'reserved'
    || !Number.isInteger(payload.pageSize)
    || payload.pageSize < 1
    || payload.pageSize > 20
    || !isValidIsoTimestamp(payload.snapshotAt)
    || !validateSortValues(payload.sortBy, payload.lastSortValues)
    || !PRODUCT_ID_PATTERN.test(payload.lastItemId)
  ) {
    fail('INVALID_CURSOR_SCOPE', '分页游标作用域无效');
  }
  const snapshotMs = new Date(payload.snapshotAt).getTime();
  if (
    snapshotMs > nowMs + CURSOR_FUTURE_TOLERANCE_MS
    || nowMs - snapshotMs > CURSOR_MAX_AGE_MS
  ) {
    fail('INVALID_CURSOR_SCOPE', '分页游标已失效');
  }
  return payload;
}

function createCursor(payload, secret, nowMs = Date.now()) {
  const key = assertCursorSecret(secret);
  validateCursorPayload(payload, nowMs);
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > CURSOR_MAX_PAYLOAD_BYTES) {
    fail('INVALID_CURSOR_SCOPE', '分页游标内容过长');
  }
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', key)
    .update(encoded)
    .digest('base64url');
  const cursor = `${encoded}.${signature}`;
  if (cursor.length > CURSOR_MAX_LENGTH) {
    fail('INVALID_CURSOR_SCOPE', '分页游标过长');
  }
  return cursor;
}

function parseCursor(cursor, secret, expected, nowMs = Date.now()) {
  const key = assertCursorSecret(secret);
  if (
    typeof cursor !== 'string'
    || !cursor
    || cursor.length > CURSOR_MAX_LENGTH
  ) {
    fail('INVALID_CURSOR_SCOPE', '分页游标无效');
  }
  const parts = cursor.split('.');
  if (
    parts.length !== 2
    || !/^[A-Za-z0-9_-]+$/.test(parts[0])
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
  ) {
    fail('INVALID_CURSOR_SCOPE', '分页游标无效');
  }
  let payload;
  try {
    const payloadBuffer = Buffer.from(parts[0], 'base64url');
    if (payloadBuffer.length > CURSOR_MAX_PAYLOAD_BYTES) {
      fail('INVALID_CURSOR_SCOPE', '分页游标内容过长');
    }
    payload = JSON.parse(payloadBuffer.toString('utf8'));
  } catch (error) {
    if (error instanceof MarketCoreError) {
      throw error;
    }
    fail('INVALID_CURSOR_SCOPE', '分页游标无效');
  }
  const expectedSignature = crypto
    .createHmac('sha256', key)
    .update(parts[0])
    .digest();
  let actualSignature;
  try {
    actualSignature = Buffer.from(parts[1], 'base64url');
  } catch (error) {
    fail('INVALID_CURSOR_SCOPE', '分页游标签名无效');
  }
  if (
    actualSignature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    fail('INVALID_CURSOR_SCOPE', '分页游标签名无效');
  }
  validateCursorPayload(payload, nowMs);

  const bindings = [
    ['marketMode', expected.marketMode],
    ['scopeSchoolId', expected.scopeSchoolId],
    ['action', expected.action],
    ['categoryId', expected.categoryId],
    ['normalizedKeywordDigest', expected.normalizedKeywordDigest],
    ['sortBy', expected.sortBy],
    ['pageSize', expected.pageSize]
  ];
  const mismatch = bindings.some(([keyName, expectedValue]) => (
    payload[keyName] !== expectedValue
  ));
  const expectedStatuses = Array.isArray(expected.statuses)
    ? expected.statuses
    : [];
  if (
    mismatch
    || payload.statuses.length !== expectedStatuses.length
    || payload.statuses.some((value, index) => value !== expectedStatuses[index])
  ) {
    fail('INVALID_CURSOR_SCOPE', '分页游标与当前查询不匹配');
  }
  return payload;
}

function normalizeSortableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function buildLastSortValues(record, sortBy) {
  const createdAt = normalizeDateIso(record && record.createdAt);
  if (!createdAt) {
    fail('INVALID_CURSOR_SCOPE', '商品排序时间无效');
  }
  if (sortBy === 'default') {
    return {
      favoriteCount: Math.floor(normalizeSortableNumber(record.favoriteCount)),
      viewCount: Math.floor(normalizeSortableNumber(record.viewCount)),
      createdAt
    };
  }
  if (sortBy === 'priceAsc' || sortBy === 'priceDesc') {
    return {
      price: normalizeSortableNumber(record.price),
      createdAt
    };
  }
  return { createdAt };
}

function buildCursorPayload(options) {
  return {
    version: CURSOR_VERSION,
    marketMode: MARKET_MODE.SCHOOL_SCOPED,
    scopeSchoolId: options.scopeSchoolId,
    action: CURSOR_ACTION,
    categoryId: options.categoryId,
    normalizedKeywordDigest: options.normalizedKeywordDigest,
    sortBy: options.sortBy,
    statuses: ['available', 'reserved'],
    pageSize: options.pageSize,
    snapshotAt: options.snapshotAt,
    lastSortValues: buildLastSortValues(options.lastRecord, options.sortBy),
    lastItemId: String(options.lastRecord && options.lastRecord._id || '')
  };
}

function buildSeekCondition(command, sortBy, values, lastItemId) {
  const createdAt = new Date(values.createdAt);
  if (sortBy === 'newest') {
    return command.or([
      { createdAt: command.lt(createdAt) },
      { createdAt, _id: command.gt(lastItemId) }
    ]);
  }
  if (sortBy === 'priceAsc') {
    return command.or([
      { price: command.gt(values.price) },
      { price: values.price, createdAt: command.lt(createdAt) },
      { price: values.price, createdAt, _id: command.gt(lastItemId) }
    ]);
  }
  if (sortBy === 'priceDesc') {
    return command.or([
      { price: command.lt(values.price) },
      { price: values.price, createdAt: command.lt(createdAt) },
      { price: values.price, createdAt, _id: command.gt(lastItemId) }
    ]);
  }
  return command.or([
    { favoriteCount: command.lt(values.favoriteCount) },
    {
      favoriteCount: values.favoriteCount,
      viewCount: command.lt(values.viewCount)
    },
    {
      favoriteCount: values.favoriteCount,
      viewCount: values.viewCount,
      createdAt: command.lt(createdAt)
    },
    {
      favoriteCount: values.favoriteCount,
      viewCount: values.viewCount,
      createdAt,
      _id: command.gt(lastItemId)
    }
  ]);
}

function compareValues(left, right) {
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

function compareRecords(left, right, sortBy) {
  const leftCreatedAt = normalizeDateIso(left.createdAt);
  const rightCreatedAt = normalizeDateIso(right.createdAt);
  const rules = sortBy === 'default'
    ? [
      [normalizeSortableNumber(left.favoriteCount), normalizeSortableNumber(right.favoriteCount), -1],
      [normalizeSortableNumber(left.viewCount), normalizeSortableNumber(right.viewCount), -1],
      [leftCreatedAt, rightCreatedAt, -1],
      [String(left._id), String(right._id), 1]
    ]
    : sortBy === 'priceAsc'
      ? [
        [normalizeSortableNumber(left.price), normalizeSortableNumber(right.price), 1],
        [leftCreatedAt, rightCreatedAt, -1],
        [String(left._id), String(right._id), 1]
      ]
      : sortBy === 'priceDesc'
        ? [
          [normalizeSortableNumber(left.price), normalizeSortableNumber(right.price), -1],
          [leftCreatedAt, rightCreatedAt, -1],
          [String(left._id), String(right._id), 1]
        ]
        : [
          [leftCreatedAt, rightCreatedAt, -1],
          [String(left._id), String(right._id), 1]
        ];
  for (const [leftValue, rightValue, direction] of rules) {
    const compared = compareValues(leftValue, rightValue);
    if (compared !== 0) {
      return compared * direction;
    }
  }
  return 0;
}

module.exports = {
  MARKET_MODE,
  RESPONSE_MARKET_MODE,
  CURSOR_VERSION,
  CURSOR_ACTION,
  CURSOR_MAX_LENGTH,
  MarketCoreError,
  createUserId,
  hashAllowlistIdentity,
  decideMarketMode,
  createKeywordDigest,
  assertCursorSecret,
  createCursor,
  parseCursor,
  buildCursorPayload,
  buildSeekCondition,
  buildLastSortValues,
  compareRecords,
  normalizeDateIso
};
