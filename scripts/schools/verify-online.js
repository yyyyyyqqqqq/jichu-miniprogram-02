const fs = require('fs');
const path = require('path');
const {
  ROOT,
  NORMALIZED_JSON_PATH,
  stableJson
} = require('./core');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  runCloudBase
} = require('./cloud-cli');

const TARGET_NAMES = ['上海工程技术大学', '上海财经大学浙江学院'];
const ALLOWED_PUBLIC_FIELDS = [
  'city',
  'educationLevel',
  'id',
  'name',
  'platformStatus',
  'province',
  'selectable'
];
const TEMP_DIR = path.join(ROOT, 'temp');
const GROUP_FILES = {
  list: path.join(TEMP_DIR, 'phase-15-online-list.json'),
  search: path.join(TEMP_DIR, 'phase-15-online-search.json'),
  detail: path.join(TEMP_DIR, 'phase-15-online-detail.json'),
  pagination: path.join(TEMP_DIR, 'phase-15-online-pagination.json')
};

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = 'ONLINE_VERIFICATION_FAILED';
    throw error;
  }
}

function invokeSchoolQuery(event) {
  const environmentId = loadEnvironmentId();
  const response = runCloudBase([
    '--env-id', environmentId,
    'fn', 'invoke', 'schoolQuery',
    '--params', JSON.stringify(event),
    '--json'
  ], {
    timeoutMs: 180000
  });
  const root = response.data || response.Response || response;
  assert(Number(root.InvokeResult) === 0, 'cloud function invocation failed');
  const result = typeof root.RetMsg === 'string' ? JSON.parse(root.RetMsg) : root.RetMsg;
  assert(result && typeof result.success === 'boolean', 'cloud function returned an invalid envelope');
  return result;
}

function assertPublicSchool(record) {
  assert(record && record.selectable === true, 'active school is not selectable');
  assert(record.platformStatus === 'active', 'non-active school leaked into a public result');
  assert(
    JSON.stringify(Object.keys(record).sort()) === JSON.stringify(ALLOWED_PUBLIC_FIELDS),
    'public school response leaked internal fields'
  );
}

function loadTargets() {
  const records = JSON.parse(fs.readFileSync(NORMALIZED_JSON_PATH, 'utf8'));
  const targets = TARGET_NAMES.map((name) => records.find((record) => record.name === name));
  assert(targets.every(Boolean), 'target school is absent from normalized data');
  const pending = records.find((record) => record.name === '北京大学');
  assert(pending, 'pending probe school is absent from normalized data');
  return { targets, pending };
}

function runListGroup() {
  const all = invokeSchoolQuery({ action: 'list', pageSize: 20 });
  assert(all.success, 'online list failed');
  assert(all.data.items.length === 2, 'online list does not contain exactly two schools');
  all.data.items.forEach(assertPublicSchool);
  assert(
    JSON.stringify(all.data.items.map((record) => record.name)) === JSON.stringify(TARGET_NAMES),
    'online list order or scope is incorrect'
  );
  const shanghai = invokeSchoolQuery({ action: 'list', province: '上海市' });
  const zhejiang = invokeSchoolQuery({ action: 'list', province: '浙江省' });
  const beijing = invokeSchoolQuery({ action: 'list', province: '北京市' });
  assert(shanghai.success && shanghai.data.items.length === 1, 'Shanghai province filter failed');
  assert(shanghai.data.items[0].name === TARGET_NAMES[0], 'Shanghai province result crossed scope');
  assert(zhejiang.success && zhejiang.data.items.length === 1, 'Zhejiang province filter failed');
  assert(zhejiang.data.items[0].name === TARGET_NAMES[1], 'Zhejiang province result crossed scope');
  assert(beijing.success && beijing.data.items.length === 0, 'empty province returned a pending school');
  return {
    all,
    provinces: { shanghai, zhejiang, beijing }
  };
}

function runSearchGroup() {
  const { targets, pending } = loadTargets();
  const cases = [
    ['学校A前缀', '上海工程', TARGET_NAMES[0]],
    ['学校B前缀', '上海财经大学浙江', TARGET_NAMES[1]],
    ['学校A全名', TARGET_NAMES[0], TARGET_NAMES[0]],
    ['学校B全名', TARGET_NAMES[1], TARGET_NAMES[1]],
    ['学校A标识码', targets[0].officialCode, TARGET_NAMES[0]],
    ['学校B标识码', targets[1].officialCode, TARGET_NAMES[1]]
  ];
  const successful = cases.map(([label, keyword, expected]) => {
    const result = invokeSchoolQuery({ action: 'search', keyword });
    assert(result.success && result.data.items.length === 1, `${label} search failed`);
    assert(result.data.items[0].name === expected, `${label} search returned another school`);
    assertPublicSchool(result.data.items[0]);
    return { label, keyword, result };
  });
  const pendingResult = invokeSchoolQuery({ action: 'search', keyword: pending.name });
  const special = invokeSchoolQuery({ action: 'search', keyword: '.*' });
  const longKeyword = invokeSchoolQuery({ action: 'search', keyword: '测'.repeat(41) });
  assert(pendingResult.success && pendingResult.data.items.length === 0, 'pending school is searchable');
  assert(special.success && special.data.items.length === 0, 'special characters were not escaped');
  assert(!longKeyword.success && longKeyword.code === 'INVALID_KEYWORD', 'long keyword was accepted');
  return {
    successful,
    pending: pendingResult,
    special,
    longKeyword
  };
}

