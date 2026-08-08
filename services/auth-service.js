const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');

const AUTH_ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  TIMEOUT: '登录请求超时，请重新尝试',
  CLOUD_NOT_READY: '云服务暂不可用',
  AUTH_FAILED: '登录失败，请稍后重试',
  AUTH_CONTEXT_MISSING: '无法确认当前微信身份',
  INVALID_NICKNAME: '昵称应为 1～20 个字符',
  INVALID_AVATAR: '请选择有效的头像图片',
  INVALID_CAMPUS: '校园信息不能超过 40 个字符',
  INVALID_SCHOOL_ID: '请选择有效的学校',
  SCHOOL_NOT_FOUND: '学校信息不存在，请刷新后重试',
  SCHOOL_NOT_ACTIVE: '该学校暂未开放',
  SCHOOL_ALREADY_SELECTED: '你已经完成学校选择',
  SCHOOL_REQUIRED: '请先完成学校选择',
  SCHOOL_UNCHANGED: '新学校与当前学校相同',
  SCHOOL_UPDATE_FAILED: '学校修改失败，请稍后重试',
  PROFILE_INCOMPLETE: '请先完善个人资料',
  SCHOOL_SELECTION_REQUIRED: '请先选择学校',
  SCHOOL_UNAVAILABLE: '当前学校暂不可用，请重新选择',
  USER_DISABLED: '当前账户暂不可用',
  USER_NOT_FOUND: '当前微信身份尚未登录',
  DATABASE_ERROR: '认证服务暂不可用，请稍后重试',
  INTERNAL_ERROR: '认证服务暂不可用，请稍后重试',
  INVALID_ACTION: '认证请求不受支持',
  INVALID_RESPONSE: '认证服务返回异常',
  UNKNOWN_ERROR: '认证服务暂不可用'
};

class AuthError extends Error {
  constructor(code, message) {
    super(message || AUTH_ERROR_MESSAGES[code] || AUTH_ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'AuthError';
    this.code = code || 'UNKNOWN_ERROR';
  }
}

function createAuthError(code) {
  return new AuthError(code, AUTH_ERROR_MESSAGES[code]);
}

function normalizeUser(value) {
  if (!value || typeof value !== 'object') {
    throw createAuthError('INVALID_RESPONSE');
  }

  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) {
    throw createAuthError('INVALID_RESPONSE');
  }

  const status = value.status === 'disabled' ? 'disabled' : 'active';
  if (status === 'disabled') {
    throw createAuthError('USER_DISABLED');
  }

  const rawNickname = typeof value.nickname === 'string'
    ? value.nickname.trim()
    : '';
  const nickname = rawNickname === '微信用户' ? '' : rawNickname;
  const schoolId = typeof value.schoolId === 'string'
    ? value.schoolId.trim()
    : '';
  const schoolVersion = Number(value.schoolVersion);

  return {
    id,
    nickname,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : '',
    avatarText: nickname.slice(0, 1) || '即',
    campus: typeof value.campus === 'string' ? value.campus : '',
    bio: typeof value.bio === 'string' ? value.bio : '',
    role: 'user',
    status,
    profileCompleted: value.profileCompleted === true,
    schoolId,
    schoolName: typeof value.schoolName === 'string'
      ? value.schoolName.trim()
      : '',
    schoolSelectedAt: typeof value.schoolSelectedAt === 'string'
      ? value.schoolSelectedAt
      : '',
    schoolUpdatedAt: typeof value.schoolUpdatedAt === 'string'
      ? value.schoolUpdatedAt
      : '',
    schoolVersion: Number.isInteger(schoolVersion) && schoolVersion > 0
      ? schoolVersion
      : 0,
    schoolRequired: value.schoolRequired !== false,
    schoolUnavailable: value.schoolUnavailable === true,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    lastLoginAt: typeof value.lastLoginAt === 'string' ? value.lastLoginAt : ''
  };
}

function mapCloudFailure(error) {
  if (error instanceof AuthError) {
    return error;
  }

  const message = error && typeof error.errMsg === 'string'
    ? error.errMsg.toLowerCase()
    : '';

  if (message.includes('timeout')) {
    return createAuthError('TIMEOUT');
  }
  if (message.includes('network') || message.includes('request:fail')) {
    return createAuthError('NETWORK_ERROR');
  }
  if (
    message.includes('cloud')
    || message.includes('environment')
    || message.includes('function not found')
  ) {
    return createAuthError('CLOUD_NOT_READY');
  }

  return createAuthError('AUTH_FAILED');
}

