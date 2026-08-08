const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUTH_STORE_PATH = path.join(ROOT, 'store', 'auth-store.js');
const AUTH_SERVICE_PATH = path.join(ROOT, 'services', 'auth-service.js');
const AUTH_GUARD_PATH = path.join(ROOT, 'services', 'auth-guard.js');
const HOME_PATH = path.join(ROOT, 'pages', 'home', 'index.js');
const storage = new Map();
let checks = 0;

function check(value, message) {
  assert(value, message);
  checks += 1;
}

function readyUser(id, schoolId, schoolName) {
  return {
    id,
    nickname: `用户-${id.slice(-4)}`,
    avatarUrl: 'cloud://avatar',
    avatarText: '用',
    campus: '',
    bio: '',
    role: 'user',
    status: 'active',
    profileCompleted: true,
    schoolId,
    schoolName,
    schoolSelectedAt: '2026-08-01T00:00:00.000Z',
    schoolUpdatedAt: '2026-08-07T00:00:00.000Z',
    schoolVersion: 2,
    schoolRequired: false,
    schoolUnavailable: false,
    createdAt: '',
    updatedAt: '',
    lastLoginAt: ''
  };
}

function installWx() {
  global.wx = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    removeStorageSync(key) { storage.delete(key); },
    stopPullDownRefresh() {},
    showToast() {},
    pageScrollTo() {}
  };
}

function freshAuthStore(currentResolver) {
  delete require.cache[require.resolve(AUTH_STORE_PATH)];
  const AuthService = require(AUTH_SERVICE_PATH);
  AuthService.getCurrentUser = currentResolver;
  AuthService.login = async () => currentResolver();
  return require(AUTH_STORE_PATH);
}

function instantiatePage(definition) {
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch, callback) {
      this.data = { ...this.data, ...patch };
      if (typeof callback === 'function') callback();
    },
    getTabBar() { return null; }
  };
  return page;
}

function loadHomePage() {
  let definition = null;
  global.Page = (value) => { definition = value; };
  delete require.cache[require.resolve(AUTH_GUARD_PATH)];
  delete require.cache[require.resolve(HOME_PATH)];
  require(HOME_PATH);
  check(Boolean(definition), 'home page definition was not captured');
  return instantiatePage(definition);
}

async function main() {
  installWx();
  storage.clear();
  const userA = readyUser(
    'u_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '学校 A'
  );
  const userB = readyUser(
    'u_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '学校 B'
  );
  let currentUser = userA;
  let currentCalls = 0;
  let AuthStore = freshAuthStore(async () => {
    currentCalls += 1;
    return currentUser;
  });

  await AuthStore.bootstrap();
  check(currentCalls === 1, 'default bootstrap did not restore through authUser/current');
  check(AuthStore.getCurrentUser().id === userA.id, 'default bootstrap restored the wrong user');
  check(!AuthStore.hasExplicitLogout(), 'normal bootstrap incorrectly set explicit logout');

  const ProductService = require(path.join(ROOT, 'services', 'product-service.js'));
  const originalGetProducts = ProductService.getProducts;
  let productCalls = 0;
  let resolvePendingProducts;
  ProductService.getProducts = async () => {
    productCalls += 1;
    return new Promise((resolve) => { resolvePendingProducts = resolve; });
  };

  const home = loadHomePage();
  home.onLoad();
  home.setData({
    products: [{ id: 'p_old' }],
    viewState: 'success',
    page: null,
    total: null,
    hasMore: true,
    nextCursor: 'old-cursor',
    marketMode: 'schoolScoped',
    marketScope: { schoolId: userA.schoolId, schoolName: userA.schoolName },
    queryScopeKey: 'old-scope'
  });
  const pending = home.loadProducts({ mode: 'query' });
  check(productCalls === 1, 'strict list request was not started for stale-response test');

  AuthStore.logout();
  check(storage.get('auth:explicit-logout') === true, 'logout did not persist the explicit marker');
  check(!storage.has('auth:user-summary'), 'logout did not clear the cached user');
  check(AuthStore.getCurrentUser() === null, 'logout did not clear the in-memory user');
  check(home.data.products.length === 0, 'logout did not immediately clear the home product list');
  check(home.data.marketMode === '' && home.data.marketScope.schoolId === '', 'logout did not clear market mode and scope');
  check(home.data.nextCursor === '' && home.data.queryScopeKey === '', 'logout did not clear cursor and query scope');
  check(home.data.page === 1 && home.data.total === 0 && home.data.hasMore === false, 'logout did not reset pagination state');
  check(home.data.viewState === 'guide' && home.data.guideType === 'login', 'logout did not show the anonymous market guide');

  resolvePendingProducts({
    list: [{ id: 'p_late' }],
    marketMode: 'schoolScoped',
    scope: { schoolId: userA.schoolId, schoolName: userA.schoolName },
    page: null,
    pageSize: 6,
    total: null,
    hasMore: false,
    nextCursor: ''
  });
  await pending;
  check(home.data.products.length === 0, 'a pre-logout list response overwrote anonymous state');

  const callsBeforeRestart = currentCalls;
  AuthStore = freshAuthStore(async () => {
    currentCalls += 1;
    return currentUser;
  });
  await AuthStore.bootstrap();
  check(currentCalls === callsBeforeRestart, 'restart with explicit logout called authUser/current');
  check(AuthStore.getState().status === 'anonymous', 'restart with explicit logout did not remain anonymous');
  check(AuthStore.hasExplicitLogout(), 'restart lost the explicit logout marker');

  const restartedHome = loadHomePage();
  restartedHome.onLoad();
  await restartedHome.onShow();
  check(productCalls === 1, 'anonymous restart called ProductService.getProducts');
  check(restartedHome.data.viewState === 'guide', 'anonymous restart did not show the guide');

  await AuthStore.loginCurrentIdentity();
  check(!AuthStore.hasExplicitLogout(), 'manual identity login did not clear the explicit marker');
  check(AuthStore.getCurrentUser().id === userA.id, 'manual identity login restored the wrong account');
  check(storage.get('auth:user-summary').id === userA.id, 'manual login did not cache account A safely');

  AuthStore.logout();
  currentUser = userB;
  await AuthStore.loginCurrentIdentity();
  check(AuthStore.getCurrentUser().id === userB.id, 'account B manual login restored account A');
  check(storage.get('auth:user-summary').id === userB.id, 'account B cache retained account A');

  AuthStore.logout();
  const markerBeforeFailure = storage.get('auth:explicit-logout');
  const failingStore = freshAuthStore(async () => {
    const error = new Error('network failed');
    error.code = 'NETWORK_ERROR';
    throw error;
  });
  let failed = false;
  try {
    await failingStore.loginCurrentIdentity();
  } catch (error) {
    failed = true;
  }
  check(failed, 'manual login failure was not surfaced');
  check(markerBeforeFailure === true && storage.get('auth:explicit-logout') === true, 'login failure cleared the explicit marker');
  check(!storage.has('auth:user-summary'), 'login failure restored a stale account cache');

  home.onUnload();
  restartedHome.onUnload();
  ProductService.getProducts = originalGetProducts;
  delete global.Page;
  delete global.wx;
  process.stdout.write(`Phase 18 explicit logout verification succeeded: ${checks} checks passed.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
