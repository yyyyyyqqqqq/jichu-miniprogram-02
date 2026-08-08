const fs = require('fs');
const {
  PRIVATE_CANARY_PATH,
  FIXTURE_PREFIX,
  loadJson,
  maskId,
  assert,
  writePrivateJson
} = require('./phase-18-canary-core');

const MODULE = process.env.PHASE18_CANARY_AUTOMATOR_MODULE;
const ENDPOINT = process.env.PHASE18_CANARY_AUTOMATOR_WS_ENDPOINT;

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

function fixtureIds(result) {
  return (result.data.list || []).filter((item) => String(item.title || '').startsWith(FIXTURE_PREFIX)).map((item) => item._id);
}

function compare(spec, left, right) {
  const desc = (a, b) => a === b ? 0 : a > b ? -1 : 1;
  if (spec === 'default') {
    return desc(left.favoriteCount, right.favoriteCount)
      || desc(left.viewCount, right.viewCount)
      || desc(left.createdAt, right.createdAt)
      || left.productId.localeCompare(right.productId);
  }
  if (spec === 'newest') return desc(left.createdAt, right.createdAt) || left.productId.localeCompare(right.productId);
  if (spec === 'priceAsc') return left.price - right.price || desc(left.createdAt, right.createdAt) || left.productId.localeCompare(right.productId);
  return right.price - left.price || desc(left.createdAt, right.createdAt) || left.productId.localeCompare(right.productId);
}

async function waitForPath(miniProgram, suffix, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const page = await miniProgram.currentPage();
    if (page && String(page.path || '').endsWith(suffix)) return page;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`page did not reach ${suffix}`);
}

async function waitForPageData(miniProgram, predicate, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await miniProgram.evaluate(function readPageData() {
      const pages = getCurrentPages(); const page = pages[pages.length - 1];
      return page ? page.data : null;
    });
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('page data did not settle');
}

