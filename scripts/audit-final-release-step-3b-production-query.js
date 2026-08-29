const {
  EXPECTED_TOTAL,
  QUERY_AUDIT_PATH,
  validateSource,
  compareProductionSchools,
  assertProductionIntegrity,
  readAllSchools,
  invokeSchoolQuery,
  safeWriteJson,
  publicSummary,
  assert
} = require('./final-release-step-3b-core');
const { runPreflight, maskIdentifier } = require('./environment-preflight');
const schoolCore = require('./schools/core');

const PAGE_SIZE = 20;
const SEARCH_TERMS = Object.freeze([
  '北京', '上海', '浙江', '清华大学', '4111010003', '绝不存在的学校关键词xyz', '财经', '工程'
]);
const PROVINCES = Object.freeze(['北京市', '上海市', '浙江省', '广东省', '四川省']);

function parseArguments(argv) {
  const options = { environmentName: '', mode: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--mode') options.mode = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0;
}

function expectedIds(records, options = {}) {
  const keyword = schoolCore.normalizeNameForSearch(options.keyword || '');
  return records.filter((record) => {
    if (options.province && record.province !== options.province) return false;
    if (!keyword) return true;
    if (/^\d{10}$/.test(keyword)) return record.officialCode === keyword;
    return record.nameNormalized.startsWith(keyword);
  }).map((record) => record._id);
}

function assertSameSet(actual, expected, label) {
  assert(actual.length === expected.length, `${label} count ${actual.length} != ${expected.length}`, 'PRODUCTION_QUERY_COUNT_MISMATCH');
  const expectedSet = new Set(expected);
  assert(actual.every((id) => expectedSet.has(id)), `${label} returned an unexpected school`, 'PRODUCTION_QUERY_SET_MISMATCH');
}

function createInvoker(environmentId, samples) {
  return (event) => {
    const response = invokeSchoolQuery(environmentId, event);
    samples.push({
      action: event.action,
      elapsedMs: response.elapsedMs,
      remoteDurationMs: response.remoteDurationMs,
      memoryBytes: response.memoryBytes,
      payloadBytes: response.payloadBytes
    });
    return response.result;
  };
}

function traverse(invoke, expectedCount, options = {}) {
  const ids = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = '';
  let pages = 0;
  let firstPageCount = 0;
  let lastHasMore = true;
  const maximumPages = Math.ceil(expectedCount / PAGE_SIZE) + 3;
  while (pages < maximumPages) {
    const response = invoke({
      action: options.keyword ? 'search' : 'list',
      pageSize: PAGE_SIZE,
      province: options.province || '',
      cursor,
      ...(options.keyword ? { keyword: options.keyword } : {})
    });
    assert(response.success === true && response.code === 'OK', `query failed for ${JSON.stringify(options)}`, 'PRODUCTION_QUERY_FAILED');
    assert(response.data && Array.isArray(response.data.items) && response.data.items.length <= PAGE_SIZE, 'invalid query page', 'PRODUCTION_QUERY_PAGE_INVALID');
    if (pages === 0) firstPageCount = response.data.items.length;
    for (const item of response.data.items) {
      assert(item.selectable === true && item.platformStatus === 'active', 'non-active school leaked', 'PRODUCTION_QUERY_STATUS_EXPOSURE');
      assert(!seenIds.has(item.id), 'duplicate school returned', 'PRODUCTION_QUERY_DUPLICATE');
      seenIds.add(item.id);
      ids.push(item.id);
    }
    pages += 1;
    lastHasMore = response.data.hasMore;
    if (!response.data.hasMore) {
      assert(!response.data.nextCursor, 'final page exposed a cursor', 'PRODUCTION_QUERY_END_CURSOR_INVALID');
      break;
    }
    assert(response.data.nextCursor && !seenCursors.has(response.data.nextCursor), 'cursor repeated', 'PRODUCTION_QUERY_CURSOR_REPEAT');
    seenCursors.add(response.data.nextCursor);
    cursor = response.data.nextCursor;
    if (pages % 25 === 0) process.stderr.write(`[STEP3B][PRODUCTION] ${JSON.stringify(options)} page ${pages}\n`);
  }
  assert(lastHasMore === false, 'query traversal did not terminate', 'PRODUCTION_QUERY_NON_TERMINATING');
  return { ids, pages, firstPageCount, cursorCount: seenCursors.size };
}

function run(options) {
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  assert(['pre-activation', 'nationwide'].includes(options.mode), '--mode pre-activation|nationwide is required', 'QUERY_MODE_REQUIRED');
  const preflight = runPreflight({ environmentName: 'production', action: 'audit' });
  const { records: normalized } = validateSource();
  const production = readAllSchools(preflight.environmentId);
  const integrity = compareProductionSchools(normalized, production);
  assertProductionIntegrity(integrity);
  const active = production.filter((record) => record.platformStatus === 'active' && record.officialStatus === 'valid');
  const pending = production.filter((record) => record.platformStatus === 'pending');
  if (options.mode === 'pre-activation') {
    assert(active.length === 2 && pending.length === 2950, 'pre-activation counts drifted', 'PRE_ACTIVATION_COUNT_DRIFT');
  } else {
    assert(active.length === EXPECTED_TOTAL && pending.length === 0, 'nationwide counts drifted', 'NATIONWIDE_COUNT_DRIFT');
  }
  const samples = [];
  const invoke = createInvoker(preflight.environmentId, samples);
  const browse = traverse(invoke, active.length);
  assertSameSet(browse.ids, expectedIds(active), 'production browse');
  if (options.mode === 'nationwide') assert(browse.firstPageCount === 20, 'nationwide first page is not 20', 'NATIONWIDE_FIRST_PAGE_INVALID');

  const searches = {};
  const searchTerms = options.mode === 'pre-activation'
    ? ['上海', active[0].officialCode]
    : SEARCH_TERMS;
  for (const keyword of searchTerms) {
    const expected = expectedIds(active, { keyword });
    const result = traverse(invoke, expected.length, { keyword });
    assertSameSet(result.ids, expected, `search ${keyword}`);
    searches[keyword] = { count: result.ids.length, pages: result.pages };
  }

  const provinces = {};
  if (options.mode === 'nationwide') {
    for (const province of PROVINCES) {
      const expected = expectedIds(active, { province });
      const result = traverse(invoke, expected.length, { province });
      assertSameSet(result.ids, expected, `province ${province}`);
      provinces[province] = { count: result.ids.length, pages: result.pages };
    }
  }

  const first = invoke({ action: 'list', pageSize: 1 });
  assert(first.success && first.data.hasMore && first.data.nextCursor, 'cursor fixture unavailable', 'PRODUCTION_CURSOR_TEST_FAILED');
  const repeatedLeft = invoke({ action: 'list', pageSize: 1, cursor: first.data.nextCursor });
  const repeatedRight = invoke({ action: 'list', pageSize: 1, cursor: first.data.nextCursor });
  assert(JSON.stringify(repeatedLeft.data.items) === JSON.stringify(repeatedRight.data.items), 'legal cursor is non-deterministic', 'PRODUCTION_CURSOR_NON_DETERMINISTIC');
  const cursor = first.data.nextCursor;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
  assert(invoke({ action: 'list', cursor: tampered }).code === 'INVALID_ARGUMENT', 'tampered cursor accepted', 'PRODUCTION_CURSOR_TAMPER_ACCEPTED');
  assert(invoke({ action: 'list', province: '广东省', cursor }).code === 'INVALID_ARGUMENT', 'cross-province cursor accepted', 'PRODUCTION_CURSOR_SCOPE_ACCEPTED');
  assert(invoke({ action: 'list', province: '不存在省' }).code === 'INVALID_PROVINCE', 'invalid province accepted', 'PRODUCTION_INVALID_INPUT_ACCEPTED');
  assert(invoke({ action: 'list', pageSize: 21 }).code === 'INVALID_PAGE_SIZE', 'invalid pageSize accepted', 'PRODUCTION_INVALID_INPUT_ACCEPTED');
  assert(invoke({ action: 'search', keyword: 'x'.repeat(41) }).code === 'INVALID_KEYWORD', 'oversized keyword accepted', 'PRODUCTION_INVALID_INPUT_ACCEPTED');

  let pendingIsolation = null;
  if (options.mode === 'pre-activation') {
    const pendingDetail = invoke({ action: 'detail', schoolId: pending[0]._id });
    const pendingSearch = invoke({ action: 'search', keyword: pending[0].officialCode });
    assert(pendingDetail.code === 'SCHOOL_NOT_ACTIVE', 'pending detail leaked', 'PENDING_SCHOOL_EXPOSED');
    assert(pendingSearch.success && pendingSearch.data.items.length === 0, 'pending search leaked', 'PENDING_SCHOOL_EXPOSED');
    pendingIsolation = { detailRejected: true, searchCount: 0 };
  }

  const durations = samples.map((sample) => sample.remoteDurationMs);
  const payloads = samples.map((sample) => sample.payloadBytes);
  const memory = samples.map((sample) => sample.memoryBytes);
  const report = {
    schemaVersion: 1,
    mode: options.mode,
    completedAt: new Date().toISOString(),
    environment: publicSummary(preflight),
    schoolCounts: { total: production.length, active: active.length, pending: pending.length },
    nationwide: { count: browse.ids.length, pages: browse.pages, firstPageCount: browse.firstPageCount, duplicate: 0, cursorDuplicate: 0, lastPageHasMore: false },
    searches,
    provinces,
    pendingIsolation,
    cursor: { signedTamperRejected: true, scopeMismatchRejected: true, repeatedCursorDeterministic: true },
    invalidInputsRejected: true,
    searchSemantics: 'nameNormalized prefix, or exact 10-digit officialCode',
    calls: samples.length,
    errors: 0,
    performance: {
      remoteDurationMs: {
        min: Math.min(...durations),
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        max: Math.max(...durations)
      },
      payloadBytes: { p95: percentile(payloads, 0.95), max: Math.max(...payloads) },
      functionMemoryBytesMax: Math.max(...memory)
    },
    passed: true
  };
  safeWriteJson(QUERY_AUDIT_PATH.replace('.json', `-${options.mode}.json`), report);
  if (options.mode === 'nationwide') safeWriteJson(QUERY_AUDIT_PATH, report);
  return report;
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    let message = String(error && error.message || error);
    try {
      const targets = require('../config/cloud.targets.private');
      for (const id of Object.values(targets).filter(Boolean)) message = message.split(id).join(maskIdentifier(id));
    } catch (ignored) {
      // Environment configuration failures are already fail-closed.
    }
    process.stderr.write(`${error.code || 'STEP3B_PRODUCTION_QUERY_AUDIT_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { PAGE_SIZE, SEARCH_TERMS, PROVINCES, parseArguments, percentile, expectedIds, traverse, run };
