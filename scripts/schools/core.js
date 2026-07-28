const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const XLSX = require('@e965/xlsx');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_PATH = path.join(ROOT, 'list of universities.xls');
const GENERATED_DIR = path.join(ROOT, 'data', 'schools', 'generated');
const REPORT_DIR = path.join(ROOT, 'reports', 'schools');
const NORMALIZED_JSON_PATH = path.join(GENERATED_DIR, 'schools.normalized.json');
const NORMALIZED_CSV_PATH = path.join(GENERATED_DIR, 'schools.normalized.csv');
const SOURCE_YEAR = 2026;
const SOURCE_VERSION = '截至2026年6月17日';
const SOURCE_PAGE = 'https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202606/t20260618_1441074.html';
const SOURCE_DOWNLOAD = 'https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202606/W020260618416094865984.xls';
const EXPECTED_HEADERS = ['序号', '学校名称', '学校标识码', '主管部门', '所在地', '办学层次', '备注'];
const VALID_LEVELS = new Set(['本科', '专科']);
const VALID_OFFICIAL_STATUSES = new Set(['valid', 'inactive', 'merged']);
const VALID_PLATFORM_STATUSES = new Set(['pending', 'active', 'inactive', 'merged']);
const PROVINCE_HEADER_PATTERN = /^(.+?)[（(](\d+)所[）)]$/;
const OFFICIAL_CODE_PATTERN = /^\d{10}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/u;

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256Text(value) {
  return sha256Buffer(Buffer.from(String(value), 'utf8'));
}

function hashFile(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function normalizeText(value) {
  return value === null || value === undefined
    ? ''
    : String(value)
      .normalize('NFKC')
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
}

function normalizeName(value) {
  return normalizeText(value);
}

function normalizeNameForSearch(value) {
  return normalizeName(value).toLocaleLowerCase('zh-CN');
}

function normalizeOfficialCode(value) {
  if (value === null || value === undefined || value === '') {
    throw new Error('officialCode is required');
  }
  let normalized;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('officialCode number is unsafe');
    }
    normalized = String(value);
  } else {
    normalized = normalizeText(value);
  }
  if (!OFFICIAL_CODE_PATTERN.test(normalized)) {
    throw new Error(`officialCode must be 10 digits: ${normalized || '<empty>'}`);
  }
  return normalized;
}

function buildSchoolId(officialCode) {
  const normalized = normalizeOfficialCode(officialCode);
  return `s_${sha256Text(`MOE:${normalized}`).slice(0, 32)}`;
}

function normalizeProvince(value) {
  return normalizeText(value);
}

function normalizeEducationLevel(value) {
  const normalized = normalizeText(value);
  if (!VALID_LEVELS.has(normalized)) {
    throw new Error(`unsupported educationLevel: ${normalized || '<empty>'}`);
  }
  return normalized;
}

function readWorkbook(sourcePath = SOURCE_PATH) {
  if (!fs.existsSync(sourcePath)) {
    const error = new Error(`source file not found: ${path.basename(sourcePath)}`);
    error.code = 'SOURCE_FILE_NOT_FOUND';
    throw error;
  }
  const before = hashFile(sourcePath);
  let workbook;
  try {
    workbook = XLSX.readFile(sourcePath, {
      raw: true,
      cellDates: false,
      cellFormula: true,
      cellStyles: true,
      cellText: true,
      bookFiles: true,
      bookVBA: true
    });
  } catch (cause) {
    const error = new Error(`unable to parse source workbook: ${cause.message}`);
    error.code = 'SOURCE_PARSE_FAILED';
    throw error;
  }
  const after = hashFile(sourcePath);
  if (before !== after) {
    const error = new Error('source workbook changed during read');
    error.code = 'SOURCE_CHECKSUM_CHANGED';
    throw error;
  }
  return {
    workbook,
    checksum: before,
    size: fs.statSync(sourcePath).size
  };
}

