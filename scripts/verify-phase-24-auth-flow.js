const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const checks = [];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function check(condition, message) {
  assert(condition, message);
  checks.push(message);
}

function createAuthCloudMock() {
  const users = new Map();
  const schoolA = `s_${'a'.repeat(32)}`;
  const schoolB = `s_${'b'.repeat(32)}`;
  const schoolC = `s_${'c'.repeat(32)}`;
  const schools = new Map([
    [schoolA, { _id: schoolA, name: '第一大学', platformStatus: 'active', officialStatus: 'valid' }],
    [schoolB, { _id: schoolB, name: '第二大学', platformStatus: 'active', officialStatus: 'valid' }],
    [schoolC, { _id: schoolC, name: '第三大学', platformStatus: 'active', officialStatus: 'valid' }]
  ]);
  let identity = { OPENID: 'openid-phase24-new', APPID: 'phase24-app' };
  const database = {
    collection(name) {
      const records = name === 'users' ? users : schools;
      return {
        where(condition) {
          return {
            limit() {
              return {
                async get() {
                  const record = records.get(condition._id);
                  return { data: record ? [{ ...record }] : [] };
                }
              };
            }
          };
        },
        doc(id) {
          return {
            async get() {
              const record = records.get(id);
              if (!record) throw new Error('document does not exist');
              return { data: { ...record } };
            },
            async set({ data }) {
              records.set(id, { ...data, _id: id });
            },
            async update({ data }) {
              const current = records.get(id);
              if (!current) throw new Error('document does not exist');
              records.set(id, { ...current, ...data, _id: id });
            }
          };
        }
      };
    },
    serverDate() {
      return new Date('2026-08-11T08:00:00.000Z');
    },
    async runTransaction(callback) {
      return callback({ collection: database.collection.bind(database) });
    }
  };
  return {
    users,
    schoolA,
    schoolB,
    schoolC,
    setIdentity(value) {
      identity = { ...value };
    },
    cloud: {
      DYNAMIC_CURRENT_ENV: 'dynamic',
      init() {},
      database() {
        return database;
      },
      getWXContext() {
        return { ...identity };
      }
    }
  };
}

