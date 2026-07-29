const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function createVerifier() {
  const messages = [];
  function check(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
    messages.push(message);
  }
  return {
    check,
    messages
  };
}

function createUserId(appId, openId) {
  return `u_${crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

async function verifyAuthUserSchoolFlow(root, verifier) {
  const { check } = verifier;
  const functionPath = path.join(root, 'cloudfunctions', 'authUser', 'index.js');
  const originalLoad = Module._load;
  const users = new Map();
  const activeA = `s_${'a'.repeat(32)}`;
  const activeB = `s_${'b'.repeat(32)}`;
  const pending = `s_${'c'.repeat(32)}`;
  const missing = `s_${'d'.repeat(32)}`;
  const schools = new Map([
    [activeA, {
      _id: activeA,
      name: '第一验证大学',
      officialStatus: 'valid',
      platformStatus: 'active'
    }],
    [activeB, {
      _id: activeB,
      name: '第二验证学院',
      officialStatus: 'valid',
      platformStatus: 'active'
    }],
    [pending, {
      _id: pending,
      name: '待开放验证大学',
      officialStatus: 'valid',
      platformStatus: 'pending'
    }]
  ]);
  const updateCounts = new Map();
  let identity = {
    OPENID: 'legacy-no-school',
    APPID: 'school-selection-verification'
  };

  const database = {
    collection(name) {
      const records = name === 'users'
        ? users
        : name === 'schools'
          ? schools
          : null;
      check(Boolean(records), `unexpected collection ${name}`);
      return {
        where(condition) {
          return {
            limit() {
              return {
                async get() {
                  const record = records.get(condition._id);
                  return {
                    data: record ? [{ ...record }] : []
                  };
                }
              };
            }
          };
        },
        doc(id) {
          return {
            async get() {
              const record = records.get(id);
              if (!record) {
                throw new Error('document with _id does not exist');
              }
              return {
                data: { ...record }
              };
            },
            async set({ data }) {
              records.set(id, {
                ...data,
                _id: id
              });
            },
            async update({ data }) {
              const record = records.get(id);
              if (!record) {
                throw new Error('document with _id does not exist');
              }
              updateCounts.set(id, (updateCounts.get(id) || 0) + 1);
              records.set(id, {
                ...record,
                ...data,
                _id: id
              });
            }
          };
        }
      };
    },
    serverDate() {
      return new Date('2026-07-28T10:00:00.000Z');
    },
    async runTransaction(callback) {
      return callback({
        collection: database.collection.bind(database)
      });
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { ...identity };
    }
  };
  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(functionPath)];

  function seedUser(openId, overrides = {}) {
    identity = {
      OPENID: openId,
      APPID: 'school-selection-verification'
    };
    const id = createUserId(identity.APPID, openId);
    users.set(id, {
      _id: id,
      openid: openId,
      nickname: '验证用户',
      avatarUrl: `cloud://test.bucket/avatars/${id}/20260728/avatar.png`,
      campus: '',
      status: 'active',
      role: 'user',
      profileCompleted: true,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
      ...overrides
    });
    return id;
  }

  try {
    const authUser = require(functionPath);

    seedUser('legacy-no-school');
    const legacy = await authUser.main({ action: 'current' });
    check(legacy.success === true, 'legacy user current succeeds');
    check(legacy.data.user.schoolRequired === true, 'legacy user requires school');
    check(legacy.data.user.schoolUnavailable === false, 'legacy user is not marked unavailable');
    check(legacy.data.user.schoolId === '', 'legacy user receives empty school id');

    seedUser('malformed-school', {
      schoolId: 'malformed-school',
      schoolName: '历史异常学校'
    });
    const malformed = await authUser.main({ action: 'current' });
    check(malformed.data.user.schoolRequired === true, 'malformed stored school requires selection');
    check(malformed.data.user.schoolUnavailable === true, 'malformed stored school is unavailable');

    seedUser('missing-school', {
      schoolId: missing,
      schoolName: '已经不存在的学校',
      schoolVersion: 1
    });
    const missingCurrent = await authUser.main({ action: 'current' });
    check(missingCurrent.data.user.schoolRequired === true, 'missing school requires selection');
    check(missingCurrent.data.user.schoolUnavailable === true, 'missing school is unavailable');
    check(missingCurrent.data.user.schoolName === '已经不存在的学校', 'missing school keeps its historical name');

    seedUser('pending-school', {
      schoolId: pending,
      schoolName: '待开放验证大学',
      schoolVersion: 1
    });
    const pendingCurrent = await authUser.main({ action: 'current' });
    check(pendingCurrent.data.user.schoolRequired === true, 'pending school requires selection');
    check(pendingCurrent.data.user.schoolUnavailable === true, 'pending school is unavailable');

    seedUser('active-school', {
      schoolId: activeA,
      schoolName: '客户端旧名称',
      schoolVersion: 1,
      schoolSelectedAt: new Date('2026-07-21T00:00:00.000Z'),
      schoolUpdatedAt: new Date('2026-07-21T00:00:00.000Z')
    });
    const activeCurrent = await authUser.main({ action: 'current' });
    check(activeCurrent.data.user.schoolRequired === false, 'active school is ready');
    check(activeCurrent.data.user.schoolUnavailable === false, 'active school is available');
    check(activeCurrent.data.user.schoolName === '第一验证大学', 'active school name is authoritative');

    seedUser('first-selection', {
      campus: '历史校园文本'
    });
    const invalidValues = [
      undefined,
      null,
      '',
      [],
      {},
      `s_${'a'.repeat(40)}`
    ];
    for (const value of invalidValues) {
      const response = await authUser.main({
        action: 'selectSchool',
        data: {
          schoolId: value
        }
      });
      check(response.code === 'INVALID_SCHOOL_ID', `invalid school value rejected: ${String(value)}`);
    }
    const missingSelection = await authUser.main({
      action: 'selectSchool',
      data: { schoolId: missing }
    });
    check(missingSelection.code === 'SCHOOL_NOT_FOUND', 'missing school selection is rejected');
    const pendingSelection = await authUser.main({
      action: 'selectSchool',
      data: { schoolId: pending }
    });
    check(pendingSelection.code === 'SCHOOL_NOT_ACTIVE', 'pending school selection is rejected');

    const selectedUserId = createUserId(identity.APPID, identity.OPENID);
    const selection = await authUser.main({
      action: 'selectSchool',
      OPENID: 'forged-user',
      data: {
        schoolId: activeA,
        schoolName: '伪造学校',
        userId: 'u_victim'
      }
    });
    check(selection.success === true, 'active school selection succeeds');
    check(selection.data.user.schoolId === activeA, 'selected school id is returned');
    check(selection.data.user.schoolName === '第一验证大学', 'client school name is ignored');
    check(selection.data.user.schoolRequired === false, 'successful selection clears required state');
    check(selection.data.user.schoolUnavailable === false, 'successful selection clears unavailable state');
    check(selection.data.user.schoolVersion === 1, 'first selection writes version one');
    check(Boolean(selection.data.user.schoolSelectedAt), 'first selection writes selected time');
    check(Boolean(selection.data.user.schoolUpdatedAt), 'first selection writes updated time');
    check(users.get(selectedUserId).schoolId === activeA, 'current identity user is updated');

    const updateCount = updateCounts.get(selectedUserId);
    const storedSelectedAt = users.get(selectedUserId).schoolSelectedAt;
    const repeated = await authUser.main({
      action: 'selectSchool',
      data: { schoolId: activeA }
    });
    check(repeated.success === true, 'same school retry succeeds');
    check(repeated.data.user.schoolVersion === 1, 'same school retry preserves version');
    check(
      users.get(selectedUserId).schoolSelectedAt === storedSelectedAt,
      'same school retry preserves stored selected time'
    );
    check(updateCounts.get(selectedUserId) === updateCount, 'same school retry performs no write');

    const otherSchool = await authUser.main({
      action: 'selectSchool',
      data: { schoolId: activeB }
    });
    check(otherSchool.code === 'SCHOOL_ALREADY_SELECTED', 'valid school cannot be directly changed');
    check(users.get(selectedUserId).schoolId === activeA, 'rejected change preserves selected school');

    const selectedRecord = users.get(selectedUserId);
    const profileUpdate = await authUser.main({
      action: 'updateProfile',
      data: {
        profile: {
          nickname: '资料更新用户',
          avatarUrl: selectedRecord.avatarUrl,
          campus: '客户端伪造校园',
          schoolId: activeB,
          schoolName: '客户端伪造学校',
          schoolSelectedAt: '2099-01-01T00:00:00.000Z',
          schoolUpdatedAt: '2099-01-01T00:00:00.000Z',
          schoolVersion: 999,
          schoolRequired: true,
          schoolUnavailable: true
        }
      }
    });
    const storedAfterProfileUpdate = users.get(selectedUserId);
    check(profileUpdate.success === true, 'nickname and avatar update still succeeds');
    check(
      profileUpdate.data.user.schoolName === '第一验证大学',
      'profile update response preserves authoritative school name'
    );
    check(
      storedAfterProfileUpdate.schoolId === activeA
      && storedAfterProfileUpdate.schoolName === '第一验证大学'
      && storedAfterProfileUpdate.schoolVersion === 1,
      'profile update ignores protected school fields'
    );
    check(
      storedAfterProfileUpdate.campus === '历史校园文本',
      'profile update preserves historical campus field'
    );

    const oldSelectedAt = new Date('2026-07-10T00:00:00.000Z');
    const unavailableUserId = seedUser('unavailable-rebind', {
      schoolId: pending,
      schoolName: '待开放验证大学',
      schoolSelectedAt: oldSelectedAt,
      schoolUpdatedAt: oldSelectedAt,
      schoolVersion: 1
    });
    const rebound = await authUser.main({
      action: 'selectSchool',
      data: { schoolId: activeB }
    });
    check(rebound.success === true, 'unavailable school can be rebound');
    check(rebound.data.user.schoolVersion === 2, 'unavailable rebind increments version');
    check(
      rebound.data.user.schoolSelectedAt === oldSelectedAt.toISOString(),
      'unavailable rebind preserves first selected time'
    );
    check(users.get(unavailableUserId).schoolName === '第二验证学院', 'unavailable rebind uses authoritative name');

    const safeJson = JSON.stringify([
      legacy,
      activeCurrent,
      selection,
      rebound
    ]);
    check(!safeJson.includes(identity.OPENID), 'safe response omits current openid');
    check(
      !/"(?:openid|OPENID|_openid|roleInternal|permissions)"/.test(safeJson),
      'safe response omits sensitive identity fields'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function verifyAuthStoreSchoolFlow(root, verifier) {
  const { check } = verifier;
  const authServicePath = path.join(root, 'services', 'auth-service.js');
  const storePath = path.join(root, 'store', 'auth-store.js');
  const AuthService = require(authServicePath);
  const originalMethods = {
    getCurrentUser: AuthService.getCurrentUser,
    selectSchool: AuthService.selectSchool
  };
  const originalWx = global.wx;
  const storage = new Map();
  global.wx = {
    getStorageSync(key) {
      return storage.get(key);
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    }
  };
  delete require.cache[require.resolve(storePath)];

  const unselectedUser = {
    id: `u_${'1'.repeat(32)}`,
    nickname: '缓存验证用户',
    avatarUrl: 'cloud://test/avatar.png',
    campus: '',
    profileCompleted: true,
    schoolId: '',
    schoolName: '',
    schoolSelectedAt: '',
    schoolUpdatedAt: '',
    schoolVersion: 0,
    schoolRequired: true,
    schoolUnavailable: false
  };
  const readyUser = {
    ...unselectedUser,
    schoolId: `s_${'a'.repeat(32)}`,
    schoolName: '第一验证大学',
    schoolSelectedAt: '2026-07-28T10:00:00.000Z',
    schoolUpdatedAt: '2026-07-28T10:00:00.000Z',
    schoolVersion: 1,
    schoolRequired: false,
    schoolUnavailable: false
  };

  try {
    storage.set('auth:user-summary', {
      id: unselectedUser.id,
      nickname: unselectedUser.nickname,
      avatarUrl: unselectedUser.avatarUrl,
      profileCompleted: true
    });
    AuthService.getCurrentUser = async () => ({ ...unselectedUser });
    const AuthStore = require(storePath);
    await AuthStore.bootstrap();
    check(AuthStore.isLoggedIn() === true, 'legacy cache restores authenticated profile');
    check(AuthStore.isSchoolReady() === false, 'legacy cache does not bypass school selection');
    check(AuthStore.getCurrentUser().schoolRequired === true, 'server required state wins over old cache');
    check(
      storage.get('auth:user-summary').schoolRequired === true,
      'school required state is written to cache'
    );

    let selectCalls = 0;
    let resolveSelection;
    AuthService.selectSchool = async () => {
      selectCalls += 1;
      return new Promise((resolve) => {
        resolveSelection = () => resolve({ ...readyUser });
      });
    };
    const first = AuthStore.selectSchool(readyUser.schoolId);
    const second = AuthStore.selectSchool(readyUser.schoolId);
    check(first === second, 'concurrent school selection reuses one promise');
    check(AuthStore.getState().selectingSchool === true, 'store exposes school submitting state');
    resolveSelection();
    await first;
    check(selectCalls === 1, 'concurrent school selection calls service once');
    check(AuthStore.isSchoolReady() === true, 'selection immediately makes store school-ready');
    check(AuthStore.getCurrentUser().schoolName === readyUser.schoolName, 'selection updates current user');
    check(
      storage.get('auth:user-summary').schoolId === readyUser.schoolId,
      'selection updates persistent cache'
    );

    AuthStore.logout();
    check(AuthStore.getCurrentUser() === null, 'logout clears school user state');
    check(AuthStore.isSchoolReady() === false, 'logout clears school readiness');
    check(!storage.has('auth:user-summary'), 'logout removes school cache');
  } finally {
    AuthService.getCurrentUser = originalMethods.getCurrentUser;
    AuthService.selectSchool = originalMethods.selectSchool;
    delete require.cache[require.resolve(storePath)];
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyGuardFlow(root, verifier) {
  const { check } = verifier;
  const storePath = path.join(root, 'store', 'auth-store.js');
  const navigationPath = path.join(root, 'services', 'navigation-service.js');
  const guardPath = path.join(root, 'services', 'auth-guard.js');
  const AuthStore = require(storePath);
  const NavigationService = require(navigationPath);
  const originalStore = {};
  const originalNavigation = {};
  [
    'getState',
    'getCurrentUser',
    'isLoggedIn',
    'isSchoolReady',
    'bootstrap'
  ].forEach((name) => {
    originalStore[name] = AuthStore[name];
  });
  [
    'getCurrentRoute',
    'safeNavigateTo',
    'safeRedirectTo',
    'safeSwitchTab',
    'safeNavigateBack'
  ].forEach((name) => {
    originalNavigation[name] = NavigationService[name];
  });
  const navigations = [];
  let state;
  let user;
  let schoolReady;
  AuthStore.getState = () => ({ ...state, user });
  AuthStore.getCurrentUser = () => (user ? { ...user } : null);
  AuthStore.isLoggedIn = () => Boolean(
    state.status === 'authenticated'
    && user
    && user.profileCompleted
  );
  AuthStore.isSchoolReady = () => AuthStore.isLoggedIn() && schoolReady;
  AuthStore.bootstrap = async () => ({ ...state, user });
  NavigationService.getCurrentRoute = () => state.route || '/pages/home/index';
  ['safeNavigateTo', 'safeRedirectTo', 'safeSwitchTab', 'safeNavigateBack']
    .forEach((name) => {
      NavigationService[name] = async (url) => {
        navigations.push({ name, url });
        return true;
      };
    });
  delete require.cache[require.resolve(guardPath)];

  try {
    const AuthGuard = require(guardPath);
    state = { status: 'anonymous', restoring: false, route: '/pages/home/index' };
    user = null;
    schoolReady = false;
    check(
      await AuthGuard.requireMarketAccess({ target: 'home' }) === true,
      'anonymous user retains public market access'
    );
    check(navigations.length === 0, 'anonymous market access does not navigate');

    state = { status: 'authenticated', restoring: false, route: '/pages/publish/index' };
    user = { profileCompleted: true, schoolRequired: true };
    schoolReady = false;
    check(
      await AuthGuard.requireLogin({ target: 'publish' }) === false,
      'unselected user cannot enter protected route'
    );
    check(
      navigations.pop().url.startsWith('/pages/school-select/index?target=publish'),
      'unselected user is redirected to school selection'
    );

    state.route = '/pages/school-select/index';
    const beforeDuplicate = navigations.length;
    check(
      await AuthGuard.requireLogin({ target: 'publish' }) === false,
      'school page remains blocked until selection'
    );
    check(navigations.length === beforeDuplicate, 'school page is not opened twice');

    state.route = '/pages/home/index';
    user = { profileCompleted: false };
    check(
      await AuthGuard.requireMarketAccess({ target: 'home' }) === false,
      'incomplete profile cannot enter market'
    );
    check(
      navigations.pop().url.startsWith('/pages/login/index?target=home'),
      'incomplete profile is sent to login profile flow'
    );

    user = { profileCompleted: true, schoolRequired: false, schoolId: `s_${'a'.repeat(32)}` };
    schoolReady = true;
    check(
      await AuthGuard.requireLogin({ target: 'publish' }) === true,
      'school-ready user enters protected route'
    );
    const beforeReady = navigations.length;
    await AuthGuard.navigateAfterSchoolSelection({ target: 'home' });
    check(navigations.length === beforeReady + 1, 'selection success navigates to target');
    check(navigations.pop().name === 'safeSwitchTab', 'home target uses switchTab');

    schoolReady = false;
    await AuthGuard.navigateAfterLogin({
      target: 'product-detail',
      productId: 'product-safe'
    });
    const schoolNavigation = navigations.pop();
    check(
      schoolNavigation.url.includes('target=product-detail')
      && schoolNavigation.url.includes('id=product-safe'),
      'login-to-school redirect preserves safe target'
    );
  } finally {
    Object.assign(AuthStore, originalStore);
    Object.assign(NavigationService, originalNavigation);
    delete require.cache[require.resolve(guardPath)];
  }
}

function verifyPageAndSourceBoundaries(root, verifier) {
  const { check } = verifier;
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const appJson = JSON.parse(read('app.json'));
  const pageSource = read('pages/school-select/index.js');
  const pageWxml = read('pages/school-select/index.wxml');
  const pageWxss = read('pages/school-select/index.wxss');
  const authFunction = read('cloudfunctions/authUser/index.js');
  const guardSource = read('services/auth-guard.js');
  const homeSource = read('pages/home/index.js');
  const tabSource = read('custom-tab-bar/index.js');
  const productSources = [
    read('cloudfunctions/createProduct/index.js'),
    read('cloudfunctions/manageProduct/index.js'),
    read('cloudfunctions/productQuery/index.js')
  ].join('\n');

  check(appJson.pages.includes('pages/school-select/index'), 'school selection page is registered');
  ['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach((name) => {
    check(
      fs.existsSync(path.join(root, 'pages', 'school-select', name)),
      `school selection ${name} exists`
    );
  });
  check(/SchoolService\.listSchools/.test(pageSource), 'page reuses school list service');
  check(/SchoolService\.searchSchools/.test(pageSource), 'page reuses school search service');
  check(/SEARCH_DEBOUNCE_MS\s*=\s*350/.test(pageSource), 'search uses bounded debounce');
  check(/requestVersion/.test(pageSource), 'page rejects stale school responses');
  check(/isPageActive/.test(pageSource), 'page guards setData after unload');
  check(/wx\.showModal/.test(pageSource), 'selection requires confirmation modal');
  check(/AuthStore\.selectSchool/.test(pageSource), 'page binds through AuthStore');
  check(/school\.selectable === true/.test(pageSource), 'page filters non-selectable schools');
  check(/isSubmitting/.test(pageSource), 'page prevents duplicate submission');
  check(/onLogoutTap/.test(pageSource), 'mandatory flow preserves logout');
  check(/viewState === 'error'/.test(pageWxml), 'page renders request error state');
  check(/viewState === 'empty'/.test(pageWxml), 'page renders empty search state');
  check(/env\(safe-area-inset-bottom\)/.test(pageWxss), 'page respects bottom safe area');
  check(/selectSchool/.test(authFunction), 'authUser exposes school selection action');
  check(/transaction\.collection\('users'\)/.test(authFunction), 'school binding uses transaction user document');
  check(/platformStatus === 'active'/.test(authFunction), 'server validates active platform status');
  check(/officialStatus === 'valid'/.test(authFunction), 'server validates official school status');
  check(/SCHOOL_ALREADY_SELECTED/.test(authFunction), 'server rejects direct valid-school changes');
  check(/requireMarketAccess/.test(guardSource), 'guard exposes market access check');
  check(/requireMarketAccess/.test(homeSource), 'home waits for school access decision');
  check(/requireMarketAccess/.test(tabSource), 'custom tab bar enforces school guard');
  check(
    /schools\s*=\s*db\.collection\(['"]schools['"]\)/.test(productSources)
      && !/switchSchool|changeSchool/.test(productSources),
    'later product binding preserves phase 16 first-selection boundary'
  );
}

function verifyProfileSchoolLinkage(root, verifier) {
  const { check } = verifier;
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const profileSource = read('pages/profile/index.js');
  const profileTemplate = read('pages/profile/index.wxml');
  const profileStyle = read('pages/profile/index.wxss');
  const editSource = read('pages/login/index.js');
  const editTemplate = read('pages/login/index.wxml');
  const editStyle = read('pages/login/index.wxss');
  const authServiceSource = read('services/auth-service.js');
  const authFunctionSource = read('cloudfunctions/authUser/index.js');
  const AuthService = require(path.join(root, 'services', 'auth-service.js'));
  const safeProfile = AuthService.__test.normalizeProfileInput({
    nickname: '资料验证用户',
    avatarUrl: 'cloud://test.bucket/avatars/u_profile/20260728/avatar.png',
    campus: '客户端校园',
    schoolId: `s_${'f'.repeat(32)}`,
    schoolName: '客户端学校',
    schoolVersion: 999
  }, {
    requireAvatar: true
  });

  check(
    /schoolName\s*\|\|\s*legacyCampus\s*\|\|\s*'校园信息待完善'/.test(profileSource),
    'profile display prioritizes schoolName over legacy campus and fallback'
  );
  check(
    /\{\{displaySchoolName\}\}/.test(profileTemplate)
    && !/user\.campus/.test(profileTemplate),
    'profile card renders the unified school presentation'
  );
  check(
    /applyAuthState\(AuthStore\.getState\(\)\)/.test(profileSource),
    'profile onShow reapplies the latest AuthStore summary'
  );
  check(
    /\.profile-copy[\s\S]*min-width:\s*0/.test(profileStyle)
    && /\.profile-note[\s\S]*text-overflow:\s*ellipsis/.test(profileStyle)
    && /\.profile-note[\s\S]*white-space:\s*nowrap/.test(profileStyle)
    && /\.login-status[\s\S]*flex:\s*none/.test(profileStyle),
    'long school names preserve profile card layout'
  );
  check(
    /class="school-readonly"/.test(editTemplate)
    && /\{\{schoolDisplayName\}\}/.test(editTemplate)
    && /已绑定/.test(editTemplate),
    'profile editor renders a read-only bound school area'
  );
  check(
    !/bindinput="onCampusInput"/.test(editTemplate)
    && !/value="\{\{campus\}\}"/.test(editTemplate)
    && !/onCampusInput/.test(editSource),
    'profile editor no longer exposes a campus input'
  );
  check(
    /学校由校园选择结果确定，当前暂不支持自行修改。/.test(editTemplate),
    'profile editor explains the school binding rule'
  );
  check(
    /尚未选择学校/.test(editSource)
    && /onSelectSchoolTap/.test(editSource)
    && /AuthGuard\.requireLogin/.test(editSource),
    'missing school state provides a guarded selection entry'
  );
  check(
    /\.school-readonly__name[\s\S]*text-overflow:\s*ellipsis/.test(editStyle)
    && /\.school-readonly__status[\s\S]*flex:\s*none/.test(editStyle),
    'read-only school layout handles long names'
  );
  check(
    Object.keys(safeProfile).sort().join(',') === 'avatarUrl,nickname',
    'AuthService strips campus and protected school fields from profile payloads'
  );
  const normalizedProfileBlock = authServiceSource.slice(
    authServiceSource.indexOf('function normalizeProfileInput'),
    authServiceSource.indexOf('async function login')
  );
  check(
    !/\bcampus\b|\bschool(?:Id|Name|SelectedAt|UpdatedAt|Version|Required|Unavailable)\b/.test(
      normalizedProfileBlock
    ),
    'profile payload normalizer has no campus or school mutation fields'
  );
  const updateProfileBlock = authFunctionSource.slice(
    authFunctionSource.indexOf('async function updateProfile'),
    authFunctionSource.indexOf('async function selectSchool')
  );
  check(
    !/\bcampus\s*:|\bschool(?:Id|Name|SelectedAt|UpdatedAt|Version|Required|Unavailable)\s*:/.test(
      updateProfileBlock
    )
    && /toResolvedSafeUser/.test(updateProfileBlock),
    'authUser updateProfile only writes profile fields and returns resolved school state'
  );
  check(
    /schoolName:\s*user\.schoolName\s*\|\|\s*''/.test(read('store/auth-store.js')),
    'AuthStore persists the authoritative school name'
  );
}

async function verifySchoolSelectionFlow(root) {
  const verifier = createVerifier();
  await verifyAuthUserSchoolFlow(root, verifier);
  await verifyAuthStoreSchoolFlow(root, verifier);
  await verifyGuardFlow(root, verifier);
  verifyPageAndSourceBoundaries(root, verifier);
  verifyProfileSchoolLinkage(root, verifier);
  return {
    checks: verifier.messages.length,
    messages: verifier.messages
  };
}

if (require.main === module) {
  verifySchoolSelectionFlow(path.resolve(__dirname, '..'))
    .then((result) => {
      process.stdout.write(
        `School selection verification succeeded: ${result.checks} checks passed.\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`School selection verification failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  verifySchoolSelectionFlow
};
