const AuthService = require('../services/auth-service');
const { CLOUD_CONFIG } = require('../config/cloud');
const { AUTH_TARGETS } = require('../constants/routes');
const { buildUserPresentation } = require('../utils/user-presentation');

const AUTH_STATUS = {
  IDLE: 'idle',
  RESTORING: 'restoring',
  ANONYMOUS: 'anonymous',
  AUTHENTICATED: 'authenticated',
  ERROR: 'error'
};

const LOGIN_STAGE = {
  NONE: 'none',
  IDENTITY_PENDING: 'identityPending',
  PROFILE_CONFIRM_REQUIRED: 'profileConfirmRequired',
  SCHOOL_SELECTION_REQUIRED: 'schoolSelectionRequired',
  READY: 'ready'
};

const VALID_LOGIN_TARGETS = new Set(Object.values(AUTH_TARGETS));
const SAFE_CONTEXT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,96}$/;

const state = {
  status: AUTH_STATUS.IDLE,
  user: null,
  error: null,
  initialized: false,
  restoring: false,
  loggingIn: false,
  updatingProfile: false,
  selectingSchool: false,
  updatingSchool: false,
  explicitLogout: false,
  loginStage: LOGIN_STAGE.NONE,
  loginContext: null
};

const listeners = new Set();
let bootstrapPromise = null;
let loginPromise = null;
let profilePromise = null;
let schoolPromise = null;
let operationVersion = 0;

function cloneUser(user) {
  return user ? { ...user } : null;
}

function getState() {
  return {
    ...state,
    user: cloneUser(state.user),
    error: state.error ? { ...state.error } : null,
    loginContext: state.loginContext ? { ...state.loginContext } : null
  };
}

function normalizeLoginContext(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const target = VALID_LOGIN_TARGETS.has(source.target)
    ? source.target
    : AUTH_TARGETS.PROFILE;
  const context = { target };
  ['productId', 'conversationId', 'appointmentId', 'publicUserId'].forEach((key) => {
    const normalized = source[key] === null || source[key] === undefined
      ? ''
      : String(source[key]).trim();
    if (SAFE_CONTEXT_ID_PATTERN.test(normalized)) {
      context[key] = normalized;
    }
  });
  return context;
}

function normalizeLoginTransaction(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (![
    LOGIN_STAGE.PROFILE_CONFIRM_REQUIRED,
    LOGIN_STAGE.SCHOOL_SELECTION_REQUIRED,
    LOGIN_STAGE.READY
  ].includes(value.stage)) {
    return null;
  }
  const userId = typeof value.userId === 'string' ? value.userId.trim() : '';
  if (!/^u_[a-f0-9]{32}$/.test(userId)) {
    return null;
  }
  return {
    stage: value.stage,
    userId,
    context: normalizeLoginContext(value.context)
  };
}

function notify() {
  const snapshot = getState();
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      // 页面订阅异常不能破坏认证状态机。
    }
  });
}

function setState(patch) {
  Object.assign(state, patch);
  notify();
}

function subscribe(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }

  listeners.add(listener);
  listener(getState());
  return () => {
    listeners.delete(listener);
  };
}

