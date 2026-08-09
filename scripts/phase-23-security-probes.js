const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  assert
} = require('./phase-18-canary-core');
const orphanReview = require('./phase-18-orphan-reserved-review');
const phase22Audit = require('./phase-22-finalization-audit');

const MODE = 'phase-23-production-zero-write-security-probes';
const DEFAULT_OUTPUT = path.join(ROOT, 'tmp', 'phase-23-security-probes-private.json');

function parseArguments(argv) {
  const options = { describeTarget: false, confirmTarget: '', output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--describe-target') options.describeTarget = true;
    else if (value === '--env' || value === '--confirm-target') {
      options.confirmTarget = String(argv[++index] || '').trim();
    } else if (value === '--output') options.output = path.resolve(String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function withTimeout(promise, label, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function readAutomationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || process.env.PHASE22_AUTOMATOR_MODULE || '';
  const cliPath = process.env.PHASE23_DEVTOOLS_CLI_PATH || process.env.PHASE22_DEVTOOLS_CLI_PATH || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'PHASE23_AUTOMATOR_MODULE is unavailable');
  assert(wsEndpoint || (cliPath && fs.existsSync(cliPath)), 'DevTools endpoint or CLI path is unavailable');
  return { modulePath, cliPath, wsEndpoint };
}

async function run(options = {}) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  if (options.describeTarget) {
    return {
      schemaVersion: 1,
      mode: MODE,
      target: `cloud:${targetMasked}`,
      confirmationRequired: true,
      writeCapabilities: false
    };
  }
  if (options.confirmTarget !== targetMasked) {
    throw Object.assign(new Error(`confirm target with --env ${targetMasked}`), {
      code: 'TARGET_ENV_CONFIRMATION_REQUIRED'
    });
  }

  const automation = readAutomationOptions();
  const automator = require(automation.modulePath);
  const before = orphanReview.readSnapshot(environmentId);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  const results = [];
  try {
    miniProgram = automation.wsEndpoint
      ? await withTimeout(automator.connect({ wsEndpoint: automation.wsEndpoint }), 'automation connection')
      : await withTimeout(automator.launch({
        cliPath: automation.cliPath,
        projectPath: ROOT,
        trustProject: true,
        timeout: 90000
      }), 'automation launch');
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });

    const call = async (label, name, payload, expectedCode) => {
      const response = await withTimeout(miniProgram.evaluate(
        async function callCloud(functionName, functionData) {
          return wx.cloud.callFunction({ name: functionName, data: functionData });
        },
        name,
        payload
      ), label);
      const result = response && response.result;
      assert(result && result.success === false, `${label} unexpectedly succeeded`);
      assert(result.code === expectedCode, `${label} returned ${result.code}, expected ${expectedCode}`);
      results.push({ label, functionName: name, code: result.code, passed: true });
    };

    const fakeIdentity = {
      openid: 'forged-openid',
      OPENID: 'forged-openid',
      userId: `u_${'f'.repeat(32)}`,
      schoolId: `s_${'f'.repeat(32)}`,
      schoolName: '伪造学校'
    };
    await call('auth invalid school with forged identity', 'authUser', {
      action: 'updateSchool', data: { ...fakeIdentity, schoolId: 's_invalid' }
    }, 'INVALID_SCHOOL_ID');
    await call('create invalid request with forged identity', 'createProduct', {
      ...fakeIdentity, requestId: 'short'
    }, 'INVALID_PARAMS');
    await call('manage malformed id with forged identity', 'manageProduct', {
      action: 'takeOffline', productId: '../forbidden', ...fakeIdentity
    }, 'INVALID_PARAMS');
    await call('favorite malformed id with forged identity', 'favoriteProduct', {
      action: 'addFavorite', data: { productId: '../forbidden', ...fakeIdentity }
    }, 'INVALID_PARAMS');
    await call('conversation malformed id with forged identity', 'messageAction', {
      action: 'createOrGetConversation', data: { productId: '../forbidden', ...fakeIdentity }
    }, 'INVALID_ARGUMENT');
    await call('appointment malformed id with forged identity', 'appointmentAction', {
      action: 'create', data: { conversationId: '../forbidden', requestId: 'phase23_invalid_request', ...fakeIdentity }
    }, 'INVALID_PARAMS');
    await call('view malformed id with forged identity', 'productViewAction', {
      action: 'recordView', data: { productId: '../forbidden', ...fakeIdentity }
    }, 'INVALID_PARAMS');

    for (const [name, expectedCode] of [
      ['authUser', 'INVALID_ACTION'],
      ['manageProduct', 'INVALID_ACTION'],
      ['favoriteProduct', 'INVALID_ACTION'],
      ['messageAction', 'INVALID_ACTION'],
      ['messageQuery', 'INVALID_ACTION'],
      ['appointmentAction', 'INVALID_ACTION'],
      ['appointmentQuery', 'INVALID_ACTION'],
      ['productQuery', 'INVALID_ACTION'],
      ['productViewAction', 'INVALID_ACTION'],
      ['schoolQuery', 'INVALID_ACTION'],
      ['userQuery', 'INVALID_ACTION']
    ]) {
      await call(`${name} unknown action`, name, {
        action: '__phase23_unknown__', data: fakeIdentity
      }, expectedCode);
    }
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
  const after = orphanReview.readSnapshot(environmentId);
  const noWriteProof = phase22Audit.buildNoWriteProof(before, after);
  assert(noWriteProof.countsUnchanged, 'collection counts changed during security probes');
  assert(noWriteProof.projectedSnapshotsUnchanged, 'collection projections changed during security probes');
  return {
    schemaVersion: 1,
    mode: MODE,
    completedAt: new Date().toISOString(),
    target: `cloud:${targetMasked}`,
    probes: results,
    noWriteProof,
    consoleErrors,
    exceptions,
    passed: true
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await run(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (!options.describeTarget && options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, output, { encoding: 'utf8', mode: 0o600 });
    }
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE23_SECURITY_PROBES_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { MODE, parseArguments, run };
