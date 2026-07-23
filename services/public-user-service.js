const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');
const ProductService = require('./product-service');

const PUBLIC_USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const DEFAULT_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 20;

const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  TIMEOUT: '用户主页请求超时，请重新尝试',
  CLOUD_NOT_READY: '用户主页服务暂不可用',
  INVALID_ACTION: '用户主页请求不受支持',
  INVALID_PARAMS: '用户主页参数不正确',
  USER_NOT_FOUND: '该用户不存在',
  PUBLIC_PROFILE_UNAVAILABLE: '该用户主页暂不可用',
  DATABASE_ERROR: '用户主页数据暂不可用，请稍后重试',
  INTERNAL_ERROR: '用户主页服务暂不可用',
  INVALID_RESPONSE: '用户主页服务返回异常',
  UNKNOWN_ERROR: '用户主页服务暂不可用'
};

class PublicUserError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'PublicUserError';
    this.code = code || 'UNKNOWN_ERROR';
  }
}

function createError(code, message) {
  return new PublicUserError(code, message || ERROR_MESSAGES[code]);
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

function mapTransportError(error) {
  if (error instanceof PublicUserError) {
    return error;
  }
  const message = error && typeof error.errMsg === 'string'
    ? error.errMsg.toLowerCase()
    : '';
  if (message.includes('timeout')) {
    return createError('TIMEOUT');
  }
  if (message.includes('network') || message.includes('request:fail')) {
    return createError('NETWORK_ERROR');
  }
  if (
    message.includes('cloud')
    || message.includes('environment')
    || message.includes('function not found')
  ) {
    return createError('CLOUD_NOT_READY');
  }
  return createError('UNKNOWN_ERROR');
}

async function callUserQuery(action, data) {
  try {
    await CloudService.ensureCloudReady();
  } catch (error) {
    throw createError('CLOUD_NOT_READY');
  }
  if (typeof wx.cloud.callFunction !== 'function') {
    throw createError('CLOUD_NOT_READY');
  }

  let timeoutId;
  const request = new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: CLOUD_CONFIG.userQueryFunctionName,
      data: { action, data },
      success: resolve,
      fail: reject
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError('TIMEOUT'));
    }, CLOUD_CONFIG.userQueryTimeoutMs);
  });

  return Promise.race([request, timeout])
    .then((response) => {
      const payload = response && response.result;
      if (
        !payload
        || typeof payload !== 'object'
        || typeof payload.success !== 'boolean'
      ) {
        throw createError('INVALID_RESPONSE');
      }
      if (!payload.success) {
        throw createError(payload.code || 'UNKNOWN_ERROR', payload.message);
      }
      return payload.data && typeof payload.data === 'object'
        ? payload.data
        : {};
    })
    .catch((error) => {
      throw mapTransportError(error);
    })
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
}

async function getPublicProfile(publicUserId) {
  const id = normalizePublicUserId(publicUserId);
  if (!id) {
    throw createError('INVALID_PARAMS');
  }
  const data = await callUserQuery('publicProfile', { publicUserId: id });
  const profile = data.profile;
  if (
    !profile
    || typeof profile !== 'object'
    || normalizePublicUserId(profile.publicUserId) !== id
  ) {
    throw createError('INVALID_RESPONSE');
  }
  const nickname = typeof profile.nickname === 'string' && profile.nickname.trim()
    ? profile.nickname.trim()
    : '即出用户';
  return {
    publicUserId: id,
    nickname,
    avatarUrl: typeof profile.avatarUrl === 'string' ? profile.avatarUrl : '',
    avatarText: nickname.slice(0, 1) || '即',
    campus: typeof profile.campus === 'string' && profile.campus.trim()
      ? profile.campus.trim()
      : '校园信息待完善',
    bio: typeof profile.bio === 'string' && profile.bio.trim()
      ? profile.bio.trim()
      : '这个用户还没有填写简介',
    joinDate: typeof profile.joinDate === 'string' ? profile.joinDate : '',
    activeProductCount: normalizeCount(profile.activeProductCount)
  };
}

async function getPublicProducts(publicUserId, options = {}) {
  const id = normalizePublicUserId(publicUserId);
  if (!id) {
    throw createError('INVALID_PARAMS');
  }
  const page = normalizePositiveInteger(options.page, 1, 100);
  const pageSize = normalizePositiveInteger(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const data = await callUserQuery('publicProducts', {
    publicUserId: id,
    page,
    pageSize
  });
  let list;
  try {
    list = ProductService.normalizeProductList(data.list);
  } catch (error) {
    throw createError('INVALID_RESPONSE');
  }
  return {
    list,
    total: normalizeCount(data.total),
    page: normalizePositiveInteger(data.page, page, 100),
    pageSize: normalizePositiveInteger(data.pageSize, pageSize, MAX_PAGE_SIZE),
    hasMore: data.hasMore === true
  };
}

module.exports = {
  PublicUserError,
  normalizePublicUserId,
  getPublicProfile,
  getPublicProducts
};