function cellDisplayValue(sheet, rowIndex, columnIndex) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  const cell = sheet[address];
  if (!cell) {
    return null;
  }
  return cell.w !== undefined && cell.w !== null ? cell.w : cell.v;
}

function inspectWorkbook(sourcePath = SOURCE_PATH) {
  const { workbook, checksum, size } = readWorkbook(sourcePath);
  const sheets = workbook.SheetNames.map((name, sheetIndex) => {
    const sheet = workbook.Sheets[name];
    const range = sheet['!ref']
      ? XLSX.utils.decode_range(sheet['!ref'])
      : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    const rowCount = range.e.r >= range.s.r ? range.e.r + 1 : 0;
    const columnCount = range.e.c >= range.s.c ? range.e.c + 1 : 0;
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true
    });
    const formulas = [];
    const comments = [];
    const typeDistribution = {};
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!') || !cell) {
        continue;
      }
      typeDistribution[cell.t || 'unknown'] = (typeDistribution[cell.t || 'unknown'] || 0) + 1;
      if (cell.f) {
        formulas.push({ cell: address, formula: cell.f });
      }
      if (Array.isArray(cell.c) && cell.c.length > 0) {
        comments.push({ cell: address, count: cell.c.length });
      }
    }
    let emptyRows = 0;
    let partialRows = 0;
    rows.forEach((row) => {
      const populated = Array.from({ length: columnCount }, (_, index) => row[index])
        .filter((value) => value !== null && value !== undefined && value !== '').length;
      if (populated === 0) {
        emptyRows += 1;
      } else if (populated < columnCount) {
        partialRows += 1;
      }
    });
    const headerRowIndex = rows.findIndex((row) => (
      EXPECTED_HEADERS.every((header, index) => normalizeText(row[index]) === header)
    ));
    const firstDataRowIndex = rows.findIndex((row, index) => (
      index > headerRowIndex && Number.isFinite(Number(row[0])) && normalizeText(row[1])
    ));
    const lastDataRowIndex = rows.reduce((last, row, index) => (
      Number.isFinite(Number(row[0])) && normalizeText(row[1]) ? index : last
    ), -1);
    return {
      name,
      hidden: Boolean(workbook.Workbook
        && workbook.Workbook.Sheets
        && workbook.Workbook.Sheets[sheetIndex]
        && workbook.Workbook.Sheets[sheetIndex].Hidden),
      ref: sheet['!ref'] || '',
      rowCount,
      columnCount,
      headerRow: headerRowIndex + 1,
      dataStartRow: firstDataRowIndex + 1,
      dataEndRow: lastDataRowIndex + 1,
      trailingRows: lastDataRowIndex >= 0 ? rowCount - lastDataRowIndex - 1 : rowCount,
      emptyRows,
      partialRows,
      merges: (sheet['!merges'] || []).map(XLSX.utils.encode_range),
      formulaCount: formulas.length,
      formulas,
      commentCount: comments.reduce((sum, item) => sum + item.count, 0),
      comments,
      imageCount: Array.isArray(sheet['!images']) ? sheet['!images'].length : 0,
      imageDetection: 'SheetJS cell model; embedded BIFF drawings are not surfaced when absent from !images',
      typeDistribution,
      first20Rows: rows.slice(0, 20).map((row) => (
        Array.from({ length: columnCount }, (_, index) => row[index] === undefined ? null : row[index])
      ))
    };
  });
  return {
    file: {
      name: path.basename(sourcePath),
      size,
      sha256: checksum,
      format: 'OLE Compound File / Excel 97-2003 BIFF (.xls)',
      signature: fs.readFileSync(sourcePath).subarray(0, 8).toString('hex').toUpperCase(),
      sourcePage: SOURCE_PAGE,
      sourceDownload: SOURCE_DOWNLOAD
    },
    workbook: {
      sheetCount: workbook.SheetNames.length,
      sheetNames: workbook.SheetNames,
      hiddenSheetCount: sheets.filter((sheet) => sheet.hidden).length,
      hasFormulas: sheets.some((sheet) => sheet.formulaCount > 0),
      hasMerges: sheets.some((sheet) => sheet.merges.length > 0),
      hasComments: sheets.some((sheet) => sheet.commentCount > 0),
      hasDetectedImages: sheets.some((sheet) => sheet.imageCount > 0),
      properties: {
        application: workbook.Props && workbook.Props.Application || '',
        author: workbook.Props && workbook.Props.Author || '',
        lastAuthor: workbook.Props && workbook.Props.LastAuthor || '',
        createdDate: workbook.Props && workbook.Props.CreatedDate || null,
        modifiedDate: workbook.Props && workbook.Props.ModifiedDate || null
      }
    },
    sheets
  };
}

