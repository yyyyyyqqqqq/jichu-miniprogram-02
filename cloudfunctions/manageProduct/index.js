const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const products = db.collection('products');

const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ACTIONS = {
  TAKE_OFFLINE: 'takeOffline',
  RELIST: 'relist',
  MARK_SOLD: 'markSold'
};
const TRANSITIONS = {
  [ACTIONS.TAKE_OFFLINE]: {
    from: 'available',
    to: 'offline',
    marker: 'offlineAt'
  },
  [ACTIONS.RELIST]: {
    from: 'offline',
    to: 'available',
    marker: 'relistedAt'
  },
  [ACTIONS.MARK_SOLD]: {
    from: 'available',
    to: 'sold',
    marker: 'soldAt'
  }
};

const ERROR_CODES = {
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_FORBIDDEN: 'PRODUCT_FORBIDDEN',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function success(productId, status, reused) {
  return {
    success: true,
    code: ERROR_CODES.OK,
    message: '',
    data: {
      productId,
      status,
      reused: reused === true
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

function normalizeProductId(value) {
  const productId = value === null || value === undefined
    ? ''
    : String(value).trim();
  return PRODUCT_ID_PATTERN.test(productId) ? productId : '';
}

function getOpenId() {
  const context = cloud.getWXContext();
  return context && typeof context.OPENID === 'string'
    ? context.OPENID
    : '';
}

async function findProduct(productId) {
  const result = await products.where({
    _id: productId
  }).limit(1).get();
  return result.data && result.data.length > 0 ? result.data[0] : null;
}

function isIdempotentResult(product, transition) {
  return product.status === transition.to && Boolean(product[transition.marker]);
}

function buildUpdateData(action) {
  const currentTime = db.serverDate();
  const data = {
    status: TRANSITIONS[action].to,
    updatedAt: currentTime
  };

  if (action === ACTIONS.TAKE_OFFLINE) {
    data.offlineAt = currentTime;
  } else if (action === ACTIONS.RELIST) {
    data.offlineAt = null;
    data.relistedAt = currentTime;
  } else if (action === ACTIONS.MARK_SOLD) {
    data.soldAt = currentTime;
  }

  return data;
}

async function performTransition(productId, openId, action) {
  const transition = TRANSITIONS[action];
  const product = await findProduct(productId);

  if (!product) {
    return failure(ERROR_CODES.PRODUCT_NOT_FOUND, '商品不存在');
  }
  if (product.sellerOpenid !== openId) {
    return failure(ERROR_CODES.PRODUCT_FORBIDDEN, '无权管理该商品');
  }
  if (isIdempotentResult(product, transition)) {
    return success(productId, transition.to, true);
  }
  if (product.status !== transition.from) {
    return failure(
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      '当前商品状态不支持此操作'
    );
  }

  const updateResult = await products.where({
    _id: productId,
    sellerOpenid: openId,
    status: transition.from
  }).update({
    data: buildUpdateData(action)
  });
  const updatedCount = updateResult
    && updateResult.stats
    && Number(updateResult.stats.updated) || 0;

  if (updatedCount > 0) {
    return success(productId, transition.to, false);
  }

  const latest = await findProduct(productId);
  if (!latest) {
    return failure(ERROR_CODES.PRODUCT_NOT_FOUND, '商品不存在');
  }
  if (latest.sellerOpenid !== openId) {
    return failure(ERROR_CODES.PRODUCT_FORBIDDEN, '无权管理该商品');
  }
  if (isIdempotentResult(latest, transition)) {
    return success(productId, transition.to, true);
  }
  return failure(
    ERROR_CODES.INVALID_STATUS_TRANSITION,
    '商品状态已发生变化，请刷新后重试'
  );
}

exports.main = async (event = {}) => {
  const request = event && typeof event === 'object' && !Array.isArray(event)
    ? event
    : {};
  const action = typeof request.action === 'string'
    ? request.action.trim()
    : '';
  const productId = normalizeProductId(request.productId);

  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, action)) {
    return failure(ERROR_CODES.INVALID_ACTION, '不支持的商品管理操作');
  }
  if (!productId) {
    return failure(ERROR_CODES.INVALID_PARAMS, '缺少有效商品 ID');
  }

  const openId = getOpenId();
  if (!openId) {
    return failure(ERROR_CODES.UNAUTHORIZED, '登录状态已失效，请重新登录');
  }

  try {
    return await performTransition(productId, openId, action);
  } catch (error) {
    console.error('[manageProduct] request failed', {
      action,
      code: error && (error.errCode || error.code || '')
    });
    const errorCode = error && (error.errCode || error.code || '');
    const errorMessage = error && error.message
      ? String(error.message).toLowerCase()
      : '';
    const isDatabaseError = Boolean(
      error && error.errCode
      || String(errorCode).toLowerCase().includes('database')
      || errorMessage.includes('database')
      || errorMessage.includes('collection')
    );
    return failure(
      isDatabaseError ? ERROR_CODES.DATABASE_ERROR : ERROR_CODES.INTERNAL_ERROR,
      isDatabaseError
        ? '商品状态更新失败，请稍后重试'
        : '商品管理服务暂不可用'
    );
  }
};