async function verifyAuthUserIdentityFlow() {
  const functionPath = path.join(ROOT, 'cloudfunctions/authUser/index.js');
  const originalLoad = Module._load;
  const mock = createAuthCloudMock();
  Module._load = function loadCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') return mock.cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(functionPath)];
  try {
    const authUser = require(functionPath);
    const created = await authUser.main({
      action: 'loginIdentity',
      OPENID: 'forged-event-openid',
      data: {
        openid: 'forged-data-openid',
        userId: 'u_forged',
        schoolId: mock.schoolC,
        profileCompleted: true,
        nickname: '伪造昵称',
        avatarUrl: 'cloud://forged/avatar.png'
      }
    });
    check(created.success === true, 'new identity login succeeds');
    check(mock.users.size === 1, 'new identity creates exactly one user');
    check(created.data.user.nickname === '', 'new identity nickname remains empty');
    check(created.data.user.avatarUrl === '', 'new identity avatar remains empty');
    check(created.data.user.profileCompleted === false, 'new identity profile remains incomplete');
    check(created.data.user.schoolRequired === true, 'new identity requires school selection');
    check(created.data.user.schoolId === '', 'new identity does not forge a school');
    const userId = created.data.user.publicUserId;
    check(mock.users.get(userId).openid === 'openid-phase24-new', 'identity comes only from getWXContext');

    mock.users.set(userId, {
      ...mock.users.get(userId),
      nickname: '原昵称',
      avatarUrl: 'cloud://safe/avatars/original.png',
      profileCompleted: true,
      schoolId: mock.schoolA,
      schoolName: '第一大学',
      schoolVersion: 7
    });
    const restored = await authUser.main({ action: 'loginIdentity' });
    check(restored.success === true && mock.users.size === 1, 'existing identity is restored idempotently');
    check(restored.data.user.nickname === '原昵称', 'existing nickname is preserved');
    check(restored.data.user.avatarUrl === 'cloud://safe/avatars/original.png', 'existing avatar is preserved');
    check(restored.data.user.schoolId === mock.schoolA, 'existing school is preserved');
    check(restored.data.user.schoolVersion === 7, 'existing schoolVersion is preserved');

    mock.users.set(userId, {
      ...mock.users.get(userId),
      nickname: '',
      avatarUrl: '',
      profileCompleted: false,
      schoolChangedAt: ''
    });
    const changed = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: mock.schoolB }
    });
    check(changed.success === true, 'incomplete-profile identity can update school when cooldown allows');
    check(changed.data.user.schoolId === mock.schoolB, 'school update uses the requested active school');
    check(changed.data.user.schoolName === '第二大学', 'school update uses authoritative school name');
    check(changed.data.user.schoolVersion === 8, 'school update increments schoolVersion');
    check(changed.data.user.profileCompleted === false, 'school update does not alter profile completion');
    const cooldown = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: mock.schoolC }
    });
    check(cooldown.code === 'SCHOOL_CHANGE_COOLDOWN', 'school cooldown still rejects an immediate second change');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function verifyClientIdentityFlow() {
  const AuthService = require(path.join(ROOT, 'services/auth-service'));
  const AuthStore = require(path.join(ROOT, 'store/auth-store'));
  const originalWx = global.wx;
  const originalIdentity = AuthService.loginIdentity;
  const originalUpdateProfile = AuthService.updateProfile;
  const originalSelectSchool = AuthService.selectSchool;
  const storage = new Map();
  global.wx = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    removeStorageSync(key) { storage.delete(key); }
  };
  const identityUser = {
    id: `u_${'1'.repeat(32)}`,
    nickname: '',
    displayNickname: '校园用户',
    avatarUrl: '',
    avatarText: '校',
    status: 'active',
    profileCompleted: false,
    schoolId: '',
    schoolName: '',
    schoolVersion: 0,
    schoolRequired: true,
    schoolUnavailable: false
  };
  try {
    AuthStore.clearSession();
    AuthService.loginIdentity = async () => ({ ...identityUser });
    await AuthStore.loginIdentity();
    check(AuthStore.isLoggedIn() === true, 'incomplete profile is still an authenticated identity');
    check(AuthStore.isSchoolReady() === false, 'identity without school is not schoolReady');
    check(AuthStore.isProfileConfirmationRequired() === true, 'explicit identity login requires profile confirmation');
    check(AuthStore.getCurrentUser().profileCompleted === false, 'AuthStore preserves profile completion as display state');
    check(storage.has('auth:user-summary'), 'identity login writes the safe user summary');
    check(storage.has('auth:login-transaction'), 'identity login persists the explicit login transaction');

    AuthService.updateProfile = async () => ({
      ...identityUser,
      nickname: '确认用户',
      avatarUrl: 'cloud://test/avatars/u/avatar.png',
      profileCompleted: true
    });
    await AuthStore.confirmLoginProfile({
      nickname: '确认用户',
      avatarUrl: 'cloud://test/avatars/u/avatar.png'
    });
    check(
      AuthStore.getState().loginStage === AuthStore.LOGIN_STAGE.SCHOOL_SELECTION_REQUIRED,
      'profile confirmation advances a new user to school selection'
    );

    AuthService.selectSchool = async () => ({
      ...identityUser,
      nickname: '确认用户',
      avatarUrl: 'cloud://test/avatars/u/avatar.png',
      profileCompleted: true,
      schoolId: `s_${'a'.repeat(32)}`,
      schoolName: '第一大学',
      schoolVersion: 1,
      schoolRequired: false
    });
    await AuthStore.selectSchool(`s_${'a'.repeat(32)}`);
    check(AuthStore.isLoggedIn() === true, 'selected incomplete profile remains authenticated');
    check(AuthStore.isSchoolReady() === true, 'authenticated identity with valid school becomes schoolReady');
    check(AuthStore.getCurrentUser().profileCompleted === true, 'school selection preserves confirmed profile state');
    check(AuthStore.getState().loginStage === AuthStore.LOGIN_STAGE.READY, 'school selection completes the explicit login steps');

    AuthStore.logout();
    check(AuthStore.isLoggedIn() === false, 'explicit logout clears authenticated identity');
    check(AuthStore.getCurrentUser() === null, 'explicit logout clears current user');
    check(!storage.has('auth:user-summary'), 'explicit logout clears cached summary');
    check(!storage.has('auth:login-transaction'), 'explicit logout clears the login transaction');
  } finally {
    AuthService.loginIdentity = originalIdentity;
    AuthService.updateProfile = originalUpdateProfile;
    AuthService.selectSchool = originalSelectSchool;
    AuthStore.clearSession();
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
  }
}

