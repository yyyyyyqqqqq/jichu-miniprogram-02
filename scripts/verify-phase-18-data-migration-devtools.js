const fs = require('fs');
const {
  PRIVATE_CANARY_PATH,
  loadJson,
  maskId,
  assert,
  writePrivateJson
} = require('./phase-18-canary-core');
const { PRIVATE_RESULT_PATH } = require('./phase-18-data-migration-core');

const MODULE = process.env.PHASE18_CANARY_AUTOMATOR_MODULE;
const ENDPOINT = process.env.PHASE18_CANARY_AUTOMATOR_WS_ENDPOINT;

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

async function waitForPath(miniProgram, suffix, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const page = await miniProgram.currentPage();
    if (page && String(page.path || '').endsWith(suffix)) return page;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`page did not reach ${suffix}`);
}

async function waitForData(miniProgram, predicate, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await miniProgram.evaluate(function readCurrentData() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return page ? page.data : null;
    });
    if (data && predicate(data)) return data;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('page data did not settle');
}

async function run() {
  assert(MODULE && ENDPOINT, 'developer-tools automation settings are required');
  assert(fs.existsSync(PRIVATE_RESULT_PATH), 'private migration result is missing');
  assert(fs.existsSync(PRIVATE_CANARY_PATH), 'private canary result is missing');
  const migration = loadJson(PRIVATE_RESULT_PATH);
  const canary = loadJson(PRIVATE_CANARY_PATH);
  const expectedProductIds = new Set(migration.products.candidates.map((item) => item.productId));
  assert(expectedProductIds.size === 20, 'private migration product count is not 20');
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
    const callCloud = async (name, data) => payload(await withTimeout(
      miniProgram.evaluate(async function invoke(functionName, request) {
        return wx.cloud.callFunction({ name: functionName, data: request });
      }, name, data),
      `${name}:${data.action || ''}`
    ));
    const list = (data) => callCloud('productQuery', { action: 'list', data });
    const current = await callCloud('authUser', { action: 'current', data: {} });
    assert(current.success === true, 'current user request failed');
    assert(current.data.user.id === canary.userId, 'unexpected DevTools user');
    assert(current.data.user.schoolId === migration.targetSchool.id, 'DevTools user is not at the migration target school');

    const allProducts = [];
    let cursor = '';
    do {
      const page = await list({ sortBy: 'default', categoryId: 'all', pageSize: 20, cursor });
      assert(page.success === true && page.data.marketMode === 'schoolScoped', 'strict list failed');
      assert(page.data.scope.schoolId === migration.targetSchool.id, 'strict scope is not the target school');
      assert((page.data.list || []).every((item) => item.schoolId === migration.targetSchool.id), 'strict list contains another school');
      allProducts.push(...page.data.list);
      cursor = page.data.hasMore ? page.data.nextCursor : '';
    } while (cursor);
    const seenIds = new Set(allProducts.map((item) => item._id));
    expectedProductIds.forEach((id) => assert(seenIds.has(id), 'migrated product is missing from target strict market'));
    assert(allProducts.length >= 20 && seenIds.size === allProducts.length, 'target market contains duplicate or missing migrated products');

    for (const sortBy of ['default', 'newest', 'priceAsc', 'priceDesc']) {
      const result = await list({ sortBy, categoryId: 'all', pageSize: 6 });
      assert(result.success === true && result.data.marketMode === 'schoolScoped', `${sortBy} first page failed`);
      assert((result.data.list || []).every((item) => item.schoolId === migration.targetSchool.id), `${sortBy} leaked another school`);
    }
    const sample = allProducts.find((item) => expectedProductIds.has(item._id));
    assert(sample, 'no migrated sample is available');
    const detail = await callCloud('productQuery', { action: 'detail', data: { productId: sample._id } });
    assert(detail.success === true && detail.data.product.schoolId === migration.targetSchool.id, 'migrated product detail failed');
    const category = await list({ sortBy: 'default', categoryId: sample.categoryId, pageSize: 6 });
    assert(category.success === true && category.data.marketMode === 'schoolScoped', 'category strict query failed');
    const search = await list({ sortBy: 'default', categoryId: 'all', keyword: sample.title, pageSize: 6 });
    assert(search.success === true && search.data.list.some((item) => item._id === sample._id), 'migrated product search failed');

    const mine = await callCloud('productQuery', {
      action: 'myProducts',
      data: { status: ['available', 'reserved', 'offline'], page: 1, pageSize: 20 }
    });
    assert(mine.success === true, 'myProducts smoke failed');
    const crossSchoolOffline = mine.data.list.find((item) => (
      item.status === 'offline'
      && item.schoolId
      && item.schoolId !== migration.targetSchool.id
    ));
    assert(crossSchoolOffline, 'no cross-school offline product is available for relist verification');
    const rejectedRelist = await callCloud('manageProduct', {
      action: 'relist',
      productId: crossSchoolOffline._id
    });
    assert(rejectedRelist.success === false && rejectedRelist.code === 'PRODUCT_SCHOOL_MISMATCH', 'real cross-school relist was not rejected');
    const mineAfter = await callCloud('productQuery', {
      action: 'myProducts',
      data: { status: 'offline', page: 1, pageSize: 20 }
    });
    const unchanged = mineAfter.data.list.find((item) => item._id === crossSchoolOffline._id);
    assert(unchanged && unchanged.status === 'offline' && unchanged.schoolId === crossSchoolOffline.schoolId, 'rejected relist changed the product');

    await miniProgram.switchTab('/pages/home/index');
    await waitForPath(miniProgram, 'pages/home/index');
    const home = await waitForData(miniProgram, (data) => (
      data.isLoading === false
      && data.marketMode === 'schoolScoped'
      && data.marketScope && data.marketScope.schoolId === migration.targetSchool.id
    ));
    assert((home.products || []).every((item) => item.schoolId === migration.targetSchool.id), 'home contains another school');
    await miniProgram.switchTab('/pages/profile/index');
    await waitForPath(miniProgram, 'pages/profile/index');
    await withTimeout(miniProgram.evaluate(async function openSchoolChange() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      await page.changeSchool();
      return true;
    }), 'open school change');
    await waitForPath(miniProgram, 'pages/school-select/index');
    const schoolPage = await waitForData(miniProgram, (data) => data.viewState === 'success' && data.isSubmitting === false);
    assert(schoolPage.currentSchoolId === migration.targetSchool.id, 'school change page current school is wrong');
    await miniProgram.navigateBack();
    await miniProgram.reLaunch('/pages/home/index');
    await waitForPath(miniProgram, 'pages/home/index');
    const restarted = await waitForData(miniProgram, (data) => data.isLoading === false && data.marketMode === 'schoolScoped');
    assert(restarted.marketScope.schoolId === migration.targetSchool.id, 'restart did not restore target strict scope');
    assert(consoleErrors === 0 && exceptions === 0, 'DevTools recorded console errors or exceptions');

    const verification = {
      completedAt: new Date().toISOString(),
      userId: canary.userId,
      targetSchoolId: migration.targetSchool.id,
      targetSchoolName: migration.targetSchool.name,
      publicProductsSeen: allProducts.length,
      migratedProductsSeen: 20,
      sortsVerified: ['default', 'newest', 'priceAsc', 'priceDesc'],
      loadMoreVerified: true,
      categoryVerified: true,
      searchVerified: true,
      detailVerified: true,
      myProductsVerified: true,
      schoolChangeEntryVerified: true,
      restartVerified: true,
      crossSchoolRelistRejected: true,
      crossSchoolProductUnchanged: true,
      consoleErrors,
      exceptions
    };
    writePrivateJson(PRIVATE_RESULT_PATH, { ...migration, devtoolsVerification: verification });
    return {
      passed: true,
      userId: maskId(canary.userId),
      targetSchoolId: maskId(migration.targetSchool.id),
      publicProductsSeen: allProducts.length,
      migratedProductsSeen: 20,
      sortsVerified: verification.sortsVerified,
      categoryVerified: true,
      searchVerified: true,
      detailVerified: true,
      myProductsVerified: true,
      schoolChangeEntryVerified: true,
      restartVerified: true,
      crossSchoolRelistRejected: true,
      consoleErrors,
      exceptions
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE18_DATA_MIGRATION_DEVTOOLS_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
