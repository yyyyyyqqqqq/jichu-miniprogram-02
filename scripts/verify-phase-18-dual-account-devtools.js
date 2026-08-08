const fs = require('fs');
const path = require('path');
const {
  FINAL_FIXTURE_PREFIX,
  PRIVATE_DUAL_ACCOUNT_PATH,
  loadDualAccountPrivate,
  maskId,
  assert,
  writePrivateJson
} = require('./phase-18-dual-account-core');
const MarketCore = require('../cloudfunctions/productQuery/market-core');

const MODULE = process.env.PHASE18_DUAL_AUTOMATOR_MODULE;
const ENDPOINT = process.env.PHASE18_DUAL_AUTOMATOR_WS_ENDPOINT;
const ROLE = String(process.env.PHASE18_DUAL_ACCOUNT_ROLE || 'A').toUpperCase();

function withTimeout(promise, label, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function payload(response) {
  const value = response && response.result;
  assert(value && typeof value.success === 'boolean', 'invalid cloud response');
  return value;
}

function assertSorted(items, sortBy) {
  for (let index = 1; index < items.length; index += 1) {
    assert(
      MarketCore.compareRecords(items[index - 1], items[index], sortBy) <= 0,
      `${sortBy} order is invalid`
    );
  }
}

async function waitForHome(miniProgram, schoolId, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await miniProgram.evaluate(function readHomeData() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return page ? page.data : null;
    });
    if (
      data
      && data.isLoading === false
      && data.marketMode === 'schoolScoped'
      && data.marketScope
      && data.marketScope.schoolId === schoolId
    ) return data;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('home strict data did not settle');
}