function parseSource(sourcePath = SOURCE_PATH) {
  const { workbook, checksum } = readWorkbook(sourcePath);
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== '全国普通高等学校名单') {
    const error = new Error(`unexpected workbook sheets: ${workbook.SheetNames.join(', ')}`);
    error.code = 'SOURCE_SCHEMA_MISMATCH';
    throw error;
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true
  });
  const headerIndex = rows.findIndex((row) => (
    EXPECTED_HEADERS.every((header, index) => normalizeText(row[index]) === header)
  ));
  if (headerIndex < 0) {
    const error = new Error('expected header row was not found');
    error.code = 'SOURCE_SCHEMA_MISMATCH';
    throw error;
  }
  const records = [];
  const excludedRecords = [];
  const provinceSections = [];
  let currentProvince = '';
  let expectedProvinceCount = null;
  let observedProvinceCount = 0;
  function closeProvinceSection(endRow) {
    if (!currentProvince) {
      return;
    }
    provinceSections.push({
      province: currentProvince,
      expectedCount: expectedProvinceCount,
      observedCount: observedProvinceCount,
      matches: expectedProvinceCount === observedProvinceCount,
      endRow
    });
  }
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const first = normalizeText(row[0]);
    const sectionMatch = first.match(PROVINCE_HEADER_PATTERN);
    if (sectionMatch && row.slice(1).every((value) => value === null || value === undefined || value === '')) {
      closeProvinceSection(index);
      currentProvince = normalizeProvince(sectionMatch[1]);
      expectedProvinceCount = Number(sectionMatch[2]);
      observedProvinceCount = 0;
      continue;
    }
    const sequence = Number(row[0]);
    if (Number.isInteger(sequence) && sequence > 0) {
      const rawCode = cellDisplayValue(sheet, index, 2);
      records.push({
        sourceRow: index + 1,
        sequence,
        rawName: row[1],
        rawOfficialCode: rawCode,
        rawAuthority: row[3],
        rawCity: row[4],
        rawEducationLevel: row[5],
        rawRemark: row[6],
        rawProvince: currentProvince
      });
      observedProvinceCount += 1;
      continue;
    }
    const nonEmpty = row.some((value) => value !== null && value !== undefined && value !== '');
    if (nonEmpty) {
      excludedRecords.push({
        sourceRow: index + 1,
        reason: 'non_school_row',
        values: row.slice(0, EXPECTED_HEADERS.length)
      });
    }
  }
  closeProvinceSection(rows.length);
  return {
    checksum,
    sheetName: workbook.SheetNames[0],
    headerRow: headerIndex + 1,
    dataStartRow: records.length > 0 ? records[0].sourceRow : null,
    dataEndRow: records.length > 0 ? records[records.length - 1].sourceRow : null,
    records,
    excludedRecords,
    provinceSections
  };
}

function normalizeRecord(record) {
  const officialCode = normalizeOfficialCode(record.rawOfficialCode);
  const name = normalizeName(record.rawName);
  const province = normalizeProvince(record.rawProvince);
  const city = normalizeText(record.rawCity);
  const authority = normalizeText(record.rawAuthority);
  const educationLevel = normalizeEducationLevel(record.rawEducationLevel);
  return {
    _id: buildSchoolId(officialCode),
    officialCode,
    name,
    nameNormalized: normalizeNameForSearch(name),
    province,
    city,
    educationLevel,
    authority,
    officialStatus: 'valid',
    platformStatus: 'pending',
    dataSource: 'MOE',
    sourceYear: SOURCE_YEAR,
    sourceVersion: SOURCE_VERSION,
    sourceRow: record.sourceRow,
    remark: normalizeText(record.rawRemark)
  };
}

