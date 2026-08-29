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

const OUTPUT_PATH = path.join(ROOT, 'tmp', 'final-release-step-4b-production-readonly-runtime.json');
const ALLOWED_STATUSES = new Set(['available', 'reserved', 'offline', 'sold']);

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', output: OUTPUT_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--output') options.output = path.resolve(ROOT, String(argv[++index] || ''));
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'production', 'this workflow accepts only --env production', 'PRODUCTION_TARGET_REQUIRED');
  return options;
}

function automationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE || '';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath), 'PHASE23_AUTOMATOR_MODULE is unavailable');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsEndpoint), 'local DevTools automation endpoint is unavailable');
  return { modulePath, wsEndpoint };
}

function assertEnvelope(result, expectedSuccess = true) {
  assert(result && typeof result === 'object', 'response envelope missing');
  assert(typeof result.success === 'boolean' && typeof result.code === 'string'
    && typeof result.message === 'string' && Object.prototype.hasOwnProperty.call(result, 'data'),
  'response envelope drifted');
  assert(result.success === expectedSuccess, `unexpected result: ${result.code}`);
}

function validateList(result, expectedPage, expectedPageSize) {
  assertEnvelope(result, true);
  assert(result.code === 'OK' && result.data && Array.isArray(result.data.list), 'favorite list failed');
  assert(result.data.page === expectedPage && result.data.pageSize === expectedPageSize, 'pagination drifted');
  assert(Number.isInteger(result.data.total) && result.data.total >= 0, 'total drifted');
  assert(typeof result.data.hasMore === 'boolean', 'hasMore drifted');
  for (const item of result.data.list) {
    assert(item && typeof item._id === 'string' && item._id, 'DTO product ID missing');
    assert(ALLOWED_STATUSES.has(item.status), 'allowed-status filtering drifted');
    assert(!Object.prototype.hasOwnProperty.call(item, 'sellerOpenid'), 'private seller identity leaked');
  }
  for (let index = 1; index < result.data.list.length; index += 1) {
    const previous = Date.parse(result.data.list[index - 1].favoritedAt || '');
    const current = Date.parse(result.data.list[index].favoritedAt || '');
    assert(!Number.isFinite(previous) || !Number.isFinite(current) || previous >= current, 'favorite order drifted');
  }
  return result.data;
}

function signature(data) {
  return crypto.createHash('sha256').update(JSON.stringify({
    ids: data.list.map((item) => item._id),
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    hasMore: data.hasMore
  })).digest('hex');
}

async function run(options) {
  const preflight = runPreflight({ environmentName: 'production', action: 'audit' });
  assert(preflight.activeTargetMatches, 'active client target must be production', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(options.confirmTarget === preflight.environmentIdMasked,
    `confirm target with --confirm-target ${preflight.environmentIdMasked}`, 'TARGET_CONFIRMATION_REQUIRED');
  const targets = require('../config/cloud.targets.private');
  assert(preflight.environmentId === targets.production && preflight.environmentId !== targets.staging,
    'registered production target mismatch', 'PRODUCTION_TARGET_MISMATCH');
  const automation = automationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = await automator.connect({ wsEndpoint: automation.wsEndpoint });
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });
    const call = async (request) => {
      const response = await miniProgram.evaluate(async function callFavorite(data) {
        return wx.cloud.callFunction({ name: 'favoriteProduct', data });
      }, request);
      return response && response.result;
    };

    const page1 = validateList(await call({
      action: 'listMyFavorites', data: { page: 1, pageSize: 3 }
    }), 1, 3);
    const page1Repeat = validateList(await call({
      action: 'listMyFavorites', data: { page: 1, pageSize: 3 }
    }), 1, 3);
    assert(signature(page1) === signature(page1Repeat), 'page 1 order/envelope is unstable');
    const page2 = validateList(await call({
      action: 'listMyFavorites', data: { page: 2, pageSize: 3 }
    }), 2, 3);
    assert(page2.total === page1.total, 'page totals differ');
    const page1Ids = new Set(page1.list.map((item) => item._id));
    assert(page2.list.every((item) => !page1Ids.has(item._id)), 'favorite pages overlap');

    const invalidPage = validateList(await call({
      action: 'listMyFavorites', data: { page: 0, pageSize: 3 }
    }), 1, 3);
    assert(signature(invalidPage) === signature(page1), 'invalid page fallback drifted');
    const invalidPageSize = validateList(await call({
      action: 'listMyFavorites', data: { page: 1, pageSize: 0 }
    }), 1, 6);
    assert(invalidPageSize.total === page1.total, 'invalid pageSize changed total');

    const forged = validateList(await call({
      action: 'listMyFavorites',
      data: {
        page: 1,
        pageSize: 3,
        openid: 'forged-openid',
        OPENID: 'forged-openid',
        userOpenid: 'forged-openid',
        userId: `u_${'f'.repeat(32)}`
      }
    }), 1, 3);
    assert(signature(forged) === signature(page1), 'forged client identity influenced results');
    const invalidAction = await call({ action: '__step4b_invalid__', data: {} });
    assertEnvelope(invalidAction, false);
    assert(invalidAction.code === 'INVALID_ACTION', 'invalid action was not rejected');

    const directDatabase = await miniProgram.evaluate(async function directFavoriteRead() {
      try {
        await wx.cloud.database().collection('favorites').limit(1).get();
        return { rejected: false };
      } catch (error) {
        return { rejected: true };
      }
    });
    assert(directDatabase && directDatabase.rejected === true, 'client direct database read was not denied');
    assert(consoleErrors === 0 && exceptions === 0, 'DevTools recorded runtime errors');

    const report = {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      mode: 'FINAL_RELEASE_STEP_4B_PRODUCTION_READONLY_RUNTIME',
      environment: publicSummary(preflight),
      pageSize: 3,
      relationTotal: page1.total,
      page1DtoCount: page1.list.length,
      page2DtoCount: page2.list.length,
      checks: [
        'page-1', 'page-2', 'stable-order', 'total', 'has-more',
        'allowed-statuses', 'invalid-page', 'invalid-page-size',
        'forged-client-identity-ignored', 'invalid-action-rejected',
        'response-envelope', 'safe-dto', 'client-direct-database-denied'
      ],
      missingDeletedCoverageFromCurrentData: (
        Math.min(page1.total, 6) - page1.list.length - page2.list.length
      ) > 0,
      writeActionsIncluded: false,
      businessWrites: 0,
      consoleErrors,
      exceptions,
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
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'STEP4B_PRODUCTION_RUNTIME_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { OUTPUT_PATH, parseArguments, run };
