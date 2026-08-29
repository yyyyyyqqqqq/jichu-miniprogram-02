const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const schools = db.collection('schools');

const MAX_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE = 20;
const MAX_KEYWORD_LENGTH = 40;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const OFFICIAL_CODE_PATTERN = /^\d{10}$/;
const CURSOR_VERSION = 1;
const CURSOR_SECRET_ENV = 'SCHOOL_QUERY_CURSOR_HMAC_SECRET';
const PROVINCES = new Set([
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区',
  '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省',
  '浙江省', '安徽省', '福建省', '江西省', '山东省',
  '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区',
  '海南省', '重庆市', '四川省', '贵州省', '云南省',
  '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区',
  '新疆维吾尔自治区'
]);

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_KEYWORD: 'INVALID_KEYWORD',
  INVALID_PROVINCE: 'INVALID_PROVINCE',
  INVALID_PAGE_SIZE: 'INVALID_PAGE_SIZE',
  SCHOOL_NOT_FOUND: 'SCHOOL_NOT_FOUND',
  SCHOOL_NOT_ACTIVE: 'SCHOOL_NOT_ACTIVE',
  QUERY_FAILED: 'QUERY_FAILED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE'
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

function normalizeText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function normalizeKeyword(value) {
  const keyword = normalizeText(value).toLocaleLowerCase('zh-CN');
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH) {
    return '';
  }
  return keyword;
}

function normalizeProvince(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  const province = normalizeText(value);
  return PROVINCES.has(province) ? province : null;
}

function normalizePageSize(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_PAGE_SIZE;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PAGE_SIZE) {
    return 0;
  }
  return number;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cursorSecret() {
  const secret = String(process.env[CURSOR_SECRET_ENV] || '').trim();
  if (secret.length < 43) {
    const error = new Error('school query cursor secret is unavailable');
    error.code = 'CURSOR_SECRET_UNAVAILABLE';
    throw error;
  }
  return secret;
}

function signCursorPayload(encodedPayload) {
  return crypto
    .createHmac('sha256', cursorSecret())
    .update(encodedPayload)
    .digest('base64url');
}

