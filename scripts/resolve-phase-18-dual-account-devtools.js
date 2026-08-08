const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  PRIVATE_CANARY_PATH,
  USER_ID_PATTERN,
  SCHOOL_ID_PATTERN,
  loadJson,
  loadEnvironmentId,
  queryCollection
} = require('./phase-18-canary-core');
const {
  PRIVATE_DUAL_ACCOUNT_PATH,
  maskId,
  assert,
  writePrivateJson
} = require('./phase-18-dual-account-core');

const AUTOMATOR_MODULE = process.env.PHASE18_DUAL_AUTOMATOR_MODULE;
const DEVTOOLS_CLI_PATH = process.env.PHASE18_DUAL_DEVTOOLS_CLI_PATH;
const DEVTOOLS_CLI_SCRIPT = process.env.PHASE18_DUAL_DEVTOOLS_CLI_SCRIPT;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE18_DUAL_AUTOMATOR_WS_ENDPOINT;

function withTimeout(promise, label, timeoutMs = 90000) {
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

function progress(message) {
  process.stderr.write(`[phase18-dual-resolve] ${message}\n`);
}

function safeAccount(user) {
  return {
    userId: user.id,
    status: user.status,
    profileCompleted: user.profileCompleted === true,
    schoolId: user.schoolId,
    schoolName: user.schoolName,
    schoolVersion: Number(user.schoolVersion || 0)
  };
}

function validateAccount(account, label) {
  assert(account && USER_ID_PATTERN.test(String(account.userId || '')), `${label} internal userId is invalid`);
  assert(account.status === 'active', `${label} is not active`);
  assert(account.profileCompleted === true, `${label} profile is incomplete`);
  assert(SCHOOL_ID_PATTERN.test(String(account.schoolId || '')), `${label} schoolId is invalid`);
  assert(typeof account.schoolName === 'string' && account.schoolName.trim(), `${label} schoolName is missing`);
}

function assertPrivatePathIgnored() {
  const relative = path.relative(ROOT, PRIVATE_DUAL_ACCOUNT_PATH);
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', relative], {
    cwd: ROOT,
    windowsHide: true
  });
  assert(result.status === 0, 'private dual-account path is not protected by .gitignore');
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'dual-account automator module is unavailable');
  assert(DEVTOOLS_CLI_PATH && fs.existsSync(DEVTOOLS_CLI_PATH), 'developer-tools CLI is unavailable');
  assert(fs.existsSync(PRIVATE_CANARY_PATH), 'private primary canary result is missing');
  assertPrivatePathIgnored();

  const primaryPrivate = loadJson(PRIVATE_CANARY_PATH);
  assert(USER_ID_PATTERN.test(String(primaryPrivate.userId || '')), 'primary private userId is invalid');
  const environmentId = loadEnvironmentId();
  const MiniProgram = require(path.join(AUTOMATOR_MODULE, 'out', 'MiniProgram')).default;
  const originalCheckVersion = MiniProgram.prototype.checkVersion;
  MiniProgram.prototype.checkVersion = async function skipBrokenVersionProbe() {};
  const automator = require(AUTOMATOR_MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = AUTOMATOR_WS_ENDPOINT
      ? await withTimeout(automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }), 'automation connection')
      : await withTimeout(automator.launch({
        cliPath: DEVTOOLS_CLI_PATH,
        args: DEVTOOLS_CLI_SCRIPT ? [DEVTOOLS_CLI_SCRIPT] : [],
        projectPath: ROOT,
        trustProject: true,
        timeout: 90000
      }), 'automation launch');
    progress('automation connected');
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });

    const callCloud = async (name, data) => payload(await withTimeout(
      miniProgram.evaluate(async function callCloudFunction(functionName, functionData) {
        return wx.cloud.callFunction({ name: functionName, data: functionData });
      }, name, data),
      `${name} cloud call`,
      45000
    ));
    const current = await callCloud('authUser', { action: 'current', data: {} });
    progress('authUser/current returned');
    assert(current.success === true && current.data && current.data.user, 'current DevTools identity is not logged in');
    const accountB = safeAccount(current.data.user);
    validateAccount(accountB, 'account B');
    assert(accountB.userId !== primaryPrivate.userId, 'current DevTools identity is the primary account, not the second account');

    const schoolDetail = await callCloud('schoolQuery', {
      action: 'detail',
      schoolId: accountB.schoolId
    });
    progress('schoolQuery/detail returned');
    assert(schoolDetail.success === true && schoolDetail.data, 'account B authoritative school is unavailable');
    assert(schoolDetail.data.id === accountB.schoolId, 'account B school detail id mismatches');
    assert(schoolDetail.data.name === accountB.schoolName, 'account B school name is not authoritative');

    const primaryRows = queryCollection(environmentId, 'users', {
      filter: { _id: primaryPrivate.userId },
      projection: {
        _id: 1,
        status: 1,
        profileCompleted: 1,
        schoolId: 1,
        schoolName: 1,
        schoolVersion: 1
      },
      limit: 2
    });
    progress('primary account authoritative read returned');
    assert(primaryRows.length === 1, 'primary account no longer resolves uniquely');
    const accountA = {
      userId: primaryRows[0]._id,
      status: primaryRows[0].status,
      profileCompleted: primaryRows[0].profileCompleted === true,
      schoolId: primaryRows[0].schoolId,
      schoolName: primaryRows[0].schoolName,
      schoolVersion: Number(primaryRows[0].schoolVersion || 0)
    };
    validateAccount(accountA, 'account A');
    assert(accountA.userId !== accountB.userId, 'resolved accounts are not distinct');
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded errors during identity resolution');

    const result = {
      schemaVersion: 1,
      resolvedAt: new Date().toISOString(),
      accountA,
      accountB,
      schoolsDiffer: accountA.schoolId !== accountB.schoolId,
      source: 'authUser/current + authoritative users/schoolQuery reads',
      openidStored: false,
      consoleErrors,
      exceptions
    };
    writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, result);
    return {
      passed: true,
      accountA: {
        userId: maskId(accountA.userId),
        schoolId: maskId(accountA.schoolId),
        schoolName: accountA.schoolName,
        status: accountA.status,
        profileCompleted: accountA.profileCompleted
      },
      accountB: {
        userId: maskId(accountB.userId),
        schoolId: maskId(accountB.schoolId),
        schoolName: accountB.schoolName,
        status: accountB.status,
        profileCompleted: accountB.profileCompleted
      },
      schoolsDiffer: result.schoolsDiffer,
      privatePathIgnored: true,
      openidStored: false,
      consoleErrors,
      exceptions
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
    MiniProgram.prototype.checkVersion = originalCheckVersion;
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE18_DUAL_ACCOUNT_RESOLVE_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
});
