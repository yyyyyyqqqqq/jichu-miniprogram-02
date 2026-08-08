const { loadEnvironmentId } = require('./phase-18-canary-core');
const { searchChallengeLogs } = require('./resolve-phase-18-dual-account-cls');
const {
  loadDualAccountPrivate,
  writePrivateJson,
  PRIVATE_DUAL_ACCOUNT_PATH,
  assert
} = require('./phase-18-dual-account-core');

function run() {
  const entries = searchChallengeLogs(loadEnvironmentId(), '', 'function_name:"productQuery"');
  const matches = entries.filter((entry) => {
    const content = JSON.stringify(entry && entry.content || {});
    return content.includes('[phase18-cross-school-cursor-probe]')
      && content.includes('INVALID_CURSOR_SCOPE');
  });
  assert(matches.length >= 1, 'cross-school cursor rejection log was not found');
  const privateData = loadDualAccountPrivate();
  privateData.crossSchoolCursorProbe = {
    completedAt: new Date().toISOString(),
    sourceRole: 'A',
    submitterRole: 'B',
    code: 'INVALID_CURSOR_SCOPE',
    logMatches: matches.length,
    rawLogsStored: false
  };
  writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, privateData);
  return {
    passed: true,
    direction: 'A cursor -> B account',
    code: 'INVALID_CURSOR_SCOPE',
    rawLogsStored: false
  };
}

try {
  process.stdout.write(`${JSON.stringify(run(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`PHASE18_CROSS_SCHOOL_CURSOR_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}