function sortSchools(records) {
  return [...records].sort((left, right) => (
    left.province.localeCompare(right.province, 'zh-CN')
    || left.nameNormalized.localeCompare(right.nameNormalized, 'zh-CN')
    || left.officialCode.localeCompare(right.officialCode)
  ));
}

function normalizeSource(parsed) {
  const errors = [];
  const normalized = [];
  parsed.records.forEach((record) => {
    try {
      normalized.push(normalizeRecord(record));
    } catch (error) {
      errors.push({
        sourceRow: record.sourceRow,
        code: 'NORMALIZATION_FAILED',
        message: error.message
      });
    }
  });
  return {
    records: sortSchools(normalized),
    errors
  };
}

function groupDuplicates(records, field) {
  const groups = new Map();
  records.forEach((record) => {
    const key = record[field];
    const values = groups.get(key) || [];
    values.push(record);
    groups.set(key, values);
  });
  return [...groups.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([value, values]) => ({
      value,
      rows: values.map((record) => record.sourceRow),
      ids: values.map((record) => record._id),
      names: values.map((record) => record.name),
      officialCodes: values.map((record) => record.officialCode)
    }));
}

function validateSchools(records, normalizationErrors = []) {
  const p0 = [...normalizationErrors];
  const p1 = [];
  const duplicateIds = groupDuplicates(records, '_id');
  const duplicateCodes = groupDuplicates(records, 'officialCode');
  const duplicateNames = groupDuplicates(records, 'nameNormalized');
  duplicateIds.forEach((item) => p0.push({ code: 'DUPLICATE_ID', ...item }));
  duplicateCodes.forEach((item) => p0.push({ code: 'DUPLICATE_OFFICIAL_CODE', ...item }));
  duplicateNames.forEach((item) => p1.push({ code: 'DUPLICATE_NAME', ...item }));
  records.forEach((record) => {
    const row = record.sourceRow;
    const required = ['officialCode', 'name', 'nameNormalized', 'province', 'educationLevel'];
    required.forEach((field) => {
      if (!record[field]) {
        p0.push({ code: `MISSING_${field.toUpperCase()}`, sourceRow: row });
      }
    });
    if (!OFFICIAL_CODE_PATTERN.test(record.officialCode || '')) {
      p0.push({ code: 'INVALID_OFFICIAL_CODE', sourceRow: row, value: record.officialCode });
    }
    try {
      if (buildSchoolId(record.officialCode) !== record._id) {
        p0.push({ code: 'SCHOOL_ID_MISMATCH', sourceRow: row, id: record._id });
      }
    } catch (error) {
      p0.push({ code: 'SCHOOL_ID_INVALID_CODE', sourceRow: row, message: error.message });
    }
    if (!VALID_LEVELS.has(record.educationLevel)) {
      p0.push({ code: 'INVALID_EDUCATION_LEVEL', sourceRow: row, value: record.educationLevel });
    }
    if (!VALID_OFFICIAL_STATUSES.has(record.officialStatus)) {
      p0.push({ code: 'INVALID_OFFICIAL_STATUS', sourceRow: row, value: record.officialStatus });
    }
    if (!VALID_PLATFORM_STATUSES.has(record.platformStatus)) {
      p0.push({ code: 'INVALID_PLATFORM_STATUS', sourceRow: row, value: record.platformStatus });
    }
    if (!record.authority) {
      p1.push({ code: 'MISSING_AUTHORITY', sourceRow: row, id: record._id });
    }
    for (const field of ['name', 'nameNormalized', 'province', 'city', 'authority']) {
      if (CONTROL_CHARACTER_PATTERN.test(record[field] || '')) {
        p1.push({ code: 'INVISIBLE_CHARACTER', sourceRow: row, field, id: record._id });
      }
    }
  });
  if (!Number.isInteger(SOURCE_YEAR) || SOURCE_YEAR < 2000 || SOURCE_YEAR > 2100) {
    p1.push({ code: 'INVALID_SOURCE_YEAR', value: SOURCE_YEAR });
  }
  if (!SOURCE_VERSION) {
    p1.push({ code: 'MISSING_SOURCE_VERSION' });
  }
  return {
    valid: p0.length === 0,
    p0,
    p1,
    statistics: {
      total: records.length,
      duplicateIds: duplicateIds.length,
      duplicateOfficialCodes: duplicateCodes.length,
      duplicateNames: duplicateNames.length,
      p0Count: p0.length,
      p1Count: p1.length
    }
  };
}

