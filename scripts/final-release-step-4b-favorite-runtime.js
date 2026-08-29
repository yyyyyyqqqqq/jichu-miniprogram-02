'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  assert
} = require('./phase-18-canary-core');

const FUNCTION_NAME = 'favoriteProduct';
const ACTION = 'listMyFavorites';
const PAGE_SIZE = 10;

function parseArguments(argv) {
  const options = { confirmTarget: '', mode: '', samples: 10, output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--mode') options.mode = String(argv[++index] || '').trim();
    else if (value === '--samples') options.samples = Number(argv[++index]);
    else if (value === '--output') options.output = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(['smoke', 'measure'].includes(options.mode), '--mode smoke|measure is required');
  assert(Number.isInteger(options.samples) && options.samples >= 1 && options.samples <= 20,
    '--samples must be an integer from 1 to 20');
  if (options.mode === 'measure') assert(options.samples >= 10, 'measure mode requires 10 to 20 samples');
  return options;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values)
  };
}

function readAutomationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'PHASE23_AUTOMATOR_MODULE is unavailable');
  assert(wsEndpoint, 'PHASE23_AUTOMATOR_WS_ENDPOINT is unavailable');
  return { modulePath, wsEndpoint };
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

function validatePage(result, expectedPage) {
  assert(result && result.success === true && result.code === 'OK', 'favorite list failed');
  assert(result.data && Array.isArray(result.data.list), 'favorite list response schema drifted');
  assert(result.data.page === expectedPage, 'favorite page number drifted');
  assert(result.data.pageSize === PAGE_SIZE, 'favorite page size drifted');
  assert(Number.isInteger(result.data.total) && result.data.total >= 0, 'favorite total drifted');
  assert(typeof result.data.hasMore === 'boolean', 'favorite hasMore drifted');
  assert(result.data.list.length <= PAGE_SIZE, 'favorite page exceeded page size');
  for (const item of result.data.list) {
    assert(item && typeof item._id === 'string' && item._id, 'favorite item id missing');
    assert(['available', 'reserved', 'offline', 'sold'].includes(item.status), 'favorite status filter drifted');
    assert(!Object.prototype.hasOwnProperty.call(item, 'sellerOpenid'), 'favorite private seller identity leaked');
  }
  for (let index = 1; index < result.data.list.length; index += 1) {
    const previous = new Date(result.data.list[index - 1].favoritedAt || 0).getTime();
    const current = new Date(result.data.list[index].favoritedAt || 0).getTime();
    assert(!Number.isFinite(previous) || !Number.isFinite(current) || previous >= current,
      'favorite order drifted');
  }
}

function pageSignature(result) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      ids: result.data.list.map((item) => item._id),
      total: result.data.total,
      hasMore: result.data.hasMore,
      page: result.data.page,
      pageSize: result.data.pageSize
    }))
    .digest('hex');
}

async function run(options) {
  const environmentId = loadEnvironmentId();
  const target = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === target, `confirm target with --env ${target}`);
  const automation = readAutomationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = await withTimeout(
      automator.connect({ wsEndpoint: automation.wsEndpoint }),
      'automation connection'
    );
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });

    const invoke = async (page) => {
      const startedAt = Date.now();
      const response = await withTimeout(miniProgram.evaluate(
        async function callFavoriteList(functionName, action, requestPage, pageSize) {
          return wx.cloud.callFunction({
            name: functionName,
            data: { action, data: { page: requestPage, pageSize } }
          });
        },
        FUNCTION_NAME,
        ACTION,
        page,
        PAGE_SIZE
      ), `${FUNCTION_NAME}:${ACTION}`);
      const durationMs = Date.now() - startedAt;
      const result = response && response.result;
      validatePage(result, page);
      return {
        result,
        durationMs,
        payloadBytes: Buffer.byteLength(JSON.stringify(result), 'utf8')
      };
    };

    const warmup = await invoke(1);
    const durations = [];
    const payloads = [];
    let stableSignature = pageSignature(warmup.result);
    for (let index = 0; index < options.samples; index += 1) {
      const sample = await invoke(1);
      assert(pageSignature(sample.result) === stableSignature, 'favorite list changed during sequential samples');
      durations.push(sample.durationMs);
      payloads.push(sample.payloadBytes);
    }
    const secondPage = await invoke(2);
    assert(secondPage.result.data.total === warmup.result.data.total, 'favorite total differs between pages');
    const firstIds = new Set(warmup.result.data.list.map((item) => item._id));
    assert(secondPage.result.data.list.every((item) => !firstIds.has(item._id)), 'favorite pages overlap');
    assert(consoleErrors === 0 && exceptions === 0, 'DevTools recorded runtime errors');

    const report = {
      schemaVersion: 1,
      mode: `FINAL_RELEASE_STEP_4B_FAVORITE_${options.mode.toUpperCase()}`,
      completedAt: new Date().toISOString(),
      target: `cloud:${target}`,
      functionName: FUNCTION_NAME,
      action: ACTION,
      pageSize: PAGE_SIZE,
      warmupSamplesExcluded: 1,
      formalSamples: options.samples,
      sequential: true,
      concurrency: 1,
      errors: 0,
      latencyMs: summarize(durations),
      payloadBytes: summarize(payloads),
      total: warmup.result.data.total,
      firstPageRelationCount: Math.min(PAGE_SIZE, warmup.result.data.total),
      firstPageCount: warmup.result.data.list.length,
      firstPageFilteredOrMissingCount: Math.max(
        0,
        Math.min(PAGE_SIZE, warmup.result.data.total) - warmup.result.data.list.length
      ),
      secondPageCount: secondPage.result.data.list.length,
      stableOrderAndEnvelope: true,
      writeActionsIncluded: false,
      fixtureCreated: false,
      consoleErrors,
      exceptions,
      passed: true
    };
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600
      });
    }
    return report;
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STEP4B_FAVORITE_RUNTIME_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { FUNCTION_NAME, ACTION, PAGE_SIZE, parseArguments, run };
