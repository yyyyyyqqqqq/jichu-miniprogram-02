const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  assert
} = require('./phase-18-canary-core');

const MODE = 'phase-23-production-read-only-performance';
const DEFAULT_OUTPUT = path.join(ROOT, 'tmp', 'phase-23-performance-private.json');

function parsePositiveInteger(value, fallback, maximum, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw Object.assign(new Error(`${label} must be an integer from 1 to ${maximum}`), {
      code: 'INVALID_ARGUMENT'
    });
  }
  return number;
}

function parseArguments(argv) {
  const options = {
    describeTarget: false,
    confirmTarget: '',
    iterations: 5,
    concurrency: 2,
    output: DEFAULT_OUTPUT
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--describe-target') options.describeTarget = true;
    else if (value === '--env' || value === '--confirm-target') {
      options.confirmTarget = String(argv[++index] || '').trim();
    } else if (value === '--iterations') {
      options.iterations = parsePositiveInteger(argv[++index], 5, 20, 'iterations');
    } else if (value === '--concurrency') {
      options.concurrency = parsePositiveInteger(argv[++index], 2, 5, 'concurrency');
    } else if (value === '--output') options.output = path.resolve(String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function statistics(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] == null ? null : sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null
  };
}

function unwrap(response) {
  const result = response && response.result;
  assert(result && typeof result.success === 'boolean', 'invalid cloud response');
  return result;
}

function readAutomationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || process.env.PHASE22_AUTOMATOR_MODULE || '';
  const cliPath = process.env.PHASE23_DEVTOOLS_CLI_PATH || process.env.PHASE22_DEVTOOLS_CLI_PATH || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'PHASE23_AUTOMATOR_MODULE is unavailable');
  assert(wsEndpoint || (cliPath && fs.existsSync(cliPath)), 'DevTools endpoint or CLI path is unavailable');
  return { modulePath, cliPath, wsEndpoint };
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

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
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
      writeActionsIncluded: false
    };
  }
  if (options.confirmTarget !== targetMasked) {
    throw Object.assign(new Error(`confirm target with --env ${targetMasked}`), {
      code: 'TARGET_ENV_CONFIRMATION_REQUIRED'
    });
  }
  const automation = readAutomationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
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

    const invoke = async (name, action, data) => {
      const payload = name === 'schoolQuery'
        ? { action, ...data }
        : { action, data };
      const started = Date.now();
      const response = await withTimeout(miniProgram.evaluate(
        async function callCloud(functionName, payload) {
          return wx.cloud.callFunction({ name: functionName, data: payload });
        },
        name,
        payload
      ), `${name}:${action}`);
      const result = unwrap(response);
      const durationMs = Date.now() - started;
      if (!result.success) {
        const error = new Error(`${name}:${action} failed with ${result.code}`);
        error.code = result.code || 'CLOUD_CALL_FAILED';
        throw error;
      }
      return { result, durationMs };
    };

    const current = await invoke('authUser', 'current', {});
    assert(current.result.data && current.result.data.user && current.result.data.user.schoolId, 'authenticated school context is unavailable');
    const publicUserId = current.result.data.user.id;
    const firstProducts = await invoke('productQuery', 'list', {
      categoryId: 'all', sortBy: 'default', keyword: '', pageSize: 10
    });
    assert(firstProducts.result.data.marketMode === 'schoolScoped', 'product list is not schoolScoped');
    const product = (firstProducts.result.data.list || [])[0] || null;
    const cursor = firstProducts.result.data.nextCursor || '';
    const conversations = await invoke('messageQuery', 'listConversations', { pageSize: 10 });
    const conversation = (conversations.result.data.list || [])[0] || null;
    const appointments = await invoke('appointmentQuery', 'listMine', { pageSize: 10 });
    const appointment = (appointments.result.data.list || [])[0] || null;

    const cases = [
      ['auth.current', 'authUser', 'current', {}],
      ['products.default', 'productQuery', 'list', { categoryId: 'all', sortBy: 'default', keyword: '', pageSize: 10 }],
      ['products.newest', 'productQuery', 'list', { categoryId: 'all', sortBy: 'newest', keyword: '', pageSize: 10 }],
      ['products.priceAsc', 'productQuery', 'list', { categoryId: 'all', sortBy: 'priceAsc', keyword: '', pageSize: 10 }],
      ['products.priceDesc', 'productQuery', 'list', { categoryId: 'all', sortBy: 'priceDesc', keyword: '', pageSize: 10 }],
      ['products.category', 'productQuery', 'list', { categoryId: 'books', sortBy: 'default', keyword: '', pageSize: 10 }],
      ['products.keyword', 'productQuery', 'list', { categoryId: 'all', sortBy: 'default', keyword: 'phase23-no-match', pageSize: 10 }],
      ['favorites.list', 'favoriteProduct', 'listMyFavorites', { page: 1, pageSize: 10 }],
      ['messages.conversations', 'messageQuery', 'listConversations', { pageSize: 10 }],
      ['appointments.list', 'appointmentQuery', 'listMine', { pageSize: 10 }],
      ['schools.list', 'schoolQuery', 'list', { pageSize: 10 }],
      ['schools.search', 'schoolQuery', 'search', { keyword: '上海', pageSize: 10 }],
      ['seller.profile', 'userQuery', 'publicProfile', { publicUserId }],
      ['seller.products', 'userQuery', 'publicProducts', { publicUserId, page: 1, pageSize: 10 }]
    ];
    if (cursor) {
      cases.push(['products.cursor', 'productQuery', 'list', {
        categoryId: 'all', sortBy: 'default', keyword: '', pageSize: 10, cursor
      }]);
    }
    if (product && product._id) {
      cases.push(['products.detail', 'productQuery', 'detail', { productId: product._id }]);
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

    const reportCases = [];
    for (const [label, name, action, data] of cases) {
      const firstObserved = await invoke(name, action, data);
      const tasks = Array.from({ length: options.iterations }, () => async () => (
        invoke(name, action, data)
      ));
      const samples = await runPool(tasks, options.concurrency);
      reportCases.push({
        label,
        functionName: name,
        action,
        firstObservedMs: firstObserved.durationMs,
        warm: statistics(samples.map((item) => item.durationMs)),
        errors: 0
      });
    }
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');
    const allWarm = reportCases.flatMap((item) => Array.from({ length: item.warm.count }, () => item.warm.p50));
    return {
      schemaVersion: 1,
      mode: MODE,
      completedAt: new Date().toISOString(),
      target: `cloud:${targetMasked}`,
      parameters: { iterations: options.iterations, concurrency: options.concurrency },
      scope: {
        cases: reportCases.length,
        writeActionsIncluded: false,
        databaseDirectReads: false,
        fixtureCreated: false,
        controlledColdStart: false,
        note: 'firstObservedMs is observational only; it is not a forced cold-start measurement'
      },
      cases: reportCases,
      aggregate: {
        warmSamples: reportCases.reduce((sum, item) => sum + item.warm.count, 0),
        p50OfCaseP50: statistics(reportCases.map((item) => item.warm.p50)).p50,
        maxObserved: Math.max(...reportCases.map((item) => Math.max(item.firstObservedMs, item.warm.max))),
        errors: 0
      },
      consoleErrors,
      exceptions,
      passed: allWarm.length > 0 && consoleErrors === 0 && exceptions === 0
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
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
    process.stderr.write(`${error.code || 'PHASE23_PERFORMANCE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  MODE,
  parseArguments,
  percentile,
  statistics,
  runPool,
  run
};