function toCachedUser(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const rawNickname = typeof value.nickname === 'string'
    ? value.nickname.trim()
    : '';
  const nickname = rawNickname === '微信用户' ? '' : rawNickname;
  const presentation = buildUserPresentation({
    nickname,
    avatarUrl: value.avatarUrl
  });
  const schoolVersion = Number(value.schoolVersion);
  const schoolChangeRemainingMs = Number(value.schoolChangeRemainingMs);

  if (!id) {
    return null;
  }

  return {
    id,
    nickname,
    displayNickname: presentation.nickname,
    avatarUrl: presentation.avatarUrl,
    avatarText: presentation.avatarText,
    campus: typeof value.campus === 'string' ? value.campus : '',
    bio: '',
    role: 'user',
    status: 'active',
    profileCompleted: value.profileCompleted === true,
    schoolId: typeof value.schoolId === 'string' ? value.schoolId.trim() : '',
    schoolName: typeof value.schoolName === 'string'
      ? value.schoolName.trim()
      : '',
    schoolSelectedAt: typeof value.schoolSelectedAt === 'string'
      ? value.schoolSelectedAt
      : '',
    schoolUpdatedAt: typeof value.schoolUpdatedAt === 'string'
      ? value.schoolUpdatedAt
      : '',
    schoolChangedAt: typeof value.schoolChangedAt === 'string'
      ? value.schoolChangedAt
      : '',
    schoolVersion: Number.isInteger(schoolVersion) && schoolVersion > 0
      ? schoolVersion
      : 0,
    canChangeSchool: value.canChangeSchool !== false,
    nextSchoolChangeAllowedAt: typeof value.nextSchoolChangeAllowedAt === 'string'
      ? value.nextSchoolChangeAllowedAt
      : '',
    schoolChangeRemainingMs: Number.isFinite(schoolChangeRemainingMs)
      && schoolChangeRemainingMs > 0
      ? Math.floor(schoolChangeRemainingMs)
      : 0,
    schoolRequired: value.schoolRequired !== false,
    schoolUnavailable: value.schoolUnavailable === true,
    createdAt: '',
    updatedAt: '',
    lastLoginAt: ''
  };
}

function readCachedUser() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') {
    return null;
  }

  try {
    const raw = wx.getStorageSync(CLOUD_CONFIG.userCacheKey);
    if (!raw) {
      return null;
    }
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const user = toCachedUser(value);
    if (!user) {
      wx.removeStorageSync(CLOUD_CONFIG.userCacheKey);
    }
    return user;
  } catch (error) {
    wx.removeStorageSync(CLOUD_CONFIG.userCacheKey);
    return null;
  }
}

function writeCachedUser(user) {
  if (
    typeof wx === 'undefined'
    || typeof wx.setStorageSync !== 'function'
    || !user
  ) {
    return;
  }

  wx.setStorageSync(CLOUD_CONFIG.userCacheKey, {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    campus: user.campus,
    profileCompleted: user.profileCompleted === true,
    schoolId: user.schoolId || '',
    schoolName: user.schoolName || '',
    schoolSelectedAt: user.schoolSelectedAt || '',
    schoolUpdatedAt: user.schoolUpdatedAt || '',
    schoolChangedAt: user.schoolChangedAt || '',
    schoolVersion: user.schoolVersion || 0,
    canChangeSchool: user.canChangeSchool !== false,
    nextSchoolChangeAllowedAt: user.nextSchoolChangeAllowedAt || '',
    schoolChangeRemainingMs: user.schoolChangeRemainingMs || 0,
    schoolRequired: user.schoolRequired !== false,
    schoolUnavailable: user.schoolUnavailable === true
  });
}

function clearCachedUser() {
  if (typeof wx !== 'undefined' && typeof wx.removeStorageSync === 'function') {
    wx.removeStorageSync(CLOUD_CONFIG.userCacheKey);
  }
}

function readExplicitLogout() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') {
    return false;
  }
  try {
    return wx.getStorageSync(CLOUD_CONFIG.explicitLogoutKey) === true;
  } catch (error) {
    return false;
  }
}

function writeExplicitLogout() {
  if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
    wx.setStorageSync(CLOUD_CONFIG.explicitLogoutKey, true);
  }
}

function clearExplicitLogout() {
  if (typeof wx !== 'undefined' && typeof wx.removeStorageSync === 'function') {
    wx.removeStorageSync(CLOUD_CONFIG.explicitLogoutKey);
  }
}

function readLoginTransaction() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') {
    return null;
  }
  try {
    const transaction = normalizeLoginTransaction(
      wx.getStorageSync(CLOUD_CONFIG.loginTransactionKey)
    );
    if (!transaction) {
      wx.removeStorageSync(CLOUD_CONFIG.loginTransactionKey);
    }
    return transaction;
  } catch (error) {
    wx.removeStorageSync(CLOUD_CONFIG.loginTransactionKey);
    return null;
  }
}