async function run() {
  assert(MODULE && ENDPOINT, 'developer-tools automation settings are required');
  assert(fs.existsSync(PRIVATE_CANARY_PATH), 'private fixture result is missing');
  const privateData = loadJson(PRIVATE_CANARY_PATH);
  const automator = require(MODULE);
  let miniProgram;
  const timings = [];
  let consoleErrors = 0;
  let exceptions = 0;
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
      timings.push({
        label: name === 'productQuery'
          ? `${data.action}:${data.data && data.data.sortBy || ''}:${data.data && data.data.categoryId || ''}:${data.data && data.data.cursor ? 'cursor' : 'first'}`
          : `${name}:${data.action || ''}`,
        durationMs: Date.now() - started
      });
      return payload(response);
    };
    const current = async () => rawCall('authUser', { action: 'current', data: {} });
    const list = async (data) => rawCall('productQuery', { action: 'list', data });
    const expectInvalidCursor = async (data, label) => {
      const result = await list(data);
      assert(result.success === false && result.code === 'INVALID_CURSOR_SCOPE', `${label} was not rejected`);
    };
    const userBefore = (await current()).data.user;
    assert(userBefore.id === privateData.userId, 'unexpected developer-tools user');
    assert(userBefore.schoolId === privateData.schoolB.id, 'canary must start at school B');

    const bFirst = await list({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'all', pageSize: 4 });
    assert(bFirst.success && bFirst.data.marketMode === 'schoolScoped', 'allowlisted user did not enter strict mode');
    assert(bFirst.data.scope.schoolId === privateData.schoolB.id, 'strict scope is not school B');
    assert(bFirst.data.page == null && bFirst.data.total == null, 'strict response leaked legacy pagination fields');
    assert(bFirst.data.hasMore === true && bFirst.data.nextCursor, 'school B first page has no signed cursor');
    assert((bFirst.data.list || []).every((item) => item.schoolId === privateData.schoolB.id), 'school B list leaked another school');
    const bCursor = bFirst.data.nextCursor;
    const bSecond = await list({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'all', pageSize: 4, cursor: bCursor });
    assert(bSecond.success && bSecond.data.marketMode === 'schoolScoped', 'school B second page failed');
    const bSeen = [...fixtureIds(bFirst), ...fixtureIds(bSecond)];
    assert(new Set(bSeen).size === 5, 'school B cursor paging has duplicates or gaps');
    const cursorPayload = JSON.parse(Buffer.from(bCursor.split('.')[0], 'base64url').toString('utf8'));
    assert(cursorPayload.normalizedKeywordDigest && !JSON.stringify(cursorPayload).includes(FIXTURE_PREFIX), 'cursor contains plaintext keyword');
    const tampered = `${bCursor.slice(0, -1)}${bCursor.endsWith('a') ? 'b' : 'a'}`;
    await expectInvalidCursor({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'all', pageSize: 4, cursor: tampered }, 'tampered cursor');
    await expectInvalidCursor({ keyword: FIXTURE_PREFIX, sortBy: 'newest', categoryId: 'all', pageSize: 4, cursor: bCursor }, 'sort-bound cursor');
    await expectInvalidCursor({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'books', pageSize: 4, cursor: bCursor }, 'category-bound cursor');
    await expectInvalidCursor({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'all', pageSize: 5, cursor: bCursor }, 'page-size-bound cursor');
    await expectInvalidCursor({ keyword: `${FIXTURE_PREFIX}修改`, sortBy: 'default', categoryId: 'all', pageSize: 4, cursor: bCursor }, 'keyword-bound cursor');
    await expectInvalidCursor({ keyword: '', sortBy: 'default', categoryId: 'all', pageSize: 4, cursor: bCursor }, 'cleared-keyword cursor');

    const uiSwitch = async (school) => {
      await miniProgram.switchTab('/pages/profile/index');
      await waitForPath(miniProgram, 'pages/profile/index');
      await withTimeout(miniProgram.evaluate(async function openSchoolChange() {
        const pages = getCurrentPages(); const page = pages[pages.length - 1];
        await page.changeSchool(); return true;
      }), 'open school change');
      await waitForPath(miniProgram, 'pages/school-select/index');
      await miniProgram.evaluate(function tapSchool(id) {
        const pages = getCurrentPages(); const page = pages[pages.length - 1];
        page.onSchoolTap({ currentTarget: { dataset: { id } } });
      }, school.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await miniProgram.native().confirmModal();
      await waitForPath(miniProgram, 'pages/profile/index');
      const changed = (await current()).data.user;
      assert(changed.schoolId === school.id && changed.schoolName === school.name, 'UI school change did not persist');
      return changed;
    };

    const userA = await uiSwitch(privateData.schoolA);
    assert(userA.schoolVersion > userBefore.schoolVersion, 'school version did not increase B to A');
    await expectInvalidCursor({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'all', pageSize: 4, cursor: bCursor }, 'cross-school B cursor');

    const aFixtures = privateData.fixtures.filter((item) => item.school === 'A' && ['available', 'reserved'].includes(item.status));
    for (const sortBy of ['default', 'newest', 'priceAsc', 'priceDesc']) {
      const actual = [];
      let cursor = '';
      let pageCount = 0;
      do {
        const result = await list({ keyword: FIXTURE_PREFIX, sortBy, categoryId: 'all', pageSize: 4, cursor });
        assert(result.success && result.data.scope.schoolId === privateData.schoolA.id, `${sortBy} strict page failed`);
        assert(result.data.page == null && result.data.total == null, `${sortBy} returned legacy pagination fields`);
        if (pageCount === 0) {
          assert(result.data.hasMore === true && result.data.nextCursor, `${sortBy} first page has no cursor`);
        }
        actual.push(...fixtureIds(result));
        cursor = result.data.hasMore ? result.data.nextCursor : '';
        pageCount += 1;
      } while (cursor);
      const expected = [...aFixtures].sort((left, right) => compare(sortBy, left, right)).map((item) => item.productId);
      assert(JSON.stringify(actual) === JSON.stringify(expected), `${sortBy} order is not deterministic`);
      assert(pageCount === 3 && new Set(actual).size === 12, `${sortBy} did not complete three unique pages`);
    }

    const walk = async (base, expectedCount) => {
      const seen = [];
      let cursor = '';
      let firstCursor = '';
      do {
        const result = await list({ ...base, cursor });
        assert(result.success, 'cursor page failed');
        seen.push(...fixtureIds(result));
        if (!firstCursor) firstCursor = result.data.nextCursor || '';
        cursor = result.data.hasMore ? result.data.nextCursor : '';
      } while (cursor);
      assert(seen.length === expectedCount && new Set(seen).size === expectedCount, 'cursor traversal has duplicates or gaps');
      return firstCursor;
    };
    const aCursor = await walk({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'all', pageSize: 5 }, 12);
    await walk({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'books', pageSize: 5 }, 8);
    const userB = await uiSwitch(privateData.schoolB);
    assert(userB.schoolVersion > userA.schoolVersion, 'school version did not increase A to B');
    await expectInvalidCursor({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'all', pageSize: 5, cursor: aCursor }, 'stale A cursor after UI change');

    const finalB = await list({ keyword: FIXTURE_PREFIX, sortBy: 'default', categoryId: 'all', pageSize: 20 });
    assert(finalB.success && finalB.data.scope.schoolId === privateData.schoolB.id, 'final B strict scope failed');
    assert((finalB.data.list || []).every((item) => item.schoolId === privateData.schoolB.id), 'final B list leaked school A or no-school fixture');
    await miniProgram.switchTab('/pages/home/index');
    await waitForPath(miniProgram, 'pages/home/index');
    let home = await waitForPageData(miniProgram, (data) => (
      data.isLoading === false
      && ['success', 'empty'].includes(data.viewState)
      && data.marketMode === 'schoolScoped'
      && data.marketScope && data.marketScope.schoolId === privateData.schoolB.id
    ));
    assert(home.page == null && home.total == null, 'home did not retain strict pagination semantics');
    assert((home.products || []).every((item) => item.schoolId === privateData.schoolB.id), 'home contains mixed-school products');
    await miniProgram.evaluate(async function refreshHome() {
      const pages = getCurrentPages(); const page = pages[pages.length - 1];
      await page.onPullDownRefresh(); return true;
    });
    home = await waitForPageData(miniProgram, (data) => data.isRefreshing === false && data.marketMode === 'schoolScoped');
    assert(home.marketScope.schoolId === privateData.schoolB.id, 'refresh changed strict scope');
    const detailSource = (finalB.data.list || [])[0];
    assert(detailSource && detailSource._id, 'no B product is available for detail smoke');
    const detail = await rawCall('productQuery', { action: 'detail', data: { productId: detailSource._id } });
    assert(detail.success === true, 'product detail smoke failed');
    const mine = await rawCall('productQuery', { action: 'myProducts', data: { status: ['available', 'reserved', 'offline'], page: 1, pageSize: 20 } });
    assert(mine.success === true, 'myProducts smoke failed');
    await miniProgram.reLaunch('/pages/home/index');
    await waitForPath(miniProgram, 'pages/home/index');
    const restartedHome = await waitForPageData(miniProgram, (data) => data.isLoading === false && data.marketMode === 'schoolScoped');
    assert(restartedHome.marketScope.schoolId === privateData.schoolB.id, 'restart did not restore strict school B scope');
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');
    const sortedTimings = timings.map((item) => item.durationMs).sort((a, b) => a - b);
    const result = {
      completedAt: new Date().toISOString(),
      strictVerification: {
        passed: true,
        startedAtSchool: 'B', endedAtSchool: 'B', uiSchoolChanges: 2,
        schoolBPublicFixtureCount: 5, schoolAPublicFixtureCount: 12,
        sortsVerified: ['default', 'newest', 'priceAsc', 'priceDesc'],
        cursorPagesVerified: true, noDuplicateOrGap: true, cursorKeywordPlaintextAbsent: true,
        cursorTamperRejected: true, cursorScopeMismatchRejected: true, crossSchoolCursorRejected: true,
        offlineExcluded: true, noSchoolExcluded: true, crossSchoolIsolation: true,
        homeStrictRendered: true, pullDownRefreshPassed: true, detailPassed: true,
        myProductsPassed: true, restartRecoveredStrictScope: true,
        timingMs: { count: timings.length, min: sortedTimings[0], max: sortedTimings.at(-1), median: sortedTimings[Math.floor(sortedTimings.length / 2)] },
        timingSamples: timings,
        consoleErrors, exceptions
      }
    };
    writePrivateJson(PRIVATE_CANARY_PATH, {
      ...privateData,
      finalUserSchoolId: userB.schoolId,
      finalUserSchoolName: userB.schoolName,
      finalSchoolVersion: userB.schoolVersion,
      ...result
    });
    process.stdout.write(`${JSON.stringify({
      passed: true, userId: maskId(privateData.userId), finalSchoolId: maskId(privateData.schoolB.id),
      schoolAPublicFixtureCount: 12, schoolBPublicFixtureCount: 5,
      sortsVerified: result.strictVerification.sortsVerified,
      cursorChecksPassed: true, isolationPassed: true,
      timingMs: result.strictVerification.timingMs, consoleErrors, exceptions
    }, null, 2)}\n`);
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

run().catch((error) => {
  process.stderr.write(`PHASE18_CANARY_DEVTOOLS_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
