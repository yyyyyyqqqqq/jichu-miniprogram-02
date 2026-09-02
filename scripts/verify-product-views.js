const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

function missingDocumentError(id) {
  const error = new Error(`document.get:fail document with _id ${id} does not exist`);
  error.errCode = -1;
  return error;
}

function createDatabaseHarness(initialProducts) {
  const products = new Map(
    initialProducts.map((product) => [product._id, Object.assign({}, product)])
  );
  const views = new Map();
  const users = new Map();
  let transactionQueue = Promise.resolve();

  function resolveValue(value) {
    if (value && typeof value === 'object' && value.$serverDate === true) {
      return new Date(Date.now());
    }
    return value;
  }

  function getCollectionMap(name) {
    if (name === 'products') {
      return products;
    }
    if (name === 'productViews') {
      return views;
    }
    if (name === 'users') {
      return users;
    }
    throw new Error(`unexpected product view collection ${name}`);
  }

  function createDocument(name, id) {
    const collection = getCollectionMap(name);
    return {
      async get() {
        if (!collection.has(id)) {
          throw missingDocumentError(id);
        }
        return {
          data: Object.assign({}, collection.get(id))
        };
      },
      async set({ data }) {
        const stored = { _id: id };
        Object.entries(data || {}).forEach(([key, value]) => {
          stored[key] = resolveValue(value);
        });
        collection.set(id, stored);
      },
      async update({ data }) {
        if (!collection.has(id)) {
          throw missingDocumentError(id);
        }
        const stored = Object.assign({}, collection.get(id));
        Object.entries(data || {}).forEach(([key, value]) => {
          if (value && typeof value === 'object' && Number.isFinite(value.$inc)) {
            stored[key] = Number(stored[key] || 0) + value.$inc;
          } else {
            stored[key] = resolveValue(value);
          }
        });
        collection.set(id, stored);
      }
    };
  }

  const transaction = {
    collection(name) {
      return {
        doc(id) {
          return createDocument(name, id);
        }
      };
    }
  };

  const command = {
    inc(value) {
      return { $inc: Number(value) };
    }
  };

  const database = {
    command,
    collection(name) {
      return {
        doc(id) {
          return createDocument(name, id);
        }
      };
    },
    serverDate() {
      return { $serverDate: true };
    },
    runTransaction(callback) {
      const execution = transactionQueue.then(
        () => callback(transaction)
      ).then((result) => ({ result }));
      transactionQueue = execution.then(
        () => undefined,
        () => undefined
      );
      return execution;
    }
  };

  return {
    database,
    products,
    views,
    users
  };
}