function writeLoginTransaction(stage, user, context) {
  if (
    typeof wx === 'undefined'
    || typeof wx.setStorageSync !== 'function'
    || !user
    || !/^u_[a-f0-9]{32}$/.test(String(user.id || ''))
  ) {
    return;
  }
  wx.setStorageSync(CLOUD_CONFIG.loginTransactionKey, {
    stage,
    userId: user.id,
    context: normalizeLoginContext(context)
  });
}

function clearLoginTransaction() {
  if (typeof wx !== 'undefined' && typeof wx.removeStorageSync === 'function') {
    wx.removeStorageSync(CLOUD_CONFIG.loginTransactionKey);
  }
}

function setLoginStage(stage, user, context) {
  const normalizedContext = normalizeLoginContext(context || state.loginContext);
  if (stage === LOGIN_STAGE.NONE) {
    clearLoginTransaction();
    setState({
      loginStage: LOGIN_STAGE.NONE,
      loginContext: null
    });
    return;
  }
  if (stage !== LOGIN_STAGE.IDENTITY_PENDING) {
    writeLoginTransaction(stage, user || state.user, normalizedContext);
  }
  setState({
    loginStage: stage,
    loginContext: normalizedContext
  });
}

function normalizeError(error) {
  return {
    code: error && error.code ? error.code : 'UNKNOWN_ERROR',
    message: error && error.message
      ? error.message
      : '登录状态校验失败，请重试',
    details: error && error.details && typeof error.details === 'object'
      ? { ...error.details }
      : null
  };
}

function bootstrap(options = {}) {
  const force = options.force === true;

  if (bootstrapPromise) {
    return bootstrapPromise;
  }
  if (state.initialized && !force) {
    return Promise.resolve(getState());
  }

  if (readExplicitLogout()) {
    operationVersion += 1;
    clearCachedUser();
    clearLoginTransaction();
    setState({
      status: AUTH_STATUS.ANONYMOUS,
      user: null,
      error: null,
      initialized: true,
      restoring: false,
      loggingIn: false,
      updatingProfile: false,
      selectingSchool: false,
      updatingSchool: false,
      explicitLogout: true,
      loginStage: LOGIN_STAGE.NONE,
      loginContext: null
    });
    return Promise.resolve(getState());
  }

  // 只有已经由服务端确认过的内存会话，才允许在前台刷新期间继续作为
  // authenticated 展示。冷启动缓存仍必须经过 current 校验，显式退出
  // 则在上面的分支立即清空，不能借此恢复旧账号摘要。
  const preservesTrustedSession = Boolean(
    force
    && state.status === AUTH_STATUS.AUTHENTICATED
    && state.user
    && state.explicitLogout !== true
  );
  const persistedTransaction = readLoginTransaction();
  const cachedUser = preservesTrustedSession
    ? cloneUser(state.user)
    : readCachedUser();
  const version = operationVersion + 1;
  operationVersion = version;

  setState({
    status: preservesTrustedSession
      ? AUTH_STATUS.AUTHENTICATED
      : AUTH_STATUS.RESTORING,
    user: cachedUser,
    error: null,
    initialized: preservesTrustedSession ? true : false,
    restoring: true,
    loginStage: preservesTrustedSession
      ? state.loginStage
      : (persistedTransaction ? persistedTransaction.stage : LOGIN_STAGE.NONE),
    loginContext: preservesTrustedSession
      ? state.loginContext
      : (persistedTransaction ? persistedTransaction.context : null)
  });

  const operation = (async () => {
    try {
      const user = await AuthService.getCurrentUser();
      if (version !== operationVersion) {
        return getState();
      }

      if (user) {
        const transaction = persistedTransaction || (
          state.loginStage !== LOGIN_STAGE.NONE
            ? {
              stage: state.loginStage,
              userId: state.user && state.user.id,
              context: state.loginContext
            }
            : null
        );
        const keepsTransaction = Boolean(
          transaction
          && transaction.userId === user.id
          && transaction.stage !== LOGIN_STAGE.IDENTITY_PENDING
        );
        if (!keepsTransaction) {
          clearLoginTransaction();
        }
        writeCachedUser(user);
        setState({
          status: AUTH_STATUS.AUTHENTICATED,
          user,
          error: null,
          loginStage: keepsTransaction
            ? transaction.stage
            : LOGIN_STAGE.NONE,
          loginContext: keepsTransaction
            ? normalizeLoginContext(transaction.context)
            : null
        });
      } else {
        clearCachedUser();
        clearLoginTransaction();
        setState({
          status: AUTH_STATUS.ANONYMOUS,
          user: null,
          error: null,
          loginStage: LOGIN_STAGE.NONE,
          loginContext: null
        });
      }
    } catch (error) {
      if (version === operationVersion) {
        const normalizedError = normalizeError(error);
        if (normalizedError.code === 'USER_DISABLED') {
          clearCachedUser();
          clearLoginTransaction();
        }
        setState({
          status: normalizedError.code === 'USER_DISABLED'
            ? AUTH_STATUS.ERROR
            : (preservesTrustedSession
              ? AUTH_STATUS.AUTHENTICATED
              : AUTH_STATUS.ERROR),
          user: normalizedError.code === 'USER_DISABLED' ? null : cachedUser,
          error: normalizedError,
          loginStage: normalizedError.code === 'USER_DISABLED'
            ? LOGIN_STAGE.NONE
            : state.loginStage,
          loginContext: normalizedError.code === 'USER_DISABLED'
            ? null
            : state.loginContext
        });
      }
    } finally {
      if (version === operationVersion) {
        setState({
          initialized: true,
          restoring: false
        });
      }
    }

    return getState();
  })();

  bootstrapPromise = operation;
  operation.finally(() => {
    if (bootstrapPromise === operation) {
      bootstrapPromise = null;
    }
  });

  return operation;
}

