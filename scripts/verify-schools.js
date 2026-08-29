const fs = require('fs');
const path = require('path');
const Module = require('module');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeInvalidCopy(records, mutation) {
  const copy = clone(records);
  mutation(copy);
  return copy;
}

function verifySourceAndNormalization(root) {
  const core = require('./schools/core');
  const before = core.hashFile(core.SOURCE_PATH);
  const inspection = core.inspectWorkbook(core.SOURCE_PATH);
  const parsed = core.parseSource(core.SOURCE_PATH);
  const normalized = core.normalizeSource(parsed);
  const validation = core.validateSchools(normalized.records, normalized.errors);
  const after = core.hashFile(core.SOURCE_PATH);

  assert(before === after, 'source workbook changed during inspection');
  assert(inspection.workbook.sheetCount === 1, 'source workbook sheet count changed');
  assert(inspection.workbook.sheetNames[0] === '全国普通高等学校名单', 'source workbook sheet changed');
  assert(inspection.sheets[0].headerRow === 3, 'source header row was not detected');
  assert(inspection.sheets[0].dataStartRow === 5, 'source first data row changed');
  assert(inspection.sheets[0].dataEndRow === 2986, 'source last data row changed');
  assert(inspection.sheets[0].formulaCount === 0, 'source unexpectedly contains formulas');
  assert(inspection.sheets[0].merges.length === 33, 'source merge profile changed');
  assert(parsed.records.length === 2952, 'ordinary school count changed');
  assert(parsed.provinceSections.length === 31, 'province section count changed');
  assert(parsed.provinceSections.every((section) => section.matches), 'province group count mismatch');
  assert(parsed.excludedRecords.length === 0, 'non-school rows leaked into the parsed range');
  assert(normalized.errors.length === 0, 'source normalization produced errors');
  assert(validation.valid && validation.p0.length === 0, 'normalized source failed P0 validation');
  assert(validation.p1.length === 0, 'normalized source has unresolved P1 issues');
  assert(normalized.records.filter((record) => record.educationLevel === '本科').length === 1412, 'undergraduate count changed');
  assert(normalized.records.filter((record) => record.educationLevel === '专科').length === 1540, 'junior college count changed');
  assert(normalized.records.every((record) => record.platformStatus === 'pending'), 'source activated a real school');
  assert(
    normalized.records.every((record) => /^\d{10}$/.test(record.officialCode)),
    'official code format or leading-zero preservation failed'
  );
  assert(
    core.stableJson(normalized.records) === fs.readFileSync(core.NORMALIZED_JSON_PATH, 'utf8'),
    'checked-in normalized JSON is not reproducible'
  );
  return {
    core,
    records: normalized.records,
    sourceChecksum: before
  };
}

function verifyNormalizationAndValidation(core, records) {
  assert(core.normalizeOfficialCode(' 4111010001 ') === '4111010001', 'official code trimming failed');
  assert(core.normalizeOfficialCode(4111010001) === '4111010001', 'numeric official code normalization failed');
  let rejected = 0;
  for (const invalid of ['', 'abc', '411101000', '41110100011', '41-11010001']) {
    try {
      core.normalizeOfficialCode(invalid);
    } catch (error) {
      rejected += 1;
    }
  }
  assert(rejected === 5, 'invalid official codes were accepted');
  assert(
    core.buildSchoolId('4111010001') === core.buildSchoolId(4111010001),
    'deterministic ID changes with equivalent input type'
  );
  assert(
    core.buildSchoolId('4111010001') !== core.buildSchoolId('4111010002'),
    'different official codes collide'
  );
  assert(/^s_[0-9a-f]{32}$/.test(core.buildSchoolId('4111010001')), 'school ID shape is invalid');
  assert(core.normalizeName('  Ａ 大学  ') === 'A 大学', 'name normalization failed');

  const duplicateCode = makeInvalidCopy(records.slice(0, 2), (copy) => {
    copy[1].officialCode = copy[0].officialCode;
    copy[1]._id = copy[0]._id;
  });
  assert(!core.validateSchools(duplicateCode).valid, 'duplicate code did not fail validation');
  const missingCode = makeInvalidCopy(records.slice(0, 1), (copy) => {
    copy[0].officialCode = '';
  });
  assert(!core.validateSchools(missingCode).valid, 'missing code did not fail validation');
  const missingName = makeInvalidCopy(records.slice(0, 1), (copy) => {
    copy[0].name = '';
  });
  assert(!core.validateSchools(missingName).valid, 'missing name did not fail validation');
  const invalidLevel = makeInvalidCopy(records.slice(0, 1), (copy) => {
    copy[0].educationLevel = '研究生';
  });
  assert(!core.validateSchools(invalidLevel).valid, 'invalid level did not fail validation');
  const invalidId = makeInvalidCopy(records.slice(0, 1), (copy) => {
    copy[0]._id = 's_invalid';
  });
  assert(!core.validateSchools(invalidId).valid, 'mismatched ID did not fail validation');
}