function countBy(records, field) {
  return Object.fromEntries([...records.reduce((map, record) => {
    const key = record[field] || '<empty>';
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')));
}

function buildProfile(parsed, normalized, validation) {
  const raw = parsed.records;
  const abnormalWhitespace = raw.filter((record) => (
    [record.rawName, record.rawOfficialCode, record.rawAuthority, record.rawCity, record.rawEducationLevel]
      .some((value) => typeof value === 'string' && value !== value.trim())
  )).map((record) => record.sourceRow);
  const fullWidthDifferences = raw.filter((record) => (
    [record.rawName, record.rawAuthority, record.rawCity, record.rawEducationLevel]
      .some((value) => typeof value === 'string' && value.normalize('NFKC') !== value)
  )).map((record) => record.sourceRow);
  const invisibleCharacters = raw.filter((record) => (
    [record.rawName, record.rawAuthority, record.rawCity, record.rawEducationLevel]
      .some((value) => CONTROL_CHARACTER_PATTERN.test(String(value || '')))
  )).map((record) => record.sourceRow);
  const codeFormats = {};
  raw.forEach((record) => {
    const displayed = String(record.rawOfficialCode === null ? '' : record.rawOfficialCode);
    const key = /^\d+$/.test(displayed) ? `digits:${displayed.length}` : 'other';
    codeFormats[key] = (codeFormats[key] || 0) + 1;
  });
  return {
    sourceRecordCount: raw.length,
    includedRecords: normalized.length,
    excludedRecords: parsed.excludedRecords.length,
    excludedReasons: countBy(parsed.excludedRecords, 'reason'),
    schoolTypes: {
      ordinaryHigherEducation: normalized.length,
      adultHigherEducation: 0,
      scopeNote: '附件1仅包含全国普通高等学校；成人高校位于官方公告的独立附件2，未混入本源文件'
    },
    educationLevels: countBy(normalized, 'educationLevel'),
    provinceCounts: countBy(normalized, 'province'),
    cityFieldPresent: normalized.every((record) => Boolean(record.city)),
    officialCodePresent: normalized.every((record) => Boolean(record.officialCode)),
    officialCodeFormats: codeFormats,
    missing: {
      name: normalized.filter((record) => !record.name).length,
      officialCode: normalized.filter((record) => !record.officialCode).length,
      province: normalized.filter((record) => !record.province).length,
      city: normalized.filter((record) => !record.city).length,
      authority: normalized.filter((record) => !record.authority).length,
      educationLevel: normalized.filter((record) => !record.educationLevel).length
    },
    duplicates: {
      officialCode: validation.statistics.duplicateOfficialCodes,
      name: validation.statistics.duplicateNames,
      sameNameDifferentCode: validation.p1.filter((item) => item.code === 'DUPLICATE_NAME').length,
      sameCodeDifferentName: validation.p0.filter((item) => item.code === 'DUPLICATE_OFFICIAL_CODE').length
    },
    anomalies: {
      abnormalWhitespaceRows: abnormalWhitespace,
      fullWidthDifferenceRows: fullWidthDifferences,
      invisibleCharacterRows: invisibleCharacters,
      provinceSectionMismatches: parsed.provinceSections.filter((section) => !section.matches),
      suspiciousNonSchoolRows: parsed.excludedRecords
    },
    remarks: {
      nonEmptyCount: normalized.filter((record) => Boolean(record.remark)).length,
      values: countBy(normalized.filter((record) => record.remark), 'remark')
    }
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(records) {
  const fields = [
    '_id', 'officialCode', 'name', 'nameNormalized', 'province', 'city',
    'educationLevel', 'authority', 'officialStatus', 'platformStatus',
    'dataSource', 'sourceYear', 'sourceVersion', 'sourceRow', 'remark'
  ];
  return [
    fields.join(','),
    ...records.map((record) => fields.map((field) => csvEscape(record[field])).join(','))
  ].join('\r\n') + '\r\n';
}

function ensureDirectories() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function normalizedChecksum(records) {
  return sha256Text(stableJson(records));
}

function buildBatchId(records, sourceChecksum) {
  const outputChecksum = normalizedChecksum(records);
  return `school-import-${SOURCE_YEAR}-${sourceChecksum.slice(0, 12)}-${outputChecksum.slice(0, 12)}`;
}

function comparableOfficialFields(record) {
  const fields = [
    '_id', 'officialCode', 'name', 'nameNormalized', 'province', 'city',
    'educationLevel', 'authority', 'officialStatus', 'dataSource',
    'sourceYear', 'sourceVersion', 'sourceRow', 'remark'
  ];
  return Object.fromEntries(fields.map((field) => [field, record[field] === undefined ? null : record[field]]));
}

function diffSchools(desiredRecords, existingRecords) {
  const existingById = new Map(existingRecords.map((record) => [record._id, record]));
  const existingByCode = new Map(existingRecords.map((record) => [record.officialCode, record]));
  const result = {
    additions: [],
    updates: [],
    identical: [],
    conflicts: [],
    invalid: []
  };
  desiredRecords.forEach((desired) => {
    const byId = existingById.get(desired._id);
    const byCode = existingByCode.get(desired.officialCode);
    if (byId && byId.officialCode !== desired.officialCode) {
      result.conflicts.push({ type: 'ID_CODE_CONFLICT', desired, existing: byId });
      return;
    }
    if (byCode && byCode._id !== desired._id) {
      result.conflicts.push({ type: 'CODE_ID_CONFLICT', desired, existing: byCode });
      return;
    }
    const existing = byId || byCode;
    if (!existing) {
      result.additions.push(desired);
      return;
    }
    const before = comparableOfficialFields(existing);
    const after = comparableOfficialFields(desired);
    const changedFields = Object.keys(after).filter((field) => (
      JSON.stringify(before[field]) !== JSON.stringify(after[field])
    ));
    if (changedFields.length === 0) {
      result.identical.push(desired._id);
    } else {
      result.updates.push({
        id: desired._id,
        officialCode: desired.officialCode,
        changedFields,
        desired
      });
    }
  });
  return result;
}

module.exports = {
  ROOT,
  SOURCE_PATH,
  GENERATED_DIR,
  REPORT_DIR,
  NORMALIZED_JSON_PATH,
  NORMALIZED_CSV_PATH,
  SOURCE_YEAR,
  SOURCE_VERSION,
  SOURCE_PAGE,
  SOURCE_DOWNLOAD,
  EXPECTED_HEADERS,
  VALID_LEVELS,
  normalizeText,
  normalizeName,
  normalizeNameForSearch,
  normalizeOfficialCode,
  normalizeProvince,
  normalizeEducationLevel,
  buildSchoolId,
  hashFile,
  inspectWorkbook,
  parseSource,
  normalizeRecord,
  normalizeSource,
  sortSchools,
  validateSchools,
  buildProfile,
  countBy,
  stableJson,
  toCsv,
  ensureDirectories,
  normalizedChecksum,
  buildBatchId,
  comparableOfficialFields,
  diffSchools
};