function login(profile) {
  if (loginPromise) {
    return loginPromise;
  }

  const version = operationVersion + 1;
  operationVersion = version;
  setState({
    error: null,
    restoring: false,
    loggingIn: true
  });

  const operation = (async () => {
    try {
      const user = await AuthService.login(profile);
      if (version !== operationVersion) {
        return getState();
      }

      writeCachedUser(user);
      clearExplicitLogout();
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true,
        explicitLogout: false
      });
      return getState();
    } catch (error) {
      if (version === operationVersion) {
        clearCachedUser();
        setState({
          status: AUTH_STATUS.ERROR,
          user: null,
          error: normalizeError(error),
          initialized: true
        });
      }
      throw error;
    } finally {
      if (version === operationVersion) {
        setState({ loggingIn: false });
      }
    }
  })();

  loginPromise = operation;
  operation.finally(() => {
    if (loginPromise === operation) {
      loginPromise = null;
    }
  }).catch(() => {});

  return operation;
}

function loginCurrentIdentity() {
  if (loginPromise) {
    return loginPromise;
  }

  const version = operationVersion + 1;
  operationVersion = version;
  setState({
    error: null,
    restoring: false,
    loggingIn: true
  });

  const operation = (async () => {
    try {
      const user = await AuthService.getCurrentUser();
      if (version !== operationVersion) {
        return getState();
      }
      if (!user) {
        clearCachedUser();
        setState({
          status: AUTH_STATUS.ANONYMOUS,
          user: null,
          error: null,
          initialized: true,
          explicitLogout: readExplicitLogout()
        });
        return getState();
      }

      clearExplicitLogout();
      writeCachedUser(user);
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true,
        explicitLogout: false
      });
      return getState();
    } catch (error) {
      if (version === operationVersion) {
        clearCachedUser();
        setState({
          status: AUTH_STATUS.ERROR,
          user: null,
          error: normalizeError(error),
          initialized: true,
          explicitLogout: readExplicitLogout()
        });
      }
      throw error;
    } finally {
      if (version === operationVersion) {
        setState({ loggingIn: false });
      }
    }
  })();

  loginPromise = operation;
  operation.finally(() => {
    if (loginPromise === operation) {
      loginPromise = null;
    }
  }).catch(() => {});
  return operation;
}

