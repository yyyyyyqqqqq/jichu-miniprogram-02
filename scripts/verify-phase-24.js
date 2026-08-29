const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;

function check(value, message) {
  assert(value, message);
  checks += 1;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function pageFilesExist(route) {
  return ['js', 'json', 'wxml', 'wxss'].every((extension) => (
    fs.existsSync(path.join(ROOT, `${route}.${extension}`))
  ));
}

function verifyStartupAndRoutes() {
  const appConfig = readJson('app.json');
  const routeSource = read('constants/routes.js');
  const guardSource = read('services/auth-guard.js');
  const navigationSource = read('services/navigation-service.js');
  const projectConfig = readJson('project.config.json');

  check(appConfig.entryPagePath === 'pages/home/index', 'default entry page is not the home page');
  check(appConfig.pages.includes(appConfig.entryPagePath), 'default entry page is not registered');
  check(pageFilesExist(appConfig.entryPagePath), 'default entry page files are incomplete');
  appConfig.pages.forEach((route) => {
    check(pageFilesExist(route), `registered page files are incomplete: ${route}`);
  });
  check(
    appConfig.tabBar.list.every((item) => appConfig.pages.includes(item.pagePath)),
    'a tab page is not registered'
  );
  check(/HOME:\s*['"]\/pages\/home\/index['"]/.test(routeSource), 'home route constant drifted');
  check(/\[AUTH_TARGETS\.HOME\][\s\S]{0,100}method:\s*['"]switchTab['"]/.test(routeSource), 'home target does not use switchTab');
  check(/\[AUTH_TARGETS\.MESSAGES\][\s\S]{0,100}method:\s*['"]switchTab['"]/.test(routeSource), 'messages target does not use switchTab');
  check(/\[AUTH_TARGETS\.PROFILE\][\s\S]{0,100}method:\s*['"]switchTab['"]/.test(routeSource), 'profile target does not use switchTab');
  check(/\[AUTH_TARGETS\.PUBLISH\][\s\S]{0,100}method:\s*['"]redirectTo['"]/.test(routeSource), 'publish target uses an invalid tab navigation method');
  check(/VALID_TARGETS\.has\(value\)/.test(guardSource), 'auth target is not constrained to a whitelist');
  check(/encodeURIComponent\(target\)/.test(guardSource), 'auth target is not encoded safely');
  check(!/safeReLaunch|wx\.reLaunch/.test(navigationSource), 'navigation service added a broad relaunch fallback');
  const compileRoutes = projectConfig.condition.miniprogram.list.map((item) => item.pathName);
  check(compileRoutes.every((route) => appConfig.pages.includes(route)), 'project compile condition points to an unregistered page');
}

function verifyForegroundRefreshOrdering() {
  const appPath = path.join(ROOT, 'app.js');
  const originalLoad = Module._load;
  const originalApp = global.App;
  let definition;
  let refreshStarted = 0;
  let cloudReadyCalls = 0;

  global.App = (value) => { definition = value; };
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (parent && parent.filename === appPath) {
      if (request === './store/app-store') return { initialize() {} };
      if (request === './store/auth-store') {
        return {
          bootstrap: async () => {},
          refreshCurrentUser() {
            refreshStarted += 1;
            return Promise.resolve();
          }
        };
      }
      if (request === './services/cloud-service') {
        return {
          ensureCloudReady() {
            cloudReadyCalls += 1;
            return Promise.resolve();
          }
        };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(appPath)];
    require(appPath);
    check(definition && typeof definition.onShow === 'function', 'App.onShow is missing');
    definition.onShow();
    check(refreshStarted === 1, 'foreground auth refresh does not start synchronously');
    check(cloudReadyCalls === 0, 'foreground auth refresh is still deferred behind a cloud-ready microtask');
  } finally {
    Module._load = originalLoad;
    global.App = originalApp;
    delete require.cache[require.resolve(appPath)];
  }
}

async function verifyPublishLocationLifecycle() {
  const publishPath = path.join(ROOT, 'pages/publish/index.js');
  const originalLoad = Module._load;
  const originalPage = global.Page;
  const originalWx = global.wx;
  let definition;
  let loginGuardCalls = 0;
  let locationResult = {
    cancelled: false,
    location: {
      name: '图书馆门口',
      address: '校园公共区域',
      latitude: 31.1,
      longitude: 121.2
    }
  };
  const user = {
    id: 'u_1234567890abcdef1234567890abcdef',
    profileCompleted: true,
    schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    schoolName: '示例大学',
    schoolRequired: false,
    schoolUnavailable: false
  };
  let authListener = null;
  let schoolReady = true;
  let currentUser = user;
  const authStore = {
    subscribe(listener) {
      authListener = listener;
      listener({
        status: 'authenticated',
        user,
        initialized: true,
        restoring: false
      });
      return () => {};
    },
    getCurrentUser() { return currentUser ? { ...currentUser } : null; },
    isSchoolReady() { return schoolReady; }
  };

  global.wx = {
    createVideoContext() { return { pause() {} }; },
    showToast() {}
  };
  global.Page = (value) => { definition = value; };
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (parent && parent.filename === publishPath) {
      if (request === '../../store/auth-store') return authStore;
      if (request === '../../store/app-store') return { markProductsChanged() {} };
      if (request === '../../services/auth-guard') {
        return {
          async requireLogin() {
            loginGuardCalls += 1;
            return true;
          }
        };
      }
      if (request === '../../services/navigation-service') return {};
      if (request === '../../services/product-publish-service') {
        return { createSubmissionId: () => 'publish_phase24_test' };
      }
      if (request === '../../services/product-form-service') return {};
      if (request === '../../services/location-service') {
        return {
          chooseLocation: async () => locationResult,
          getErrorMessage: () => 'location error'
        };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(publishPath)];
    require(publishPath);
    const page = {
      ...definition,
      data: JSON.parse(JSON.stringify(definition.data)),
      setData(patch) { Object.assign(this.data, patch); }
    };
    page.onLoad();
    const preservedImage = { tempFilePath: 'wxfile://phase24-image', size: 1024 };
    const preservedVideo = { tempFilePath: 'wxfile://phase24-video', previewUrl: 'wxfile://phase24-video' };
    page.setData({
      title: '保留标题',
      description: '保留描述',
      location: '原地点',
      images: [preservedImage],
      video: preservedVideo
    });
    await page.onShow();
    authListener({
      status: 'authenticated',
      user,
      initialized: true,
      restoring: true
    });
    check(page.data.isLoggedIn === true, 'trusted restoring state rendered the publish login placeholder');
    check(page.data.isAuthPending === false, 'trusted restoring state rendered the pending placeholder');
    check(page.data.images[0] === preservedImage && page.data.video === preservedVideo, 'foreground auth refresh cleared selected media');
    await page.onChooseLocation();
    check(loginGuardCalls === 1, 'map return caused an extra login guard navigation');
    check(page.data.title === '保留标题' && page.data.description === '保留描述', 'map selection cleared the publish form');
    check(page.data.location === '图书馆门口', 'selected location was not written back');
    check(page.data.locationDetail && page.data.locationDetail.address === '校园公共区域', 'structured location was lost');

    locationResult = { cancelled: true, location: null };
    page.setData({ title: '取消后保留', description: '取消后仍保留' });
    await page.onChooseLocation();
    check(page.data.title === '取消后保留' && page.data.description === '取消后仍保留', 'map cancellation cleared the form');
    check(page.data.location === '图书馆门口', 'map cancellation cleared the previous location');

    schoolReady = false;
    currentUser = null;
    authListener({
      status: 'anonymous',
      user: null,
      initialized: true,
      restoring: false
    });
    check(page.data.isLoggedIn === false && page.data.isAuthPending === false, 'explicit anonymous state did not show login UI immediately');
    check(page.data.schoolName === '', 'explicit anonymous state retained the previous school name');

    authListener({
      status: 'restoring',
      user: null,
      initialized: false,
      restoring: true
    });
    check(page.data.isAuthPending === true, 'unconfirmed cold restore rendered anonymous UI');
    page.onUnload();
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
    global.wx = originalWx;
    delete require.cache[require.resolve(publishPath)];
  }
}

async function verifyTrustedRefreshAndExplicitLogout() {
  const authStorePath = path.join(ROOT, 'store/auth-store.js');
  const authServicePath = path.join(ROOT, 'services/auth-service.js');
  const cloudConfigPath = path.join(ROOT, 'config/cloud.js');
  const originalWx = global.wx;
  const AuthService = require(authServicePath);
  const originalGetCurrentUser = AuthService.getCurrentUser;
  const { CLOUD_CONFIG } = require(cloudConfigPath);
  const storage = new Map();
  const userA = {
    id: 'u_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    nickname: '用户 A',
    avatarUrl: 'cloud://avatar-a',
    profileCompleted: true,
    schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    schoolName: '学校 A',
    schoolVersion: 3,
    schoolRequired: false,
    schoolUnavailable: false
  };
  const userB = {
    ...userA,
    id: 'u_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    nickname: '用户 B',
    avatarUrl: 'cloud://avatar-b',
    schoolId: 's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    schoolName: '学校 B',
    schoolVersion: 1
  };

  global.wx = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    removeStorageSync(key) { storage.delete(key); }
  };

  try {
    let resolveColdStart;
    AuthService.getCurrentUser = () => new Promise((resolve) => {
      resolveColdStart = resolve;
    });
    storage.set(CLOUD_CONFIG.userCacheKey, { ...userA });
    delete require.cache[require.resolve(authStorePath)];
    const AuthStore = require(authStorePath);
    const coldStart = AuthStore.bootstrap();
    check(AuthStore.getState().status === 'restoring', 'cold cache was trusted before current confirmation');
    check(AuthStore.isSchoolReady() === false, 'cold cache bypassed server school confirmation');
    resolveColdStart(userA);
    await coldStart;
    check(AuthStore.isSchoolReady() === true, 'server-confirmed session did not become school-ready');

    const refreshTransitions = [];
    const unsubscribe = AuthStore.subscribe((state) => {
      refreshTransitions.push({
        status: state.status,
        restoring: state.restoring,
        userId: state.user && state.user.id,
        schoolName: state.user && state.user.schoolName
      });
    });
    refreshTransitions.length = 0;
    let resolveRefresh;
    AuthService.getCurrentUser = () => new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    const refresh = AuthStore.refreshCurrentUser();
    check(AuthStore.getState().status === 'authenticated', 'trusted foreground refresh changed status to restoring');
    check(AuthStore.getState().restoring === true, 'trusted foreground refresh did not expose refreshing state');
    check(AuthStore.isSchoolReady() === true, 'trusted foreground refresh hid the authenticated school UI');
    check(AuthStore.getCurrentUser().schoolName === userA.schoolName, 'trusted refresh cleared the school summary');
    check(
      refreshTransitions.every((state) => state.status === 'authenticated' && state.userId === userA.id),
      'trusted refresh emitted an anonymous/restoring-only UI state'
    );
    resolveRefresh(userA);
    await refresh;
    check(AuthStore.getState().restoring === false && AuthStore.isSchoolReady(), 'trusted refresh did not settle authenticated');

    AuthService.getCurrentUser = async () => {
      const error = new Error('network failed');
      error.code = 'NETWORK_ERROR';
      throw error;
    };
    await AuthStore.refreshCurrentUser();
    check(AuthStore.getState().status === 'authenticated', 'transient refresh failure discarded a trusted session');
    check(AuthStore.isSchoolReady() === true, 'transient refresh failure flashed the login UI');
    check(AuthStore.getState().error.code === 'NETWORK_ERROR', 'refresh error was not retained for diagnostics');

    let resolveStaleRefresh;
    AuthService.getCurrentUser = () => new Promise((resolve) => {
      resolveStaleRefresh = resolve;
    });
    const staleRefresh = AuthStore.refreshCurrentUser();
    AuthStore.logout();
    check(AuthStore.getState().status === 'anonymous', 'explicit logout did not become anonymous immediately');
    check(AuthStore.getCurrentUser() === null, 'explicit logout retained the in-memory user');
    check(AuthStore.isSchoolReady() === false, 'explicit logout retained school readiness');
    check(!storage.has(CLOUD_CONFIG.userCacheKey), 'explicit logout retained auth:user-summary');
    check(storage.get(CLOUD_CONFIG.explicitLogoutKey) === true, 'explicit logout marker was not stored');
    resolveStaleRefresh(userA);
    await staleRefresh;
    check(AuthStore.getState().status === 'anonymous' && AuthStore.getCurrentUser() === null, 'stale refresh restored a logged-out user');

    AuthService.getCurrentUser = async () => userB;
    await AuthStore.loginCurrentIdentity();
    check(AuthStore.isSchoolReady() === true, 'manual re-login did not restore school readiness');
    check(AuthStore.getCurrentUser().schoolName === userB.schoolName, 'manual re-login restored the previous school');
    check(storage.get(CLOUD_CONFIG.userCacheKey).schoolName === userB.schoolName, 'cache retained the previous school after re-login');
    check(!storage.has(CLOUD_CONFIG.explicitLogoutKey), 'successful re-login retained explicit logout marker');
    unsubscribe();
  } finally {
    AuthService.getCurrentUser = originalGetCurrentUser;
    delete require.cache[require.resolve(authStorePath)];
    global.wx = originalWx;
  }
}

function verifySchoolSummary() {
  const querySource = read('cloudfunctions/messageQuery/index.js');
  const messageSource = read('services/message-service.js');
  const chatTemplate = read('pages/chat/index.wxml');
  const pickerTemplate = read('pages/chat-product-picker/index.wxml');
  const appointmentQuerySource = read('cloudfunctions/appointmentQuery/index.js');
  const userQuerySource = read('cloudfunctions/userQuery/index.js');
  const authStoreSource = read('store/auth-store.js');

  check(/schoolName:\s*normalizeString\(record\s*&&\s*record\.schoolName\)/.test(querySource), 'messageQuery omits authoritative schoolName');
  check(!/schoolId:\s*normalizeString\(record\s*&&\s*record\.schoolId\)/.test(querySource.slice(querySource.indexOf('function safeUser'), querySource.indexOf('function safeProduct'))), 'messageQuery exposes schoolId in the user summary');
  check(/schoolDisplayName:\s*schoolName\s*\|\|\s*campus\s*\|\|\s*['"]校园信息待完善['"]/.test(messageSource), 'message client does not prefer schoolName with a legacy campus fallback');
  check(chatTemplate.includes('conversation.otherUser.schoolDisplayName'), 'chat header still renders legacy campus directly');
  check(pickerTemplate.includes('owner.schoolDisplayName'), 'chat product picker still renders legacy campus directly');
  check(!chatTemplate.includes('conversation.otherUser.campus'), 'chat header still binds campus');
  check(!pickerTemplate.includes('owner.campus'), 'chat product picker still binds campus');
  check(/campus:\s*normalizeString\(record\s*&&\s*record\.campus\)/.test(appointmentQuerySource), 'appointmentQuery legacy campus audit marker changed unexpectedly');
  check(
    /async function resolvePublicSchoolName/.test(userQuerySource)
      && /schoolName:\s*publicSchoolName/.test(userQuerySource)
      && /campus:\s*publicSchoolName/.test(userQuerySource),
    'userQuery public profile no longer projects the authoritative school display name'
  );
  check(/removeStorageSync\(CLOUD_CONFIG\.userCacheKey\)/.test(authStoreSource), 'logout no longer clears the cached user summary');
}

function verifySmallUxFixesAndScope() {
  const globalStyles = read('app.wxss');
  const publishStyles = read('pages/publish/index.wxss');
  const appointmentStyles = read('pages/appointment-create/index.wxss');
  const loginStyles = read('pages/login/index.wxss');
  const authServiceSource = read('services/auth-service.js');
  const authFunctionSource = read('cloudfunctions/authUser/index.js');
  const authStoreSource = read('store/auth-store.js');
  const publishSource = read('pages/publish/index.js');
  const publishTemplate = read('pages/publish/index.wxml');

  check(/input,\s*\ntextarea,\s*\nbutton/.test(globalStyles), 'textarea is missing from global border-box sizing');
  check(/\.form-textarea\s*\{[\s\S]{0,160}padding:/.test(publishStyles), 'publish textarea regression fixture is missing');
  check(/\.note-input\s*\{[\s\S]{0,180}width:\s*100%[\s\S]{0,180}padding:/.test(appointmentStyles), 'appointment textarea regression fixture is missing');
  check(/\.wechat-login-button\s*\{[\s\S]{0,180}display:\s*flex[\s\S]{0,180}align-items:\s*center[\s\S]{0,180}justify-content:\s*center/.test(loginStyles), 'login button text is not centered with flex');
  check(/profileCompleted:\s*value\.profileCompleted\s*===\s*true/.test(authServiceSource), 'profileCompleted client semantics changed');
  check(/profileCompleted/.test(authFunctionSource), 'authUser profile model was removed');
  check(/preservesTrustedSession/.test(authStoreSource), 'trusted foreground session preservation is missing');
  check(/isAuthPending/.test(publishSource), 'publish page does not distinguish pending auth from anonymous');
  check(/wx:elif="\{\{isAuthPending\}\}"/.test(publishTemplate), 'publish pending auth still renders the login placeholder');
}

async function run() {
  verifyStartupAndRoutes();
  verifyForegroundRefreshOrdering();
  await verifyPublishLocationLifecycle();
  await verifyTrustedRefreshAndExplicitLogout();
  verifySchoolSummary();
  verifySmallUxFixesAndScope();
  process.stdout.write(`Phase 24 first-round verification succeeded: ${checks} checks passed.\n`);
}

run().catch((error) => {
  process.stderr.write(`PHASE24_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
