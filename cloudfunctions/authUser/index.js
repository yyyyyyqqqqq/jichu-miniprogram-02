const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const users = db.collection('users');

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  AUTH_CONTEXT_MISSING: 'AUTH_CONTEXT_MISSING',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DISABLED: 'USER_DISABLED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function success(user) {
  return {
    success: true,
    code: ERROR_CODES.OK,
    message: '',
    data: {
      user
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

function toIsoString(value) {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toSafeUser(record) {
  return {
    id: String(record._id || ''),
    nickname: typeof record.nickname === 'string' && record.nickname.trim()
      ? record.nickname.trim()
      : '微信用户',
    avatarUrl: typeof record.avatarUrl === 'string' ? record.avatarUrl : '',
    bio: typeof record.bio === 'string' ? record.bio : '',
    campus: typeof record.campus === 'string' ? record.campus : '',
    role: 'user',
    status: record.status === 'disabled' ? 'disabled' : 'active',
    profileCompleted: record.profileCompleted === true,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt),
    lastLoginAt: toIsoString(record.lastLoginAt)
  };
}

function createUserId(appId, openId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${appId || 'wechat-app'}:${openId}`)
    .digest('hex')
    .slice(0, 32);
  return `u_${digest}`;
}

async function findUser(userId) {
  const result = await users.where({
    _id: userId
  }).limit(1).get();

  return result.data && result.data.length > 0
    ? result.data[0]
    : null;
}

function getIdentity() {
  const context = cloud.getWXContext();
  const openId = context && context.OPENID;

  if (!openId) {
    return null;
  }

  return {
    openId,
    appId: context.APPID || ''
  };
}

async function login(identity) {
  const userId = createUserId(identity.appId, identity.openId);
  const existing = await findUser(userId);

  if (existing && existing.status === 'disabled') {
    return failure(ERROR_CODES.USER_DISABLED, '当前账户暂不可用');
  }

  const now = new Date();

  if (!existing) {
    const record = {
      openid: identity.openId,
      nickname: '微信用户',
      avatarUrl: '',
      bio: '',
      campus: '',
      role: 'user',
      status: 'active',
      profileCompleted: false,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      lastLoginAt: db.serverDate()
    };

    await users.doc(userId).set({
      data: record
    });

    return success(toSafeUser({
      ...record,
      _id: userId,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now
    }));
  }

  await users.doc(userId).update({
    data: {
      updatedAt: db.serverDate(),
      lastLoginAt: db.serverDate()
    }
  });

  return success(toSafeUser({
    ...existing,
    updatedAt: now,
    lastLoginAt: now
  }));
}

async function current(identity) {
  const userId = createUserId(identity.appId, identity.openId);
  const existing = await findUser(userId);

  if (!existing) {
    return failure(ERROR_CODES.USER_NOT_FOUND, '当前微信身份尚未登录');
  }

  if (existing.status === 'disabled') {
    return failure(ERROR_CODES.USER_DISABLED, '当前账户暂不可用');
  }

  return success(toSafeUser(existing));
}

exports.main = async (event = {}) => {
  const action = typeof event.action === 'string'
    ? event.action.trim()
    : '';

  if (!['login', 'current'].includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的认证操作');
  }

  const identity = getIdentity();
  if (!identity) {
    return failure(ERROR_CODES.AUTH_CONTEXT_MISSING, '无法确认当前微信身份');
  }

  try {
    if (action === 'login') {
      return await login(identity);
    }
    return await current(identity);
  } catch (error) {
    const isDatabaseError = error && (
      error.errCode
      || error.code
      || error.message
    );
    return failure(
      isDatabaseError ? ERROR_CODES.DATABASE_ERROR : ERROR_CODES.INTERNAL_ERROR,
      '认证服务暂不可用，请稍后重试'
    );
  }
};
