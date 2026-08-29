'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const { ACTOR_PATH } = require('./manage-final-release-step-4b1-favorites-fixtures');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', output: ACTOR_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--output') options.output = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'staging', 'this workflow accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
  return options;
}

function automationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'PHASE23_AUTOMATOR_MODULE is unavailable');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsEndpoint), 'local DevTools automation endpoint is unavailable');
  return { modulePath, wsEndpoint };
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: 'audit'
  });
  assert(preflight.activeTargetMatches && preflight.environmentName === 'staging',
    'active mini program target must be staging', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(options.confirmTarget === preflight.environmentIdMasked,
    `confirm target with --confirm-target ${preflight.environmentIdMasked}`, 'TARGET_CONFIRMATION_REQUIRED');
  const automation = automationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  try {
    miniProgram = await automator.connect({ wsEndpoint: automation.wsEndpoint });
    const response = await miniProgram.evaluate(async function readCurrentUser() {
      return wx.cloud.callFunction({
        name: 'authUser',
        data: { action: 'current', data: {} }
      });
    });
    const result = response && response.result;
    assert(result && result.success === true && result.code === 'OK', 'staging current user is unavailable', 'STAGING_ACTOR_UNAVAILABLE');
    const user = result.data && result.data.user;
    assert(user && /^u_[0-9a-f]{32}$/.test(String(user.id || '')), 'staging actor user ID is invalid');
    assert(/^s_[0-9a-f]{32}$/.test(String(user.schoolId || '')), 'staging actor must have a valid school');
    const appId = require('../project.private.config.json').appid;
    const users = require('./phase-24-staging-core').queryCollection(preflight.environmentId, 'users', { _id: user.id }, 2);
    assert(users.length === 1 && typeof users[0].openid === 'string' && users[0].openid,
      'staging actor private identity cannot be resolved');
    const expectedUserId = `u_${sha256(`${appId}:${users[0].openid}`).slice(0, 32)}`;
    assert(expectedUserId === user.id, 'staging actor identity mapping drifted');
    const actor = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      environmentRole: 'staging',
      environmentMasked: preflight.environmentIdMasked,
      environmentFingerprint: sha256(`staging:${preflight.environmentId}`),
      userId: user.id,
      openidSha256: sha256(users[0].openid),
      schoolId: user.schoolId,
      schoolName: user.schoolName || '',
      campus: user.campus || ''
    };
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(actor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return {
      mode: 'captured-staging-actor',
      environment: publicSummary(preflight),
      userIdFingerprint: sha256(user.id).slice(0, 16),
      schoolIdFingerprint: sha256(user.schoolId).slice(0, 16),
      privateOutput: path.relative(ROOT, options.output),
      cloudWritesExecuted: false
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STEP4B1_ACTOR_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, run };
