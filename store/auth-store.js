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
  updatingProfile: false
};

const listeners = new Set();
let bootstrapPromise = null;
let loginPromise = null;
let profilePromise = null;
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
    profileCompleted: user.profileCompleted === true
  });
}

function clearCachedUser() {
  if (typeof wx !== 'undefined' && typeof wx.removeStorageSync === 'function') {
    wx.removeStorageSync(CLOUD_CONFIG.userCacheKey);
  }
}

function normalizeError(error) {
  return {
    code: error && error.code ? error.code : 'UNKNOWN_ERROR',
    message: error && error.message
      ? error.message
      : '登录状态校验失败，请重试'
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
      setState({
        status: AUTH_STATUS.AUTHENTICATED,
        user,
        error: null,
        initialized: true
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

function logout() {
  operationVersion += 1;
  clearCachedUser();
  setState({
    status: AUTH_STATUS.ANONYMOUS,
    user: null,
    error: null,
    initialized: true,
    restoring: false,
    loggingIn: false,
    updatingProfile: false
  });
}

function getCurrentUser() {
  return cloneUser(state.user);
}

function isLoggedIn() {
  return state.status === AUTH_STATUS.AUTHENTICATED
    && Boolean(state.user)
    && state.user.profileCompleted === true;
}

module.exports = {
  AUTH_STATUS,
  bootstrap,
  login,
  updateProfile,
  logout,
  refreshCurrentUser,
  getState,
  getCurrentUser,
  isLoggedIn,
  subscribe
};
