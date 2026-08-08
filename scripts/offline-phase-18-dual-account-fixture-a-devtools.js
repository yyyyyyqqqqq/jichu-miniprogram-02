const fs = require('fs');
const path = require('path');
const {
  loadDualAccountPrivate,
  maskId,
  assert,
  writePrivateJson,
  PRIVATE_DUAL_ACCOUNT_PATH
} = require('./phase-18-dual-account-core');

const MODULE = process.env.PHASE18_DUAL_AUTOMATOR_MODULE;
const ENDPOINT = process.env.PHASE18_DUAL_AUTOMATOR_WS_ENDPOINT;

function withTimeout(promise, label, timeoutMs = 45000) {
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

async function run() {
  assert(MODULE && fs.existsSync(MODULE) && ENDPOINT, 'developer-tools automation settings are required');
  const privateData = loadDualAccountPrivate();
  assert(privateData.fixtureAId && privateData.fixtureAInitial, 'account A fixture evidence is missing');
  const MiniProgram = require(path.join(MODULE, 'out', 'MiniProgram')).default;
  const originalCheckVersion = MiniProgram.prototype.checkVersion;
  MiniProgram.prototype.checkVersion = async function skipBrokenVersionProbe() {};
  const automator = require(MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = await withTimeout(automator.connect({ wsEndpoint: ENDPOINT }), 'automation connection');
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });
    const callCloud = async (name, data) => payload(await withTimeout(miniProgram.evaluate(
      async function invoke(functionName, functionData) {
        return wx.cloud.callFunction({ name: functionName, data: functionData });
      }, name, data
    ), `${name} cloud call`));
    const current = await callCloud('authUser', { action: 'current', data: {} });
    assert(current.success === true && current.data.user.id === privateData.accountA.userId, 'current identity is not account A');
    const offline = await callCloud('manageProduct', {
      action: 'takeOffline', productId: privateData.fixtureAId
    });
    assert(offline.success === true && offline.data.status === 'offline', 'account A takeOffline failed');
    assert(
      Number(offline.data.version) === Number(privateData.fixtureAInitial.version) + 1,
      'account A fixture version did not increment exactly once'
    );
    const mine = await callCloud('productQuery', {
      action: 'myProducts', data: { status: ['offline'], page: 1, pageSize: 20 }
    });
    const found = mine.success === true && (mine.data.list || []).find((item) => item._id === privateData.fixtureAId);
    assert(found && found.status === 'offline', 'account A offline fixture is absent from myProducts');
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');
    const updated = loadDualAccountPrivate();
    updated.fixtureAOfflineResponse = offline.data;
    updated.fixtureAOfflineAt = new Date().toISOString();
    writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, updated);
    return {
      passed: true,
      title: privateData.fixtureAInitial.title,
      productId: maskId(privateData.fixtureAId),
      status: offline.data.status,
      version: offline.data.version,
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
  process.stderr.write(`PHASE18_DUAL_ACCOUNT_OFFLINE_A_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 0));