async function run() {
  assert(MODULE && fs.existsSync(MODULE) && ENDPOINT, 'developer-tools automation settings are required');
  assert(['A', 'B'].includes(ROLE), 'account role must be A or B');
  const privateData = loadDualAccountPrivate();
  const account = ROLE === 'A' ? privateData.accountA : privateData.accountB;
  const other = ROLE === 'A' ? privateData.accountB : privateData.accountA;
  const MiniProgram = require(path.join(MODULE, 'out', 'MiniProgram')).default;
  const originalCheckVersion = MiniProgram.prototype.checkVersion;
  MiniProgram.prototype.checkVersion = async function skipBrokenVersionProbe() {};
  const automator = require(MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  const timings = [];
  try {
    miniProgram = await withTimeout(automator.connect({ wsEndpoint: ENDPOINT }), 'automation connection');
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });
    const rawCall = async (name, data) => {
      const started = Date.now();
      const response = await withTimeout(miniProgram.evaluate(
        async function callCloud(functionName, functionData) {
          return wx.cloud.callFunction({ name: functionName, data: functionData });
        }, name, data
      ), `${name} cloud call`);
      timings.push(Date.now() - started);
      return payload(response);
    };
    const list = (data) => rawCall('productQuery', { action: 'list', data });
    const current = await rawCall('authUser', { action: 'current', data: {} });
    assert(current.success === true && current.data && current.data.user, 'current account is not logged in');
    assert(current.data.user.id === account.userId, `current identity is not account ${ROLE}`);
    assert(current.data.user.schoolId === account.schoolId, `account ${ROLE} school is stale`);

    const seen = new Set();
    const defaultFirstPageIds = new Set();
    let firstCursor = '';
    for (const sortBy of ['default', 'newest', 'priceAsc', 'priceDesc']) {
      const result = await list({ categoryId: 'all', keyword: '', sortBy, pageSize: 6 });
      assert(result.success === true, `${sortBy} list failed`);
      assert(result.data.marketMode === 'schoolScoped', `${sortBy} did not use strict mode`);
      assert(result.data.scope.schoolId === account.schoolId, `${sortBy} scope is incorrect`);
      assert(result.data.scope.schoolName === account.schoolName, `${sortBy} school name is incorrect`);
      assert(result.data.page == null && result.data.total == null, `${sortBy} leaked legacy pagination`);
      const items = result.data.list || [];
      assert(items.every((item) => item.schoolId === account.schoolId), `${sortBy} leaked another school`);
      assert(items.every((item) => item.schoolId !== other.schoolId), `${sortBy} included the other school`);
      assertSorted(items, sortBy);
      items.forEach((item) => seen.add(item._id));
      if (ROLE === 'A') {
        assert(result.data.hasMore === true && result.data.nextCursor, `${sortBy} does not have the required second page`);
        const next = await list({
          categoryId: 'all', keyword: '', sortBy, pageSize: 6, cursor: result.data.nextCursor
        });
        assert(next.success === true, `${sortBy} second page failed`);
        const secondPage = next.data.list || [];
        assert(secondPage.length > 0, `${sortBy} second page is empty`);
        assert(secondPage.every((item) => item.schoolId === account.schoolId), `${sortBy} second page leaked another school`);
        assert(new Set([...items, ...secondPage].map((item) => item._id)).size === items.length + secondPage.length, `${sortBy} pages contain duplicates`);
        assertSorted([...items, ...secondPage], sortBy);
        secondPage.forEach((item) => seen.add(item._id));
      }
      if (sortBy === 'default') {
        firstCursor = result.data.nextCursor || '';
        items.forEach((item) => defaultFirstPageIds.add(item._id));
      }
    }

    for (const filters of [
      { categoryId: 'books', keyword: '', sortBy: 'default', pageSize: 6 },
      { categoryId: 'all', keyword: '阶段18', sortBy: 'default', pageSize: 6 }
    ]) {
      const result = await list(filters);
      assert(result.success === true && result.data.marketMode === 'schoolScoped', 'filtered list left strict mode');
      assert(result.data.scope.schoolId === account.schoolId, 'filtered list changed school scope');
      assert((result.data.list || []).every((item) => item.schoolId === account.schoolId), 'filtered list leaked another school');
    }

    const fixtureSearch = await list({
      categoryId: 'all', keyword: FINAL_FIXTURE_PREFIX, sortBy: 'default', pageSize: 6
    });
    const fixtureTitles = (fixtureSearch.data && fixtureSearch.data.list || []).map((item) => item.title);
    assert(fixtureSearch.success === true, 'final fixture search failed');
    assert(!fixtureTitles.includes(`${FINAL_FIXTURE_PREFIX}A`), 'offline final fixture A became public');
    assert(!fixtureTitles.includes(`${FINAL_FIXTURE_PREFIX}B`), 'offline final fixture B became public');

    const forged = await list({
      categoryId: 'all', keyword: '', sortBy: 'default', pageSize: 6,
      schoolId: other.schoolId,
      userId: other.userId
    });
    assert(forged.success === true && forged.data.scope.schoolId === account.schoolId, 'client-forged identity/school changed scope');
    if (firstCursor) {
      const next = await list({ categoryId: 'all', keyword: '', sortBy: 'default', pageSize: 6, cursor: firstCursor });
      assert(next.success === true && next.data.scope.schoolId === account.schoolId, 'cursor page changed school scope');
      assert((next.data.list || []).every((item) => item.schoolId === account.schoolId), 'cursor page leaked another school');
      assert((next.data.list || []).every((item) => !defaultFirstPageIds.has(item._id)), 'cursor page contains duplicates');
      for (const mismatch of [
        { categoryId: 'all', keyword: '', sortBy: 'newest', pageSize: 6 },
        { categoryId: 'all', keyword: '阶段18', sortBy: 'default', pageSize: 6 },
        { categoryId: 'books', keyword: '', sortBy: 'default', pageSize: 6 },
        { categoryId: 'all', keyword: '', sortBy: 'default', pageSize: 5 }
      ]) {
        const rejected = await list({ ...mismatch, cursor: firstCursor });
        assert(rejected.success === false && rejected.code === 'INVALID_CURSOR_SCOPE', 'query-mismatched cursor was not rejected');
      }
    }

    if (ROLE === 'B') {
      const latest = loadDualAccountPrivate();
      const accountACursor = latest.finalCutoverValidation
        && latest.finalCutoverValidation.accountA
        && latest.finalCutoverValidation.accountA.cursor;
      assert(accountACursor, 'account A final-cutover cursor is unavailable');
      const rejected = await list({
        categoryId: 'all', keyword: '', sortBy: 'default', pageSize: 6, cursor: accountACursor
      });
      assert(rejected.success === false && rejected.code === 'INVALID_CURSOR_SCOPE', 'account A cursor was accepted by account B');
    }

    await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'home relaunch');
    const home = await waitForHome(miniProgram, account.schoolId);
    assert((home.products || []).every((item) => item.schoolId === account.schoolId), 'home rendered mixed-school products');
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');

    const roleKey = ROLE === 'A' ? 'accountA' : 'accountB';
    const updated = loadDualAccountPrivate();
    updated.devtoolsValidation = updated.devtoolsValidation || {};
    updated.devtoolsValidation[roleKey] = {
      completedAt: new Date().toISOString(),
      marketMode: 'schoolScoped',
      schoolId: account.schoolId,
      sortsVerified: ['default', 'newest', 'priceAsc', 'priceDesc'],
      categoryVerified: true,
      searchVerified: true,
      fixtureIsolationVerified: true,
      cursorVerified: Boolean(firstCursor),
      cursor: firstCursor,
      forgedScopeIgnored: true,
      homeStrictRendered: true,
      productCountObserved: seen.size,
      consoleErrors,
      exceptions
    };
    updated.finalCutoverValidation = updated.finalCutoverValidation || {};
    updated.finalCutoverValidation[roleKey] = {
      completedAt: new Date().toISOString(),
      marketMode: 'schoolScoped',
      strictForAllWithoutAllowlist: true,
      schoolId: account.schoolId,
      sortsVerified: ['default', 'newest', 'priceAsc', 'priceDesc'],
      twoPagesPerSort: ROLE === 'A',
      categoryVerified: true,
      searchVerified: true,
      offlineFixturesHidden: true,
      cursorVerified: Boolean(firstCursor),
      cursorQueryMismatchRejected: Boolean(firstCursor),
      crossAccountCursorRejected: ROLE === 'B',
      cursor: firstCursor,
      forgedScopeIgnored: true,
      homeStrictRendered: true,
      productCountObserved: seen.size,
      consoleErrors,
      exceptions,
      timings
    };
    writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, updated);
    const sortedTimings = timings.sort((left, right) => left - right);
    return {
      passed: true,
      role: ROLE,
      userId: maskId(account.userId),
      schoolId: maskId(account.schoolId),
      schoolName: account.schoolName,
      marketMode: 'schoolScoped',
      sortsVerified: ['default', 'newest', 'priceAsc', 'priceDesc'],
      categoryVerified: true,
      searchVerified: true,
      fixtureIsolationVerified: true,
      cursorVerified: Boolean(firstCursor),
      forgedScopeIgnored: true,
      productCountObserved: seen.size,
      timingMs: {
        count: sortedTimings.length,
        min: sortedTimings[0],
        max: sortedTimings[sortedTimings.length - 1]
      },
      consoleErrors,
      exceptions
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
    MiniProgram.prototype.checkVersion = originalCheckVersion;
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE18_DUAL_ACCOUNT_DEVTOOLS_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
});
