const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'pages', 'school-select', 'index.js'), 'utf8');

function school(number) {
  return {
    id: `s_${String(number).padStart(32, '0')}`,
    name: `测试学校${number}`,
    province: '北京市',
    city: '北京市',
    educationLevel: '本科',
    platformStatus: 'active',
    selectable: true
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function loadDefinition(schoolService) {
  let definition;
  const context = {
    require(request) {
      if (request.includes('auth-store')) return { subscribe() { return () => {}; } };
      if (request.includes('auth-guard')) return {
        normalizeTarget(value) { return value || 'home'; },
        normalizeProductId() { return ''; },
        normalizeConversationId() { return ''; },
        normalizeAppointmentId() { return ''; },
        normalizePublicUserId() { return ''; }
      };
      if (request.includes('navigation-service')) return {};
      if (request.includes('school-service')) return schoolService;
      if (request.includes('constants/routes')) return { ROUTES: {}, AUTH_TARGETS: { HOME: 'home' } };
      throw new Error(`unexpected require: ${request}`);
    },
    Page(value) { definition = value; },
    module: { exports: {} },
    exports: {},
    setTimeout,
    clearTimeout,
    console,
    wx: { showToast() {}, showModal() {} }
  };
  vm.runInNewContext(SOURCE, context, { filename: 'pages/school-select/index.js' });
  return definition;
}

function makePage(definition) {
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = (patch) => Object.assign(page.data, patch);
  page.isPageActive = true;
  page.requestVersion = 0;
  page.seenCursors = new Set();
  return page;
}

async function testAppendDedupeAndEnd() {
  const service = {
    async listSchools(options) {
      if (!options.cursor) return { items: [school(1), school(2)], nextCursor: 'c1', hasMore: true };
      return { items: [school(2), school(3)], nextCursor: '', hasMore: false };
    }
  };
  service.searchSchools = service.listSchools;
  const page = makePage(loadDefinition(service));
  assert(await page.loadSchools('', { reset: true }));
  assert.strictEqual(page.data.schools.length, 2);
  assert.strictEqual(page.data.hasMore, true);
  assert(await page.loadSchools('', { reset: false }));
  assert.strictEqual(JSON.stringify(page.data.schools.map((item) => item.id)), JSON.stringify([school(1).id, school(2).id, school(3).id]));
  assert.strictEqual(page.data.hasMore, false);
  assert.strictEqual(page.data.nextCursor, '');
}

async function testStaleResetResponse() {
  const oldRequest = deferred();
  const newRequest = deferred();
  const service = {
    searchSchools({ keyword }) {
      return keyword === '旧' ? oldRequest.promise : newRequest.promise;
    },
    listSchools() { throw new Error('unexpected list'); }
  };
  const page = makePage(loadDefinition(service));
  const oldPromise = page.loadSchools('旧', { reset: true });
  const newPromise = page.loadSchools('新', { reset: true });
  newRequest.resolve({ items: [school(9)], nextCursor: '', hasMore: false });
  assert(await newPromise);
  oldRequest.resolve({ items: [school(8)], nextCursor: '', hasMore: false });
  assert.strictEqual(await oldPromise, false);
  assert.strictEqual(JSON.stringify(page.data.schools.map((item) => item.id)), JSON.stringify([school(9).id]));
}

async function testWindowCapAndCursorLock() {
  let pageNumber = 0;
  const service = {
    async listSchools() {
      const start = pageNumber * 20 + 1;
      pageNumber += 1;
      return {
        items: Array.from({ length: 20 }, (_, index) => school(start + index)),
        nextCursor: pageNumber < 6 ? `cursor-${pageNumber}` : '',
        hasMore: pageNumber < 6
      };
    }
  };
  service.searchSchools = service.listSchools;
  const page = makePage(loadDefinition(service));
  assert(await page.loadSchools('', { reset: true }));
  for (let index = 0; index < 5; index += 1) assert(await page.loadSchools('', { reset: false }));
  assert.strictEqual(page.data.schools.length, 100);
  assert.strictEqual(page.data.discardedCount, 20);
  assert.strictEqual(page.data.schools[0].id, school(21).id);
}

async function testLoadingLockAndRepeatedCursor() {
  const pending = deferred();
  let calls = 0;
  const service = {
    listSchools(options) {
      calls += 1;
      if (!options.cursor) return Promise.resolve({ items: [school(1)], nextCursor: 'same', hasMore: true });
      return pending.promise;
    }
  };
  service.searchSchools = service.listSchools;
  const page = makePage(loadDefinition(service));
  await page.loadSchools('', { reset: true });
  const first = page.loadSchools('', { reset: false });
  assert.strictEqual(await page.loadSchools('', { reset: false }), false);
  assert.strictEqual(calls, 2);
  pending.resolve({ items: [school(2)], nextCursor: 'same', hasMore: true });
  assert.strictEqual(await first, false);
  assert(/游标异常/.test(page.data.loadMoreError));
  assert.strictEqual(JSON.stringify(page.data.schools.map((item) => item.id)), JSON.stringify([school(1).id]));
}

async function testProvinceUsesServerQuery() {
  let received;
  const service = {
    async listSchools(options) {
      received = options;
      return { items: [], nextCursor: '', hasMore: false };
    }
  };
  service.searchSchools = service.listSchools;
  const page = makePage(loadDefinition(service));
  page.onProvinceChange({ detail: { value: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(page.data.province, '北京市');
  assert.strictEqual(received.province, '北京市');
  assert.strictEqual(received.cursor, '');
  assert.strictEqual(received.pageSize, 20);
}

async function run() {
  await testAppendDedupeAndEnd();
  await testStaleResetResponse();
  await testWindowCapAndCursorLock();
  await testLoadingLockAndRepeatedCursor();
  await testProvinceUsesServerQuery();
  process.stdout.write('School selector pagination verification passed: 5 groups.\n');
}

run().catch((error) => {
  process.stderr.write(`${error.code || 'SCHOOL_SELECTOR_PAGINATION_VERIFY_FAILED'}: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