function encodeCursor(record, scope) {
  const payload = {
    v: CURSOR_VERSION,
    n: record.nameNormalized,
    i: record._id,
    p: scope.province || '',
    k: scope.keyword || ''
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${signCursorPayload(encodedPayload)}`;
}

function decodeCursor(value, scope) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || value.length > 768) {
    return undefined;
  }
  try {
    const parts = value.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return undefined;
    }
    const expected = Buffer.from(signCursorPayload(parts[0]));
    const actual = Buffer.from(parts[1]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return undefined;
    }
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (
      !payload
      || payload.v !== CURSOR_VERSION
      || typeof payload.n !== 'string'
      || !payload.n
      || payload.n.length > 120
      || typeof payload.i !== 'string'
      || !SCHOOL_ID_PATTERN.test(payload.i)
      || payload.p !== (scope.province || '')
      || payload.k !== (scope.keyword || '')
      || Object.keys(payload).sort().join(',') !== 'i,k,n,p,v'
    ) {
      return undefined;
    }
    return {
      nameNormalized: payload.n,
      id: payload.i
    };
  } catch (error) {
    return undefined;
  }
}

function toPublicSchool(record) {
  return {
    id: String(record._id || ''),
    name: String(record.name || ''),
    province: String(record.province || ''),
    city: String(record.city || ''),
    educationLevel: String(record.educationLevel || ''),
    platformStatus: String(record.platformStatus || ''),
    selectable: record.platformStatus === 'active'
  };
}

function cursorCondition(cursor) {
  if (!cursor) {
    return null;
  }
  return command.or([
    {
      nameNormalized: command.gt(cursor.nameNormalized)
    },
    command.and([
      {
        nameNormalized: cursor.nameNormalized
      },
      {
        _id: command.gt(cursor.id)
      }
    ])
  ]);
}

async function queryActiveSchools(options) {
  const conditions = [{
    platformStatus: 'active',
    officialStatus: 'valid'
  }];
  if (options.province) {
    conditions.push({ province: options.province });
  }
  if (options.keyword) {
    conditions.push({
      nameNormalized: db.RegExp({
        regexp: `^${escapeRegExp(options.keyword)}`,
        options: 'i'
      })
    });
  }
  const after = cursorCondition(options.cursor);
  if (after) {
    conditions.push(after);
  }
  const where = conditions.length === 1 ? conditions[0] : command.and(conditions);
  const response = await schools
    .where(where)
    .field({
      _id: true,
      name: true,
      nameNormalized: true,
      province: true,
      city: true,
      educationLevel: true,
      platformStatus: true
    })
    .orderBy('nameNormalized', 'asc')
    .orderBy('_id', 'asc')
    .limit(options.pageSize + 1)
    .get();
  const records = Array.isArray(response.data) ? response.data : [];
  const pageRecords = records.slice(0, options.pageSize);
  const hasMore = records.length > options.pageSize;
  return {
    items: pageRecords.map(toPublicSchool),
    nextCursor: hasMore
      ? encodeCursor(pageRecords[pageRecords.length - 1], options)
      : '',
    hasMore
  };
}

async function handleList(event) {
  const province = normalizeProvince(event.province);
  if (province === null) {
    return failure(ERROR_CODES.INVALID_PROVINCE, '省级地区参数无效');
  }
  const pageSize = normalizePageSize(event.pageSize);
  if (!pageSize) {
    return failure(ERROR_CODES.INVALID_PAGE_SIZE, '分页大小无效');
  }
  const scope = { province, keyword: '' };
  const cursor = decodeCursor(event.cursor, scope);
  if (cursor === undefined) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '分页游标无效');
  }
  return success(await queryActiveSchools({
    ...scope,
    pageSize,
    cursor
  }));
}

async function handleSearch(event) {
  const keyword = normalizeKeyword(event.keyword);
  if (!keyword) {
    return failure(ERROR_CODES.INVALID_KEYWORD, '搜索关键词无效');
  }
  const province = normalizeProvince(event.province);
  if (province === null) {
    return failure(ERROR_CODES.INVALID_PROVINCE, '省级地区参数无效');
  }
  const pageSize = normalizePageSize(event.pageSize);
  if (!pageSize) {
    return failure(ERROR_CODES.INVALID_PAGE_SIZE, '分页大小无效');
  }
  if (OFFICIAL_CODE_PATTERN.test(keyword)) {
    const response = await schools.where({
      officialCode: keyword,
      platformStatus: 'active',
      officialStatus: 'valid',
      ...(province ? { province } : {})
    }).field({
      _id: true,
      name: true,
      province: true,
      city: true,
      educationLevel: true,
      platformStatus: true
    }).limit(1).get();
    const record = Array.isArray(response.data) ? response.data[0] : null;
    return success({
      items: record ? [toPublicSchool(record)] : [],
      nextCursor: '',
      hasMore: false
    });
  }
  const scope = { province, keyword };
  const cursor = decodeCursor(event.cursor, scope);
  if (cursor === undefined) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '分页游标无效');
  }
  return success(await queryActiveSchools({
    ...scope,
    pageSize,
    cursor
  }));
}

async function handleDetail(event) {
  const schoolId = normalizeText(event.schoolId);
  if (!SCHOOL_ID_PATTERN.test(schoolId)) {
    return failure(ERROR_CODES.INVALID_ARGUMENT, '学校 ID 无效');
  }
  const response = await schools.where({
    _id: schoolId
  }).field({
    _id: true,
    name: true,
    province: true,
    city: true,
    educationLevel: true,
    officialStatus: true,
    platformStatus: true
  }).limit(1).get();
  const record = Array.isArray(response.data) ? response.data[0] : null;
  if (!record) {
    return failure(ERROR_CODES.SCHOOL_NOT_FOUND, '学校不存在');
  }
  if (record.platformStatus !== 'active' || record.officialStatus !== 'valid') {
    return failure(ERROR_CODES.SCHOOL_NOT_ACTIVE, '学校当前不可选择');
  }
  return success(toPublicSchool(record));
}

async function main(event = {}) {
  try {
    if (event.action === 'list') {
      return await handleList(event);
    }
    if (event.action === 'search') {
      return await handleSearch(event);
    }
    if (event.action === 'detail') {
      return await handleDetail(event);
    }
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的学校查询操作');
  } catch (error) {
    console.error('[schoolQuery] query failed', {
      code: error && error.errCode ? String(error.errCode) : 'QUERY_FAILED'
    });
    return failure(ERROR_CODES.QUERY_FAILED, '学校数据暂不可用');
  }
}

exports.main = main;
exports.__test = {
  ERROR_CODES,
  PROVINCES,
  CURSOR_SECRET_ENV,
  normalizeText,
  normalizeKeyword,
  normalizeProvince,
  normalizePageSize,
  escapeRegExp,
  encodeCursor,
  decodeCursor,
  toPublicSchool
};
