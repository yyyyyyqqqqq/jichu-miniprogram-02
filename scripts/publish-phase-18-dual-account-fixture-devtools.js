const fs = require('fs');
const path = require('path');
const {
  loadEnvironmentId,
  queryCollection
} = require('./phase-18-canary-core');
const {
  FINAL_FIXTURE_PREFIX,
  loadDualAccountPrivate,
  maskId,
  assert,
  writePrivateJson,
  PRIVATE_DUAL_ACCOUNT_PATH
} = require('./phase-18-dual-account-core');

const MODULE = process.env.PHASE18_DUAL_AUTOMATOR_MODULE;
const ENDPOINT = process.env.PHASE18_DUAL_AUTOMATOR_WS_ENDPOINT;
const TITLE = `${FINAL_FIXTURE_PREFIX}A`;
const REQUEST_ID = 'phase18_dual_final_a_20260807';

function withTimeout(promise, label, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function payload(response) {
  const value = response && response.result;
  assert(value && typeof value.success === 'boolean', 'invalid cloud response');
  return value;
}

async function run() {
  assert(MODULE && fs.existsSync(MODULE) && ENDPOINT, 'developer-tools automation settings are required');
  const privateData = loadDualAccountPrivate();
  const MiniProgram = require(path.join(MODULE, 'out', 'MiniProgram')).default;
  const originalCheckVersion = MiniProgram.prototype.checkVersion;
  MiniProgram.prototype.checkVersion = async function skipBrokenVersionProbe() {};
  const automator = require(MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = await withTimeout(automator.connect({ wsEndpoint: ENDPOINT }), 'automation connection');
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });
    const callCloud = async (name, data) => payload(await withTimeout(miniProgram.evaluate(
      async function invoke(functionName, functionData) {
        return wx.cloud.callFunction({ name: functionName, data: functionData });
      }, name, data
    ), `${name} cloud call`));

    const current = await callCloud('authUser', { action: 'current', data: {} });
    assert(current.success === true && current.data.user.id === privateData.accountA.userId, 'current identity is not account A');
    assert(current.data.user.schoolId === privateData.accountA.schoolId, 'account A school is stale');
    const mine = await callCloud('productQuery', {
      action: 'myProducts',
      data: { status: ['available', 'offline'], page: 1, pageSize: 20 }
    });
    assert(mine.success === true && mine.data && Array.isArray(mine.data.list), 'account A products are unavailable');
    let editable;
    for (const candidate of mine.data.list) {
      const response = await callCloud('manageProduct', {
        action: 'getEditableProduct',
        productId: candidate._id
      });
      if (
        response.success === true
        && response.data
        && response.data.product
        && Array.isArray(response.data.product.images)
        && response.data.product.images.length > 0
        && response.data.product.location
        && response.data.product.locationDetail
      ) {
        editable = response.data.product;
        break;
      }
    }
    assert(editable, 'no reusable account A media/location source was found');
    const created = await callCloud('createProduct', {
      requestId: REQUEST_ID,
      product: {
        title: TITLE,
        description: '阶段18双账号跨校隔离最终验收商品A。',
        price: 18,
        categoryId: 'books',
        categoryName: '客户端伪造分类',
        condition: editable.condition,
        location: editable.location,
        locationDetail: editable.locationDetail,
        images: editable.images,
        video: editable.video || null,
        schoolId: privateData.accountB.schoolId,
        schoolName: privateData.accountB.schoolName,
        sellerId: privateData.accountB.userId,
        status: 'sold'
      }
    });
    assert(created.success === true && created.data && created.data.productId, 'account A real createProduct failed');
    assert(created.data.schoolId === privateData.accountA.schoolId, 'forged account B school overrode account A authority');
    assert(created.data.schoolName === privateData.accountA.schoolName, 'account A authoritative school name is missing');
    const detail = await callCloud('productQuery', {
      action: 'detail',
      data: { productId: created.data.productId }
    });
    assert(detail.success === true && detail.data.product.title === TITLE, 'account A fixture detail failed');
    assert(detail.data.product.schoolId === privateData.accountA.schoolId, 'account A fixture detail school is wrong');
    assert(detail.data.product.sellerPublicUserId === privateData.accountA.userId, 'forged seller overrode account A authority');
    const candidateEvidence = loadDualAccountPrivate();
    candidateEvidence.fixtureACandidate = {
      createResponse: created.data,
      detailProduct: detail.data.product,
      capturedAt: new Date().toISOString()
    };
    writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, candidateEvidence);

    const rows = queryCollection(loadEnvironmentId(), 'products', {
      filter: { _id: created.data.productId },
      projection: {
        _id: 1, title: 1, description: 1, price: 1, categoryId: 1, condition: 1,
        location: 1, locationDetail: 1, images: 1, video: 1, status: 1, version: 1,
        schoolId: 1, schoolName: 1, sellerId: 1, sellerName: 1
      },
      limit: 2
    });
    assert(
      rows.length === 1 && rows[0].status === 'available',
      `account A fixture is not available (id=${maskId(created.data.productId)}, rows=${rows.length}, status=${rows[0] && rows[0].status || 'missing'})`
    );
    assert(rows[0].schoolId === privateData.accountA.schoolId && rows[0].sellerId === privateData.accountA.userId, 'account A fixture authority is wrong');
    const updated = loadDualAccountPrivate();
    updated.fixtureAId = rows[0]._id;
    updated.fixtureAInitial = rows[0];
    updated.fixtureAPublishedAt = new Date().toISOString();
    writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, updated);
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');
    return {
      passed: true,
      fixture: TITLE,
      productId: maskId(rows[0]._id),
      userId: maskId(privateData.accountA.userId),
      schoolId: maskId(rows[0].schoolId),
      schoolName: rows[0].schoolName,
      status: rows[0].status,
      clientForgedSchoolIgnored: true,
      clientForgedSellerIgnored: true,
      consoleErrors,
      exceptions
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
    MiniProgram.prototype.checkVersion = originalCheckVersion;
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE18_DUAL_ACCOUNT_PUBLISH_A_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
});
