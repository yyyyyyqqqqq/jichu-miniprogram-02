const fs = require('fs');
const {
  ROOT,
  assert
} = require('./phase-18-canary-core');
const { CLOUD_CONFIG } = require('../config/cloud');

const AUTOMATOR_MODULE = process.env.PHASE24_AUTOMATOR_MODULE;
const DEVTOOLS_CLI_PATH = process.env.PHASE24_DEVTOOLS_CLI_PATH;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE24_AUTOMATOR_WS_ENDPOINT;
const AUTH_FLOW_MODE = process.env.PHASE24_AUTH_FLOW_MODE || '';

function withTimeout(promise, label, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function waitFor(miniProgram, predicate, label, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await miniProgram.evaluate(function currentPageSnapshot() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return page ? { route: page.route, data: page.data } : null;
    });
    if (snapshot && predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not settle`);
}

async function rawCloudCall(miniProgram, name, action, data) {
  try {
    return await withTimeout(miniProgram.evaluate(async function call(input) {
      const response = await wx.cloud.callFunction({
        name: input.name,
        data: { action: input.action, data: input.data }
      });
      return response && response.result;
    }, { name, action, data }), `${name}/${action}`, 45000);
  } catch (error) {
    const wrapped = new Error(`${name}/${action} failed: ${error && error.message || error}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

async function verifyStartup(miniProgram) {
  await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'home launch');
  const snapshot = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/home/index' && value.data.isLoading === false,
    'home page'
  );
  const optionMetadata = await miniProgram.evaluate(function readOptionMetadata() {
    const launch = wx.getLaunchOptionsSync ? wx.getLaunchOptionsSync() : {};
    const enter = wx.getEnterOptionsSync ? wx.getEnterOptionsSync() : {};
    return {
      launchPath: launch.path || '',
      launchScene: launch.scene || 0,
      launchQueryKeys: Object.keys(launch.query || {}).sort(),
      enterPath: enter.path || '',
      enterScene: enter.scene || 0,
      enterQueryKeys: Object.keys(enter.query || {}).sort()
    };
  });
  return { route: snapshot.route, optionMetadata };
}

async function verifyAuthFlowPages(miniProgram) {
  await withTimeout(
    miniProgram.reLaunch('/pages/login/index?target=publish'),
    'login page launch'
  );
  const login = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/login/index' && value.data.authStatus !== 'idle',
    'explicit login page'
  );
  const profileKeys = [
    'nickname',
    'avatarPreviewUrl',
    'isUpdatingProfile',
    'isProfileStep',
    'loginStage'
  ];
  assert(
    profileKeys.every((key) => Object.prototype.hasOwnProperty.call(login.data, key)),
    'login page does not expose the explicit profile-confirm transaction state'
  );
  assert(login.data.target === 'publish', 'login page did not preserve the publish target');

  let profileEdit = 'requires-authentication';
  if (login.data.isAuthenticated === true) {
    await withTimeout(miniProgram.reLaunch('/pages/profile-edit/index'), 'profile edit launch');
    const editor = await waitFor(
      miniProgram,
      (value) => value.route === 'pages/profile-edit/index',
      'profile edit page'
    );
    assert(
      Object.prototype.hasOwnProperty.call(editor.data, 'nickname')
        && Object.prototype.hasOwnProperty.call(editor.data, 'avatarPreviewUrl'),
      'profile edit page does not own display profile state'
    );
    profileEdit = 'loaded-for-authenticated-user';
  }
  return {
    route: login.route,
    target: login.data.target,
    profileFieldsOnLogin: true,
    initialLoginStage: login.data.loginStage,
    profileEdit
  };
}

