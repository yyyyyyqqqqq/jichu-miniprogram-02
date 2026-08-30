'use strict';

const fs = require('fs');
const {
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run() {
  const preflight = runPreflight({
    environmentName: 'staging',
    action: 'audit',
    confirmTarget: ''
  });
  assert(preflight.activeTargetMatches, 'active client target must be staging');
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'automator module is unavailable');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsEndpoint), 'automation endpoint is unavailable');
  const automator = require(modulePath);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = await automator.connect({ wsEndpoint });
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });
    await miniProgram.reLaunch('/pages/feedback/index');
    await delay(1200);
    const state = await miniProgram.evaluate(function readFeedbackPageState() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return page ? {
        route: page.route,
        content: page.data.content,
        contentLength: page.data.contentLength,
        maxLength: page.data.maxLength,
        isSubmitting: page.data.isSubmitting,
        errorMessage: page.data.errorMessage,
        successMessage: page.data.successMessage
      } : null;
    });
    assert(state && state.route === 'pages/feedback/index', 'feedback page did not render');
    assert(state.content === '' && state.contentLength === 0 && state.maxLength === 1000, 'feedback initial input state drifted');
    assert(state.isSubmitting === false && !state.errorMessage && !state.successMessage, 'feedback initial status state drifted');
    assert(consoleErrors === 0 && exceptions === 0, 'DevTools recorded feedback page errors');
    return {
      passed: true,
      environment: publicSummary(preflight),
      route: state.route,
      contentLength: state.contentLength,
      maxLength: state.maxLength,
      isSubmitting: state.isSubmitting,
      consoleErrors,
      exceptions,
      businessWrites: 0
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_DEVTOOLS_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run };
