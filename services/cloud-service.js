const { CLOUD_CONFIG } = require('../config/cloud');

let cloudInitPromise = null;
let cloudReady = false;
let lastInitError = null;

class CloudServiceError extends Error {
  constructor(code, message, cause) {
    super(message || code);
    this.name = 'CloudServiceError';
    this.code = code;
    this.cause = cause || null;
    this.errCode = cause && (cause.errCode || cause.code)
      ? cause.errCode || cause.code
      : code;
    this.errMsg = cause && (cause.errMsg || cause.message)
      ? cause.errMsg || cause.message
      : this.message;
  }
}

function createCloudError(code, message, cause) {
  return new CloudServiceError(code, message, cause);
}

function getErrorText(error) {
  return [
    error && error.errCode,
    error && error.code,
    error && error.errMsg,
    error && error.message
  ].filter(Boolean).join(' ').toLowerCase();
}

function classifyCallError(error) {
  if (error instanceof CloudServiceError) {
    return error;
  }
  const text = getErrorText(error);
  if (text.includes('timeout') || text.includes('timed out')) {
    return createCloudError(
      'CLOUD_TIMEOUT',
      'Cloud function call timed out',
      error
    );
  }
  if (
    text.includes('function not found')
    || text.includes('functionname parameter could not be found')
    || /function[^]*?(?:not exist|does not exist)/.test(text)
    || text.includes('云函数不存在')
  ) {
    return createCloudError(
      'FUNCTION_NOT_FOUND',
      'Cloud function does not exist',
      error
    );
  }
  if (
    text.includes('network')
    || text.includes('request:fail')
    || text.includes('socket')
    || text.includes('connection')
  ) {
    return createCloudError(
      'NETWORK_ERROR',
      'Network request failed',
      error
    );
  }
  return createCloudError(
    'CLOUD_CALL_FAILED',
    'Cloud function call failed',
    error
  );
}

function ensureCloudReady() {
  if (cloudReady) {
    return Promise.resolve();
  }
  if (cloudInitPromise) {
    return cloudInitPromise;
  }

  cloudInitPromise = Promise.resolve()
    .then(() => {
      if (
        typeof wx === 'undefined'
        || !wx.cloud
        || typeof wx.cloud.init !== 'function'
      ) {
        throw createCloudError(
          'CLOUD_UNAVAILABLE',
          'Cloud capability unavailable'
        );
      }

      try {
        wx.cloud.init({
          env: CLOUD_CONFIG.environmentId,
          traceUser: true
        });
      } catch (error) {
        throw createCloudError(
          'CLOUD_INIT_FAILED',
          'Cloud initialization failed',
          error
        );
      }

      cloudReady = true;
      lastInitError = null;
    })
    .catch((error) => {
      cloudReady = false;
      lastInitError = error;
      cloudInitPromise = null;
      throw error;
    });

  return cloudInitPromise;
}

function isCloudReady() {
  return cloudReady;
}

function getCloudState() {
  return {
    ready: cloudReady,
    initializing: Boolean(cloudInitPromise && !cloudReady),
    lastErrorCode: lastInitError && lastInitError.code
      ? lastInitError.code
      : ''
  };
}

async function callFunction(options = {}) {
  await ensureCloudReady();
  if (
    typeof wx.cloud.callFunction !== 'function'
    || typeof options.name !== 'string'
    || !options.name
  ) {
    throw createCloudError(
      'CLOUD_UNAVAILABLE',
      'Cloud function capability unavailable'
    );
  }

  let timeoutId;
  const request = new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: options.name,
      data: options.data || {},
      success: resolve,
      fail: reject
    });
  });
  const timeoutMs = Number(options.timeoutMs);
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createCloudError(
        'CLOUD_TIMEOUT',
        'Cloud function call timed out'
      ));
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000);
  });

  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    throw classifyCallError(error);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

module.exports = {
  CloudServiceError,
  ensureCloudReady,
  isCloudReady,
  getCloudState,
  classifyCallError,
  callFunction
};
