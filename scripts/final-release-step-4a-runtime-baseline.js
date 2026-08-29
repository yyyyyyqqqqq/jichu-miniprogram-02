'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  assert
} = require('./phase-18-canary-core');

const OUTPUT_PATH = path.join(ROOT, 'tmp', 'final-release-step-4a-runtime-baseline.json');
const ALLOWED_READ_ACTIONS = Object.freeze({
  authUser: new Set(['current']),
  productQuery: new Set(['list', 'myProducts', 'detail']),
  messageQuery: new Set(['listConversations', 'listMessages']),
  appointmentQuery: new Set(['listMine', 'detail']),
  schoolQuery: new Set(['list'])
});

function parseArguments(argv) {
  const options = { confirmTarget: '', samples: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--samples') options.samples = Number(argv[++index]);
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(Number.isInteger(options.samples) && options.samples >= 3 && options.samples <= 8,
    '--samples must be an integer from 3 to 8');
  return options;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null
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

function assertReadAction(functionName, action) {
  assert(
    ALLOWED_READ_ACTIONS[functionName]
      && ALLOWED_READ_ACTIONS[functionName].has(action),
    `${functionName}:${action} is not on the read-only allowlist`
  );
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

    const invoke = async (functionName, action, data = {}) => {
      assertReadAction(functionName, action);
      const payload = functionName === 'schoolQuery'
        ? { action, ...data }
        : { action, data };
      const started = Date.now();
      const response = await withTimeout(miniProgram.evaluate(
        async function callReadOnlyCloud(name, request) {
          return wx.cloud.callFunction({ name, data: request });
        },
        functionName,
        payload
      ), `${functionName}:${action}`);
      const durationMs = Date.now() - started;
      const result = response && response.result;
      assert(result && result.success === true, `${functionName}:${action} failed`);
      return {
        result,
        durationMs,
        payloadBytes: Buffer.byteLength(JSON.stringify(result), 'utf8')
      };
    };

    const discovery = {};
    discovery.current = await invoke('authUser', 'current');
    discovery.myProducts = await invoke('productQuery', 'myProducts', {
      page: 1, pageSize: 20
    });
    discovery.conversations = await invoke('messageQuery', 'listConversations', { pageSize: 1 });
    discovery.appointments = await invoke('appointmentQuery', 'listMine', { pageSize: 1 });

    const product = (discovery.myProducts.result.data.list || [])
      .find((item) => item && item.status === 'sold') || null;
    const conversation = (discovery.conversations.result.data.list || [])[0] || null;
    const appointment = (discovery.appointments.result.data.list || [])[0] || null;
    const cases = [
      ['auth.current', 'authUser', 'current', {}],
      ['products.homeFirstPage', 'productQuery', 'list', {
        categoryId: 'all', sortBy: 'default', keyword: '', pageSize: 6
      }],
      ['products.ownerFirstPage', 'productQuery', 'myProducts', {
        page: 1, pageSize: 6
      }],
      ['products.ownerSecondPage', 'productQuery', 'myProducts', {
        page: 2, pageSize: 6
      }],
      ['messages.conversations', 'messageQuery', 'listConversations', { pageSize: 10 }],
      ['appointments.list', 'appointmentQuery', 'listMine', { pageSize: 10 }],
      ['schools.firstPage', 'schoolQuery', 'list', { pageSize: 20 }]
    ];
    if (product && product._id) {
      cases.push(['products.ownerDetail', 'productQuery', 'detail', { productId: product._id }]);
    }
    if (conversation && conversation.conversationId) {
      cases.push(['messages.history', 'messageQuery', 'listMessages', {
        conversationId: conversation.conversationId, pageSize: 20
      }]);
    }
    if (appointment && appointment.appointmentId) {
      cases.push(['appointments.detail', 'appointmentQuery', 'detail', {
        appointmentId: appointment.appointmentId
      }]);
    }

    const results = [];
    for (const [endpoint, functionName, action, data] of cases) {
      const durations = [];
      const payloads = [];
      for (let index = 0; index < options.samples; index += 1) {
        const sample = await invoke(functionName, action, data);
        durations.push(sample.durationMs);
        payloads.push(sample.payloadBytes);
      }
      results.push({
        endpoint,
        functionName,
        action,
        errors: 0,
        latencyMs: summarize(durations),
        payloadBytes: summarize(payloads)
      });
    }
    assert(consoleErrors === 0 && exceptions === 0, 'DevTools recorded errors');
    const report = {
      schemaVersion: 1,
      mode: 'FINAL_RELEASE_STEP_4A_PRODUCTION_READ_ONLY_BASELINE',
      completedAt: new Date().toISOString(),
      target: `cloud:${target}`,
      samplesPerEndpoint: options.samples,
      writeActionsIncluded: false,
      fixturesCreated: false,
      controlledColdStart: false,
      publicHomeCursorAvailable: false,
      publicHomeCursorReason: 'PUBLIC MARKET ZERO',
      productDetailSampleAvailable: Boolean(product),
      productDetailSampleReason: product
        ? 'existing owner sold product'
        : 'no safe readable product under PUBLIC MARKET ZERO',
      cases: results,
      consoleErrors,
      exceptions,
      passed: true
    };
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600
    });
    return report;
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STEP4A_BASELINE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { ALLOWED_READ_ACTIONS, OUTPUT_PATH, parseArguments, summarize, run };
