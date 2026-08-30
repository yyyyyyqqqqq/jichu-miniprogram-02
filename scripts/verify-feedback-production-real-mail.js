'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, runPreflight, publicSummary, assert } = require('./environment-preflight');
const { queryCollection } = require('./phase-24-staging-core');
const {
  MANIFEST_PATH,
  FIXTURE_CONTENT,
  maskFeedbackId,
  loadJson,
  writePrivateJson
} = require('./manage-feedback-production-mail-fixture');
const { APPROVED_SOURCE_SHA256 } = require('./capture-feedback-production-snapshot');

const EXPECTED_SUBJECT = '即出 - 新用户反馈';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = {
    environmentName: '', confirmTarget: '', allowSingleRealMail: false,
    manifestPath: MANIFEST_PATH,
    output: path.join(ROOT, 'tmp', 'feedback-production-real-mail-report.json')
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--allow-single-real-mail') options.allowSingleRealMail = true;
    else if (value === '--manifest') options.manifestPath = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--output') options.output = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'production', 'real mail smoke accepts only --env production', 'STAGING_TARGET_REJECTED');
  assert(options.allowSingleRealMail, '--allow-single-real-mail is required', 'REAL_MAIL_AUTHORIZATION_REQUIRED');
  return options;
}

function automationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'automator module is unavailable');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsEndpoint), 'local DevTools automation endpoint is unavailable');
  return { modulePath, wsEndpoint };
}

