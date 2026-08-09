const fs = require('fs');
const {
  ROOT,
  assert
} = require('./phase-18-canary-core');

const AUTOMATOR_MODULE = process.env.PHASE22_AUTOMATOR_MODULE;
const DEVTOOLS_CLI_PATH = process.env.PHASE22_DEVTOOLS_CLI_PATH;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE22_AUTOMATOR_WS_ENDPOINT;
const OWNER_HISTORY_STATUSES = ['sold', 'offline'];

function trace(message) {
  if (process.env.PHASE22_DEVTOOLS_TRACE === '1') {
    process.stderr.write(`[phase22-devtools] ${message}\n`);
  }
}

function withTimeout(promise, label, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function waitForPageData(miniProgram, predicate, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await miniProgram.evaluate(function currentPageData() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return page ? page.data : null;
    });
    if (data && predicate(data)) return data;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('page data did not settle');
}

async function cloudCall(miniProgram, name, action, data) {
  const response = await withTimeout(miniProgram.evaluate(async function call(input) {
    return wx.cloud.callFunction({
      name: input.name,
      data: { action: input.action, data: input.data }
    });
  }, { name, action, data }), `${name}/${action}`, 45000);
  const payload = response && response.result;
  assert(payload && payload.success === true, `${name}/${action} failed`);
  return payload.data || {};
}

async function findSafeOwnerUnassignedSample(miniProgram) {
  for (const status of OWNER_HISTORY_STATUSES) {
    for (let page = 1; page <= 10; page += 1) {
      const result = await cloudCall(miniProgram, 'productQuery', 'myProducts', {
        status,
        page,
        pageSize: 20
      });
      const sample = (result.list || []).find((product) => (
        !String(product.schoolId || '').trim()
        && !String(product.schoolName || '').trim()
      ));
      if (sample) {
        return {
          status,
          product: Object.assign({}, sample, {
            id: String(sample.id || sample._id || '')
          })
        };
      }
      if (!result.hasMore) break;
    }
  }
  return null;
}

async function invokeCurrentPage(miniProgram, method, argument) {
  return withTimeout(miniProgram.evaluate(function invoke(input) {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    if (!page || typeof page[input.method] !== 'function') {
      throw new Error(`current page method unavailable: ${input.method}`);
    }
    return page[input.method](input.argument);
  }, { method, argument }), `page/${method}`);
}

