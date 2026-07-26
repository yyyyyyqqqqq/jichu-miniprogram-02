const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const command = db.command;
const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const VIEW_RECORD_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const COUNTABLE_STATUSES = new Set(['available', 'reserved', 'sold']);

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

const VIEW_REASONS = {
  COUNTED: 'COUNTED',
  DUPLICATE_VIEW: 'DUPLICATE_VIEW',
  OWNER_VIEW: 'OWNER_VIEW',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_NOT_VIEWABLE: 'PRODUCT_NOT_VIEWABLE'
};

function success(data) {
  return {
    success: true,
    data,
    code: ERROR_CODES.OK,
    message: ''
  };
}

function failure(code, message) {
  return {
    success: false,
    data: null,
    code,
    message
  };
}

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

function createViewId(productId, openId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${productId}:${openId}`)
    .digest('hex')
    .slice(0, 48);
  return `pv_${digest}`;
}

function toTimestamp(value) {
  if (!value) {
    return NaN;
  }
  let candidate = value;
  if (typeof value.toDate === 'function') {
    candidate = value.toDate();
  } else if (
    typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, '$date')
  ) {
    candidate = value.$date;
  }
  const timestamp = candidate instanceof Date
    ? candidate.getTime()
    : new Date(candidate).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function isWithinViewWindow(lastCountedAt, nowMs) {
  const lastTimestamp = toTimestamp(lastCountedAt);
  if (!Number.isFinite(lastTimestamp)) {
    return false;
  }
  return nowMs - lastTimestamp < VIEW_WINDOW_MS;
}

function extractRecord(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  if (Array.isArray(result.data)) {
    return result.data[0] || null;
  }
  return result.data && typeof result.data === 'object'
    ? result.data
    : null;
}

function isMissingDocumentError(error) {
  const code = error && (error.errCode || error.code);
  const message = error && error.message
    ? String(error.message).toLowerCase()
    : '';
  return code === 'DATABASE_DOCUMENT_NOT_EXIST'
    || code === -1 && (
      message.includes('document with _id')
      && message.includes('does not exist')
    )
    || message.includes('document does not exist');
}

async function getDocumentOrNull(document) {
  try {
    return extractRecord(await document.get());
  } catch (error) {
    if (isMissingDocumentError(error)) {
      return null;
    }
    throw error;
  }
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

async function recordView(data, openId) {
  const productId = normalizeProductId(data.productId);
  if (!productId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }

  const nowMs = Date.now();
  const viewId = createViewId(productId, openId);
  const result = await runTransaction(async (transaction) => {
    const productDocument = transaction.collection('products').doc(productId);
    const product = await getDocumentOrNull(productDocument);
    if (!product) {
      return {
        counted: false,
        reason: VIEW_REASONS.PRODUCT_NOT_FOUND,
        currentViewCount: 0
      };
    }

    const currentViewCount = normalizeCount(product.viewCount);
    if (!COUNTABLE_STATUSES.has(product.status)) {
      return {
        counted: false,
        reason: VIEW_REASONS.PRODUCT_NOT_VIEWABLE,
        currentViewCount
      };
    }
    if (product.sellerOpenid === openId) {
      return {
        counted: false,
        reason: VIEW_REASONS.OWNER_VIEW,
        currentViewCount
      };
    }

    const viewDocument = transaction.collection('productViews').doc(viewId);
    const existing = await getDocumentOrNull(viewDocument);
    if (existing && isWithinViewWindow(existing.lastCountedAt, nowMs)) {
      return {
        counted: false,
        reason: VIEW_REASONS.DUPLICATE_VIEW,
        currentViewCount
      };
    }

    const timestampFields = {
      productId,
      viewerOpenid: openId,
      lastCountedAt: db.serverDate(),
      nextEligibleAt: new Date(nowMs + VIEW_WINDOW_MS),
      cleanupAfter: new Date(nowMs + VIEW_RECORD_RETENTION_MS),
      updatedAt: db.serverDate()
    };
    if (existing) {
      await viewDocument.update({ data: timestampFields });
    } else {
      await viewDocument.set({
        data: Object.assign({}, timestampFields, {
          createdAt: db.serverDate()
        })
      });
    }
    await productDocument.update({
      data: {
        viewCount: command.inc(1),
        updatedAt: db.serverDate()
      }
    });

    return {
      counted: true,
      reason: VIEW_REASONS.COUNTED,
      currentViewCount: currentViewCount + 1
    };
  });

  return success(result);
}

exports.main = async (event = {}) => {
  const request = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const action = typeof request.action === 'string'
    ? request.action.trim()
    : '';
  const data = request.data
    && typeof request.data === 'object'
    && !Array.isArray(request.data)
    ? request.data
    : {};

  if (action !== 'recordView') {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的浏览记录操作');
  }

  const context = cloud.getWXContext();
  const openId = context && typeof context.OPENID === 'string'
    ? context.OPENID.trim()
    : '';
  if (!openId) {
    return failure(ERROR_CODES.UNAUTHORIZED, '登录状态已失效，请重新登录');
  }

  try {
    return await recordView(data, openId);
  } catch (error) {
    console.error('[productViewAction] request failed', {
      action,
      code: error && (error.errCode || error.code || '')
    });
    const code = error && (error.errCode || error.code || '');
    const message = error && error.message
      ? String(error.message).toLowerCase()
      : '';
    const isDatabaseError = Boolean(
      error && error.errCode
      || String(code).toLowerCase().includes('database')
      || message.includes('database')
      || message.includes('collection')
      || message.includes('transaction')
    );
    return failure(
      isDatabaseError ? ERROR_CODES.DATABASE_ERROR : ERROR_CODES.INTERNAL_ERROR,
      isDatabaseError
        ? '浏览记录暂不可用'
        : '浏览服务暂不可用'
    );
  }
};

exports._test = {
  VIEW_WINDOW_MS,
  VIEW_RECORD_RETENTION_MS,
  createViewId,
  isWithinViewWindow,
  normalizeProductId
};
