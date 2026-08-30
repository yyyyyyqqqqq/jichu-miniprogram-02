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
const { queryCollection } = require('./phase-24-staging-core');
const { runNoSql } = require('./schools/cloud-cli');

const MANIFEST_PATH = path.join(ROOT, 'tmp', 'feedback-staging-mail-fixture.json');
const ACTOR_PATH = path.join(ROOT, 'tmp', 'final-release-step-4b1-actor.json');
const FIXTURE_CONTENT = '[STAGING TEST] 即出意见反馈邮件链路验证，请忽略。';

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
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

function parseArguments(argv) {
  const options = {
    action: '',
    environmentName: '',
    confirmTarget: '',
    manifestPath: MANIFEST_PATH,
    actorPath: ACTOR_PATH
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--action') options.action = String(argv[++index] || '').trim();
    else if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--manifest') options.manifestPath = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--actor') options.actorPath = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(['audit', 'prepare', 'cleanup'].includes(options.action), '--action audit|prepare|cleanup is required', 'INVALID_ACTION');
  assert(options.environmentName === 'staging', 'mail fixture accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
  return options;
}

function deleteExactId(environmentId, id) {
  runNoSql(environmentId, [{
    TableName: 'feedbacks',
    CommandType: 'DELETE',
    Command: JSON.stringify({
      delete: 'feedbacks',
      deletes: [{ q: { _id: id }, limit: 1 }]
    })
  }]);
}

function readActor(environmentId, actorPath) {
  assert(fs.existsSync(actorPath), 'staging actor file is missing', 'ACTOR_FILE_MISSING');
  const actor = loadJson(actorPath);
  assert(actor.environmentRole === 'staging', 'actor role is not staging', 'ACTOR_ROLE_MISMATCH');
  const users = queryCollection(environmentId, 'users', { _id: actor.userId }, 2);
  assert(users.length === 1, 'staging actor user is missing', 'ACTOR_USER_MISSING');
  const openId = String(users[0]._openid || users[0].openid || '');
  assert(openId && sha256(openId) === actor.openidSha256, 'staging actor identity fingerprint drifted', 'ACTOR_IDENTITY_DRIFT');
  return { actor, openId };
}

function createFixtureRunId(now = new Date()) {
  return `feedback_mail_staging_${now.toISOString().replace(/\D/g, '')}`;
}

async function run(options) {
  const write = options.action !== 'audit';
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: write ? (options.action === 'prepare' ? 'seed' : 'cleanup') : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !write,
    allowInactiveStagingWrite: write
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.environmentId === targets.staging && preflight.environmentId !== targets.production,
    'registered staging target is required', 'STAGING_TARGET_MISMATCH');

  if (options.action === 'prepare') {
    if (fs.existsSync(options.manifestPath)) {
      const previous = loadJson(options.manifestPath);
      assert(previous.status === 'cleaned-and-verified', 'previous mail fixture is not cleaned', 'FIXTURE_NOT_CLEAN');
    }
    const { actor, openId } = readActor(preflight.environmentId, options.actorPath);
    const now = new Date();
    const fixtureRunId = createFixtureRunId(now);
    const requestId = fixtureRunId;
    const feedbackId = `fb_${sha256(`${openId}:${requestId}`)}`;
    const manifest = {
      schemaVersion: 1,
      status: 'prepared-and-verified',
      preparedAt: now.toISOString(),
      fixtureRunId,
      environmentRole: 'staging',
      environmentFingerprint: sha256(`staging:${preflight.environmentId}`),
      requestId,
      feedbackId,
      actorUserId: actor.userId,
      actorOpenidSha256: actor.openidSha256,
      content: FIXTURE_CONTENT,
      purpose: 'single staging real SMTP feedback verification',
      maximumRealMailAttempts: 1
    };
    writePrivateJson(options.manifestPath, manifest);
    assert(queryCollection(preflight.environmentId, 'feedbacks', { _id: feedbackId }, 2).length === 0,
      'exact mail fixture id already exists', 'FIXTURE_ID_COLLISION');
    return {
      mode: 'prepared-and-verified',
      environment: publicSummary(preflight),
      fixtureRunId,
      feedbackId: maskFeedbackId(feedbackId),
      manifestWrittenBeforeBusinessWrite: true,
      realMailAttempts: 0
    };
  }

  assert(fs.existsSync(options.manifestPath), 'mail fixture manifest is missing', 'FIXTURE_MANIFEST_MISSING');
  const manifest = loadJson(options.manifestPath);
  assert(/^feedback_mail_staging_\d{17}$/.test(manifest.fixtureRunId)
    && /^fb_[a-f0-9]{64}$/.test(manifest.feedbackId),
  'mail fixture manifest drifted', 'FIXTURE_MANIFEST_DRIFT');
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
  const leftovers = queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2);
  assert(leftovers.length === 0, 'mail fixture cleanup failed', 'FIXTURE_CLEANUP_FAILED');
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
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_MAIL_FIXTURE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MANIFEST_PATH,
  ACTOR_PATH,
  FIXTURE_CONTENT,
  maskFeedbackId,
  loadJson,
  writePrivateJson,
  parseArguments,
  run
};