function normalizedMailError(record) {
  const code = String(record && record.mailLastErrorCode || '').trim();
  const allowed = new Set([
    'SMTP_AUTH_FAILED', 'SMTP_CONNECTION_FAILED', 'SMTP_MESSAGE_REJECTED',
    'MAIL_SEND_FAILED', 'MAIL_CONFIG_MISSING', 'MAIL_CONFIG_INVALID'
  ]);
  return allowed.has(code) ? code : code ? 'UNKNOWN_MAIL_ERROR' : '';
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: 'seed',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: true
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.production,
    'active target must be registered production', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId !== targets.staging, 'staging target is forbidden', 'STAGING_TARGET_REJECTED');
  const localHash = sha256(fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'feedbackAction', 'index.js')));
  assert(localHash === APPROVED_SOURCE_SHA256, 'feedbackAction source hash drifted', 'SOURCE_FREEZE_DRIFT');

  const manifest = loadJson(options.manifestPath);
  assert(manifest.status === 'prepared-and-verified' && manifest.environmentRole === 'production',
    'production fixture manifest is not ready', 'FIXTURE_NOT_READY');
  assert(manifest.content === FIXTURE_CONTENT && Number(manifest.maximumRealMailAttempts) === 1,
    'production fixture content or attempt limit drifted', 'FIXTURE_MANIFEST_DRIFT');
  assert(Number(manifest.realMailAttempts || 0) === 0, 'real mail attempt was already consumed', 'REAL_MAIL_ATTEMPT_ALREADY_USED');
  assert(queryCollection(preflight.environmentId, 'feedbacks', {}, 1).length === 0,
    'production feedbacks is not empty before smoke', 'FEEDBACK_BASELINE_NOT_EMPTY');
  assert(queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2).length === 0,
    'production fixture id is not clean before call', 'FIXTURE_NOT_CLEAN');

  const automation = automationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  let payload = null;
  let record = null;
  let directReadRejected = false;
  const startedAt = Date.now();
  try {
    miniProgram = await automator.connect({ wsEndpoint: automation.wsEndpoint });
    const current = await miniProgram.evaluate(async function currentUser() {
      return wx.cloud.callFunction({ name: 'authUser', data: { action: 'current', data: {} } });
    });
    assert(current && current.result && current.result.success === true
      && current.result.data && current.result.data.user.id === manifest.actorUserId,
    'DevTools identity differs from production fixture actor');

    const response = await miniProgram.evaluate(async function submitFeedback(content, requestId) {
      return wx.cloud.callFunction({
        name: 'feedbackAction',
        data: {
          action: 'submit',
          content,
          requestId,
          OPENID: 'forged-openid',
          openid: 'forged-openid',
          userOpenid: 'forged-openid',
          recipient: 'attacker@example.com'
        }
      });
    }, manifest.content, manifest.requestId);
    payload = response && response.result;
    record = queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2)[0] || null;
    const directRead = await miniProgram.evaluate(async function directFeedbackRead() {
      try {
        await wx.cloud.database().collection('feedbacks').doc('nonexistent').get();
        return { rejected: false };
      } catch (_) {
        return { rejected: true };
      }
    });
    directReadRejected = Boolean(directRead && directRead.rejected);
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }

  const latencyMs = Date.now() - startedAt;
  const mailErrorCode = normalizedMailError(record);
  const safeResult = {
    attemptedAt: new Date().toISOString(),
    realMailAttempts: 1,
    feedbackId: maskFeedbackId(manifest.feedbackId),
    responseSuccess: Boolean(payload && payload.success === true),
    accepted: Boolean(payload && payload.data && payload.data.accepted === true),
    notificationDelivered: Boolean(payload && payload.data && payload.data.notificationDelivered === true),
    status: record && record.status || '',
    mailStatus: record && record.mailStatus || '',
    mailErrorCode,
    latencyMs,
    directReadRejected
  };
  writePrivateJson(options.manifestPath, {
    ...manifest,
    status: 'submission-attempted',
    submission: safeResult,
    realMailAttempts: 1
  });

  const forbiddenKeys = [
    'recipient', 'mailRecipient', 'mailUser', 'mailSecret', 'password',
    'authorizationCode', 'transport', 'auth', 'token', 'credential'
  ];
  assert(record, 'production feedback record was not persisted', 'FEEDBACK_NOT_PERSISTED');
  forbiddenKeys.forEach((key) => assert(!Object.prototype.hasOwnProperty.call(record, key),
    `forbidden feedback field persisted: ${key}`, 'PRIVATE_FIELD_PERSISTED'));
  assert(record.content === manifest.content && record.status === 'submitted',
    'production feedback business fields drifted', 'FEEDBACK_RECORD_DRIFT');
  assert(sha256(String(record.userOpenid || '')) === manifest.actorOpenidSha256,
    'trusted production feedback identity drifted', 'FEEDBACK_IDENTITY_DRIFT');
  assert(payload && payload.success === true && payload.data && payload.data.accepted === true,
    'production feedback submit was not accepted', payload && payload.code || 'FEEDBACK_SUBMIT_FAILED');
  assert(payload.data.feedbackId === manifest.feedbackId, 'feedback id differs from private manifest', 'FEEDBACK_ID_DRIFT');
  assert(directReadRejected, 'client direct feedback database read was not rejected', 'DIRECT_DATABASE_READ_ALLOWED');
  if (record.mailStatus !== 'sent' || payload.data.notificationDelivered !== true || mailErrorCode) {
    const error = new Error(mailErrorCode || 'UNKNOWN_MAIL_ERROR');
    error.code = 'SMTP_TEST_NOT_READY';
    throw error;
  }
  assert(!record.mailLastErrorCode, 'sent feedback retained a mail error code', 'MAIL_ERROR_CODE_RETAINED');

  const report = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    mode: 'FEEDBACK_PRODUCTION_REAL_SMTP_SMOKE',
    environment: publicSummary(preflight),
    fixtureRunId: manifest.fixtureRunId,
    feedbackId: maskFeedbackId(manifest.feedbackId),
    credentialConfigured: true,
    secretValueRecorded: false,
    sourceSha256: localHash,
    realMailAttempts: 1,
    realSubmit: {
      success: true,
      accepted: true,
      status: record.status,
      mailStatus: record.mailStatus,
      mailLastErrorCodePresent: false,
      notificationDelivered: true,
      directReadRejected,
      latencyMs
    },
    expectedSubject: EXPECTED_SUBJECT,
    stagingMarkerExpected: false,
    recipientControlledByServer: true,
    ownerInboxConfirmation: 'pending',
    authorizedProductionFeedbackWrites: 1,
    passed: true
  };
  writePrivateJson(options.output, report);
  return report;
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_PRODUCTION_REAL_MAIL_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { EXPECTED_SUBJECT, parseArguments, run };
