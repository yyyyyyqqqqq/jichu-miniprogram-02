const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const users = db.collection('users');

const NICKNAME_MAX_LENGTH = 20;
const CAMPUS_MAX_LENGTH = 40;
const LEGACY_DEFAULT_NICKNAMES = new Set(['微信用户']);
const AVATAR_FILE_NAME_PATTERN =
  /^[a-zA-Z0-9_-]{1,160}\.(?:jpg|jpeg|png|gif|webp)$/i;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_NICKNAME: 'INVALID_NICKNAME',
  INVALID_AVATAR: 'INVALID_AVATAR',
  INVALID_CAMPUS: 'INVALID_CAMPUS',
  AUTH_FAILED: 'AUTH_FAILED',
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

function businessError(code, message) {
  const error = new Error(message);
  error.businessCode = code;
  throw error;
}

function normalizeText(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeNickname(value) {
  const nickname = normalizeText(value);
  return LEGACY_DEFAULT_NICKNAMES.has(nickname) ? '' : nickname;
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

function toSafeUser(record) {
  const publicUserId = String(record._id || '');
  const nickname = normalizeNickname(record.nickname);
  const avatarUrl = typeof record.avatarUrl === 'string'
    ? record.avatarUrl
    : '';

  return {
    id: publicUserId,
    publicUserId,
    nickname,
    avatarUrl,
    bio: typeof record.bio === 'string' ? record.bio : '',
    campus: normalizeText(record.campus),
    role: 'user',
    status: record.status === 'disabled' ? 'disabled' : 'active',
    profileCompleted: Boolean(
      record.profileCompleted === true
      && nickname
      && avatarUrl
    ),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt),
    lastLoginAt: toIsoString(record.lastLoginAt)
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

function isOwnedAvatar(fileID, userId) {
  const segments = getCloudFilePath(fileID).split('/');
  return segments.length === 4
    && segments[0] === 'avatars'
    && segments[1] === userId
    && /^\d{8}$/.test(segments[2])
    && AVATAR_FILE_NAME_PATTERN.test(segments[3]);
}

function validateProfile(value, userId, options = {}) {
  const profile = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const nickname = normalizeNickname(profile.nickname);
  if (
    !nickname
    || nickname.length > NICKNAME_MAX_LENGTH
    || /[\u0000-\u001f\u007f]/.test(nickname)
  ) {
    businessError(
      ERROR_CODES.INVALID_NICKNAME,
      `昵称应为 1～${NICKNAME_MAX_LENGTH} 个字符`
    );
  }

  if (
    profile.campus !== undefined
    && profile.campus !== null
    && typeof profile.campus !== 'string'
  ) {
    businessError(ERROR_CODES.INVALID_CAMPUS, '校园信息格式不正确');
  }
  const campus = normalizeText(profile.campus);
  if (
    campus.length > CAMPUS_MAX_LENGTH
    || /[\u0000-\u001f\u007f]/.test(campus)
  ) {
    businessError(
      ERROR_CODES.INVALID_CAMPUS,
      `校园信息不能超过 ${CAMPUS_MAX_LENGTH} 个字符`
    );
  }

  const avatarUrl = typeof profile.avatarUrl === 'string'
    ? profile.avatarUrl.trim()
    : '';
  if (
    (options.requireAvatar === true || avatarUrl)
    && !isOwnedAvatar(avatarUrl, userId)
  ) {
    businessError(ERROR_CODES.INVALID_AVATAR, '请选择有效的头像图片');
  }

  return {
    nickname,
    avatarUrl,
    campus
  };
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
  const openId = context && normalizeText(context.OPENID);
  const appId = context && normalizeText(context.APPID);

  if (!openId || !appId) {
    return null;
  }

  return {
    openId,
    appId
  };
}

function assertExistingUser(existing, identity) {
  if (!existing) {
    return;
  }
  if (existing.status === 'disabled') {
    businessError(ERROR_CODES.USER_DISABLED, '当前账户暂不可用');
  }
  if (
    typeof existing.openid !== 'string'
    || existing.openid !== identity.openId
  ) {
    businessError(ERROR_CODES.AUTH_FAILED, '无法确认当前用户记录');
  }
}

async function login(identity, input) {
  const userId = createUserId(identity.appId, identity.openId);
  const profile = validateProfile(input, userId);
  const existing = await findUser(userId);
  assertExistingUser(existing, identity);
  const now = new Date();

  if (!existing) {
    const record = {
      openid: identity.openId,
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
      bio: '',
      campus: profile.campus,
      role: 'user',
      status: 'active',
      profileCompleted: Boolean(profile.nickname && profile.avatarUrl),
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      lastLoginAt: db.serverDate()
    };

    // 确定性文档 ID 是服务端并发兜底：同一 OPENID 只会写入同一文档。
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

  const finalAvatarUrl = profile.avatarUrl || existing.avatarUrl || '';
  const updateData = {
    nickname: profile.nickname,
    campus: profile.campus,
    profileCompleted: Boolean(profile.nickname && finalAvatarUrl),
    updatedAt: db.serverDate(),
    lastLoginAt: db.serverDate()
  };
  if (profile.avatarUrl) {
    updateData.avatarUrl = profile.avatarUrl;
  }

  await users.doc(userId).update({
    data: updateData
  });

  return success(toSafeUser({
    ...existing,
    ...updateData,
    avatarUrl: finalAvatarUrl,
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
  assertExistingUser(existing, identity);
  return success(toSafeUser(existing));
}

async function updateProfile(identity, input) {
  const userId = createUserId(identity.appId, identity.openId);
  const existing = await findUser(userId);
  if (!existing) {
    return failure(ERROR_CODES.USER_NOT_FOUND, '当前微信身份尚未登录');
  }
  assertExistingUser(existing, identity);

  const profile = validateProfile(input, userId, {
    requireAvatar: true
  });
  const now = new Date();
  const updateData = {
    nickname: profile.nickname,
    avatarUrl: profile.avatarUrl,
    campus: profile.campus,
    profileCompleted: true,
    updatedAt: db.serverDate()
  };
  await users.doc(userId).update({
    data: updateData
  });

  return success(toSafeUser({
    ...existing,
    ...updateData,
    updatedAt: now
  }));
}

function classifyFailure(error) {
  const message = [
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).join(' ').toLowerCase();
  const code = String(
    error && (error.errCode || error.code || '')
  ).toLowerCase();
  return (
    code.includes('database')
    || message.includes('database')
    || message.includes('collection')
    || message.includes('document')
  )
    ? ERROR_CODES.DATABASE_ERROR
    : ERROR_CODES.INTERNAL_ERROR;
}

exports.main = async (event = {}) => {
  const request = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const action = normalizeText(request.action);
  const data = request.data
    && typeof request.data === 'object'
    && !Array.isArray(request.data)
    ? request.data
    : {};
  const allowedActions = ['login', 'current', 'updateProfile'];

  if (!allowedActions.includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的认证操作');
  }

  const identity = getIdentity();
  if (!identity) {
    return failure(ERROR_CODES.AUTH_FAILED, '无法确认当前微信身份');
  }

  try {
    if (action === 'login') {
      return await login(identity, data.profile);
    }
    if (action === 'updateProfile') {
      return await updateProfile(identity, data.profile);
    }
    return await current(identity);
  } catch (error) {
    if (error && error.businessCode) {
      return failure(error.businessCode, error.message);
    }
    const code = classifyFailure(error);
    return failure(
      code,
      code === ERROR_CODES.DATABASE_ERROR
        ? '认证数据暂不可用，请稍后重试'
        : '认证服务暂不可用，请稍后重试'
    );
  }
};