function simulateImport(existing, desired) {
  const map = new Map(existing.map((record) => [record._id, clone(record)]));
  const diff = require('./schools/core').diffSchools(desired, [...map.values()]);
  diff.additions.forEach((record) => map.set(record._id, {
    ...clone(record),
    platformStatus: 'pending',
    createdAt: 'fixed'
  }));
  diff.updates.forEach((item) => {
    const previous = map.get(item.desired._id);
    map.set(item.desired._id, {
      ...previous,
      ...clone(item.desired),
      platformStatus: previous.platformStatus,
      isHot: previous.isHot
    });
  });
  return [...map.values()];
}

function verifyDryRunAndImport(core, records, sourceChecksum) {
  const { buildReport } = require('./schools/diff');
  const { parseArguments, buildImportReport } = require('./schools/import');
  const {
    buildInsertDocuments,
    buildOfficialUpdate,
    buildPlatformStatusUpdateCommand
  } = require('./schools/cloud-cli');
  const {
    TOOL_VERSION,
    parseArguments: parseStatusArguments,
    buildOperationId,
    buildPlan: buildStatusPlan
  } = require('./schools/set-platform-status');

  const report = buildReport(records, [], sourceChecksum, 'test-empty');
  assert(report.additions === 2952 && report.updates === 0, 'empty dry-run counts are incorrect');
  assert(report.conflicts === 0 && report.invalid === 0, 'empty dry-run reported conflicts');
  assert(report.statusPlan.pending === 2952 && !report.statusPlan.active, 'dry-run activated schools');
  assert(report.batchId === core.buildBatchId(records, sourceChecksum), 'batch ID is unstable');
  assert(
    core.buildBatchId(records, sourceChecksum) !== core.buildBatchId(records.slice(0, -1), sourceChecksum),
    'batch ID did not change after normalized data changed'
  );

  assert(parseArguments([]).apply === false, 'import does not default to dry-run');
  assert(parseArguments(['--dry-run', '--local-only']).apply === false, 'explicit dry-run enables writes');
  assert(parseArguments(['--apply', '--confirm', 'batch']).apply === true, 'apply arguments are not parsed');

  const current = [{
    ...records[0],
    platformStatus: 'active',
    isHot: true
  }];
  const planned = buildImportReport(records.slice(0, 2), current, sourceChecksum, 'mock');
  assert(planned.additions === 1 && planned.identical === 1, 'idempotent diff is incorrect');
  const first = simulateImport(current, records.slice(0, 2));
  const second = simulateImport(first, records.slice(0, 2));
  assert(second.length === 2, 'repeat import created duplicates');
  assert(second[0].platformStatus === 'active' && second[0].isHot === true, 'import overwrote operations fields');

  const inserted = buildInsertDocuments(records.slice(0, 1), new Date('2026-07-28T00:00:00.000Z'))[0];
  assert(inserted.platformStatus === 'pending', 'new import record is not pending');
  const update = buildOfficialUpdate(records[0], new Date('2026-07-28T00:00:00.000Z'));
  assert(!Object.prototype.hasOwnProperty.call(update, 'platformStatus'), 'official update overwrites platformStatus');
  assert(!Object.prototype.hasOwnProperty.call(update, 'isHot'), 'official update overwrites isHot');

  const targetRecords = records.filter((record) => (
    record.name === '上海工程技术大学'
    || record.name === '上海财经大学浙江学院'
  ));
  const reason = 'phase-15 test school activation';
  const statusOptions = parseStatusArguments([
    '--school-id', targetRecords[0]._id,
    '--school-id', targetRecords[1]._id,
    '--status', 'active',
    '--reason', reason
  ]);
  assert(!statusOptions.apply, 'platform status tool does not default to dry-run');
  const operationId = buildOperationId(statusOptions.schoolIds, 'active', reason);
  assert(
    operationId === buildOperationId([...statusOptions.schoolIds].reverse(), 'active', reason),
    'platform status operation ID depends on argument order'
  );
  const cloudTargets = targetRecords.map((record) => ({
    ...record,
    createdAt: 'created',
    updatedAt: 'updated',
    lastSeenAt: 'seen'
  }));
  const statusPlan = buildStatusPlan({
    ...statusOptions,
    normalizedRecords: targetRecords,
    cloudRecords: cloudTargets,
    target: 'cloud:masked'
  });
  assert(statusPlan.conflicts.length === 0, 'eligible school activation has conflicts');
  assert(statusPlan.targets.every((target) => target.fromStatus === 'pending'), 'activation source status changed');
  const statusCommand = buildPlatformStatusUpdateCommand(statusPlan.targets, {
    operationId,
    toolVersion: TOOL_VERSION,
    status: 'active',
    reason
  });
  const rawStatusCommand = JSON.parse(statusCommand.Command);
  assert(rawStatusCommand.updates.length === 2, 'status update batch scope changed');
  assert(
    rawStatusCommand.updates.every((item) => (
      item.q.platformStatus === 'pending'
      && item.q.officialStatus === 'valid'
      && item.u.$set.platformStatus === 'active'
      && !Object.prototype.hasOwnProperty.call(item.u.$set, 'officialCode')
      && item.u.$currentDate.updatedAt === true
      && item.u.$currentDate.activatedAt === true
    )),
    'platform status update is not conditional or changes protected fields'
  );
  const invalidOfficial = cloudTargets.map((record, index) => ({
    ...record,
    officialStatus: index === 0 ? 'inactive' : record.officialStatus
  }));
  assert(
    buildStatusPlan({
      ...statusOptions,
      normalizedRecords: targetRecords,
      cloudRecords: invalidOfficial,
      target: 'cloud:masked'
    }).conflicts.some((item) => item.code === 'OFFICIAL_STATUS_NOT_VALID'),
    'activation accepts a non-valid official status'
  );
  let batchRejected = false;
  try {
    parseStatusArguments([
      '--school-id', targetRecords[0]._id,
      '--school-id', targetRecords[1]._id,
      '--school-id', records[2]._id,
      '--status', 'active',
      '--reason', reason
    ]);
  } catch (error) {
    batchRejected = error.code === 'STATUS_BATCH_LIMIT';
  }
  assert(batchRejected, 'platform status tool accepts more than two schools');
}

