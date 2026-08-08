const fs = require('fs');
const path = require('path');
const {
  PRIVATE_DUAL_ACCOUNT_PATH,
  loadDualAccountPrivate,
  maskId,
  assert,
  writePrivateJson
} = require('./phase-18-dual-account-core');

const MODULE = process.env.PHASE18_DUAL_AUTOMATOR_MODULE;
const ENDPOINT = process.env.PHASE18_DUAL_AUTOMATOR_WS_ENDPOINT;

function withTimeout(promise, label, timeoutMs = 60000) {
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

async function run() {
  assert(MODULE && fs.existsSync(MODULE) && ENDPOINT, 'developer-tools automation settings are required');
  const privateData = loadDualAccountPrivate();
  const account = privateData.accountA;
  const schoolA = privateData.accountA;
  const schoolB = privateData.accountB;
  const MiniProgram = require(path.join(MODULE, 'out', 'MiniProgram')).default;
  const originalCheckVersion = MiniProgram.prototype.checkVersion;
  MiniProgram.prototype.checkVersion = async function skipBrokenVersionProbe() {};
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
    const call = async (name, data) => {
      const started = Date.now();
      const response = await withTimeout(miniProgram.evaluate(
        async function callCloud(functionName, functionData) {
          return wx.cloud.callFunction({ name: functionName, data: functionData });
        }, name, data
      ), `${name} cloud call`);
      timings.push(Date.now() - started);
      return payload(response);
    };
    const list = (data) => call('productQuery', { action: 'list', data });
    const current = await call('authUser', { action: 'current', data: {} });
    assert(current.success === true && current.data.user.id === account.userId, 'legacy drill is not using account A');
    assert(current.data.user.schoolId === schoolA.schoolId, 'account A did not start at school A');
    const startVersion = Number(current.data.user.schoolVersion || 0);

    let firstProductId = '';
    for (const sortBy of ['default', 'newest', 'priceAsc', 'priceDesc']) {
      const first = await list({ categoryId: 'all', keyword: '', sortBy, page: 1, pageSize: 6 });
      assert(first.success === true && first.data.marketMode === 'legacy', `${sortBy} did not enter legacy`);
      assert(first.data.page === 1 && Number.isFinite(first.data.total), `${sortBy} legacy pagination is missing`);
      assert(first.data.scope.schoolId === '' && first.data.scope.schoolName === '', `${sortBy} retained strict scope`);
      assert((first.data.list || []).length > 0, `${sortBy} first page is empty`);
      assert(first.data.hasMore === true, `${sortBy} does not have a second legacy page`);
      const second = await list({ categoryId: 'all', keyword: '', sortBy, page: 2, pageSize: 6 });
      assert(second.success === true && second.data.marketMode === 'legacy' && second.data.page === 2, `${sortBy} second legacy page failed`);
      assert(new Set([...(first.data.list || []), ...(second.data.list || [])].map((item) => item._id)).size
        === (first.data.list || []).length + (second.data.list || []).length, `${sortBy} legacy pages contain duplicates`);
      if (!firstProductId) firstProductId = first.data.list[0]._id;
    }

    for (const filters of [
      { categoryId: 'books', keyword: '', sortBy: 'default', page: 1, pageSize: 6 },
      { categoryId: 'all', keyword: '测试', sortBy: 'default', page: 1, pageSize: 6 }
    ]) {
      const result = await list(filters);
      assert(result.success === true && result.data.marketMode === 'legacy', 'legacy filtered list failed');
    }
    const detail = await call('productQuery', { action: 'detail', data: { productId: firstProductId } });
    assert(detail.success === true && detail.data.product._id === firstProductId, 'legacy detail failed');
    const mine = await call('productQuery', { action: 'myProducts', data: { page: 1, pageSize: 6 } });
    assert(mine.success === true && Array.isArray(mine.data.list), 'legacy myProducts failed');

    const changed = await call('authUser', { action: 'updateSchool', data: { schoolId: schoolB.schoolId } });
    assert(changed.success === true && changed.data.user.schoolId === schoolB.schoolId, 'legacy drill A->B school change failed');
    const afterChange = await list({ categoryId: 'all', keyword: '', sortBy: 'default', page: 1, pageSize: 6 });
    assert(afterChange.success === true && afterChange.data.marketMode === 'legacy', 'legacy mode changed after school update');
    const restored = await call('authUser', { action: 'updateSchool', data: { schoolId: schoolA.schoolId } });
    assert(restored.success === true && restored.data.user.schoolId === schoolA.schoolId, 'legacy drill did not restore account A school');
    assert(Number(restored.data.user.schoolVersion || 0) >= startVersion + 2, 'schoolVersion did not advance twice');
    assert(consoleErrors === 0 && exceptions === 0, 'legacy drill recorded runtime errors');

    const evidence = loadDualAccountPrivate();
    evidence.finalCutoverValidation = evidence.finalCutoverValidation || {};
    evidence.finalCutoverValidation.legacyRollback = {
      completedAt: new Date().toISOString(),
      result: 'passed',
      marketMode: 'legacy',
      sorts: ['default', 'newest', 'priceAsc', 'priceDesc'],
      twoPagesPerSort: true,
      category: true,
      search: true,
      detail: true,
      myProducts: true,
      schoolChange: 'A->B->A',
      schoolVersionBefore: startVersion,
      schoolVersionAfter: Number(restored.data.user.schoolVersion || 0),
      consoleErrors,
      exceptions,
      timings
    };
    writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, evidence);
    const sorted = [...timings].sort((left, right) => left - right);
    return {
      passed: true,
      account: maskId(account.userId),
      marketMode: 'legacy',
      sorts: ['default', 'newest', 'priceAsc', 'priceDesc'],
      twoPagesPerSort: true,
      category: true,
      search: true,
      detail: true,
      myProducts: true,
      schoolChange: 'A->B->A',
      schoolVersionBefore: startVersion,
      schoolVersionAfter: Number(restored.data.user.schoolVersion || 0),
      timingMs: { count: sorted.length, min: sorted[0], max: sorted[sorted.length - 1] },
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
  process.stderr.write(`PHASE18_LEGACY_ROLLBACK_DEVTOOLS_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 0);
});
