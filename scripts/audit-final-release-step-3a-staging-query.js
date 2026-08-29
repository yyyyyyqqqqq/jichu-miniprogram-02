const { performance } = require('perf_hooks');
const {
  runPreflight,
  publicSummary,
  assert,
  maskIdentifier
} = require('./environment-preflight');
const schoolCore = require('./schools/core');
const { runCloudBase } = require('./schools/cloud-cli');

const PAGE_SIZE = 20;
const SEARCH_TERMS = Object.freeze([
  '北京', '上海', '浙江', '财经', '工程', '清华大学', '4111010003', '绝不存在的学校关键词xyz'
]);
const PROVINCES = Object.freeze(['北京市', '上海市', '浙江省', '广东省', '四川省']);

function parseArguments(argv) {
  const options = { environmentName: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0;
}

function parseInvocation(response) {
  const root = response && (response.data || response.Response || response) || {};
  assert(Number(root.InvokeResult) === 0, 'schoolQuery remote invocation failed', 'STAGING_INVOKE_FAILED');
  const result = JSON.parse(String(root.RetMsg || '{}'));
  return {
    result,
    remoteDurationMs: Number(root.Duration || 0),
    memoryBytes: Number(root.MemUsage || 0),
    payloadBytes: Buffer.byteLength(String(root.RetMsg || ''), 'utf8')
  };
}

function createInvoker(environmentId, samples) {
  return (event) => {
    const started = performance.now();
    const response = runCloudBase([
      '--env-id', environmentId,
      'fn', 'invoke', 'schoolQuery',
      '--params', JSON.stringify(event),
      '--json'
    ], { timeoutMs: 120000 });
    const parsed = parseInvocation(response);
    samples.push({
      action: event.action,
      elapsedMs: Math.round(performance.now() - started),
      remoteDurationMs: parsed.remoteDurationMs,
      memoryBytes: parsed.memoryBytes,
      payloadBytes: parsed.payloadBytes
    });
    return parsed.result;
  };
}

function traverse(invoke, options = {}) {
  const ids = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = '';
  let pages = 0;
  let firstPageCount = 0;
  let finalHasMore = true;
  while (pages < 200) {
    const event = {
      action: options.keyword ? 'search' : 'list',
      pageSize: PAGE_SIZE,
      province: options.province || '',
      cursor,
      ...(options.keyword ? { keyword: options.keyword } : {})
    };
    const response = invoke(event);
    assert(response.success === true && response.code === 'OK', `query failed for ${JSON.stringify(options)}`, 'STAGING_QUERY_FAILED');
    const data = response.data;
    assert(Array.isArray(data.items) && data.items.length <= PAGE_SIZE, 'page size cap failed', 'STAGING_PAGE_INVALID');
    if (pages === 0) firstPageCount = data.items.length;
    for (const item of data.items) {
      assert(item.selectable === true && item.platformStatus === 'active', 'query exposed non-active school', 'STAGING_STATUS_EXPOSURE');
      assert(!seenIds.has(item.id), 'cursor traversal returned a duplicate school', 'STAGING_CURSOR_DUPLICATE');
      seenIds.add(item.id);
      ids.push(item.id);
    }
    pages += 1;
    finalHasMore = data.hasMore;
    if (!data.hasMore) {
      assert(!data.nextCursor, 'final page exposes a cursor', 'STAGING_CURSOR_END_INVALID');
      break;
    }
    assert(data.nextCursor && !seenCursors.has(data.nextCursor), 'cursor did not advance', 'STAGING_CURSOR_REPEAT');
    seenCursors.add(data.nextCursor);
    cursor = data.nextCursor;
    if (pages % 25 === 0) process.stderr.write(`[STEP3A][STAGING] query traversal ${JSON.stringify(options)} page ${pages}\n`);
  }
  assert(pages < 200 && finalHasMore === false, 'query traversal did not terminate', 'STAGING_CURSOR_NON_TERMINATING');
  return { ids, pages, firstPageCount };
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
  assert(actual.length === expected.length, `${label} count ${actual.length} != ${expected.length}`, 'STAGING_QUERY_COUNT_MISMATCH');
  const expectedSet = new Set(expected);
  assert(actual.every((id) => expectedSet.has(id)), `${label} returned an unexpected school`, 'STAGING_QUERY_SET_MISMATCH');
}

function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: 'audit',
    allowInactiveRead: true
  });
  assert(preflight.environmentName === 'staging', 'staging query audit refuses production', 'PRODUCTION_TARGET_REJECTED');
  const source = schoolCore.normalizeSource(schoolCore.parseSource()).records;
  assert(source.length === 2952, 'source count lock failed', 'SOURCE_COUNT_DRIFT');
  const samples = [];
  const invoke = createInvoker(preflight.environmentId, samples);

  const browse = traverse(invoke);
  assert(browse.firstPageCount === 20, 'first page is not 20 schools', 'STAGING_FIRST_PAGE_INVALID');
  assertSameSet(browse.ids, expectedIds(source), 'nationwide browse');

  const searches = {};
  for (const keyword of SEARCH_TERMS) {
    const result = traverse(invoke, { keyword });
    const expected = expectedIds(source, { keyword });
    assertSameSet(result.ids, expected, `search ${keyword}`);
    searches[keyword] = { count: result.ids.length, pages: result.pages };
  }

  const provinces = {};
  for (const province of PROVINCES) {
    const result = traverse(invoke, { province });
    const expected = expectedIds(source, { province });
    assertSameSet(result.ids, expected, `province ${province}`);
    provinces[province] = { count: result.ids.length, pages: result.pages };
  }

  const combined = traverse(invoke, { province: '北京市', keyword: '北京' });
  assertSameSet(combined.ids, expectedIds(source, { province: '北京市', keyword: '北京' }), 'province + search');

  const first = invoke({ action: 'list', pageSize: 1 });
  assert(first.success && first.data.hasMore && first.data.nextCursor, 'cursor fixture unavailable', 'STAGING_CURSOR_TEST_FAILED');
  const repeatedLeft = invoke({ action: 'list', pageSize: 1, cursor: first.data.nextCursor });
  const repeatedRight = invoke({ action: 'list', pageSize: 1, cursor: first.data.nextCursor });
  assert(JSON.stringify(repeatedLeft.data.items) === JSON.stringify(repeatedRight.data.items), 'same cursor is non-deterministic', 'STAGING_CURSOR_NON_DETERMINISTIC');
  const cursor = first.data.nextCursor;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
  assert(invoke({ action: 'list', cursor: tampered }).code === 'INVALID_ARGUMENT', 'tampered cursor accepted', 'STAGING_CURSOR_TAMPER_ACCEPTED');
  assert(invoke({ action: 'list', province: '广东省', cursor }).code === 'INVALID_ARGUMENT', 'cross-scope cursor accepted', 'STAGING_CURSOR_SCOPE_ACCEPTED');
  assert(invoke({ action: 'list', province: '不存在省' }).code === 'INVALID_PROVINCE', 'invalid province accepted', 'STAGING_INVALID_INPUT_ACCEPTED');
  assert(invoke({ action: 'list', pageSize: 21 }).code === 'INVALID_PAGE_SIZE', 'oversized page accepted', 'STAGING_INVALID_INPUT_ACCEPTED');
  assert(invoke({ action: 'search', keyword: '' }).code === 'INVALID_KEYWORD', 'empty search accepted', 'STAGING_INVALID_INPUT_ACCEPTED');
  assert(invoke({ action: 'search', keyword: 'x'.repeat(41) }).code === 'INVALID_KEYWORD', 'oversized keyword accepted', 'STAGING_INVALID_INPUT_ACCEPTED');

  const remoteDurations = samples.map((sample) => sample.remoteDurationMs);
  const payloads = samples.map((sample) => sample.payloadBytes);
  const memory = samples.map((sample) => sample.memoryBytes);
  return {
    mode: 'staging-remote-query-audit',
    environment: publicSummary(preflight),
    nationwide: { count: browse.ids.length, pages: browse.pages, firstPageCount: browse.firstPageCount },
    searches,
    provinces,
    provinceAndSearch: { count: combined.ids.length, pages: combined.pages },
    cursor: { signedTamperRejected: true, scopeMismatchRejected: true, repeatedCursorDeterministic: true },
    invalidInputsRejected: true,
    calls: samples.length,
    performance: {
      remoteDurationMs: {
        min: Math.min(...remoteDurations),
        p50: percentile(remoteDurations, 0.5),
        p95: percentile(remoteDurations, 0.95),
        max: Math.max(...remoteDurations)
      },
      payloadBytes: { max: Math.max(...payloads), p95: percentile(payloads, 0.95) },
      functionMemoryBytesMax: Math.max(...memory)
    },
    searchSemantics: 'nameNormalized prefix, or exact 10-digit officialCode'
  };
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
      // Target registry failures are already fail-closed.
    }
    process.stderr.write(`${error.code || 'STEP3A_STAGING_QUERY_AUDIT_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { PAGE_SIZE, SEARCH_TERMS, PROVINCES, parseArguments, percentile, parseInvocation, expectedIds, run };