function createSchoolQueryMock(records) {
  function matches(record, condition) {
    if (!condition) {
      return true;
    }
    if (condition.__op === 'and') {
      return condition.values.every((item) => matches(record, item));
    }
    if (condition.__op === 'or') {
      return condition.values.some((item) => matches(record, item));
    }
    return Object.entries(condition).every(([field, expected]) => {
      const actual = record[field];
      if (expected && expected.__op === 'gt') {
        return actual > expected.value;
      }
      if (expected instanceof RegExp) {
        return expected.test(actual);
      }
      return actual === expected;
    });
  }
  function query() {
    let condition = null;
    let fields = null;
    let limit = 20;
    const orders = [];
    return {
      where(value) {
        condition = value;
        return this;
      },
      field(value) {
        fields = value;
        return this;
      },
      orderBy(field, direction) {
        orders.push({ field, direction });
        return this;
      },
      limit(value) {
        limit = value;
        return this;
      },
      async get() {
        const data = records.filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const order of orders) {
              if (left[order.field] === right[order.field]) {
                continue;
              }
              const result = left[order.field] < right[order.field] ? -1 : 1;
              return order.direction === 'desc' ? -result : result;
            }
            return 0;
          })
          .slice(0, limit)
          .map((record) => {
            if (!fields) {
              return clone(record);
            }
            return Object.fromEntries(Object.keys(fields)
              .filter((field) => fields[field])
              .map((field) => [field, record[field]]));
          });
        return { data };
      }
    };
  }
  return {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database() {
      return {
        command: {
          gt(value) {
            return { __op: 'gt', value };
          },
          and(values) {
            return { __op: 'and', values };
          },
          or(values) {
            return { __op: 'or', values };
          }
        },
        RegExp({ regexp, options }) {
          return new RegExp(regexp, options);
        },
        collection() {
          return query();
        }
      };
    }
  };
}

