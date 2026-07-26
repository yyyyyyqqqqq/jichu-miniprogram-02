const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');

const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function normalizeProductId(value) {
  const productId = value === null || value === undefined
    ? ''
    : String(value).trim();
  return PRODUCT_ID_PATTERN.test(productId) ? productId : '';
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function isDevelopmentEnvironment() {
  if (
    typeof wx === 'undefined'
    || typeof wx.getAccountInfoSync !== 'function'
  ) {
    return false;
  }
  try {
    const account = wx.getAccountInfoSync();
    return Boolean(
      account
      && account.miniProgram
      && account.miniProgram.envVersion === 'develop'
    );
  } catch (error) {
    return false;
  }
}

function logFailure(error) {
  if (!isDevelopmentEnvironment()) {
    return;
  }
  console.info('[product-view] record failed', {
    code: error && error.code ? String(error.code).slice(0, 64) : 'UNKNOWN_ERROR'
  });
}

async function recordProductView(productId) {
  const id = normalizeProductId(productId);
  if (!id) {
    return {
      counted: false,
      reason: 'INVALID_PARAMS',
      currentViewCount: 0
    };
  }

  try {
    await CloudService.ensureCloudReady();
    if (
      typeof wx === 'undefined'
      || !wx.cloud
      || typeof wx.cloud.callFunction !== 'function'
    ) {
      throw new Error('cloud function unavailable');
    }

    let timeoutId;
    const request = new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: CLOUD_CONFIG.productViewFunctionName,
        data: {
          action: 'recordView',
          data: { productId: id }
        },
        success: resolve,
        fail: reject
      });
    });
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('product view timeout')),
        CLOUD_CONFIG.productViewTimeoutMs
      );
    });

    const response = await Promise.race([request, timeout])
      .finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      });
    const payload = response && response.result;
    if (!payload || payload.success !== true || !payload.data) {
      const error = new Error('product view rejected');
      error.code = payload && payload.code ? payload.code : 'INVALID_RESPONSE';
      throw error;
    }

    return {
      counted: payload.data.counted === true,
      reason: typeof payload.data.reason === 'string'
        ? payload.data.reason
        : '',
      currentViewCount: normalizeCount(payload.data.currentViewCount)
    };
  } catch (error) {
    logFailure(error);
    return {
      counted: false,
      reason: 'VIEW_RECORD_FAILED',
      currentViewCount: 0
    };
  }
}

module.exports = {
  recordProductView,
  normalizeProductId
};
