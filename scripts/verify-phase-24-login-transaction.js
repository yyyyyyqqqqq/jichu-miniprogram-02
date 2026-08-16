const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STORE_PATH = path.join(ROOT, 'store/auth-store.js');
const AuthService = require(path.join(ROOT, 'services/auth-service.js'));
const AuthGuard = require(path.join(ROOT, 'services/auth-guard.js'));
const checks = [];

function check(condition, message) {
  assert(condition, message);
  checks.push(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buildUser(overrides = {}) {
  return {
    id: `u_${'1'.repeat(32)}`,
    nickname: '',
    avatarUrl: '',
    profileCompleted: false,
    status: 'active',
    schoolId: '',
    schoolName: '',
    schoolVersion: 0,
    schoolRequired: true,
    schoolUnavailable: false,
    ...overrides
  };
}

async function run() {
  const originalWx = global.wx;
  const originalGetCurrentUser = AuthService.getCurrentUser;
  const originalLoginIdentity = AuthService.loginIdentity;
  const originalUpdateProfile = AuthService.updateProfile;
  const originalSelectSchool = AuthService.selectSchool;
  const originalUpdateSchool = AuthService.updateSchool;
  const storage = new Map();
  global.wx = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    removeStorageSync(key) { storage.delete(key); }
  };

  let AuthStore = require(STORE_PATH);
  const schoolId = `s_${'a'.repeat(32)}`;
  const conversationId = `c_${'b'.repeat(64)}`;
  const appointmentId = `a_${'c'.repeat(64)}`;
  let selectCalls = 0;
  let updateSchoolCalls = 0;

  try {
    AuthStore.clearSession();
    const newUser = buildUser();
    AuthService.loginIdentity = async () => ({ ...newUser });
    await AuthStore.loginIdentity({ target: 'publish' });
    check(AuthStore.isLoggedIn(), 'new identity becomes authenticated');
    check(AuthStore.isProfileConfirmationRequired(), 'new explicit login requires profile confirmation');
    check(!AuthStore.isSchoolReady(), 'new identity is not schoolReady');
    check(AuthStore.getLoginContext().target === 'publish', 'new login preserves the publish target');

    AuthService.updateProfile = async (profile) => ({
      ...newUser,
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
      profileCompleted: true
    });
    await AuthStore.confirmLoginProfile({
      nickname: '新用户',
      avatarUrl: 'cloud://staging/avatars/u/new.png',
      schoolId: `s_${'f'.repeat(32)}`,
      role: 'admin'
    });
    check(
      AuthStore.getState().loginStage === AuthStore.LOGIN_STAGE.SCHOOL_SELECTION_REQUIRED,
      'confirmed new profile advances to school selection'
    );
    check(AuthStore.getCurrentUser().schoolId === '', 'profile confirmation does not select a school');

    AuthService.selectSchool = async () => {
      selectCalls += 1;
      return buildUser({
        nickname: '新用户',
        avatarUrl: 'cloud://staging/avatars/u/new.png',
        profileCompleted: true,
        schoolId,
        schoolName: '第一大学',
        schoolVersion: 1,
        schoolRequired: false
      });
    };
    await AuthStore.selectSchool(schoolId);
    check(AuthStore.isSchoolReady(), 'selected new user becomes schoolReady');
    check(AuthStore.getState().loginStage === AuthStore.LOGIN_STAGE.READY, 'new login reaches ready');
    check(selectCalls === 1, 'new login selects school exactly once');
    check(AuthStore.completeExplicitLogin(), 'successful navigation can close the login transaction');
    check(!storage.has('auth:login-transaction'), 'completed login clears the transaction marker');

    const existingUser = buildUser({
      nickname: '历史用户',
      avatarUrl: 'cloud://staging/avatars/u/history.png',
      profileCompleted: true,
      schoolId,
      schoolName: '第一大学',
      schoolVersion: 7,
      schoolRequired: false
    });
    AuthStore.clearSession();
    AuthService.getCurrentUser = async () => ({ ...existingUser });
    await AuthStore.bootstrap({ force: true });
    check(AuthStore.isSchoolReady(), 'normal existing session restores without a login transaction');
    check(!AuthStore.isExplicitLoginInProgress(), 'normal session restore does not require repeated profile confirmation');

    AuthStore.logout();
    check(!AuthStore.isLoggedIn(), 'explicit logout returns to anonymous');
    check(!storage.has('auth:user-summary'), 'explicit logout removes the auth snapshot');
    check(!storage.has('auth:login-transaction'), 'explicit logout removes profile confirmation state');
    let currentCalls = 0;
    AuthService.getCurrentUser = async () => {
      currentCalls += 1;
      return { ...existingUser };
    };
    await AuthStore.refreshCurrentUser();
    check(!AuthStore.isLoggedIn(), 'App.onShow after logout remains anonymous');
    check(currentCalls === 0, 'explicit logout blocks automatic current restoration');

    AuthService.loginIdentity = async () => ({ ...existingUser });
    await AuthStore.loginIdentity({
      target: 'appointment-detail',
      appointmentId
    });
    check(AuthStore.isProfileConfirmationRequired(), 'existing user must reconfirm profile after logout');
    check(AuthStore.getCurrentUser().nickname === '历史用户', 'historical nickname is only an initial reference');
    AuthService.updateProfile = async (profile) => ({
      ...existingUser,
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
      profileCompleted: true
    });
    AuthService.updateSchool = async () => {
      updateSchoolCalls += 1;
      return { ...existingUser };
    };
    const selectCallsBeforeExistingLogin = selectCalls;
    await AuthStore.confirmLoginProfile({
      nickname: '重新确认用户',
      avatarUrl: existingUser.avatarUrl
    });
    check(AuthStore.getState().loginStage === AuthStore.LOGIN_STAGE.READY, 'existing valid school skips school selection after profile confirmation');
    check(AuthStore.getCurrentUser().schoolId === schoolId, 'existing schoolId is preserved');
    check(AuthStore.getCurrentUser().schoolVersion === 7, 'existing schoolVersion is preserved');
    check(selectCalls === selectCallsBeforeExistingLogin, 'existing school does not call selectSchool');
    check(updateSchoolCalls === 0, 'relogin does not call updateSchool or start cooldown');
    check(AuthStore.getLoginContext().appointmentId === appointmentId, 'appointment target survives relogin confirmation');

    AuthStore.completeExplicitLogin();
    AuthStore.logout();
    await AuthStore.loginIdentity({ target: 'chat', conversationId });
    const pendingProfile = deferred();
    AuthService.updateProfile = async () => pendingProfile.promise;
    const staleConfirmation = AuthStore.confirmLoginProfile({
      nickname: '晚到资料',
      avatarUrl: existingUser.avatarUrl
    });
    AuthStore.logout();
    pendingProfile.resolve({ ...existingUser, nickname: '晚到资料' });
    await staleConfirmation;
    check(!AuthStore.isLoggedIn(), 'late profile response cannot revive a logged-out session');
    check(AuthStore.getCurrentUser() === null, 'late profile response cannot restore the old user');
    check(!storage.has('auth:user-summary'), 'late profile response cannot rewrite the auth cache');

    await AuthStore.loginIdentity({ target: 'chat', conversationId });
    check(storage.has('auth:login-transaction'), 'profile confirmation state is persisted across process restart');
    AuthService.getCurrentUser = async () => ({ ...existingUser });
    delete require.cache[require.resolve(STORE_PATH)];
    AuthStore = require(STORE_PATH);
    await AuthStore.bootstrap({ force: true });
    check(AuthStore.isProfileConfirmationRequired(), 'process restart restores pending profile confirmation');
    check(AuthStore.getLoginContext().conversationId === conversationId, 'process restart restores the original deep-link target');

    const chatLoginUrl = AuthGuard.buildLoginUrl({ target: 'chat', conversationId });
    const appointmentSchoolUrl = AuthGuard.buildSchoolSelectUrl({
      target: 'appointment-detail',
      appointmentId
    });
    check(chatLoginUrl.includes(`conversationId=${conversationId}`), 'chat login URL keeps conversationId');
    check(appointmentSchoolUrl.includes(`appointmentId=${appointmentId}`), 'school selection URL keeps appointmentId');
    check(!AuthGuard.buildLoginUrl({ target: 'chat', conversationId: '../unsafe' }).includes('unsafe'), 'invalid deep-link parameters are rejected');

    AuthStore.logout();
  } finally {
    AuthService.getCurrentUser = originalGetCurrentUser;
    AuthService.loginIdentity = originalLoginIdentity;
    AuthService.updateProfile = originalUpdateProfile;
    AuthService.selectSchool = originalSelectSchool;
    AuthService.updateSchool = originalUpdateSchool;
    try {
      AuthStore.clearSession();
    } catch (error) {}
    delete require.cache[require.resolve(STORE_PATH)];
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
  }

  process.stdout.write(
    `Phase 24 login-transaction verification succeeded: ${checks.length} checks passed.\n`
  );
}

run().catch((error) => {
  process.stderr.write(`PHASE24_LOGIN_TRANSACTION_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
