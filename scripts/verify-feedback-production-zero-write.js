'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, runPreflight, publicSummary, assert } = require('./environment-preflight');
const { queryCollection } = require('./phase-24-staging-core');
const { runNoSql } = require('./schools/cloud-cli');
const { APPROVED_SOURCE_SHA256 } = require('./capture-feedback-production-snapshot');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = { environmentName: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'production', 'zero-write probes accept only --env production', 'STAGING_TARGET_REJECTED');
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

async function run(options) {
  const preflight = runPreflight({ environmentName: options.environmentName, action: 'audit' });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.production,
    'active target must be registered production', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId !== targets.staging, 'staging target is forbidden', 'STAGING_TARGET_REJECTED');
  const localHash = sha256(fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'feedbackAction', 'index.js')));
  assert(localHash === APPROVED_SOURCE_SHA256, 'feedbackAction source hash drifted', 'SOURCE_FREEZE_DRIFT');
  assert(queryCollection(preflight.environmentId, 'feedbacks', {}, 1).length === 0,
    'feedbacks must be empty before zero-write probes', 'FEEDBACK_BASELINE_NOT_EMPTY');

  const probeId = `feedback_direct_write_probe_${Date.now()}`;
  const probeManifest = path.join(ROOT, 'tmp', 'feedback-production-zero-write-probe.json');
  fs.mkdirSync(path.dirname(probeManifest), { recursive: true });
  fs.writeFileSync(probeManifest, `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    environmentRole: 'production',
    exactProbeId: probeId,
    purpose: 'client direct database write denial probe'
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  const automation = automationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  let result;
  try {
    miniProgram = await automator.connect({ wsEndpoint: automation.wsEndpoint });
    result = await miniProgram.evaluate(async function feedbackSecurityProbes(exactProbeId) {
      const invoke = async (data) => {
        try {
          const response = await wx.cloud.callFunction({ name: 'feedbackAction', data });
          return response && response.result || null;
        } catch (error) {
          return { invocationRejected: true };
        }
      };
      const invalidAction = await invoke({ action: 'unknown', content: 'x', requestId: 'prod_invalid_action' });
      const blank = await invoke({ action: 'submit', content: '   ', requestId: 'prod_blank_content' });
      const oversized = await invoke({ action: 'submit', content: 'x'.repeat(1001), requestId: 'prod_oversized_content' });
      let directReadRejected = false;
      let directWriteRejected = false;
      try {
        await wx.cloud.database().collection('feedbacks').doc(exactProbeId).get();
      } catch (_) {
        directReadRejected = true;
      }
      try {
        await wx.cloud.database().collection('feedbacks').doc(exactProbeId).set({ data: { probe: true } });
      } catch (_) {
        directWriteRejected = true;
      }
      return {
        invalidAction: { success: invalidAction && invalidAction.success, code: invalidAction && invalidAction.code },
        blank: { success: blank && blank.success, code: blank && blank.code },
        oversized: { success: oversized && oversized.success, code: oversized && oversized.code },
        directReadRejected,
        directWriteRejected
      };
    }, probeId);
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }

  const unexpected = queryCollection(preflight.environmentId, 'feedbacks', { _id: probeId }, 2);
  if (unexpected.length > 0) deleteExactId(preflight.environmentId, probeId);
  const leftover = queryCollection(preflight.environmentId, 'feedbacks', { _id: probeId }, 2).length;
  assert(leftover === 0, 'direct write probe cleanup failed', 'PROBE_CLEANUP_FAILED');
  assert(result.invalidAction.success === false && result.invalidAction.code === 'INVALID_ACTION',
    'invalid action was not rejected', 'INVALID_ACTION_REGRESSION');
  assert(result.blank.success === false && result.blank.code === 'INVALID_CONTENT',
    'blank content was not rejected', 'BLANK_CONTENT_REGRESSION');
  assert(result.oversized.success === false && result.oversized.code === 'INVALID_CONTENT',
    'oversized content was not rejected', 'OVERSIZED_CONTENT_REGRESSION');
  assert(result.directReadRejected, 'client direct feedback read was allowed', 'DIRECT_READ_ALLOWED');
  assert(result.directWriteRejected, 'client direct feedback write was allowed', 'DIRECT_WRITE_ALLOWED');
  assert(unexpected.length === 0, 'client direct write unexpectedly created a record', 'DIRECT_WRITE_MUTATED');
  assert(queryCollection(preflight.environmentId, 'feedbacks', {}, 1).length === 0,
    'zero-write probes created a feedback record', 'ZERO_WRITE_GATE_MUTATED');

  return {
    mode: 'FEEDBACK_PRODUCTION_ZERO_WRITE_SECURITY',
    environment: publicSummary(preflight),
    sourceSha256: localHash,
    probes: result,
    validSubmitCalls: 0,
    feedbackCount: 0,
    exactProbeLeftover: 0,
    passed: true
  };
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_PRODUCTION_ZERO_WRITE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, run };