function loginIdentity(context = {}) {
  if (loginPromise) {
    return loginPromise;
  }

  const loginContext = normalizeLoginContext(context);
  const version = operationVersion + 1;
  operationVersion = version;
  setState({
    error: null,
    restoring: false,
    loggingIn: true,
    loginStage: LOGIN_STAGE.IDENTITY_PENDING,
    loginContext
  });

  const operation = (async () => {
    try {
      const user = await AuthService.loginIdentity();
      if (version !== operationVersion) {
        return getState();
      }
      clearExplicitLogout();
      writeCachedUser(user);
      writeLoginTransaction(
        LOGIN_STAGE.PROFILE_CONFIRM_REQUIRED,
        user,
        loginContext
      );
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true,
        explicitLogout: false,
        loginStage: LOGIN_STAGE.PROFILE_CONFIRM_REQUIRED,
        loginContext
      });
      return getState();
    } catch (error) {
      if (version === operationVersion) {
        clearCachedUser();
        clearLoginTransaction();
        setState({
          status: AUTH_STATUS.ERROR,
          user: null,
          error: normalizeError(error),
          initialized: true,
          explicitLogout: readExplicitLogout(),
          loginStage: LOGIN_STAGE.NONE,
          loginContext: null
        });
      }
      throw error;
    } finally {
      if (version === operationVersion) {
        setState({ loggingIn: false });
      }
    }
  })();

  loginPromise = operation;
  operation.finally(() => {
    if (loginPromise === operation) {
      loginPromise = null;
    }
  }).catch(() => {});
  return operation;
}

function updateProfile(profile, options = {}) {
  if (profilePromise) {
    return profilePromise;
  }

  const confirmsLogin = options.confirmsLogin === true;
  const version = operationVersion + 1;
  operationVersion = version;
  setState({
    error: null,
    updatingProfile: true
  });

  const operation = (async () => {
    try {
      const user = await AuthService.updateProfile(profile);
      if (version !== operationVersion) {
        return getState();
      }
      writeCachedUser(user);
      const nextLoginStage = confirmsLogin
        ? (
          user.schoolRequired === false
          && user.schoolUnavailable !== true
          && Boolean(user.schoolId)
            ? LOGIN_STAGE.READY
            : LOGIN_STAGE.SCHOOL_SELECTION_REQUIRED
        )
        : state.loginStage;
      if (confirmsLogin) {
        writeLoginTransaction(nextLoginStage, user, state.loginContext);
      }
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true,
        loginStage: nextLoginStage
      });
      return getState();
    } catch (error) {
      if (version === operationVersion) {
        const normalizedError = normalizeError(error);
        if (normalizedError.code === 'USER_DISABLED') {
          clearCachedUser();
        }
        setState({
          status: normalizedError.code === 'USER_DISABLED'
            ? AUTH_STATUS.ERROR
            : state.status,
          user: normalizedError.code === 'USER_DISABLED' ? null : state.user,
          error: normalizedError,
          initialized: true
        });
      }
      throw error;
    } finally {
      if (version === operationVersion) {
        setState({ updatingProfile: false });
      }
    }
  })();

  profilePromise = operation;
  operation.finally(() => {
    if (profilePromise === operation) {
      profilePromise = null;
    }
  }).catch(() => {});

  return operation;
}

function confirmLoginProfile(profile) {
  if (state.loginStage !== LOGIN_STAGE.PROFILE_CONFIRM_REQUIRED) {
    return Promise.reject(new Error('当前登录流程不需要确认资料'));
  }
  return updateProfile(profile, { confirmsLogin: true });
}

function refreshCurrentUser() {
  return bootstrap({ force: true });
}