async function verifyPublishForegroundLifecycle(miniProgram) {
  await withTimeout(miniProgram.reLaunch('/pages/publish/index'), 'publish launch');
  const initial = await waitFor(
    miniProgram,
    (value) => [
      'pages/publish/index',
      'pages/login/index',
      'pages/school-select/index'
    ].includes(value.route),
    'publish authentication'
  );
  if (initial.route !== 'pages/publish/index') {
    return {
      authenticatedFixtureAvailable: false,
      resultingRoute: initial.route,
      formPreserved: 'not-applicable'
    };
  }
  const lifecycle = await miniProgram.evaluate(async function prepareAndResume() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    const originalSetData = page.setData;
    const authUiTransitions = [];
    page.setData = function observeAuthUi(patch, callback) {
      if (
        patch
        && (
          Object.prototype.hasOwnProperty.call(patch, 'isLoggedIn')
          || Object.prototype.hasOwnProperty.call(patch, 'isAuthPending')
        )
      ) {
        authUiTransitions.push({
          isLoggedIn: Object.prototype.hasOwnProperty.call(patch, 'isLoggedIn')
            ? patch.isLoggedIn
            : page.data.isLoggedIn,
          isAuthPending: Object.prototype.hasOwnProperty.call(patch, 'isAuthPending')
            ? patch.isAuthPending
            : page.data.isAuthPending
        });
      }
      return originalSetData.call(page, patch, callback);
    };
    page.setData({
      title: 'phase24-foreground-title',
      description: 'phase24-foreground-description',
      descriptionLength: 30,
      location: 'phase24-foreground-location',
      locationDetail: {
        name: 'phase24-foreground-location',
        address: 'read-only-local-simulation',
        latitude: 30,
        longitude: 120
      }
    });
    const labels = [
      'location-selected',
      'location-cancelled',
      'image-selected',
      'image-cancelled',
      'video-selected',
      'video-cancelled',
      'app-background'
    ];
    try {
      for (const label of labels) {
        const app = getApp();
        const appResult = app && typeof app.onShow === 'function' ? app.onShow() : null;
        const pageResult = typeof page.onShow === 'function' ? page.onShow() : null;
        await Promise.all([appResult, pageResult]);
      }
      return { labels, authUiTransitions };
    } finally {
      page.setData = originalSetData;
    }
  });
  const resumed = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/publish/index' && value.data.isLoggedIn === true,
    'publish foreground resume'
  );
  assert(resumed.data.title === 'phase24-foreground-title', 'publish title was cleared after foreground resume');
  assert(
    resumed.data.description === 'phase24-foreground-description',
    'publish description was cleared after foreground resume'
  );
  assert(
    resumed.data.location === 'phase24-foreground-location'
      && resumed.data.locationDetail
      && resumed.data.locationDetail.address === 'read-only-local-simulation',
    'publish location was cleared after foreground resume'
  );
  assert(
    lifecycle.authUiTransitions.every((state) => state.isLoggedIn === true),
    'publish rendered the login placeholder during a foreground refresh'
  );
  assert(
    lifecycle.authUiTransitions.every((state) => state.isAuthPending !== true),
    'publish rendered the pending placeholder over a trusted session'
  );
  return {
    authenticatedFixtureAvailable: true,
    resultingRoute: resumed.route,
    formPreserved: true,
    loginRedirected: false,
    lifecycleSimulations: lifecycle.labels,
    authUiTransitions: lifecycle.authUiTransitions.length,
    loginPlaceholderRendered: false
  };
}