async function verifySchoolQuery(root) {
  const previousCursorSecret = process.env.SCHOOL_QUERY_CURSOR_HMAC_SECRET;
  process.env.SCHOOL_QUERY_CURSOR_HMAC_SECRET = 'school-query-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
  const activeFixtures = JSON.parse(fs.readFileSync(
    path.join(root, 'data', 'schools', 'fixtures', 'active-schools.fixture.json'),
    'utf8'
  ));
  const { buildSchoolId } = require('./schools/core');
  assert(
    activeFixtures.every((record) => (
      record.fixtureOnly === true
      && record.platformStatus === 'active'
      && record._id === buildSchoolId(record.officialCode)
    )),
    'active school fixture is not isolated or deterministic'
  );
  const fixtures = [
    ...activeFixtures,
    { _id: 's_cccccccccccccccccccccccccccccccc', officialCode: '4132010001', name: '待开放大学', nameNormalized: '待开放大学', province: '江苏省', city: '南京市', educationLevel: '本科', officialStatus: 'valid', platformStatus: 'pending', sourceRow: 7, authority: '江苏省', importBatch: 'secret' },
    { _id: 's_dddddddddddddddddddddddddddddddd', officialCode: '4151010001', name: '停用大学', nameNormalized: '停用大学', province: '四川省', city: '成都市', educationLevel: '本科', officialStatus: 'valid', platformStatus: 'inactive', sourceRow: 8, authority: '四川省' }
  ];
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return createSchoolQueryMock(fixtures);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = path.join(root, 'cloudfunctions', 'schoolQuery', 'index.js');
  delete require.cache[require.resolve(modulePath)];
  const schoolQuery = require(modulePath);
  Module._load = originalLoad;
  try {
    const list = await schoolQuery.main({ action: 'list', pageSize: 1 });
    assert(list.success && list.data.items.length === 1 && list.data.hasMore, 'list pagination failed');
    const next = await schoolQuery.main({ action: 'list', pageSize: 1, cursor: list.data.nextCursor });
    assert(next.success && next.data.items.length === 1, 'stable cursor failed');
    assert(!next.data.hasMore && !next.data.nextCursor, 'final school page exposes a phantom cursor');
    const tamperedCursor = `${list.data.nextCursor.slice(0, -1)}${list.data.nextCursor.endsWith('a') ? 'b' : 'a'}`;
    assert(
      (await schoolQuery.main({ action: 'list', pageSize: 1, cursor: tamperedCursor })).code === 'INVALID_ARGUMENT',
      'tampered cursor accepted'
    );
    assert(
      (await schoolQuery.main({ action: 'list', province: '广东省', pageSize: 1, cursor: list.data.nextCursor })).code === 'INVALID_ARGUMENT',
      'cursor scope binding failed'
    );
    assert(
      [...list.data.items, ...next.data.items].every((record) => record.platformStatus === 'active'),
      'list exposed non-active schools'
    );
    const province = await schoolQuery.main({ action: 'list', province: '广东省' });
    assert(province.success && province.data.items.length === 1, 'province filter failed');
    const prefix = await schoolQuery.main({ action: 'search', keyword: '  测试大 ' });
    assert(prefix.success && prefix.data.items[0].name === '测试大学甲', 'prefix search failed');
    const exact = await schoolQuery.main({ action: 'search', keyword: '9900000001' });
    assert(exact.success && exact.data.items[0].name === '测试大学甲', 'official code search failed');
    const regex = await schoolQuery.main({ action: 'search', keyword: '.*' });
    assert(regex.success && regex.data.items.length === 0, 'regex characters were not escaped');
    const detail = await schoolQuery.main({ action: 'detail', schoolId: fixtures[0]._id });
    assert(detail.success && detail.data.name === '测试大学甲', 'active detail failed');
    assert(!Object.prototype.hasOwnProperty.call(detail.data, 'officialCode'), 'detail leaked officialCode');
    assert(!Object.prototype.hasOwnProperty.call(detail.data, 'sourceRow'), 'detail leaked sourceRow');
    const pending = await schoolQuery.main({ action: 'detail', schoolId: fixtures[2]._id });
    assert(!pending.success && pending.code === 'SCHOOL_NOT_ACTIVE', 'pending detail is selectable');
    const inactive = await schoolQuery.main({ action: 'detail', schoolId: fixtures[3]._id });
    assert(!inactive.success && inactive.code === 'SCHOOL_NOT_ACTIVE', 'inactive detail is selectable');
    assert((await schoolQuery.main({ action: 'search', keyword: '' })).code === 'INVALID_KEYWORD', 'empty keyword accepted');
    assert((await schoolQuery.main({ action: 'search', keyword: 'a'.repeat(41) })).code === 'INVALID_KEYWORD', 'long keyword accepted');
    assert((await schoolQuery.main({ action: 'list', province: '不存在省' })).code === 'INVALID_PROVINCE', 'invalid province accepted');
    assert((await schoolQuery.main({ action: 'list', pageSize: 999 })).code === 'INVALID_PAGE_SIZE', 'large page accepted');
    assert((await schoolQuery.main({ action: 'unknown' })).code === 'INVALID_ACTION', 'unknown action accepted');
  } finally {
    delete require.cache[require.resolve(modulePath)];
    Module._load = originalLoad;
    if (previousCursorSecret === undefined) delete process.env.SCHOOL_QUERY_CURSOR_HMAC_SECRET;
    else process.env.SCHOOL_QUERY_CURSOR_HMAC_SECRET = previousCursorSecret;
  }
}

