const fs = require('fs');
const path = require('path');
const {
  ROOT,
  PRIVATE_CANARY_PATH,
  loadJson,
  maskId,
  assert,
  writePrivateJson
} = require('./phase-18-canary-core');

const AUTOMATOR_MODULE = process.env.PHASE18_DUAL_AUTOMATOR_MODULE;
const ENDPOINT = process.env.PHASE18_DUAL_AUTOMATOR_WS_ENDPOINT;
const PHASE = process.env.PHASE18_EXPLICIT_LOGOUT_PHASE;
const RESULT_PATH = path.join(ROOT, 'tmp', 'phase-18-explicit-logout-devtools-private.json');

function withTimeout(promise, label, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function waitForPath(miniProgram, suffix, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const page = await withTimeout(miniProgram.currentPage(), 'current page');
    if (page && String(page.path || '').endsWith(suffix)) return page;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`page did not reach ${suffix}`);
}

async function readPageData(miniProgram) {
  return withTimeout(miniProgram.evaluate(function readCurrentPageData() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    return page ? page.data : null;
  }), 'read page data');
}

async function waitForData(miniProgram, predicate, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await readPageData(miniProgram);
    if (data && predicate(data)) return data;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('page data did not settle');
}

async function connect() {
  assert(AUTOMATOR_MODULE && ENDPOINT, 'developer-tools automation settings are required');
  const MiniProgram = require(path.join(AUTOMATOR_MODULE, 'out', 'MiniProgram')).default;
  MiniProgram.prototype.checkVersion = async function skipBrokenVersionProbe() {};
  const automator = require(AUTOMATOR_MODULE);
  return withTimeout(automator.connect({ wsEndpoint: ENDPOINT }), 'automation connection');
}

async function installListCounter(miniProgram) {
  return withTimeout(miniProgram.evaluate(function installCounter() {
    const app = getApp({ allowDefault: true });
    if (!app || !app.globalData) return false;
    app.globalData.phase18ProductListCalls = 0;
    if (!app.globalData.phase18OriginalCloudCall) {
      app.globalData.phase18OriginalCloudCall = wx.cloud.callFunction;
      wx.cloud.callFunction = function countedCloudCall(options) {
        if (
          options
          && options.name === 'productQuery'
          && options.data
          && options.data.action === 'list'
        ) {
          app.globalData.phase18ProductListCalls += 1;
        }
        return app.globalData.phase18OriginalCloudCall.call(wx.cloud, options);
      };
    }
    return true;
  }), 'install list counter');
}

async function readRuntimeState(miniProgram) {
  return withTimeout(miniProgram.evaluate(function readState() {
    const app = getApp({ allowDefault: true });
    const cache = wx.getStorageSync('auth:user-summary');
    return {
      explicitLogout: wx.getStorageSync('auth:explicit-logout') === true,
      cachedUserId: cache && cache.id || '',
      productListCalls: app && app.globalData
        ? Number(app.globalData.phase18ProductListCalls || 0)
        : 0
    };
  }), 'read runtime state');
}

async function runLogoutPhase(miniProgram, primary) {
  await miniProgram.reLaunch('/pages/home/index');
  await waitForPath(miniProgram, 'pages/home/index');
  const initial = await waitForData(miniProgram, (data) => (
    data.isLoading === false
    && data.marketMode === 'schoolScoped'
    && data.marketScope
    && data.marketScope.schoolId
  ));
  assert((initial.products || []).length > 0, 'strict products were not loaded before logout');
  await installListCounter(miniProgram);
  await miniProgram.switchTab('/pages/profile/index');
  await waitForPath(miniProgram, 'pages/profile/index');
  await withTimeout(miniProgram.evaluate(function invokeLogout() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    page.logout();
    return true;
  }), 'invoke logout');
  await miniProgram.native().confirmModal();
  await miniProgram.switchTab('/pages/home/index');
  await waitForPath(miniProgram, 'pages/home/index');
  const anonymous = await waitForData(miniProgram, (data) => (
    data.viewState === 'guide'
    && data.guideType === 'login'
    && data.isLoading === false
  ));
  const runtime = await readRuntimeState(miniProgram);
  assert(runtime.explicitLogout === true, 'explicit logout marker is missing');
  assert(!runtime.cachedUserId, 'cached user survived explicit logout');
  assert(runtime.productListCalls === 0, 'home called productQuery/list after logout');
  assert((anonymous.products || []).length === 0, 'anonymous home retained strict products');
  assert(anonymous.marketMode === '' && anonymous.marketScope.schoolId === '', 'anonymous home retained market scope');
  assert(anonymous.nextCursor === '' && anonymous.queryScopeKey === '', 'anonymous home retained cursor state');
  const result = {
    schemaVersion: 1,
    accountUserId: primary.userId,
    logoutAt: new Date().toISOString(),
    before: {
      marketMode: initial.marketMode,
      schoolId: initial.marketScope.schoolId,
      productsLoaded: initial.products.length
    },
    afterLogout: {
      guideType: anonymous.guideType,
      guideTitle: anonymous.guideTitle,
      products: anonymous.products.length,
      marketMode: anonymous.marketMode,
      schoolId: anonymous.marketScope.schoolId,
      productListCalls: runtime.productListCalls,
      explicitLogout: runtime.explicitLogout,
      cachedUserPresent: Boolean(runtime.cachedUserId)
    }
  };
  writePrivateJson(RESULT_PATH, result);
  return {
    phase: 'logout',
    passed: true,
    userId: maskId(primary.userId),
    strictProductsBefore: initial.products.length,
    productsAfter: 0,
    productListCallsAfterLogout: 0,
    guideTitle: anonymous.guideTitle,
    explicitLogout: true
  };
}