async function verifyOwnerHistoryPages(miniProgram, sample) {
  if (!sample) {
    return {
      safeSampleAvailable: false,
      myProductsLegacyLabel: 'not-applicable',
      ownerDetailLegacyLabel: 'not-applicable'
    };
  }

  await withTimeout(miniProgram.reLaunch('/pages/my-products/index'), 'my products launch');
  trace('My Products launched');
  await waitForPageData(miniProgram, (data) => ['success', 'empty'].includes(data.viewState));
  await invokeCurrentPage(miniProgram, 'onStatusChange', {
    currentTarget: { dataset: { status: sample.status } }
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  let myProducts = await waitForPageData(miniProgram, (data) => (
    data.selectedStatus === sample.status
    && ['success', 'empty'].includes(data.viewState)
    && !data.isLoading
  ));
  let visibleSample = (myProducts.products || []).find((product) => (
    product.id === sample.product.id
  ));
  while (!visibleSample && myProducts.hasMore) {
    const previousLength = (myProducts.products || []).length;
    await invokeCurrentPage(miniProgram, 'onReachBottom');
    myProducts = await waitForPageData(miniProgram, (data) => (
      data.selectedStatus === sample.status
      && !data.isLoadingMore
      && (
        (data.products || []).length > previousLength
        || !data.hasMore
        || Boolean(data.loadMoreError)
      )
    ));
    assert(!myProducts.loadMoreError, 'My Products pagination failed during read-only validation');
    visibleSample = (myProducts.products || []).find((product) => (
      product.id === sample.product.id
    ));
  }
  assert(
    visibleSample,
    `safe unassigned owner sample is not visible in My Products (sampleIdLength=${sample.product.id.length}, visible=${(myProducts.products || []).length}, total=${myProducts.total}, hasMore=${myProducts.hasMore})`
  );
  assert(!visibleSample.schoolId && !visibleSample.schoolName, 'My Products inferred a school');
  trace('My Products legacy state passed');

  await withTimeout(
    miniProgram.reLaunch(`/pages/product-detail/index?id=${encodeURIComponent(sample.product.id)}`),
    'owner detail launch'
  );
  const detail = await waitForPageData(miniProgram, (data) => data.viewState === 'success');
  assert(detail.isOwnProduct === true, 'unassigned detail is not recognized as owner history');
  assert(!detail.product.schoolId && !detail.product.schoolName, 'owner detail inferred a school');
  trace('owner detail legacy state passed');
  return {
    safeSampleAvailable: true,
    sampleStatus: sample.status,
    myProductsLegacyLabel: 'passed',
    ownerDetailLegacyLabel: 'passed'
  };
}

function assertStrictPage(data, schoolId, label) {
  assert(data.marketMode === 'schoolScoped', `${label} is not school scoped`);
  assert(data.marketScope && data.marketScope.schoolId === schoolId, `${label} scope differs from current school`);
  assert(
    (data.products || []).every((product) => product.schoolId === schoolId),
    `${label} contains an out-of-school or unassigned product`
  );
}

async function verifyHomeSearchAndCategory(miniProgram, schoolId) {
  await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'home launch');
  const home = await waitForPageData(miniProgram, (data) => (
    data.isLoading === false
    && ['success', 'empty'].includes(data.viewState)
    && data.marketMode === 'schoolScoped'
  ));
  assertStrictPage(home, schoolId, 'home');
  trace('home strict scope passed');

  await invokeCurrentPage(miniProgram, 'onKeywordInput', {
    detail: { value: 'phase22-read-only-no-match' }
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const searched = await waitForPageData(miniProgram, (data) => (
    data.keyword === 'phase22-read-only-no-match'
    && data.isLoading === false
    && ['success', 'empty'].includes(data.viewState)
  ));
  assertStrictPage(searched, schoolId, 'search');
  trace('search strict scope passed');

  await invokeCurrentPage(miniProgram, 'onKeywordInput', { detail: { value: '' } });
  await invokeCurrentPage(miniProgram, 'onCategoryChange', { detail: { id: 'books' } });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const categorized = await waitForPageData(miniProgram, (data) => (
    data.selectedCategoryId === 'books'
    && data.keyword === ''
    && data.isLoading === false
    && ['success', 'empty'].includes(data.viewState)
  ));
  assertStrictPage(categorized, schoolId, 'category');
  trace('category strict scope passed');
  return {
    homeStrict: true,
    searchStrict: true,
    categoryStrict: true
  };
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(DEVTOOLS_CLI_PATH && fs.existsSync(DEVTOOLS_CLI_PATH), 'developer-tools CLI is unavailable');
  const automator = require(AUTOMATOR_MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = AUTOMATOR_WS_ENDPOINT
      ? await withTimeout(automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }), 'automation connection')
      : await withTimeout(automator.launch({
        cliPath: DEVTOOLS_CLI_PATH,
        projectPath: ROOT,
        trustProject: true,
        timeout: 90000
      }), 'automation launch');
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });

    const current = await cloudCall(miniProgram, 'authUser', 'current', {});
    assert(current.user && current.user.schoolId, 'current school context is unavailable');
    trace('current school context passed');
    const sample = await findSafeOwnerUnassignedSample(miniProgram);
    trace(sample ? 'safe owner history sample found' : 'no safe owner history sample');
    const ownerPages = await verifyOwnerHistoryPages(miniProgram, sample);
    const strictPages = await verifyHomeSearchAndCategory(miniProgram, current.user.schoolId);
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');
    return {
      passed: true,
      ownerPages,
      strictPages,
      writesRequested: false,
      fixturesCreated: false,
      consoleErrors,
      exceptions
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE22_DEVTOOLS_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
