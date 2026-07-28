const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 20;
const MAX_KEYWORD_LENGTH = 40;

const SCHOOL_ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  TIMEOUT: '学校查询超时，请重新尝试',
  CLOUD_TIMEOUT: '学校查询超时，请重新尝试',
  CLOUD_NOT_READY: '学校服务暂不可用',
  CLOUD_CONFIG_MISSING: '学校服务尚未配置',
  CLOUD_UNAVAILABLE: '学校服务暂不可用',
  CLOUD_INIT_FAILED: '学校服务初始化失败',
  CLOUD_CALL_FAILED: '学校服务暂不可用',
  FUNCTION_NOT_FOUND: '学校服务尚未部署',
  INVALID_ACTION: '学校查询操作不受支持',
  INVALID_ARGUMENT: '学校查询参数不正确',
  INVALID_KEYWORD: '请输入有效的学校关键词',
  INVALID_PROVINCE: '省级地区参数不正确',
  INVALID_PAGE_SIZE: '分页大小不正确',
  SCHOOL_NOT_FOUND: '学校不存在',
  SCHOOL_NOT_ACTIVE: '该学校当前不可选择',
  QUERY_FAILED: '学校数据暂不可用',
  SERVICE_UNAVAILABLE: '学校服务暂不可用',
  INVALID_RESPONSE: '学校服务返回异常',
  UNKNOWN_ERROR: '学校服务暂不可用'
};

class SchoolError extends Error {
  constructor(code, message, cause) {
    super(message || SCHOOL_ERROR_MESSAGES[code] || SCHOOL_ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'SchoolError';
    this.code = code || 'UNKNOWN_ERROR';
    this.cause = cause || null;
  }
}

function createSchoolError(code, message, cause) {
  return new SchoolError(
    code,
    message || SCHOOL_ERROR_MESSAGES[code],
    cause
  );
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function normalizePageSize(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_PAGE_SIZE;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PAGE_SIZE) {
    throw createSchoolError('INVALID_PAGE_SIZE');
  }
  return number;
}

function normalizeKeyword(value) {
  const keyword = normalizeText(value);
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH) {
    throw createSchoolError('INVALID_KEYWORD');
  }
  return keyword;
}

function normalizeSchool(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw createSchoolError('INVALID_RESPONSE');
  }
  const id = normalizeText(record.id);
  const name = normalizeText(record.name);
  const province = normalizeText(record.province);
  const educationLevel = normalizeText(record.educationLevel);
  const platformStatus = normalizeText(record.platformStatus);
  if (!id || !name || !province || !educationLevel || !platformStatus) {
    throw createSchoolError('INVALID_RESPONSE');
  }
  return {
    id,
    name,
    province,
    city: normalizeText(record.city),
    educationLevel,
    platformStatus,
    selectable: record.selectable === true
  };
}

function normalizeListPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
    throw createSchoolError('INVALID_RESPONSE');
  }
  return {
    items: payload.items.map(normalizeSchool),
    nextCursor: normalizeText(payload.nextCursor),
    hasMore: payload.hasMore === true
  };
}

function normalizeCallError(error) {
  if (error instanceof SchoolError) {
    return error;
  }
  const code = error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN_ERROR';
  return createSchoolError(code, SCHOOL_ERROR_MESSAGES[code], error);
}

async function callSchoolQuery(action, data = {}) {
  let response;
  try {
    response = await CloudService.callFunction({
      name: CLOUD_CONFIG.schoolQueryFunctionName,
      timeoutMs: CLOUD_CONFIG.schoolQueryTimeoutMs,
      data: {
        action,
        ...data
      }
    });
  } catch (error) {
    throw normalizeCallError(error);
  }
  const result = response && response.result;
  if (!result || typeof result.success !== 'boolean') {
    throw createSchoolError('INVALID_RESPONSE');
  }
  if (!result.success) {
    throw createSchoolError(
      normalizeText(result.code) || 'UNKNOWN_ERROR',
      SCHOOL_ERROR_MESSAGES[result.code]
    );
  }
  return result.data;
}

async function listSchools(options = {}) {
  const payload = await callSchoolQuery('list', {
    province: normalizeText(options.province),
    pageSize: normalizePageSize(options.pageSize),
    cursor: normalizeText(options.cursor)
  });
  return normalizeListPayload(payload);
}

async function searchSchools(options = {}) {
  const payload = await callSchoolQuery('search', {
    keyword: normalizeKeyword(options.keyword),
    province: normalizeText(options.province),
    pageSize: normalizePageSize(options.pageSize),
    cursor: normalizeText(options.cursor)
  });
  return normalizeListPayload(payload);
}

async function getSchoolDetail(schoolId) {
  const normalizedId = normalizeText(schoolId);
  if (!/^s_[0-9a-f]{32}$/.test(normalizedId)) {
    throw createSchoolError('INVALID_ARGUMENT');
  }
  const payload = await callSchoolQuery('detail', {
    schoolId: normalizedId
  });
  return normalizeSchool(payload);
}

module.exports = {
  SchoolError,
  listSchools,
  searchSchools,
  getSchoolDetail,
  __test: {
    normalizeText,
    normalizePageSize,
    normalizeKeyword,
    normalizeSchool,
    normalizeListPayload,
    normalizeCallError
  }
};