async function runRestartPhase(miniProgram, primary) {
  assert(fs.existsSync(RESULT_PATH), 'logout-phase private result is missing');
  const previous = loadJson(RESULT_PATH);
  assert(previous.accountUserId === primary.userId, 'logout phase belongs to another account');
  await miniProgram.reLaunch('/pages/home/index');
  await waitForPath(miniProgram, 'pages/home/index');
  const anonymous = await waitForData(miniProgram, (data) => (
    data.viewState === 'guide'
    && data.guideType === 'login'
    && data.isLoading === false
  ));
  const beforeLogin = await readRuntimeState(miniProgram);
  assert(beforeLogin.explicitLogout === true, 'restart did not preserve explicit logout');
  assert(!beforeLogin.cachedUserId, 'restart restored a cached user before manual login');
  assert((anonymous.products || []).length === 0 && anonymous.marketMode === '', 'restart exposed market data while anonymous');

  await withTimeout(miniProgram.evaluate(async function openLogin() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    await page.onMarketGuideAction();
    return true;
  }), 'open manual login');
  await waitForPath(miniProgram, 'pages/login/index');
  await withTimeout(miniProgram.evaluate(async function loginExplicitly() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    await page.onLoginTap();
    return true;
  }), 'manual login', 60000);
  await waitForPath(miniProgram, 'pages/home/index', 30000);
  const restored = await waitForData(miniProgram, (data) => (
    data.isLoading === false
    && data.marketMode === 'schoolScoped'
    && data.marketScope
    && data.marketScope.schoolId
  ), 35000);
  const afterLogin = await readRuntimeState(miniProgram);
  assert(afterLogin.explicitLogout === false, 'manual login did not clear explicit logout');
  assert(afterLogin.cachedUserId === primary.userId, 'manual login cached the wrong account');
  assert((restored.products || []).every((item) => item.schoolId === restored.marketScope.schoolId), 'restored strict home contains another school');
  const result = {
    ...previous,
    restartAt: new Date().toISOString(),
    afterRestart: {
      guideType: anonymous.guideType,
      products: anonymous.products.length,
      marketMode: anonymous.marketMode,
      explicitLogout: beforeLogin.explicitLogout,
      cachedUserPresent: Boolean(beforeLogin.cachedUserId)
    },
    afterManualLogin: {
      marketMode: restored.marketMode,
      schoolId: restored.marketScope.schoolId,
      products: restored.products.length,
      explicitLogout: afterLogin.explicitLogout,
      cachedUserId: afterLogin.cachedUserId
    }
  };
  writePrivateJson(RESULT_PATH, result);
  return {
    phase: 'restart',
    passed: true,
    userId: maskId(primary.userId),
    remainedAnonymousAfterRestart: true,
    productsBeforeManualLogin: 0,
    manualLoginClearedMarker: true,
    restoredMarketMode: restored.marketMode,
    restoredSchoolId: maskId(restored.marketScope.schoolId),
    restoredProducts: restored.products.length
  };
}

async function run() {
  assert(['logout', 'restart'].includes(PHASE), 'PHASE18_EXPLICIT_LOGOUT_PHASE must be logout or restart');
  assert(fs.existsSync(PRIVATE_CANARY_PATH), 'private primary canary result is missing');
  const primary = loadJson(PRIVATE_CANARY_PATH);
  let miniProgram;
  try {
    miniProgram = await connect();
    return PHASE === 'logout'
      ? await runLogoutPhase(miniProgram, primary)
      : await runRestartPhase(miniProgram, primary);
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE18_EXPLICIT_LOGOUT_DEVTOOLS_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
});
