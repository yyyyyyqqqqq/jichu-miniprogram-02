const fs = require('fs');
const {
  ROOT,
  assert
} = require('./phase-18-canary-core');
const orphanReview = require('./phase-18-orphan-reserved-review');
const phase22Audit = require('./phase-22-finalization-audit');

const AUTOMATOR_MODULE = process.env.PHASE23_AUTOMATOR_MODULE;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT;

function withTimeout(promise, label, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function snapshot(miniProgram) {
  return miniProgram.evaluate(function currentPageSnapshot() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    return page ? { route: page.route, data: page.data } : null;
  });
}

async function waitFor(miniProgram, predicate, label, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await snapshot(miniProgram);
    if (current && predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not settle`);
}

async function invoke(miniProgram, method, argument) {
  return withTimeout(miniProgram.evaluate(function invokeCurrentPage(input) {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    if (!page || typeof page[input.method] !== 'function') {
      throw new Error(`current page method unavailable: ${input.method}`);
    }
    return page[input.method](input.argument);
  }, { method, argument }), `page/${method}`);
}

function uniqueSchoolCount(data) {
  return new Set((data.schools || []).map((school) => school.id)).size;
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(AUTOMATOR_WS_ENDPOINT, 'DevTools automation endpoint is unavailable');
  const environmentId = require('./schools/cloud-cli').loadEnvironmentId();
  const before = orphanReview.readSnapshot(environmentId);
  const automator = require(AUTOMATOR_MODULE);
  const miniProgram = await withTimeout(
    automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }),
    'automation connection'
  );
  let consoleErrors = 0;
  let exceptions = 0;
  const timings = {};
  const startedAt = Date.now();
  miniProgram.on('console', (entry) => {
    if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
  });
  miniProgram.on('exception', () => { exceptions += 1; });
  try {
    let stage = Date.now();
    await withTimeout(
      miniProgram.reLaunch('/pages/school-select/index?mode=change'),
      'school selector launch'
    );
    let page = await waitFor(
      miniProgram,
      (value) => value.route === 'pages/school-select/index'
        && ['success', 'empty', 'error'].includes(value.data.viewState)
        && !value.data.isLoadingMore,
      'school selector first page'
    );
    assert(page.data.viewState === 'success', `school selector first page is ${page.data.viewState}`);
    assert(page.data.schools.length === 20, 'school selector first page is not 20');
    assert(page.data.hasMore === true && page.data.nextCursor, 'school selector first page has no continuation');
    assert(uniqueSchoolCount(page.data) === 20, 'school selector first page has duplicates');
    assert(page.data.schools.every((school) => school.selectable === true && school.platformStatus === 'active'), 'school selector exposed a non-active school');
    const firstPageIds = new Set(page.data.schools.map((school) => school.id));
    timings.firstPageMs = Date.now() - stage;

    stage = Date.now();
    await invoke(miniProgram, 'onLoadMore');
    page = await waitFor(
      miniProgram,
      (value) => value.route === 'pages/school-select/index'
        && !value.data.isLoadingMore
        && value.data.schools.length === 40,
      'school selector second page'
    );
    assert(uniqueSchoolCount(page.data) === 40, 'school selector second page has duplicates');
    assert(page.data.schools.slice(20).some((school) => !firstPageIds.has(school.id)), 'non-first-20 schools were not loaded');
    timings.secondPageMs = Date.now() - stage;

    stage = Date.now();
    while (page.data.schools.length < 100) {
      const previousLength = page.data.schools.length;
      await invoke(miniProgram, 'onLoadMore');
      page = await waitFor(
        miniProgram,
        (value) => value.route === 'pages/school-select/index'
          && !value.data.isLoadingMore
          && value.data.schools.length > previousLength,
        `school selector window ${previousLength + 20}`
      );
    }
    assert(page.data.schools.length === 100 && uniqueSchoolCount(page.data) === 100, '100-school retained window is invalid');
    await invoke(miniProgram, 'onLoadMore');
    page = await waitFor(
      miniProgram,
      (value) => value.route === 'pages/school-select/index'
        && !value.data.isLoadingMore
        && value.data.schools.length === 100
        && value.data.discardedCount >= 20,
      'school selector bounded window'
    );
    assert(page.data.schools.every((school) => !firstPageIds.has(school.id)), 'bounded window retained stale first-page schools');
    timings.window100Ms = Date.now() - stage;

    stage = Date.now();
    await invoke(miniProgram, 'onSearchConfirm', { detail: { value: '清华大学' } });
    page = await waitFor(
      miniProgram,
      (value) => value.route === 'pages/school-select/index'
        && value.data.keyword === '清华大学'
        && value.data.viewState === 'success'
        && !value.data.isLoadingMore,
      'school selector exact-name prefix search'
    );
    assert(page.data.schools.length === 1 && page.data.schools[0].name === '清华大学', 'school selector search result is invalid');
    timings.searchMs = Date.now() - stage;

    stage = Date.now();
    await invoke(miniProgram, 'onClearSearch');
    await waitFor(
      miniProgram,
      (value) => value.route === 'pages/school-select/index'
        && value.data.keyword === ''
        && value.data.viewState === 'success'
        && !value.data.isLoadingMore,
      'school selector search reset'
    );
    await invoke(miniProgram, 'onProvinceChange', { detail: { value: '1' } });
    page = await waitFor(
      miniProgram,
      (value) => value.route === 'pages/school-select/index'
        && value.data.province === '北京市'
        && value.data.viewState === 'success'
        && !value.data.isLoadingMore,
      'school selector province filter'
    );
    assert(page.data.schools.length === 20 && page.data.schools.every((school) => school.province === '北京市'), 'school selector province result is invalid');
    timings.provinceMs = Date.now() - stage;

    stage = Date.now();
    await invoke(miniProgram, 'onSearchConfirm', { detail: { value: '北京' } });
    await invoke(miniProgram, 'onSearchConfirm', { detail: { value: '上海' } });
    page = await waitFor(
      miniProgram,
      (value) => value.route === 'pages/school-select/index'
        && value.data.keyword === '上海'
        && !value.data.isLoadingMore
        && ['success', 'empty'].includes(value.data.viewState),
      'school selector stale response guard'
    );
    assert(page.data.schools.length === 0, 'stale or cross-province search result overwrote the final scope');
    timings.staleSwitchMs = Date.now() - stage;
  } finally {
    miniProgram.disconnect();
  }
  const after = orphanReview.readSnapshot(environmentId);
  const noWriteProof = phase22Audit.buildNoWriteProof(before, after);
  assert(noWriteProof.countsUnchanged && noWriteProof.projectedSnapshotsUnchanged, 'DevTools audit changed production data');
  assert(consoleErrors === 0 && exceptions === 0, 'DevTools recorded console errors or exceptions');
  return {
    schemaVersion: 1,
    mode: 'FINAL_RELEASE_STEP_3B_PRODUCTION_DEVTOOLS_READ_ONLY',
    completedAt: new Date().toISOString(),
    route: 'pages/school-select/index',
    target: 'production',
    checks: {
      firstPage20: true,
      loadMore: true,
      nonFirst20: true,
      search: true,
      province: true,
      staleResponseGuard: true,
      retainedWindow100: true,
      obviousStallObserved: false
    },
    timings,
    totalElapsedMs: Date.now() - startedAt,
    consoleErrors,
    exceptions,
    noWriteProof,
    schoolSelection: 'MANUAL SCHOOL SELECTION NOT EXECUTED DUE TO TEST ACCOUNT LIMITATION',
    passed: true
  };
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`STEP3B_PRODUCTION_DEVTOOLS_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run };
