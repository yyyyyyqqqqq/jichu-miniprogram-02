const crypto = require('crypto');
const fs = require('fs');
const {
  ROOT,
  loadEnvironmentId,
  queryCollection,
  maskId,
  assert
} = require('./phase-18-canary-core');
const { readAllSchools } = require('./schools/cloud-cli');

const AUTOMATOR_MODULE = process.env.PHASE20_AUTOMATOR_MODULE;
const DEVTOOLS_CLI_PATH = process.env.PHASE20_DEVTOOLS_CLI_PATH;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE20_AUTOMATOR_WS_ENDPOINT;

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

function hashRecords(records) {
  const sorted = records.slice().sort((left, right) => (
    String(left._id || '').localeCompare(String(right._id || ''))
  ));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function readSnapshot(environmentId) {
  const definitions = {
    users: { _id: 1, schoolId: 1, schoolName: 1, schoolChangedAt: 1, schoolVersion: 1 },
    products: { _id: 1, schoolId: 1, status: 1, sellerId: 1 },
    favorites: { _id: 1, userOpenid: 1, productId: 1 },
    conversations: { _id: 1, productId: 1, participantAUserId: 1, participantBUserId: 1 },
    messages: { _id: 1, conversationId: 1, type: 1 },
    appointments: { _id: 1, productId: 1, status: 1, isDeleted: 1 }
  };
  const snapshot = {};
  Object.entries(definitions).forEach(([name, projection]) => {
    const records = queryCollection(environmentId, name, {
      filter: {},
      projection,
      limit: 1000
    });
    snapshot[name] = { count: records.length, hash: hashRecords(records) };
  });
  const schools = readAllSchools(environmentId).map((school) => ({
    _id: school._id,
    platformStatus: school.platformStatus,
    officialStatus: school.officialStatus,
    name: school.name
  }));
  snapshot.schools = { count: schools.length, hash: hashRecords(schools) };
  return snapshot;
}

async function waitForPageData(miniProgram, predicate, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await miniProgram.evaluate(function currentPageData() {
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
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(DEVTOOLS_CLI_PATH && fs.existsSync(DEVTOOLS_CLI_PATH), 'developer-tools CLI is unavailable');
  const environmentId = loadEnvironmentId();
  const before = readSnapshot(environmentId);
  const automator = require(AUTOMATOR_MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = AUTOMATOR_WS_ENDPOINT
      ? await withTimeout(
        automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }),
        'automation connection'
      )
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

    const response = await withTimeout(miniProgram.evaluate(async function currentUser() {
      return wx.cloud.callFunction({
        name: 'authUser',
        data: { action: 'current', data: {} }
      });
    }), 'authUser current', 45000);
    const payload = response && response.result;
    assert(payload && payload.success && payload.data && payload.data.user, 'current user is unavailable');
    const user = payload.data.user;
    assert(typeof user.canChangeSchool === 'boolean', 'server cooldown capability is missing');
    assert(typeof user.schoolChangedAt === 'string', 'server changed time is missing');
    assert(typeof user.nextSchoolChangeAllowedAt === 'string', 'server next allowed time is missing');
    assert(Number.isFinite(Number(user.schoolChangeRemainingMs)), 'server remaining time is invalid');

    await withTimeout(
      miniProgram.reLaunch('/pages/school-select/index?mode=change&target=profile'),
      'school change page launch'
    );
    const changePage = await waitForPageData(miniProgram, (data) => (
      data.isChangeMode === true
      && data.viewState === 'success'
      && data.currentSchoolId === user.schoolId
      && typeof data.cooldownText === 'string'
      && data.cooldownText.length > 0
    ));
    assert(changePage.canChangeSchool === user.canChangeSchool, 'page cooldown differs from server');
    assert(/7 天/.test(changePage.cooldownText), 'page does not explain seven-day rule');

    await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'home launch');
    const home = await waitForPageData(miniProgram, (data) => (
      data.isLoading === false
      && data.marketMode === 'schoolScoped'
      && data.marketScope
      && data.marketScope.schoolId === user.schoolId
    ));
    assert(
      (home.products || []).every((product) => product.schoolId === user.schoolId),
      'home contains another school after foreground refresh'
    );

    const after = readSnapshot(environmentId);
    Object.keys(before).forEach((name) => {
      assert(before[name].count === after[name].count, `${name} count changed`);
      assert(before[name].hash === after[name].hash, `${name} projection changed`);
    });
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');
    return {
      passed: true,
      userId: maskId(user.id),
      schoolId: maskId(user.schoolId),
      canChangeSchool: user.canChangeSchool,
      cooldownFieldsPresent: true,
      changePageAuthoritative: true,
      phase18HomeStrict: true,
      productionProjectionUnchanged: true,
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
  process.stderr.write(`PHASE20_DEVTOOLS_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
