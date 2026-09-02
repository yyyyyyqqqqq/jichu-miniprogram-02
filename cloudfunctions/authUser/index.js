const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const users = db.collection('users');
const schools = db.collection('schools');

const NICKNAME_MAX_LENGTH = 20;
const CAMPUS_MAX_LENGTH = 40;
const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;
const SCHOOL_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_DEFAULT_NICKNAMES = new Set(['微信用户']);
const AVATAR_FILE_NAME_PATTERN =
  /^[a-zA-Z0-9_-]{1,160}\.(?:jpg|jpeg|png|gif|webp)$/i;

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_NICKNAME: 'INVALID_NICKNAME',
  INVALID_AVATAR: 'INVALID_AVATAR',
  INVALID_CAMPUS: 'INVALID_CAMPUS',
  INVALID_SCHOOL_ID: 'INVALID_SCHOOL_ID',
  SCHOOL_NOT_FOUND: 'SCHOOL_NOT_FOUND',
  SCHOOL_NOT_ACTIVE: 'SCHOOL_NOT_ACTIVE',
  SCHOOL_ALREADY_SELECTED: 'SCHOOL_ALREADY_SELECTED',
  SCHOOL_REQUIRED: 'SCHOOL_REQUIRED',
  SCHOOL_UNAVAILABLE: 'SCHOOL_UNAVAILABLE',
  SCHOOL_UNCHANGED: 'SCHOOL_UNCHANGED',
  SCHOOL_CHANGE_COOLDOWN: 'SCHOOL_CHANGE_COOLDOWN',
  SCHOOL_UPDATE_FAILED: 'SCHOOL_UPDATE_FAILED',
  AUTH_FAILED: 'AUTH_FAILED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_DISABLED: 'USER_DISABLED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function success(user, extraData = {}) {
  return {
    success: true,
    code: ERROR_CODES.OK,
    message: '',
    data: {
      user,
      ...extraData
    }
  };
}

function failure(code, message, data = null) {
  return {
    success: false,
    code,
    message,
    data
  };
}

