'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, runPreflight, publicSummary, assert } = require('./environment-preflight');
const { queryCollection } = require('./phase-24-staging-core');
const { runNoSql } = require('./schools/cloud-cli');

const MANIFEST_PATH = path.join(ROOT, 'tmp', 'feedback-production-mail-fixture.json');
const FIXTURE_CONTENT = '[PRODUCTION SMOKE] 即出意见反馈正式上线链路验证，请忽略。';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function maskFeedbackId(value) {
  const text = String(value || '');
  return /^fb_[a-f0-9]{64}$/.test(text) ? `fb_***${text.slice(-8)}` : 'fb_***';
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function parseArguments(argv) {
  const options = { action: '', environmentName: '', confirmTarget: '', authorized: false, manifestPath: MANIFEST_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--action') options.action = String(argv[++index] || '').trim();
    else if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--allow-feedback-production-smoke') options.authorized = true;
    else if (value === '--manifest') options.manifestPath = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(['audit', 'prepare', 'cleanup'].includes(options.action), '--action audit|prepare|cleanup is required', 'INVALID_ACTION');
  assert(options.environmentName === 'production', 'mail fixture accepts only --env production', 'STAGING_TARGET_REJECTED');
  if (options.action === 'cleanup') assert(options.authorized, '--allow-feedback-production-smoke is required', 'PRODUCTION_AUTHORIZATION_REQUIRED');
  return options;
}

function automationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'automator module is unavailable');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsEndpoint), 'local DevTools automation endpoint is unavailable');
  return { modulePath, wsEndpoint };
}

function deleteExactId(environmentId, id) {
  runNoSql(environmentId, [{
    TableName: 'feedbacks',
    CommandType: 'DELETE',
    Command: JSON.stringify({ delete: 'feedbacks', deletes: [{ q: { _id: id }, limit: 1 }] })
  }]);
}

async function readProductionActor(environmentId) {
  const automation = automationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  let current;
  try {
    miniProgram = await automator.connect({ wsEndpoint: automation.wsEndpoint });
    current = await miniProgram.evaluate(async function currentUser() {
      return wx.cloud.callFunction({ name: 'authUser', data: { action: 'current', data: {} } });
    });
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
  const payload = current && current.result;
  const userId = payload && payload.success === true && payload.data && payload.data.user && payload.data.user.id;
  assert(userId, 'production DevTools identity is unavailable', 'ACTOR_IDENTITY_UNAVAILABLE');
  const users = queryCollection(environmentId, 'users', { _id: userId }, 2);
  assert(users.length === 1, 'production actor user is missing', 'ACTOR_USER_MISSING');
  const openId = String(users[0]._openid || users[0].openid || '');
  assert(openId, 'production actor trusted identity is missing', 'ACTOR_IDENTITY_UNAVAILABLE');
  return { userId, openId };
}

function createFixtureRunId(now = new Date()) {
  return `feedback_mail_production_${now.toISOString().replace(/\D/g, '')}`;
}

async function run(options) {
  const cleanup = options.action === 'cleanup';
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: cleanup ? 'cleanup' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: cleanup
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.production,
    'active target must be registered production', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId !== targets.staging, 'staging target is forbidden', 'STAGING_TARGET_REJECTED');

  if (options.action === 'prepare') {
    if (fs.existsSync(options.manifestPath)) {
      const previous = loadJson(options.manifestPath);
      assert(previous.status === 'cleaned-and-verified', 'previous production fixture is not clean', 'FIXTURE_NOT_CLEAN');
    }
    assert(queryCollection(preflight.environmentId, 'feedbacks', {}, 1).length === 0,
      'production feedbacks must be empty before smoke', 'FEEDBACK_BASELINE_NOT_EMPTY');
    const actor = await readProductionActor(preflight.environmentId);
    const now = new Date();
    const fixtureRunId = createFixtureRunId(now);
    const requestId = fixtureRunId;
    const feedbackId = `fb_${sha256(`${actor.openId}:${requestId}`)}`;
    const manifest = {
      schemaVersion: 1,
      status: 'prepared-and-verified',
      preparedAt: now.toISOString(),
      fixtureRunId,
      environmentRole: 'production',
      environmentFingerprint: sha256(`production:${preflight.environmentId}`),
      requestId,
      feedbackId,
      actorUserId: actor.userId,
      actorOpenidSha256: sha256(actor.openId),
      content: FIXTURE_CONTENT,
      purpose: 'single owner-controlled production feedback SMTP smoke',
      maximumRealMailAttempts: 1,
      realMailAttempts: 0
    };
    writePrivateJson(options.manifestPath, manifest);
    assert(queryCollection(preflight.environmentId, 'feedbacks', { _id: feedbackId }, 2).length === 0,
      'exact production smoke id already exists', 'FIXTURE_ID_COLLISION');
    return {
      mode: 'prepared-and-verified',
      environment: publicSummary(preflight),
      fixtureRunId,
      feedbackId: maskFeedbackId(feedbackId),
      manifestWrittenBeforeBusinessWrite: true,
      realMailAttempts: 0,
      productionFeedbackCount: 0
    };
  }

  assert(fs.existsSync(options.manifestPath), 'production fixture manifest is missing', 'FIXTURE_MANIFEST_MISSING');
  const manifest = loadJson(options.manifestPath);
  assert(/^feedback_mail_production_\d{17}$/.test(manifest.fixtureRunId)
    && /^fb_[a-f0-9]{64}$/.test(manifest.feedbackId)
    && manifest.environmentRole === 'production',
  'production fixture manifest drifted', 'FIXTURE_MANIFEST_DRIFT');
  const existing = queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2);
  if (options.action === 'audit') {
    return {
      mode: 'audit',
      environment: publicSummary(preflight),
      fixtureRunId: manifest.fixtureRunId,
      manifestStatus: manifest.status,
      feedbackId: maskFeedbackId(manifest.feedbackId),
      exactFixtureCount: existing.length,
      realMailAttempts: Number(manifest.realMailAttempts || 0)
    };
  }
  if (existing.length > 0) deleteExactId(preflight.environmentId, manifest.feedbackId);
  const leftover = queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2).length;
  assert(leftover === 0, 'production smoke cleanup failed', 'FIXTURE_CLEANUP_FAILED');
  writePrivateJson(options.manifestPath, {
    ...manifest,
    status: 'cleaned-and-verified',
    cleanedAt: new Date().toISOString(),
    leftoverFixtureCount: 0
  });
  return {
    mode: 'cleaned-and-verified',
    environment: publicSummary(preflight),
    fixtureRunId: manifest.fixtureRunId,
    feedbackId: maskFeedbackId(manifest.feedbackId),
    deletedExactRecordIds: existing.length,
    leftoverFixtureCount: 0,
    realMailAttempts: Number(manifest.realMailAttempts || 0)
  };
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_PRODUCTION_FIXTURE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { MANIFEST_PATH, FIXTURE_CONTENT, maskFeedbackId, loadJson, writePrivateJson, parseArguments, run };