async function callCloudFunction(action, data = {}) {
  try {
    await CloudService.ensureCloudReady();
  } catch (error) {
    throw createAuthError('CLOUD_NOT_READY');
  }
  if (typeof wx.cloud.callFunction !== 'function') {
    throw createAuthError('CLOUD_NOT_READY');
  }

  let timeoutId;
  const request = new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: CLOUD_CONFIG.authFunctionName,
      data: {
        action,
        data
      },
      success: resolve,
      fail: reject
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createAuthError('TIMEOUT'));
    }, CLOUD_CONFIG.authTimeoutMs);
  });

  return Promise.race([request, timeout])
    .then((response) => {
      const payload = response && response.result;
      if (!payload || typeof payload !== 'object' || typeof payload.success !== 'boolean') {
        throw createAuthError('INVALID_RESPONSE');
      }
      return payload;
    })
    .catch((error) => {
      throw mapCloudFailure(error);
    })
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
}

function normalizeProfileInput(value, options = {}) {
  const profile = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const nickname = typeof profile.nickname === 'string'
    ? profile.nickname.trim().replace(/\s+/g, ' ')
    : '';
  if (!nickname || nickname.length > 20) {
    throw createAuthError('INVALID_NICKNAME');
  }
  const avatarUrl = typeof profile.avatarUrl === 'string'
    ? profile.avatarUrl.trim()
    : '';
  if (options.requireAvatar === true && !avatarUrl.startsWith('cloud://')) {
    throw createAuthError('INVALID_AVATAR');
  }
  return {
    nickname,
    avatarUrl
  };
}

async function login(profile) {
  const safeProfile = normalizeProfileInput(profile);
  const payload = await callCloudFunction('login', {
    profile: safeProfile
  });
  if (!payload.success) {
    throw createAuthError(payload.code || 'AUTH_FAILED');
  }
  return normalizeUser(payload.data && payload.data.user);
}

async function getCurrentUser() {
  const payload = await callCloudFunction('current');
  if (!payload.success) {
    if (payload.code === 'USER_NOT_FOUND') {
      return null;
    }
    throw createAuthError(payload.code || 'AUTH_FAILED');
  }
  return normalizeUser(payload.data && payload.data.user);
}

async function updateProfile(profile) {
  const safeProfile = normalizeProfileInput(profile, {
    requireAvatar: true
  });
  const payload = await callCloudFunction('updateProfile', {
    profile: safeProfile
  });
  if (!payload.success) {
    throw createAuthError(payload.code || 'AUTH_FAILED');
  }
  return normalizeUser(payload.data && payload.data.user);
}

async function selectSchool(schoolId) {
  const normalizedSchoolId = typeof schoolId === 'string'
    ? schoolId.trim()
    : '';
  if (!/^s_[0-9a-f]{32}$/.test(normalizedSchoolId)) {
    throw createAuthError('INVALID_SCHOOL_ID');
  }
  const payload = await callCloudFunction('selectSchool', {
    schoolId: normalizedSchoolId
  });
  if (!payload.success) {
    throw createAuthError(payload.code || 'AUTH_FAILED');
  }
  return normalizeUser(payload.data && payload.data.user);
}

async function updateSchool(schoolId) {
  const normalizedSchoolId = typeof schoolId === 'string'
    ? schoolId.trim()
    : '';
  if (!/^s_[0-9a-f]{32}$/.test(normalizedSchoolId)) {
    throw createAuthError('INVALID_SCHOOL_ID');
  }
  const payload = await callCloudFunction('updateSchool', {
    schoolId: normalizedSchoolId
  });
  if (!payload.success) {
    throw createAuthError(payload.code || 'SCHOOL_UPDATE_FAILED');
  }
  return normalizeUser(payload.data && payload.data.user);
}

function isLoggedIn() {
  const AuthStore = require('../store/auth-store');
  return AuthStore.isLoggedIn();
}

function clearLocalSession() {
  const AuthStore = require('../store/auth-store');
  AuthStore.clearSession();
}

module.exports = {
  AuthError,
  login,
  updateProfile,
  selectSchool,
  updateSchool,
  getCurrentUser,
  isLoggedIn,
  clearLocalSession,
  __test: {
    normalizeUser,
    normalizeProfileInput
  }
};
