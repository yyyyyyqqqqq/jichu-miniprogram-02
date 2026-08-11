const fs = require('fs');
const {
  ROOT,
  assert
} = require('./phase-18-canary-core');

const AUTOMATOR_MODULE = process.env.PHASE24_AUTOMATOR_MODULE;
const DEVTOOLS_CLI_PATH = process.env.PHASE24_DEVTOOLS_CLI_PATH;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE24_AUTOMATOR_WS_ENDPOINT;

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
  return withTimeout(miniProgram.evaluate(async function call(input) {
    const response = await wx.cloud.callFunction({
      name: input.name,
      data: { action: input.action, data: input.data }
    });
    return response && response.result;
  }, { name, action, data }), `${name}/${action}`, 45000);
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

  await withTimeout(miniProgram.reLaunch('/pages/messages/index'), 'messages launch');
  await waitFor(
    miniProgram,
    (value) => (
      value.route === 'pages/messages/index'
      && ['success', 'empty', 'login', 'error'].includes(value.data.viewState)
      && value.data.isRefreshing !== true
    ),
    'messages page'
  );
  if (conversations.length === 0) {
    return {
      conversationFixtureAvailable: false,
      invalidActionRejected: true,
      schoolNamePropertyPresent: 'no-conversation-fixture',
      chatDisplayChecked: 'not-applicable',
      pickerDisplayChecked: 'not-applicable'
    };
  }

  const conversationId = conversations[0].conversationId;
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
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(DEVTOOLS_CLI_PATH && fs.existsSync(DEVTOOLS_CLI_PATH), 'developer-tools CLI is unavailable');
  const automator = require(AUTOMATOR_MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
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
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });
    const startup = await verifyStartup(miniProgram);
    const publishForeground = await verifyPublishForegroundLifecycle(miniProgram);
    const messageSchoolSummary = await verifyMessageSchoolSummary(miniProgram);
    assert(consoleErrors === 0, `developer tools recorded ${consoleErrors} console error(s)`);
    assert(exceptions === 0, `developer tools recorded ${exceptions} exception(s)`);
    return {
      passed: true,
      startup,
      publishForeground,
      messageSchoolSummary,
      writesRequested: false,
      fixturesCreated: false,
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
  process.stderr.write(`PHASE24_DEVTOOLS_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