function selectSchool(schoolId) {
  if (schoolPromise) {
    return schoolPromise;
  }

  const version = operationVersion + 1;
  operationVersion = version;
  setState({
    error: null,
    selectingSchool: true
  });

  const operation = (async () => {
    try {
      const user = await AuthService.selectSchool(schoolId);
      if (version !== operationVersion) {
        return getState();
      }
      writeCachedUser(user);
      const completesLoginSchoolStep = state.loginStage
        === LOGIN_STAGE.SCHOOL_SELECTION_REQUIRED;
      if (completesLoginSchoolStep) {
        writeLoginTransaction(LOGIN_STAGE.READY, user, state.loginContext);
      }
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true,
        loginStage: completesLoginSchoolStep
          ? LOGIN_STAGE.READY
          : state.loginStage
      });
      return getState();
    } catch (error) {
      if (version === operationVersion) {
        const normalizedError = normalizeError(error);
        setState({
          error: normalizedError,
          initialized: true
        });
      }
      throw error;
    } finally {
      if (version === operationVersion) {
        setState({ selectingSchool: false });
      }
    }
  })();

  schoolPromise = operation;
  operation.finally(() => {
    if (schoolPromise === operation) {
      schoolPromise = null;
    }
  }).catch(() => {});

  return operation;
}

function updateSchool(schoolId) {
  if (schoolPromise) {
    return schoolPromise;
  }

  const version = operationVersion + 1;
  operationVersion = version;
  setState({
    error: null,
    updatingSchool: true
  });

  const operation = (async () => {
    try {
      const user = await AuthService.updateSchool(schoolId);
      if (version !== operationVersion) {
        return getState();
      }
      writeCachedUser(user);
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true
      });
      return getState();
    } catch (error) {
      if (version === operationVersion) {
        setState({
          error: normalizeError(error),
          initialized: true
        });
      }
      throw error;
    } finally {
      if (version === operationVersion) {
        setState({ updatingSchool: false });
      }
    }
  })();

  schoolPromise = operation;
  operation.finally(() => {
    if (schoolPromise === operation) {
      schoolPromise = null;
    }
  }).catch(() => {});

  return operation;
}

function clearSession() {
  operationVersion += 1;
  bootstrapPromise = null;
  loginPromise = null;
  profilePromise = null;
  schoolPromise = null;
  clearCachedUser();
  clearLoginTransaction();
  setState({
    status: AUTH_STATUS.ANONYMOUS,
    user: null,
    error: null,
    initialized: true,
    restoring: false,
    loggingIn: false,
    updatingProfile: false,
    selectingSchool: false,
    updatingSchool: false,
    explicitLogout: readExplicitLogout(),
    loginStage: LOGIN_STAGE.NONE,
    loginContext: null
  });
}

function logout() {
  writeExplicitLogout();
  clearSession();
  setState({ explicitLogout: true });
}

function hasExplicitLogout() {
  return state.explicitLogout === true || readExplicitLogout();
}

function isProfileConfirmationRequired() {
  return state.loginStage === LOGIN_STAGE.PROFILE_CONFIRM_REQUIRED;
}

function isExplicitLoginInProgress() {
  return state.loginStage !== LOGIN_STAGE.NONE;
}

function getLoginContext() {
  return state.loginContext ? { ...state.loginContext } : null;
}

function completeExplicitLogin() {
  if (state.loginStage !== LOGIN_STAGE.READY) {
    return false;
  }
  setLoginStage(LOGIN_STAGE.NONE);
  return true;
}

function getCurrentUser() {
  return cloneUser(state.user);
}

function isLoggedIn() {
  return state.status === AUTH_STATUS.AUTHENTICATED
    && Boolean(state.user);
}

function isSchoolReady() {
  return isLoggedIn()
    && state.user.schoolRequired === false
    && state.user.schoolUnavailable !== true
    && Boolean(state.user.schoolId);
}

module.exports = {
  AUTH_STATUS,
  LOGIN_STAGE,
  bootstrap,
  loginIdentity,
  login,
  loginCurrentIdentity,
  updateProfile,
  confirmLoginProfile,
  selectSchool,
  updateSchool,
  logout,
  clearSession,
  hasExplicitLogout,
  refreshCurrentUser,
  getState,
  getCurrentUser,
  isLoggedIn,
  isSchoolReady,
  isProfileConfirmationRequired,
  isExplicitLoginInProgress,
  getLoginContext,
  completeExplicitLogin,
  subscribe
};