function businessError(code, message, data = null) {
  const error = new Error(message);
  error.businessCode = code;
  error.businessData = data;
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

function normalizeSchoolId(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const schoolId = value.trim();
  return SCHOOL_ID_PATTERN.test(schoolId) ? schoolId : '';
}

function normalizeSchoolVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

function toTimestamp(value) {
  const isoString = toIsoString(value);
  const timestamp = isoString ? new Date(isoString).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSchoolChangePolicy(record, now = new Date()) {
  const nowTimestamp = now instanceof Date
    ? now.getTime()
    : new Date(now).getTime();
  const safeNow = Number.isFinite(nowTimestamp) ? nowTimestamp : Date.now();
  const schoolChangedAt = toIsoString(record && record.schoolChangedAt);
  const changedTimestamp = toTimestamp(record && record.schoolChangedAt);
  const nextAllowedTimestamp = changedTimestamp > 0
    ? changedTimestamp + SCHOOL_CHANGE_COOLDOWN_MS
    : 0;
  const remainingMs = nextAllowedTimestamp > safeNow
    ? nextAllowedTimestamp - safeNow
    : 0;
  return {
    schoolChangedAt,
    canChangeSchool: remainingMs === 0,
    nextSchoolChangeAllowedAt: nextAllowedTimestamp > 0
      ? new Date(nextAllowedTimestamp).toISOString()
      : '',
    schoolChangeRemainingMs: remainingMs
  };
}

function assertSchoolChangeAllowed(record, now = new Date()) {
  const policy = getSchoolChangePolicy(record, now);
  if (!policy.canChangeSchool) {
    businessError(
      ERROR_CODES.SCHOOL_CHANGE_COOLDOWN,
      '学校修改后 7 天内不可再次修改',
      policy
    );
  }
  return policy;
}

function logSchoolChange(outcome, code = ERROR_CODES.OK) {
  console.info('[authUser] school change', {
    outcome,
    code
  });
}

function toSafeUser(record, schoolState = {}) {
  const publicUserId = String(record._id || '');
  const nickname = normalizeNickname(record.nickname);
  const avatarUrl = typeof record.avatarUrl === 'string'
    ? record.avatarUrl
    : '';
  const schoolId = typeof schoolState.schoolId === 'string'
    ? schoolState.schoolId
    : normalizeText(record.schoolId);
  const schoolName = typeof schoolState.schoolName === 'string'
    ? schoolState.schoolName
    : normalizeText(record.schoolName);
  const schoolChangePolicy = getSchoolChangePolicy(record);

  return {
    id: publicUserId,
    publicUserId,
    nickname,
    avatarUrl,
    bio: typeof record.bio === 'string' ? record.bio : '',
    campus: normalizeText(record.campus),
    role: 'user',
    status: record.status === 'active' ? 'active' : 'disabled',
    profileCompleted: Boolean(
      record.profileCompleted === true
      && nickname
      && avatarUrl
    ),
    schoolId,
    schoolName,
    schoolSelectedAt: toIsoString(record.schoolSelectedAt),
    schoolUpdatedAt: toIsoString(record.schoolUpdatedAt),
    schoolChangedAt: schoolChangePolicy.schoolChangedAt,
    schoolVersion: normalizeSchoolVersion(record.schoolVersion),
    canChangeSchool: schoolChangePolicy.canChangeSchool,
    nextSchoolChangeAllowedAt: schoolChangePolicy.nextSchoolChangeAllowedAt,
    schoolChangeRemainingMs: schoolChangePolicy.schoolChangeRemainingMs,
    schoolRequired: schoolState.schoolRequired !== false,
    schoolUnavailable: schoolState.schoolUnavailable === true,
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
    avatarUrl
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

function isMissingDocumentError(error) {
  const message = [
    error && error.message,
    error && error.errMsg
  ].filter(Boolean).join(' ').toLowerCase();
  return (
    message.includes('does not exist')
    || message.includes('document not found')
    || message.includes('document.get:fail')
  );
}

function extractDocument(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }
  if (response.data && !Array.isArray(response.data)) {
    return response.data;
  }
  return Array.isArray(response.data) ? response.data[0] || null : null;
}

async function getDocumentOrNull(document) {
  try {
    return extractDocument(await document.get());
  } catch (error) {
    if (isMissingDocumentError(error)) {
      return null;
    }
    throw error;
  }
}

async function findSchool(schoolId, collection = schools) {
  if (!normalizeSchoolId(schoolId)) {
    return null;
  }
  if (collection && typeof collection.doc === 'function') {
    return getDocumentOrNull(collection.doc(schoolId));
  }
  const result = await collection.where({
    _id: schoolId
  }).limit(1).get();
  return Array.isArray(result.data) ? result.data[0] || null : null;
}

function isSchoolActive(school) {
  return Boolean(
    school
    && school.platformStatus === 'active'
    && school.officialStatus === 'valid'
    && normalizeText(school.name)
  );
}

async function resolveSchoolState(record, collection = schools) {
  const storedSchoolId = normalizeText(record && record.schoolId);
  const schoolId = normalizeSchoolId(storedSchoolId);
  const fallbackName = normalizeText(record && record.schoolName);
  if (!storedSchoolId) {
    return {
      schoolId: '',
      schoolName: '',
      schoolRequired: true,
      schoolUnavailable: false
    };
  }
  if (!schoolId) {
    return {
      schoolId: storedSchoolId,
      schoolName: fallbackName,
      schoolRequired: true,
      schoolUnavailable: true
    };
  }
  const school = await findSchool(schoolId, collection);
  if (!isSchoolActive(school)) {
    return {
      schoolId,
      schoolName: fallbackName,
      schoolRequired: true,
      schoolUnavailable: true
    };
  }
  return {
    schoolId,
    schoolName: normalizeText(school.name),
    schoolRequired: false,
    schoolUnavailable: false
  };
}

async function toResolvedSafeUser(record, collection = schools) {
  const schoolState = await resolveSchoolState(record, collection);
  return toSafeUser(record, schoolState);
}

async function runTransaction(callback) {
  const response = await db.runTransaction(
    async (transaction) => callback(transaction)
  );
  if (
    response
    && typeof response === 'object'
    && Object.prototype.hasOwnProperty.call(response, 'result')
  ) {
    return response.result;
  }
  return response;
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
  if (
    typeof existing.openid !== 'string'
    || existing.openid !== identity.openId
  ) {
    businessError(ERROR_CODES.AUTH_FAILED, '无法确认当前用户记录');
  }
  if (existing.status !== 'active') {
    businessError(ERROR_CODES.USER_DISABLED, '当前账户暂不可用');
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
      campus: '',
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

    return success(await toResolvedSafeUser({
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

  return success(await toResolvedSafeUser({
    ...existing,
    ...updateData,
    avatarUrl: finalAvatarUrl,
    updatedAt: now,
    lastLoginAt: now
  }));
}

async function loginIdentity(identity) {
  const userId = createUserId(identity.appId, identity.openId);
  const existing = await findUser(userId);
  assertExistingUser(existing, identity);
  const now = new Date();

  if (!existing) {
    const record = {
      openid: identity.openId,
      nickname: '',
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
    await users.doc(userId).set({ data: record });
    return success(await toResolvedSafeUser({
      ...record,
      _id: userId,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now
    }));
  }

  const updateData = {
    lastLoginAt: db.serverDate()
  };
  await users.doc(userId).update({ data: updateData });
  return success(await toResolvedSafeUser({
    ...existing,
    ...updateData,
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
  return success(await toResolvedSafeUser(existing));
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
    profileCompleted: true,
    updatedAt: db.serverDate()
  };
  await users.doc(userId).update({
    data: updateData
  });

  return success(await toResolvedSafeUser({
    ...existing,
    ...updateData,
    updatedAt: now
  }));
}

async function selectSchool(identity, input) {
  const requestedSchoolId = normalizeSchoolId(input && input.schoolId);
  if (!requestedSchoolId) {
    businessError(ERROR_CODES.INVALID_SCHOOL_ID, '请选择有效的学校');
  }

  const userId = createUserId(identity.appId, identity.openId);
  const now = new Date();
  const result = await runTransaction(async (transaction) => {
    const userDocument = transaction.collection('users').doc(userId);
    const existing = await getDocumentOrNull(userDocument);
    if (!existing) {
      businessError(ERROR_CODES.USER_NOT_FOUND, '当前微信身份尚未登录');
    }
    assertExistingUser(existing, identity);

    const schoolCollection = transaction.collection('schools');
    const existingState = await resolveSchoolState(existing, schoolCollection);
    if (!existingState.schoolRequired) {
      if (existingState.schoolId === requestedSchoolId) {
        return {
          record: existing,
          schoolState: existingState
        };
      }
      businessError(
        ERROR_CODES.SCHOOL_ALREADY_SELECTED,
        '你已经完成学校选择'
      );
    }

    const selectedSchool = await findSchool(
      requestedSchoolId,
      schoolCollection
    );
    if (!selectedSchool) {
      businessError(ERROR_CODES.SCHOOL_NOT_FOUND, '学校信息不存在');
    }
    if (!isSchoolActive(selectedSchool)) {
      businessError(ERROR_CODES.SCHOOL_NOT_ACTIVE, '该学校暂未开放');
    }

    const previousVersion = normalizeSchoolVersion(existing.schoolVersion);
    const hasPreviousSelection = Boolean(normalizeText(existing.schoolId));
    if (hasPreviousSelection) {
      assertSchoolChangeAllowed(existing, now);
    }
    const updateData = {
      schoolId: requestedSchoolId,
      schoolName: normalizeText(selectedSchool.name),
      schoolSelectedAt: existing.schoolSelectedAt || db.serverDate(),
      schoolUpdatedAt: db.serverDate(),
      schoolVersion: hasPreviousSelection
        ? Math.max(previousVersion, 1) + 1
        : 1,
      updatedAt: db.serverDate()
    };
    if (hasPreviousSelection) {
      updateData.schoolChangedAt = now;
    }
    await userDocument.update({
      data: updateData
    });
    return {
      record: {
        ...existing,
        ...updateData,
        schoolSelectedAt: existing.schoolSelectedAt || now,
        schoolUpdatedAt: now,
        schoolChangedAt: hasPreviousSelection
          ? now
          : existing.schoolChangedAt,
        updatedAt: now
      },
      schoolState: {
        schoolId: requestedSchoolId,
        schoolName: updateData.schoolName,
        schoolRequired: false,
        schoolUnavailable: false
      }
    };
  });

  return success(toSafeUser(result.record, result.schoolState));
}

async function updateSchool(identity, input) {
  const requestedSchoolId = normalizeSchoolId(input && input.schoolId);
  if (!requestedSchoolId) {
    businessError(ERROR_CODES.INVALID_SCHOOL_ID, '请选择有效的学校');
  }

  const userId = createUserId(identity.appId, identity.openId);
  const now = new Date();
  const result = await runTransaction(async (transaction) => {
    const userDocument = transaction.collection('users').doc(userId);
    const existing = await getDocumentOrNull(userDocument);
    if (!existing) {
      businessError(ERROR_CODES.USER_NOT_FOUND, '当前微信身份尚未登录');
    }
    assertExistingUser(existing, identity);
    const schoolCollection = transaction.collection('schools');
    const existingState = await resolveSchoolState(existing, schoolCollection);
    if (existingState.schoolRequired) {
      businessError(
        normalizeText(existing.schoolId)
          ? ERROR_CODES.SCHOOL_UNAVAILABLE
          : ERROR_CODES.SCHOOL_REQUIRED,
        normalizeText(existing.schoolId)
          ? '当前学校暂不可用，请先重新选择'
          : '请先完成学校选择'
      );
    }
    if (existingState.schoolId === requestedSchoolId) {
      logSchoolChange('unchanged', ERROR_CODES.SCHOOL_UNCHANGED);
      return {
        record: existing,
        schoolState: existingState,
        unchanged: true
      };
    }

    const selectedSchool = await findSchool(
      requestedSchoolId,
      schoolCollection
    );
    if (!selectedSchool) {
      businessError(ERROR_CODES.SCHOOL_NOT_FOUND, '学校信息不存在');
    }
    if (!isSchoolActive(selectedSchool)) {
      businessError(ERROR_CODES.SCHOOL_NOT_ACTIVE, '该学校暂未开放');
    }
    assertSchoolChangeAllowed(existing, now);

    const updateData = {
      schoolId: requestedSchoolId,
      schoolName: normalizeText(selectedSchool.name),
      schoolSelectedAt: existing.schoolSelectedAt || db.serverDate(),
      schoolUpdatedAt: db.serverDate(),
      schoolChangedAt: now,
      schoolVersion: Math.max(normalizeSchoolVersion(existing.schoolVersion), 1) + 1,
      updatedAt: db.serverDate()
    };
    await userDocument.update({
      data: updateData
    });

    return {
      record: {
        ...existing,
        ...updateData,
        schoolSelectedAt: existing.schoolSelectedAt || now,
        schoolUpdatedAt: now,
        schoolChangedAt: now,
        updatedAt: now
      },
      schoolState: {
        schoolId: requestedSchoolId,
        schoolName: updateData.schoolName,
        schoolRequired: false,
        schoolUnavailable: false
      },
      unchanged: false
    };
  });

  if (!result.unchanged) {
    logSchoolChange('success');
  }
  return success(toSafeUser(result.record, result.schoolState), {
    schoolChange: {
      changed: !result.unchanged,
      reason: result.unchanged ? 'unchanged' : 'updated'
    }
  });
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
  const allowedActions = [
    'loginIdentity',
    'login',
    'current',
    'updateProfile',
    'selectSchool',
    'updateSchool'
  ];

  if (!allowedActions.includes(action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的认证操作');
  }

  const identity = getIdentity();
  if (!identity) {
    return failure(ERROR_CODES.AUTH_FAILED, '无法确认当前微信身份');
  }

  try {
    if (action === 'loginIdentity') {
      return await loginIdentity(identity);
    }
    if (action === 'login') {
      return await login(identity, data.profile);
    }
    if (action === 'updateProfile') {
      return await updateProfile(identity, data.profile);
    }
    if (action === 'selectSchool') {
      return await selectSchool(identity, data);
    }
    if (action === 'updateSchool') {
      return await updateSchool(identity, data);
    }
    return await current(identity);
  } catch (error) {
    if (error && error.businessCode) {
      if (action === 'updateSchool') {
        logSchoolChange('rejected', error.businessCode);
      }
      return failure(
        error.businessCode,
        error.message,
        error.businessData || null
      );
    }
    const classifiedCode = classifyFailure(error);
    const code = action === 'updateSchool'
      ? ERROR_CODES.SCHOOL_UPDATE_FAILED
      : classifiedCode;
    return failure(
      code,
      classifiedCode === ERROR_CODES.DATABASE_ERROR
        ? '认证数据暂不可用，请稍后重试'
        : '认证服务暂不可用，请稍后重试'
    );
  }
};

exports.__test = Object.freeze({
  SCHOOL_CHANGE_COOLDOWN_MS,
  getSchoolChangePolicy,
  assertSchoolChangeAllowed,
  assertExistingUser,
  normalizeSchoolVersion,
  toIsoString
});