function verifyStaticBoundaries() {
  const authFunction = read('cloudfunctions/authUser/index.js');
  const createFunction = read('cloudfunctions/createProduct/index.js');
  const productQuery = read('cloudfunctions/productQuery/index.js');
  const userQuery = read('cloudfunctions/userQuery/index.js');
  const authStore = read('store/auth-store.js');
  const authGuard = read('services/auth-guard.js');
  const loginJs = read('pages/login/index.js');
  const loginWxml = read('pages/login/index.wxml');
  const profileEditJs = read('pages/profile-edit/index.js');
  const profileEditWxml = read('pages/profile-edit/index.wxml');
  const schoolSelect = read('pages/school-select/index.js');
  const routes = read('constants/routes.js');
  const helper = read('utils/user-presentation.js');

  check(/['"]loginIdentity['"]/.test(authFunction), 'authUser exposes loginIdentity');
  check(/cloud\.getWXContext\(\)/.test(authFunction), 'authUser uses trusted WeChat context');
  check(!/loginIdentity\(identity,\s*input/.test(authFunction), 'loginIdentity does not consume client profile input');
  check(/nickname:\s*['"]['"]/.test(authFunction), 'new identity stores an empty nickname');
  check(/avatarUrl:\s*['"]['"]/.test(authFunction), 'new identity stores an empty avatar');
  check(/profileCompleted:\s*false/.test(authFunction), 'new identity stores incomplete profile state');
  check(!/function updateSchool[\s\S]{0,900}isProfileComplete/.test(authFunction), 'updateSchool no longer requires profile completion');
  check(!/profileCompleted/.test(createFunction), 'createProduct no longer uses profile completion');
  check(!/profileCompleted/.test(productQuery), 'productQuery no longer uses profile completion');
  check(!/profileCompleted/.test(userQuery), 'userQuery no longer requires viewer profile completion');
  check(/user\.status\s*!==\s*['"]active['"]/.test(createFunction), 'createProduct still requires active user');
  check(/platformStatus\s*!==\s*['"]active['"]/.test(createFunction), 'createProduct still requires active school');
  check(/officialStatus\s*!==\s*['"]valid['"]/.test(createFunction), 'createProduct still requires officially valid school');
  check(/strictForAll/.test(productQuery) && /accessRequiresAuth/.test(productQuery), 'productQuery keeps strict authenticated market configuration');
  check(/CROSS_SCHOOL_READONLY/.test(productQuery), 'productQuery keeps cross-school read-only detail');
  check(/schoolVersion/.test(userQuery), 'userQuery keeps viewer schoolVersion scope');

  check(/function isLoggedIn\(\)[\s\S]{0,180}Boolean\(state\.user\)/.test(authStore), 'AuthStore authentication depends on trusted identity');
  check(!/function isLoggedIn\(\)[\s\S]{0,220}profileCompleted/.test(authStore), 'AuthStore authentication is decoupled from profile');
  check(!/function requireLogin[\s\S]{0,700}profileCompleted/.test(authGuard), 'AuthGuard core access is decoupled from profile');
  check(!/ensureSelectionAccess[\s\S]{0,650}profileCompleted/.test(schoolSelect), 'school-select accepts incomplete-profile identities');
  check(/navigateAfterLogin/.test(loginJs), 'login preserves safe target continuation');
  check(/AuthStore\.loginIdentity/.test(loginJs), 'login page establishes identity through AuthStore');
  check(/type="nickname"/.test(loginWxml), 'explicit login confirmation uses the nickname input capability');
  check(/open-type="chooseAvatar"/.test(loginWxml), 'explicit login confirmation uses the avatar selection capability');
  check(/AuthStore\.confirmLoginProfile/.test(loginJs), 'login page confirms profile through the explicit transaction API');
  check(!/getUserProfile|getUserInfo/.test(loginJs + loginWxml), 'login does not use deprecated profile acquisition APIs');
  check(/微信登录/.test(loginWxml), 'login page uses explicit WeChat login wording');
  check(!/确认并登录|匿名浏览|浏览商品无需登录/.test(loginWxml), 'login page removed misleading legacy wording');
  check(/type="nickname"/.test(profileEditWxml), 'profile edit owns nickname input');
  check(/open-type="chooseAvatar"/.test(profileEditWxml), 'profile edit owns avatar selection');
  check(/AuthStore\.updateProfile/.test(profileEditJs), 'profile edit uses the existing safe updateProfile path');
  check(/PROFILE_EDIT/.test(routes), 'profile edit route is registered centrally');

  check(/DEFAULT_USER_NICKNAME\s*=\s*['"]校园用户['"]/.test(helper), 'user fallback nickname is centralized');
  check(/DEFAULT_USER_AVATAR_TEXT\s*=\s*['"]校['"]/.test(helper), 'default avatar text is centralized');
  check(/微信用户/.test(helper) && /即出用户/.test(helper) && /匿名用户/.test(helper), 'legacy placeholder nicknames normalize through one helper');
  check(!/getPhoneNumber|chooseContact|startLocationUpdate|onLocationChange/.test(loginJs + loginWxml), 'login does not request unrelated permissions');
  check(!/phase-24-complete|phase-24-round-2-complete/.test(loginJs + authFunction), 'round two does not introduce completion tags');
}

async function run() {
  verifyStaticBoundaries();
  await verifyAuthUserIdentityFlow();
  await verifyClientIdentityFlow();
  process.stdout.write(`Phase 24 auth-flow verification succeeded: ${checks.length} checks passed.\n`);
}

run().catch((error) => {
  process.stderr.write(`PHASE24_AUTH_FLOW_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