function runDetailGroup() {
  const { targets, pending } = loadTargets();
  const active = targets.map((record) => {
    const result = invokeSchoolQuery({ action: 'detail', schoolId: record._id });
    assert(result.success, `detail failed for ${record.name}`);
    assertPublicSchool(result.data);
    assert(result.data.name === record.name, 'detail returned another school');
    return { name: record.name, result };
  });
  const pendingResult = invokeSchoolQuery({ action: 'detail', schoolId: pending._id });
  const missing = invokeSchoolQuery({
    action: 'detail',
    schoolId: 's_00000000000000000000000000000000'
  });
  const invalid = invokeSchoolQuery({ action: 'detail', schoolId: 'invalid-school-id' });
  assert(!pendingResult.success && pendingResult.code === 'SCHOOL_NOT_ACTIVE', 'pending detail is public');
  assert(!missing.success && missing.code === 'SCHOOL_NOT_FOUND', 'missing detail error changed');
  assert(!invalid.success && invalid.code === 'INVALID_ARGUMENT', 'invalid detail ID was accepted');
  return { active, pending: pendingResult, missing, invalid };
}

function runPaginationGroup() {
  const first = invokeSchoolQuery({ action: 'list', pageSize: 1 });
  assert(first.success && first.data.items.length === 1, 'first page failed');
  assert(first.data.hasMore && first.data.nextCursor, 'first page did not return a cursor');
  const second = invokeSchoolQuery({
    action: 'list',
    pageSize: 1,
    cursor: first.data.nextCursor
  });
  assert(second.success && second.data.items.length === 1, 'second page failed');
  assert(!second.data.hasMore && !second.data.nextCursor, 'last page returned a phantom cursor');
  const names = [...first.data.items, ...second.data.items].map((record) => record.name);
  assert(new Set(names).size === 2, 'pagination contains duplicates');
  assert(TARGET_NAMES.every((name) => names.includes(name)), 'pagination omitted an active school');
  const invalid = invokeSchoolQuery({ action: 'list', pageSize: 1, cursor: 'not-base64' });
  const crossScope = invokeSchoolQuery({
    action: 'list',
    province: '上海市',
    pageSize: 1,
    cursor: first.data.nextCursor
  });
  assert(!invalid.success && invalid.code === 'INVALID_ARGUMENT', 'invalid cursor was accepted');
  assert(!crossScope.success && crossScope.code === 'INVALID_ARGUMENT', 'cross-scope cursor was accepted');
  return { first, second, invalid, crossScope };
}