async function verifyProductViewService(projectRoot) {
  const servicePath = path.join(projectRoot, 'services/product-view-service');
  const cloudServicePath = path.join(projectRoot, 'services/cloud-service');
  const CloudService = require(cloudServicePath);
  const originalEnsureCloudReady = CloudService.ensureCloudReady;
  const originalWx = global.wx;
  const requests = [];

  CloudService.ensureCloudReady = async () => {};
  global.wx = {
    cloud: {
      callFunction({ name, data, success }) {
        requests.push({ name, data });
        success({
          result: {
            success: true,
            data: {
              counted: true,
              reason: 'COUNTED',
              currentViewCount: 12
            }
          }
        });
      }
    },
    getAccountInfoSync() {
      return {
        miniProgram: {
          envVersion: 'release'
        }
      };
    }
  };

  try {
    delete require.cache[require.resolve(servicePath)];
    const ProductViewService = require(servicePath);
    const result = await ProductViewService.recordProductView('product-service');
    assert.strictEqual(result.counted, true);
    assert.strictEqual(result.currentViewCount, 12);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].name, 'productViewAction');
    assert.strictEqual(requests[0].data.action, 'recordView');
    assert.deepStrictEqual(requests[0].data.data, {
      productId: 'product-service'
    });
    assert(
      !/openid|viewer|viewcount/i.test(JSON.stringify(requests[0].data.data)),
      'product view service sent a protected identity or counter field'
    );

    global.wx.cloud.callFunction = ({ fail }) => {
      fail({ errMsg: 'request:fail network' });
    };
    const degraded = await ProductViewService.recordProductView('product-service');
    assert.deepStrictEqual(degraded, {
      counted: false,
      reason: 'VIEW_RECORD_FAILED',
      currentViewCount: 0
    });
  } finally {
    CloudService.ensureCloudReady = originalEnsureCloudReady;
    delete require.cache[require.resolve(servicePath)];
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyProductViewFlow(projectRoot) {
  const functionPath = path.join(
    projectRoot,
    'cloudfunctions/productViewAction/index.js'
  );
  const originalLoad = Module._load;
  const originalDateNow = Date.now;
  const harness = createDatabaseHarness([
    {
      _id: 'product-countable',
      sellerOpenid: 'owner-openid',
      status: 'available',
      viewCount: 0
    },
    {
      _id: 'product-concurrent',
      sellerOpenid: 'owner-openid',
      status: 'reserved',
      viewCount: 0
    },
    {
      _id: 'product-hidden',
      sellerOpenid: 'owner-openid',
      status: 'deleted',
      viewCount: 7
    }
  ]);
  let currentOpenId = 'buyer-a-openid';
  const appId = 'product-view-verification-app';
  [
    'buyer-a-openid',
    'buyer-b-openid',
    'owner-openid',
    'buyer-c-openid',
    'buyer-concurrent-openid'
  ].forEach((openId) => {
    const userId = `u_${crypto
      .createHash('sha256')
      .update(`${appId}:${openId}`)
      .digest('hex')
      .slice(0, 32)}`;
    harness.users.set(userId, {
      _id: userId,
      openid: openId,
      status: 'active'
    });
  });
  let nowMs = Date.parse('2026-07-26T08:00:00.000Z');

  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() {
      return harness.database;
    },
    getWXContext() {
      return {
        OPENID: currentOpenId,
        APPID: appId
      };
    }
  };

  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  Date.now = () => nowMs;

  try {
    delete require.cache[require.resolve(functionPath)];
    const ProductViewAction = require(functionPath);
    const callRecordView = (productId) => ProductViewAction.main({
      action: 'recordView',
      data: { productId }
    });

    assert.strictEqual(
      ProductViewAction._test.VIEW_WINDOW_MS,
      24 * 60 * 60 * 1000
    );
    assert(
      ProductViewAction._test.isWithinViewWindow(
        new Date(nowMs - ProductViewAction._test.VIEW_WINDOW_MS + 1),
        nowMs
      )
    );
    assert(
      !ProductViewAction._test.isWithinViewWindow(
        new Date(nowMs - ProductViewAction._test.VIEW_WINDOW_MS),
        nowMs
      )
    );

    const first = await callRecordView('product-countable');
    assert.strictEqual(first.success, true);
    assert.deepStrictEqual(first.data, {
      counted: true,
      reason: 'COUNTED',
      currentViewCount: 1
    });
    assert.strictEqual(harness.products.get('product-countable').viewCount, 1);
    assert.strictEqual(harness.views.size, 1);

    const storedView = [...harness.views.values()][0];
    assert.strictEqual(storedView.productId, 'product-countable');
    assert.strictEqual(storedView.viewerOpenid, 'buyer-a-openid');
    assert(storedView.lastCountedAt instanceof Date);
    assert(storedView.nextEligibleAt instanceof Date);
    assert(storedView.cleanupAfter instanceof Date);
    assert.strictEqual(
      storedView.nextEligibleAt.getTime() - storedView.lastCountedAt.getTime(),
      ProductViewAction._test.VIEW_WINDOW_MS
    );
    assert.strictEqual(
      storedView.cleanupAfter.getTime() - storedView.lastCountedAt.getTime(),
      ProductViewAction._test.VIEW_RECORD_RETENTION_MS
    );

    const duplicate = await callRecordView('product-countable');
    assert.strictEqual(duplicate.data.counted, false);
    assert.strictEqual(duplicate.data.reason, 'DUPLICATE_VIEW');
    assert.strictEqual(harness.products.get('product-countable').viewCount, 1);
    assert.strictEqual(harness.views.size, 1);

    nowMs += ProductViewAction._test.VIEW_WINDOW_MS;
    const afterWindow = await callRecordView('product-countable');
    assert.strictEqual(afterWindow.data.counted, true);
    assert.strictEqual(afterWindow.data.currentViewCount, 2);
    assert.strictEqual(harness.products.get('product-countable').viewCount, 2);
    assert.strictEqual(harness.views.size, 1);

    currentOpenId = 'buyer-b-openid';
    const otherBuyer = await callRecordView('product-countable');
    assert.strictEqual(otherBuyer.data.counted, true);
    assert.strictEqual(otherBuyer.data.currentViewCount, 3);
    assert.strictEqual(harness.views.size, 2);

    currentOpenId = 'owner-openid';
    const ownerView = await callRecordView('product-countable');
    assert.strictEqual(ownerView.data.counted, false);
    assert.strictEqual(ownerView.data.reason, 'OWNER_VIEW');
    assert.strictEqual(harness.products.get('product-countable').viewCount, 3);
    assert.strictEqual(harness.views.size, 2);

    currentOpenId = 'buyer-c-openid';
    const missing = await callRecordView('missing-product');
    assert.strictEqual(missing.data.counted, false);
    assert.strictEqual(missing.data.reason, 'PRODUCT_NOT_FOUND');
    assert.strictEqual(harness.views.size, 2);

    const hidden = await callRecordView('product-hidden');
    assert.strictEqual(hidden.data.counted, false);
    assert.strictEqual(hidden.data.reason, 'PRODUCT_NOT_VIEWABLE');
    assert.strictEqual(harness.products.get('product-hidden').viewCount, 7);

    const invalid = await callRecordView('../invalid');
    assert.strictEqual(invalid.success, false);
    assert.strictEqual(invalid.code, 'INVALID_PARAMS');
    assert.strictEqual(harness.views.size, 2);

    currentOpenId = '';
    const unauthorized = await callRecordView('product-countable');
    assert.strictEqual(unauthorized.success, false);
    assert.strictEqual(unauthorized.code, 'UNAUTHORIZED');

    currentOpenId = 'buyer-concurrent-openid';
    const concurrentResults = await Promise.all(
      Array.from({ length: 8 }, () => callRecordView('product-concurrent'))
    );
    assert.strictEqual(
      concurrentResults.filter((result) => result.data.counted).length,
      1
    );
    assert.strictEqual(harness.products.get('product-concurrent').viewCount, 1);
    assert.strictEqual(
      [...harness.views.values()].filter(
        (view) => view.productId === 'product-concurrent'
      ).length,
      1
    );

    const invalidAction = await ProductViewAction.main({
      action: 'setViewCount',
      data: {
        productId: 'product-countable',
        viewCount: 999
      }
    });
    assert.strictEqual(invalidAction.success, false);
    assert.strictEqual(invalidAction.code, 'INVALID_ACTION');
    assert.strictEqual(harness.products.get('product-countable').viewCount, 3);

    const viewIds = [...harness.views.keys()];
    assert(viewIds.every((id) => /^pv_[a-f0-9]{48}$/.test(id)));
    assert(
      viewIds.every((id) => !id.includes('openid') && !id.includes('product')),
      'product view document id exposes raw identity or product fields'
    );
  } finally {
    Date.now = originalDateNow;
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }

  await verifyProductViewService(projectRoot);
  return true;
}

module.exports = {
  verifyProductViewFlow
};
