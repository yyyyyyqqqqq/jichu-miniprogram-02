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
const { MANIFEST_PATH, ACTOR_PATH } = require('./manage-feedback-staging-fixture');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    allowStagingMutation: false,
    manifestPath: MANIFEST_PATH,
    actorPath: ACTOR_PATH,
    output: path.join(ROOT, 'tmp', 'feedback-staging-missing-mail-report.json')
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--allow-staging-mutation') options.allowStagingMutation = true;
    else if (value === '--manifest') options.manifestPath = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--actor') options.actorPath = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--output') options.output = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'staging', 'missing-mail verification accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
  assert(options.allowStagingMutation, '--allow-staging-mutation is required', 'STAGING_MUTATION_CONFIRMATION_REQUIRED');
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
    action: 'seed',
    confirmTarget: options.confirmTarget,
    allowInactiveStagingWrite: false
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.staging,
    'active client target must be registered staging', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId !== targets.production, 'production target is forbidden', 'PRODUCTION_TARGET_REJECTED');
  const manifest = loadJson(options.manifestPath);
  const actor = loadJson(options.actorPath);
  assert(manifest.status === 'prepared-and-verified' && manifest.actorUserId === actor.userId,
    'feedback fixture manifest is not ready', 'FIXTURE_NOT_READY');
  assert(queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2).length === 0,
    'feedback fixture id is not clean before call', 'FIXTURE_NOT_CLEAN');

  const automation = automationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  try {
    miniProgram = await automator.connect({ wsEndpoint: automation.wsEndpoint });
    const current = await miniProgram.evaluate(async function currentUser() {
      return wx.cloud.callFunction({ name: 'authUser', data: { action: 'current', data: {} } });
    });
    assert(current && current.result && current.result.success === true
      && current.result.data && current.result.data.user.id === actor.userId,
    'DevTools identity differs from staging actor');

    const response = await miniProgram.evaluate(async function submitFeedback(content, requestId) {
      return wx.cloud.callFunction({
        name: 'feedbackAction',
        data: {
          action: 'submit',
          content,
          requestId,
          OPENID: 'forged-openid',
          userOpenid: 'forged-openid',
          recipient: 'attacker@example.com'
        }
      });
    }, manifest.content, manifest.requestId);
    const payload = response && response.result;
    assert(
      payload && payload.success === true && payload.code === 'OK',
      `feedbackAction did not accept staging feedback (${payload && payload.code || 'NO_PAYLOAD'}: ${payload && payload.message || 'no message'})`
    );
    assert(payload.data && payload.data.accepted === true && payload.data.feedbackId === manifest.feedbackId,
      'feedback acceptance envelope drifted');
    assert(payload.data.notificationDelivered === false && payload.data.mailStatus === 'failed',
      'missing mail configuration branch was not observed');

    const records = queryCollection(preflight.environmentId, 'feedbacks', { _id: manifest.feedbackId }, 2);
    assert(records.length === 1, 'feedback record was not persisted');
    const record = records[0];
    assert(sha256(record.userOpenid) === actor.openidSha256, 'trusted identity was not persisted');
    assert(record.content === manifest.content && record.status === 'submitted', 'feedback business fields drifted');
    assert(record.mailStatus === 'failed' && record.mailLastErrorCode === 'MAIL_CONFIG_MISSING',
      'missing mail failure was not persisted');
    const forbiddenKeys = ['OPENID', 'openid', 'recipient', 'mailUser', 'mailSecret', 'password', 'authorizationCode'];
    forbiddenKeys.forEach((key) => assert(!Object.prototype.hasOwnProperty.call(record, key), `forbidden field persisted: ${key}`));

    const directRead = await miniProgram.evaluate(async function directFeedbackRead() {
      try {
        await wx.cloud.database().collection('feedbacks').doc('nonexistent').get();
        return { rejected: false };
      } catch (error) {
        return { rejected: true, hasCode: Boolean(error && (error.errCode || error.code || error.errMsg)) };
      }
    });
    assert(directRead && directRead.rejected === true, 'client direct feedback database read was not rejected');

    const report = {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      mode: 'FEEDBACK_STAGING_MISSING_MAIL_RUNTIME',
      environment: publicSummary(preflight),
      fixtureRunId: manifest.fixtureRunId,
      checks: [
        'staging-actor-identity',
        'trusted-openid-ignores-forgery',
        'feedback-persisted',
        'mail-config-missing',
        'accepted-without-notification',
        'client-direct-database-rejected',
        'no-private-mail-fields-persisted'
      ],
      realSmtpAttempted: false,
      productionWrites: 0,
      passed: true
    };
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return report;
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_STAGING_RUNTIME_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, run };