async function verifySchoolService(root) {
  const CloudService = require(path.join(root, 'services', 'cloud-service'));
  const originalCall = CloudService.callFunction;
  const servicePath = path.join(root, 'services', 'school-service');
  delete require.cache[require.resolve(servicePath)];
  const SchoolService = require(servicePath);
  try {
    CloudService.callFunction = async ({ data }) => ({
      result: data.action === 'detail'
        ? {
          success: true,
          code: 'OK',
          data: {
            id: data.schoolId,
            name: '测试大学',
            province: '广东省',
            city: '广州市',
            educationLevel: '本科',
            platformStatus: 'active',
            selectable: true
          }
        }
        : {
          success: true,
          code: 'OK',
          data: {
            items: [],
            nextCursor: '',
            hasMore: false
          }
        }
    });
    const list = await SchoolService.listSchools({ pageSize: 10 });
    assert(Array.isArray(list.items), 'school service list normalization failed');
    const detail = await SchoolService.getSchoolDetail('s_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert(detail.selectable && detail.name === '测试大学', 'school service detail normalization failed');
    let keywordError;
    try {
      await SchoolService.searchSchools({ keyword: '' });
    } catch (error) {
      keywordError = error;
    }
    assert(keywordError && keywordError.code === 'INVALID_KEYWORD', 'school service accepts empty keyword');
  } finally {
    CloudService.callFunction = originalCall;
    delete require.cache[require.resolve(servicePath)];
  }
}

async function verifySchoolFlow(root) {
  const source = verifySourceAndNormalization(root);
  verifyNormalizationAndValidation(source.core, source.records);
  verifyDryRunAndImport(source.core, source.records, source.sourceChecksum);
  await verifySchoolQuery(root);
  await verifySchoolService(root);
  return {
    source: true,
    normalization: true,
    import: true,
    query: true,
    service: true
  };
}

if (require.main === module) {
  verifySchoolFlow(path.resolve(__dirname, '..'))
    .then((result) => {
      process.stdout.write(`School verification passed: ${Object.keys(result).length} groups.\n`);
    })
    .catch((error) => {
      process.stderr.write(`School verification failed: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  verifySchoolFlow
};
