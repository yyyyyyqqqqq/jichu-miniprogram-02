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
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE18_DUAL_AUTOMATOR_WS_ENDPOINT;
const REMOTE_QR_PATH = path.join(
  ROOT,
  'tmp',
  `phase-18-second-account-remote-qr-${Date.now()}.png`
);

function withTimeout(promise, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function waitForRemoteApp(miniProgram) {
  let lastError;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const pagePath = await withTimeout(miniProgram.evaluate(function readRemotePagePath() {
        const pages = getCurrentPages();
        const page = pages[pages.length - 1];
        return page && (page.route || page.__route__) || '';
      }), 'remote evaluated page probe', 5000);
      if (pagePath) return pagePath;
    } catch (error) {
      lastError = error;
    }
    try {
      const page = await withTimeout(miniProgram.currentPage(), 'remote current page probe', 3000);
      if (page && page.path) return page.path;
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }
  throw new Error(`remote app did not become ready${lastError ? `: ${lastError.message}` : ''}`);
}

function payload(response) {
  const value = response && response.result;
  assert(value && typeof value.success === 'boolean', 'invalid cloud response');
  return value;
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

function assertIgnored(filePath, label) {
  const relative = path.relative(ROOT, filePath);
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', relative], {
    cwd: ROOT,
    windowsHide: true
  });
  assert(result.status === 0, `${label} is not protected by .gitignore`);
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'dual-account automator module is unavailable');
  assert(AUTOMATOR_WS_ENDPOINT, 'developer-tools automation endpoint is required');
  assert(fs.existsSync(PRIVATE_CANARY_PATH), 'private primary canary result is missing');
  assertIgnored(PRIVATE_DUAL_ACCOUNT_PATH, 'private dual-account result');
  assertIgnored(REMOTE_QR_PATH, 'remote-debug QR image');

  const primaryPrivate = loadJson(PRIVATE_CANARY_PATH);
  assert(USER_ID_PATTERN.test(String(primaryPrivate.userId || '')), 'primary private userId is invalid');
  const environmentId = loadEnvironmentId();
  const MiniProgram = require(path.join(AUTOMATOR_MODULE, 'out', 'MiniProgram')).default;
  const originalCheckVersion = MiniProgram.prototype.checkVersion;
  MiniProgram.prototype.checkVersion = async function skipBrokenVersionProbe() {};
  const automator = require(AUTOMATOR_MODULE);
  let miniProgram;
  try {
    miniProgram = await withTimeout(
      automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }),
      'automation connection',
      30000
    );
    const remoteConnected = new Promise((resolve) => {
      miniProgram.connection.once('Tool.onRemoteDebugConnected', resolve);
    });
    const remote = await miniProgram.send('Tool.enableRemoteDebug', { auto: false });
    assert(remote && typeof remote.qrCode === 'string' && remote.qrCode.length > 100, 'remote-debug QR was not returned');
    fs.mkdirSync(path.dirname(REMOTE_QR_PATH), { recursive: true });
    fs.writeFileSync(REMOTE_QR_PATH, Buffer.from(remote.qrCode, 'base64'));
    process.stdout.write(`${JSON.stringify({
      phase: 'scan',
      qrPath: REMOTE_QR_PATH,
      instruction: 'Use the second real WeChat account to scan this remote-debug QR.'
    })}\n`);

    await withTimeout(remoteConnected, 'second-account remote-debug connection', 600000);
    process.stdout.write(`${JSON.stringify({ phase: 'connected', waitingForApp: true })}\n`);
    const remotePage = await waitForRemoteApp(miniProgram);
    process.stdout.write(`${JSON.stringify({ phase: 'app-ready', page: remotePage })}\n`);
    const callCloud = async (name, data) => {
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return payload(await withTimeout(
            miniProgram.evaluate(async function callCloudFunction(functionName, functionData) {
              return wx.cloud.callFunction({ name: functionName, data: functionData });
            }, name, data),
            `${name} cloud call attempt ${attempt}`,
            90000
          ));
        } catch (error) {
          lastError = error;
          if (attempt < 2) await delay(3000);
        }
      }
      throw lastError;
    };
    const current = await callCloud('authUser', { action: 'current', data: {} });
    assert(current.success === true && current.data && current.data.user, 'scanned phone identity is not logged in');
    const accountB = safeAccount(current.data.user);
    validateAccount(accountB, 'account B');
    assert(accountB.userId !== primaryPrivate.userId, 'scanned phone is the primary account, not the second account');

    const schoolDetail = await callCloud('schoolQuery', {
      action: 'detail',
      schoolId: accountB.schoolId
    });
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

    const result = {
      schemaVersion: 1,
      resolvedAt: new Date().toISOString(),
      accountA,
      accountB,
      schoolsDiffer: accountA.schoolId !== accountB.schoolId,
      source: 'phone remote debug authUser/current + authoritative users/schoolQuery reads',
      openidStored: false
    };
    writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, result);
    return {
      phase: 'resolved',
      passed: true,
      accountA: {
        userId: maskId(accountA.userId),
        schoolId: maskId(accountA.schoolId),
        schoolName: accountA.schoolName
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
      openidStored: false
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
    MiniProgram.prototype.checkVersion = originalCheckVersion;
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE18_DUAL_ACCOUNT_REMOTE_RESOLVE_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
});