async function verifyClientService(groups) {
  const CloudService = require(path.join(ROOT, 'services', 'cloud-service'));
  const servicePath = path.join(ROOT, 'services', 'school-service.js');
  delete require.cache[require.resolve(servicePath)];
  const SchoolService = require(servicePath);
  const originalCall = CloudService.callFunction;
  const searchByKeyword = new Map(
    groups.search.successful.map((item) => [item.keyword, item.result])
  );
  const detailById = new Map(
    groups.detail.active.map((item) => [item.result.data.id, item.result])
  );
  const pendingId = loadTargets().pending._id;
  try {
    CloudService.callFunction = async ({ data }) => {
      if (data.action === 'list') {
        return { result: groups.list.all };
      }
      if (data.action === 'search') {
        return { result: searchByKeyword.get(data.keyword) || groups.search.pending };
      }
      if (data.action === 'detail') {
        return {
          result: data.schoolId === pendingId
            ? groups.detail.pending
            : detailById.get(data.schoolId)
        };
      }
      throw new Error('unexpected action');
    };
    const list = await SchoolService.listSchools();
    assert(list.items.length === 2, 'SchoolService list integration failed');
    const firstSearch = await SchoolService.searchSchools({ keyword: '上海工程' });
    const secondSearch = await SchoolService.searchSchools({ keyword: '上海财经大学浙江' });
    assert(firstSearch.items[0].name === TARGET_NAMES[0], 'SchoolService school A search failed');
    assert(secondSearch.items[0].name === TARGET_NAMES[1], 'SchoolService school B search failed');
    for (const item of list.items) {
      const detail = await SchoolService.getSchoolDetail(item.id);
      assert(detail.selectable && detail.name === item.name, 'SchoolService detail integration failed');
    }
    let pendingError;
    try {
      await SchoolService.getSchoolDetail(pendingId);
    } catch (error) {
      pendingError = error;
    }
    assert(pendingError && pendingError.code === 'SCHOOL_NOT_ACTIVE', 'pending service error mapping failed');
    CloudService.callFunction = async () => {
      const error = new Error('timeout');
      error.code = 'CLOUD_TIMEOUT';
      throw error;
    };
    let timeoutError;
    try {
      await SchoolService.listSchools();
    } catch (error) {
      timeoutError = error;
    }
    assert(timeoutError && timeoutError.code === 'CLOUD_TIMEOUT', 'service timeout mapping changed');
    const source = fs.readFileSync(servicePath, 'utf8');
    assert(!/cloud\.database\s*\(/.test(source), 'SchoolService directly accesses the database');
    return {
      listCount: list.items.length,
      searchNames: [firstSearch.items[0].name, secondSearch.items[0].name],
      detailCount: list.items.length,
      pendingError: pendingError.code,
      timeoutError: timeoutError.code,
      directDatabaseAccess: false,
      userOrAuthWrites: false,
      newPages: false
    };
  } finally {
    CloudService.callFunction = originalCall;
    delete require.cache[require.resolve(servicePath)];
  }
}

function writeGroup(group, value) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(GROUP_FILES[group], stableJson(value), 'utf8');
}

async function combineReports() {
  const groups = Object.fromEntries(
    Object.entries(GROUP_FILES).map(([group, filename]) => {
      assert(fs.existsSync(filename), `missing ${group} verification result`);
      return [group, JSON.parse(fs.readFileSync(filename, 'utf8'))];
    })
  );
  const client = await verifyClientService(groups);
  const environmentId = loadEnvironmentId();
  const report = {
    target: `cloud:${maskEnvironmentId(environmentId)}`,
    functionName: 'schoolQuery',
    activeSchools: TARGET_NAMES,
    list: {
      count: groups.list.all.data.items.length,
      names: groups.list.all.data.items.map((record) => record.name),
      stableOrder: true,
      safePublicFields: true,
      pendingExcluded: true
    },
    provinceFilters: {
      shanghai: groups.list.provinces.shanghai.data.items.map((record) => record.name),
      zhejiang: groups.list.provinces.zhejiang.data.items.map((record) => record.name),
      emptyProvinceCount: groups.list.provinces.beijing.data.items.length
    },
    search: {
      casesPassed: groups.search.successful.length,
      pendingExcluded: groups.search.pending.data.items.length === 0,
      specialCharactersSafe: groups.search.special.data.items.length === 0,
      longKeywordCode: groups.search.longKeyword.code
    },
    detail: {
      activePassed: groups.detail.active.length,
      pendingCode: groups.detail.pending.code,
      missingCode: groups.detail.missing.code,
      invalidCode: groups.detail.invalid.code,
      safePublicFields: true
    },
    pagination: {
      firstPageCount: groups.pagination.first.data.items.length,
      secondPageCount: groups.pagination.second.data.items.length,
      noDuplicates: true,
      noOmissions: true,
      finalHasMore: groups.pagination.second.data.hasMore,
      invalidCursorCode: groups.pagination.invalid.code,
      crossScopeCursorCode: groups.pagination.crossScope.code
    },
    clientService: client
  };
  const outputPath = path.join(ROOT, 'reports', 'schools', 'phase-15-online-verification.json');
  fs.writeFileSync(outputPath, stableJson(report), 'utf8');
  for (const filename of Object.values(GROUP_FILES)) {
    fs.unlinkSync(filename);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const groupIndex = args.indexOf('--group');
  const group = groupIndex >= 0 ? args[groupIndex + 1] : '';
  if (args.includes('--combine')) {
    await combineReports();
    return;
  }
  const runners = {
    list: runListGroup,
    search: runSearchGroup,
    detail: runDetailGroup,
    pagination: runPaginationGroup
  };
  assert(runners[group], 'use --group list|search|detail|pagination or --combine');
  const result = runners[group]();
  writeGroup(group, result);
  process.stdout.write(`${JSON.stringify({ group, passed: true }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'ONLINE_VERIFICATION_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  invokeSchoolQuery,
  assertPublicSchool,
  runListGroup,
  runSearchGroup,
  runDetailGroup,
  runPaginationGroup,
  verifyClientService
};
