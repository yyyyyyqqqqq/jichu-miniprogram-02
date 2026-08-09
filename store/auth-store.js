const AuthService = require('../services/auth-service');
const { CLOUD_CONFIG } = require('../config/cloud');

const AUTH_STATUS = {
  IDLE: 'idle',
  RESTORING: 'restoring',
  ANONYMOUS: 'anonymous',
  AUTHENTICATED: 'authenticated',
  ERROR: 'error'
};

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
  explicitLogout: false
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
    error: state.error ? { ...state.error } : null
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
  const schoolVersion = Number(value.schoolVersion);
  const schoolChangeRemainingMs = Number(value.schoolChangeRemainingMs);

  if (!id) {
    return null;
  }

  return {
    id,
    nickname,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : '',
    avatarText: nickname.slice(0, 1) || '即',
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
      explicitLogout: true
    });
    return Promise.resolve(getState());
  }

  const cachedUser = readCachedUser();
  const version = operationVersion + 1;
  operationVersion = version;

  setState({
    status: AUTH_STATUS.RESTORING,
    user: cachedUser,
    error: null,
    initialized: false,
    restoring: true
  });

  const operation = (async () => {
    try {
      const user = await AuthService.getCurrentUser();
      if (version !== operationVersion) {
        return getState();
      }

      if (user) {
        writeCachedUser(user);
        setState({
          status: AUTH_STATUS.AUTHENTICATED,
          user,
          error: null
        });
      } else {
        clearCachedUser();
        setState({
          status: AUTH_STATUS.ANONYMOUS,
          user: null,
          error: null
        });
      }
    } catch (error) {
      if (version === operationVersion) {
        const normalizedError = normalizeError(error);
        if (normalizedError.code === 'USER_DISABLED') {
          clearCachedUser();
        }
        setState({
          status: AUTH_STATUS.ERROR,
          user: normalizedError.code === 'USER_DISABLED' ? null : cachedUser,
          error: normalizedError
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

function updateProfile(profile) {
  if (profilePromise) {
    return profilePromise;
  }

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
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true
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
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true
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
    explicitLogout: readExplicitLogout()
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

function getCurrentUser() {
  return cloneUser(state.user);
}

function isLoggedIn() {
  return state.status === AUTH_STATUS.AUTHENTICATED
    && Boolean(state.user)
    && state.user.profileCompleted === true;
}

function isSchoolReady() {
  return isLoggedIn()
    && state.user.schoolRequired === false
    && state.user.schoolUnavailable !== true
    && Boolean(state.user.schoolId);
}

module.exports = {
  AUTH_STATUS,
  bootstrap,
  login,
  loginCurrentIdentity,
  updateProfile,
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
  subscribe
};