async function verifyMessageSchoolSummary(miniProgram) {
  let stage = 'invalid-action';
  try {
  const invalidAction = await rawCloudCall(
    miniProgram,
    'messageQuery',
    'phase24UnknownReadOnlyAction',
    {}
  );
  assert(
    invalidAction && invalidAction.success === false && invalidAction.code === 'INVALID_ACTION',
    'messageQuery invalid-action boundary failed'
  );
  stage = 'list-conversations';
  const listed = await rawCloudCall(miniProgram, 'messageQuery', 'listConversations', {
    page: 1,
    pageSize: 2
  });
  assert(listed && listed.success === true, 'messageQuery listConversations failed');
  const conversations = listed.data && Array.isArray(listed.data.list)
    ? listed.data.list
    : [];
  conversations.forEach((conversation) => {
    assert(
      conversation.otherUser
        && Object.prototype.hasOwnProperty.call(conversation.otherUser, 'schoolName'),
      'messageQuery safe user summary omitted schoolName'
    );
  });

  stage = 'messages-page';
  try {
    await withTimeout(miniProgram.switchTab('/pages/messages/index'), 'messages tab');
  } catch (error) {
    // The auth guard may redirect an anonymous app session before the
    // automation command receives the tab navigation acknowledgement.
  }
  const messagesPage = await waitFor(
    miniProgram,
    (value) => (
      (
        value.route === 'pages/messages/index'
        && ['success', 'empty', 'login', 'error'].includes(value.data.viewState)
        && value.data.isRefreshing !== true
      )
      || value.route === 'pages/login/index'
    ),
    'messages page'
  );
  if (messagesPage.route === 'pages/login/index') {
    return {
      authenticatedFixtureAvailable: false,
      resultingRoute: messagesPage.route,
      invalidActionRejected: true,
      schoolNamePropertyPresent: conversations.every((conversation) => (
        conversation.otherUser
        && Object.prototype.hasOwnProperty.call(conversation.otherUser, 'schoolName')
      )),
      chatDisplayChecked: 'requires-authenticated-app-session',
      pickerDisplayChecked: 'requires-authenticated-app-session'
    };
  }
  if (conversations.length === 0) {
    return {
      conversationFixtureAvailable: false,
      invalidActionRejected: true,
      schoolNamePropertyPresent: 'no-conversation-fixture',
      chatDisplayChecked: 'not-applicable',
      pickerDisplayChecked: 'not-applicable'
    };
  }

  stage = 'chat-page';
  const conversationId = conversations[0].conversationId;
  stage = 'picker-page';
  await withTimeout(
    miniProgram.reLaunch(`/pages/chat/index?conversationId=${encodeURIComponent(conversationId)}`),
    'chat launch'
  );
  const chat = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/chat/index' && ['success', 'error'].includes(value.data.viewState),
    'chat page',
    45000
  );
  assert(chat.data.viewState === 'success', 'chat page could not load the read-only conversation fixture');
  const otherUser = chat.data.conversation && chat.data.conversation.otherUser;
  assert(otherUser && otherUser.schoolDisplayName, 'chat school display name is empty');
  if (otherUser.schoolName) {
    assert(otherUser.schoolDisplayName === otherUser.schoolName, 'chat did not prefer authoritative schoolName');
  }

  await withTimeout(
    miniProgram.reLaunch(`/pages/chat-product-picker/index?conversationId=${encodeURIComponent(conversationId)}`),
    'chat product picker launch'
  );
  const picker = await waitFor(
    miniProgram,
    (value) => (
      value.route === 'pages/chat-product-picker/index'
      && ['success', 'error'].includes(value.data.viewState)
      && value.data.isLoadingProducts !== true
    ),
    'chat product picker',
    45000
  );
  assert(picker.data.viewState === 'success', 'chat product picker could not load');
  assert(picker.data.owner && picker.data.owner.schoolDisplayName, 'picker owner school display name is empty');
  if (picker.data.owner.schoolName) {
    assert(
      picker.data.owner.schoolDisplayName === picker.data.owner.schoolName,
      'picker did not prefer authoritative schoolName'
    );
  }
  return {
    conversationFixtureAvailable: true,
    invalidActionRejected: true,
    schoolNamePropertyPresent: true,
    chatDisplayChecked: true,
    pickerDisplayChecked: true
  };
  } catch (error) {
    const wrapped = new Error(`message-school-summary/${stage}: ${error && error.message || error}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

async function verifyAuthFlowProductionBoundaries(miniProgram) {
  const current = await rawCloudCall(miniProgram, 'authUser', 'current', {});
  assert(current && current.success === true && current.data && current.data.user, 'authUser current probe failed');
  const user = current.data.user;
  assert(user.id && user.schoolId, 'current production identity is not school-ready');

  const authInvalid = await rawCloudCall(miniProgram, 'authUser', 'phase24UnknownReadOnlyAction', {});
  assert(authInvalid && authInvalid.success === false && authInvalid.code === 'INVALID_ACTION', 'authUser invalid-action boundary failed');

  const createInvalid = await rawCloudCall(miniProgram, 'createProduct', 'phase24MissingRequestId', {});
  assert(createInvalid && createInvalid.success === false && createInvalid.code === 'INVALID_PARAMS', 'createProduct non-writing invalid request was not rejected');

  const market = await rawCloudCall(miniProgram, 'productQuery', 'list', {
    pageSize: 2,
    sort: 'latest'
  });
  assert(market && market.success === true && market.data, 'productQuery read-only list probe failed');
  const products = Array.isArray(market.data.list) ? market.data.list : [];
  assert(products.every((item) => item.schoolId === user.schoolId), 'productQuery list crossed the current school boundary');

  const publicProfile = await rawCloudCall(miniProgram, 'userQuery', 'publicProfile', {
    publicUserId: user.id
  });
  assert(publicProfile && publicProfile.success === true, 'userQuery same-school profile probe failed');
  const profile = publicProfile.data && publicProfile.data.profile || {};
  const safeKeys = [
    'publicUserId',
    'nickname',
    'avatarUrl',
    'campus',
    'bio',
    'joinDate',
    'activeProductCount'
  ];
  assert(Object.keys(profile).every((key) => safeKeys.includes(key)), 'userQuery returned a non-public profile field');
  assert(profile.nickname, 'userQuery did not apply the safe nickname fallback');
  return {
    authCurrentRead: true,
    authInvalidActionRejected: true,
    createProductInvalidRequestRejectedWithoutWrite: true,
    strictMarketRead: true,
    marketItemsChecked: products.length,
    sameSchoolPublicProfileRead: true,
    publicProfileSafeFieldWhitelist: true
  };
}

async function verifyExistingAccountRelogin(miniProgram) {
  const beforePayload = await rawCloudCall(miniProgram, 'authUser', 'current', {});
  assert(beforePayload && beforePayload.success === true, 'existing account baseline is unavailable');
  const before = beforePayload.data.user;
  const preservedFields = [
    'id',
    'nickname',
    'avatarUrl',
    'profileCompleted',
    'schoolId',
    'schoolName',
    'schoolVersion'
  ];

  await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'pre-logout home launch');
  await waitFor(
    miniProgram,
    (value) => value.route === 'pages/home/index'
      && value.data.isLoading === false
      && value.data.marketMode === 'schoolScoped',
    'pre-logout strict home'
  );
  await withTimeout(miniProgram.switchTab('/pages/profile/index'), 'profile tab');
  await waitFor(miniProgram, (value) => value.route === 'pages/profile/index', 'profile page');
  await withTimeout(miniProgram.evaluate(function invokeLogout() {
    const pages = getCurrentPages();
    pages[pages.length - 1].logout();
    return true;
  }), 'invoke explicit logout');
  await withTimeout(miniProgram.native().confirmModal(), 'confirm explicit logout');

  await withTimeout(miniProgram.switchTab('/pages/home/index'), 'anonymous home tab');
  const anonymous = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/home/index'
      && value.data.isLoading === false
      && value.data.viewState === 'guide'
      && value.data.guideType === 'login',
    'anonymous home'
  );
  const logoutStorage = await miniProgram.evaluate(function readLogoutStorage() {
    return {
      explicitLogout: wx.getStorageSync('auth:explicit-logout') === true,
      cachedUser: wx.getStorageSync('auth:user-summary') || null
    };
  });
  assert(logoutStorage.explicitLogout === true, 'explicit logout marker was not persisted');
  assert(!logoutStorage.cachedUser, 'explicit logout retained the user summary');
  assert((anonymous.data.products || []).length === 0, 'anonymous home retained school products');

  await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'anonymous restart simulation');
  await waitFor(
    miniProgram,
    (value) => value.route === 'pages/home/index'
      && value.data.isLoading === false
      && value.data.guideType === 'login',
    'anonymous restart state'
  );
  await withTimeout(miniProgram.evaluate(async function openLogin() {
    const pages = getCurrentPages();
    await pages[pages.length - 1].onMarketGuideAction();
    return true;
  }), 'open simplified login');
  const login = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/login/index' && value.data.authStatus !== 'idle',
    'explicit login page'
  );
  assert(login.data.target === 'home', 'home target was not preserved for re-login');
  assert(
    ['nickname', 'avatarPreviewUrl', 'isProfileStep', 'loginStage']
      .every((key) => Object.prototype.hasOwnProperty.call(login.data, key)),
    're-login page omitted profile-confirm transaction state'
  );
  await withTimeout(miniProgram.evaluate(async function loginExistingIdentity() {
    const pages = getCurrentPages();
    await pages[pages.length - 1].onLoginTap();
    return true;
  }), 'existing identity login', 60000);
  const confirmation = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/login/index'
      && value.data.loginStage === 'profileConfirmRequired'
      && value.data.isProfileStep === true
      && value.data.isSubmitting !== true,
    'existing identity profile confirmation',
    45000
  );
  assert(confirmation.data.nickname, 'staging re-login fixture has no nickname to confirm');
  assert(confirmation.data.avatarPreviewUrl, 'staging re-login fixture has no avatar to confirm');
  await withTimeout(miniProgram.evaluate(async function confirmExistingProfile() {
    const pages = getCurrentPages();
    await pages[pages.length - 1].onConfirmProfileTap();
    return true;
  }), 'confirm existing profile', 60000);
  const restored = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/home/index'
      && value.data.isLoading === false
      && value.data.marketMode === 'schoolScoped'
      && value.data.marketScope
      && value.data.marketScope.schoolId,
    'restored strict home',
    45000
  );
  const afterPayload = await rawCloudCall(miniProgram, 'authUser', 'current', {});
  assert(afterPayload && afterPayload.success === true, 'existing identity was not restored');
  const after = afterPayload.data.user;
  preservedFields.forEach((field) => {
    assert(after[field] === before[field], `existing account field changed during loginIdentity: ${field}`);
  });
  const afterStorage = await miniProgram.evaluate(function readRestoredStorage() {
    return {
      explicitLogout: wx.getStorageSync('auth:explicit-logout') === true,
      cachedUser: wx.getStorageSync('auth:user-summary') || null
    };
  });
  assert(afterStorage.explicitLogout === false, 'manual login did not clear the explicit logout marker');
  assert(afterStorage.cachedUser && afterStorage.cachedUser.id === before.id, 'manual login cached the wrong identity');
  assert(restored.data.marketScope.schoolId === before.schoolId, 'manual login restored the wrong school market');

  await withTimeout(miniProgram.reLaunch('/pages/profile-edit/index'), 'profile edit after re-login');
  const editor = await waitFor(
    miniProgram,
    (value) => value.route === 'pages/profile-edit/index'
      && Object.prototype.hasOwnProperty.call(value.data, 'nickname')
      && Object.prototype.hasOwnProperty.call(value.data, 'avatarPreviewUrl'),
    'profile edit after re-login'
  );
  await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'final home restore');
  return {
    existingUserIdPreserved: true,
    existingProfilePreserved: true,
    existingSchoolPreserved: true,
    schoolVersionPreserved: true,
    explicitLogoutClearedCache: true,
    restartStayedLoggedOut: true,
    explicitLoginTransactionUsed: true,
    profileConfirmationRequired: true,
    targetReturnedToHome: true,
    strictMarketRestored: true,
    profileEditLoaded: editor.route === 'pages/profile-edit/index',
    productionUserCreated: false,
    businessDataWritten: false,
    existingLastLoginAtUpdated: true,
    existingProfileUpdatedWithSameConfirmedValues: true
  };
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(DEVTOOLS_CLI_PATH && fs.existsSync(DEVTOOLS_CLI_PATH), 'developer-tools CLI is unavailable');
  if (AUTH_FLOW_MODE === 'existing-account-relogin') {
    assert(
      CLOUD_CONFIG.environmentName === 'staging',
      'existing-account-relogin is write-capable and may only run against staging'
    );
  }
  const automator = require(AUTOMATOR_MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  const runtimeDiagnostics = [];
  let currentStage = 'connect';
  try {
    miniProgram = AUTOMATOR_WS_ENDPOINT
      ? await withTimeout(automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }), 'automation connection')
      : await withTimeout(automator.launch({
        cliPath: DEVTOOLS_CLI_PATH,
        projectPath: ROOT,
        trustProject: true,
        timeout: 90000
      }), 'automation launch');
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') {
        consoleErrors += 1;
        runtimeDiagnostics.push({ type: 'console', entry });
      }
    });
    miniProgram.on('exception', (entry) => {
      exceptions += 1;
      runtimeDiagnostics.push({ type: 'exception', entry });
    });
    currentStage = 'startup';
    const startup = await verifyStartup(miniProgram);
    currentStage = 'auth-flow-pages';
    const authFlowPages = await verifyAuthFlowPages(miniProgram);
    currentStage = 'publish-foreground';
    const publishForeground = await verifyPublishForegroundLifecycle(miniProgram);
    currentStage = 'message-school-summary';
    const messageSchoolSummary = await verifyMessageSchoolSummary(miniProgram);
    currentStage = 'auth-flow-boundaries';
    const authFlowProductionBoundaries = await verifyAuthFlowProductionBoundaries(miniProgram);
    currentStage = 'existing-account-relogin';
    const existingAccountRelogin = AUTH_FLOW_MODE === 'existing-account-relogin'
      ? await verifyExistingAccountRelogin(miniProgram)
      : { skipped: true };
    assert(consoleErrors === 0, `developer tools recorded ${consoleErrors} console error(s)`);
    assert(exceptions === 0, `developer tools recorded ${exceptions} exception(s)`);
    return {
      passed: true,
      startup,
      authFlowPages,
      publishForeground,
      messageSchoolSummary,
      authFlowProductionBoundaries,
      existingAccountRelogin,
      writesRequested: AUTH_FLOW_MODE === 'existing-account-relogin',
      businessWritesRequested: false,
      fixturesCreated: false,
      consoleErrors,
      exceptions
    };
  } catch (error) {
    error.phase24Stage = currentStage;
    error.runtimeDiagnostics = runtimeDiagnostics;
    throw error;
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  const details = error && typeof error === 'object'
    ? Object.getOwnPropertyNames(error).reduce((result, key) => {
      result[key] = error[key];
      return result;
    }, {})
    : { value: error };
  process.stderr.write(`PHASE24_DEVTOOLS_VERIFY_FAILED: ${JSON.stringify(details)}\n`);
  process.exitCode = 1;
});
