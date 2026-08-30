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

const MANIFEST_PATH = path.join(ROOT, 'tmp', 'feedback-staging-fixture.json');
const ACTOR_PATH = path.join(ROOT, 'tmp', 'final-release-step-4b1-actor.json');
const FIXTURE_RUN_ID = 'feedback_staging_20260830_01';
const FIXTURE_CONTENT = '[STAGING FIXTURE] feedback persistence without SMTP credentials';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function parseArguments(argv) {
  const options = { action: '', environmentName: '', confirmTarget: '', manifestPath: MANIFEST_PATH, actorPath: ACTOR_PATH };
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
  assert(options.environmentName === 'staging', 'feedback fixture accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
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
      assert(previous.status === 'cleaned-and-verified', 'previous feedback fixture is not cleaned', 'FIXTURE_NOT_CLEAN');
    }
    const { actor, openId } = readActor(preflight.environmentId, options.actorPath);
    const requestId = FIXTURE_RUN_ID;
    const feedbackId = `fb_${sha256(`${openId}:${requestId}`)}`;
    const manifest = {
      schemaVersion: 1,
      status: 'prepared-and-verified',
      preparedAt: new Date().toISOString(),
      environment: publicSummary(preflight),
      fixtureRunId: FIXTURE_RUN_ID,
      requestId,
      feedbackId,
      actorUserId: actor.userId,
      actorOpenidSha256: actor.openidSha256,
      content: FIXTURE_CONTENT,
      expectedMailLastErrorCode: 'MAIL_CONFIG_MISSING'
    };
    writePrivateJson(options.manifestPath, manifest);
    assert(queryCollection(preflight.environmentId, 'feedbacks', { _id: feedbackId }, 2).length === 0,
      'exact feedback fixture id already exists', 'FIXTURE_ID_COLLISION');
    return {
      mode: 'prepared-and-verified',
      environment: publicSummary(preflight),
      fixtureRunId: FIXTURE_RUN_ID,
      exactRecordIds: { feedbacks: [feedbackId] },
      writesPerformed: 0,
      manifestWrittenBeforeBusinessWrite: true
    };
  }

  assert(fs.existsSync(options.manifestPath), 'feedback fixture manifest is missing', 'FIXTURE_MANIFEST_MISSING');
  const manifest = loadJson(options.manifestPath);
  assert(manifest.fixtureRunId === FIXTURE_RUN_ID && /^fb_[a-f0-9]{64}$/.test(manifest.feedbackId),
    'feedback fixture manifest drifted', 'FIXTURE_MANIFEST_DRIFT');
  const existing = queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2);
  if (options.action === 'audit') {
    return {
      mode: 'audit',
      environment: publicSummary(preflight),
      fixtureRunId: manifest.fixtureRunId,
      manifestStatus: manifest.status,
      exactFixtureCount: existing.length
    };
  }
  if (existing.length > 0) deleteExactId(preflight.environmentId, manifest.feedbackId);
  const leftovers = queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2);
  assert(leftovers.length === 0, 'feedback fixture cleanup failed', 'FIXTURE_CLEANUP_FAILED');
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
    deletedExactRecordIds: existing.length,
    leftoverFixtureCount: 0
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_FIXTURE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { MANIFEST_PATH, ACTOR_PATH, FIXTURE_RUN_ID, FIXTURE_CONTENT, parseArguments, run };
