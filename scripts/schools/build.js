const fs = require('fs');
const path = require('path');
const {
  SOURCE_PATH,
  REPORT_DIR,
  NORMALIZED_JSON_PATH,
  NORMALIZED_CSV_PATH,
  SOURCE_YEAR,
  SOURCE_VERSION,
  inspectWorkbook,
  parseSource,
  normalizeSource,
  validateSchools,
  buildProfile,
  stableJson,
  toCsv,
  ensureDirectories,
  normalizedChecksum,
  buildBatchId
} = require('./core');

function writeJson(name, value) {
  fs.writeFileSync(path.join(REPORT_DIR, name), stableJson(value), 'utf8');
}

function profileMarkdown(inspection, profile) {
  const sheet = inspection.sheets[0];
  const provinceRows = Object.entries(profile.provinceCounts)
    .map(([province, count]) => `| ${province} | ${count} |`)
    .join('\n');
  return `# 教育部全国普通高等学校名单数据画像

- 原始文件：\`${inspection.file.name}\`
- 文件格式：${inspection.file.format}
- 文件大小：${inspection.file.size} 字节
- SHA-256：\`${inspection.file.sha256}\`
- 工作表：${inspection.workbook.sheetCount} 个（${inspection.workbook.sheetNames.join('、')}）
- 隐藏工作表：${inspection.workbook.hiddenSheetCount} 个
- 公式：${inspection.workbook.hasFormulas ? '存在' : '未发现'}
- 合并单元格：${inspection.workbook.hasMerges ? `存在，共 ${sheet.merges.length} 处` : '未发现'}
- 批注：${inspection.workbook.hasComments ? '存在' : '未发现'}
- 图片：解析器单元格模型未检测到图片；原文件未被修改

## 表结构

- 使用范围：\`${sheet.ref}\`
- 最大行列：${sheet.rowCount} 行 × ${sheet.columnCount} 列
- 表头：第 ${sheet.headerRow} 行
- 学校数据：第 ${sheet.dataStartRow}—${sheet.dataEndRow} 行
- 完全空行：${sheet.emptyRows}
- 部分空行：${sheet.partialRows}
- 尾部说明行：${sheet.trailingRows}

## 业务统计

- 普通高校：${profile.schoolTypes.ordinaryHigherEducation}
- 成人高校：${profile.schoolTypes.adultHigherEducation}（本文件是附件1，成人高校在独立附件2）
- 本科：${profile.educationLevels['本科'] || 0}
- 专科：${profile.educationLevels['专科'] || 0}
- 纳入：${profile.includedRecords}
- 排除：${profile.excludedRecords}
- 学校名称空值：${profile.missing.name}
- 学校标识码空值：${profile.missing.officialCode}
- 重复标识码：${profile.duplicates.officialCode}
- 重复规范化名称：${profile.duplicates.name}
- 异常省份分组：${profile.anomalies.provinceSectionMismatches.length}
- 非空备注：${profile.remarks.nonEmptyCount}

## 省级分布

| 省级地区 | 学校数 |
| --- | ---: |
${provinceRows}
`;
}

function validationMarkdown(validation, records) {
  return `# 学校标准化数据校验报告

- 数据年份：${SOURCE_YEAR}
- 来源版本：${SOURCE_VERSION}
- 有效记录：${records.length}
- P0：${validation.p0.length}
- P1：${validation.p1.length}
- 结果：${validation.valid ? '通过' : '失败'}
- 重复内部 ID：${validation.statistics.duplicateIds}
- 重复官方标识码：${validation.statistics.duplicateOfficialCodes}
- 重复规范化名称：${validation.statistics.duplicateNames}

P0 失败会阻止标准化输出和正式导入。P1 仅用于人工审阅，不静默修正官方字段。
`;
}

function main() {
  ensureDirectories();
  const before = fs.readFileSync(SOURCE_PATH);
  const inspection = inspectWorkbook(SOURCE_PATH);
  const parsed = parseSource(SOURCE_PATH);
  const normalized = normalizeSource(parsed);
  const validation = validateSchools(normalized.records, normalized.errors);
  const profile = buildProfile(parsed, normalized.records, validation);
  const after = fs.readFileSync(SOURCE_PATH);
  if (!before.equals(after)) {
    throw new Error('raw workbook was modified');
  }

  writeJson('source-profile.json', {
    generatedFrom: inspection.file.name,
    sourceSha256: inspection.file.sha256,
    inspection,
    profile,
    provinceSections: parsed.provinceSections
  });
  writeJson('source-anomalies.json', {
    sourceSha256: inspection.file.sha256,
    normalizationErrors: normalized.errors,
    validationP0: validation.p0,
    validationP1: validation.p1,
    anomalies: profile.anomalies,
    excludedRecords: parsed.excludedRecords
  });
  fs.writeFileSync(
    path.join(REPORT_DIR, 'source-summary.md'),
    profileMarkdown(inspection, profile),
    'utf8'
  );
  writeJson('validation-report.json', validation);
  fs.writeFileSync(
    path.join(REPORT_DIR, 'validation-report.md'),
    validationMarkdown(validation, normalized.records),
    'utf8'
  );
  if (!validation.valid) {
    const error = new Error(`P0 validation failed with ${validation.p0.length} issue(s)`);
    error.code = 'VALIDATION_FAILED';
    throw error;
  }

  fs.writeFileSync(NORMALIZED_JSON_PATH, stableJson(normalized.records), 'utf8');
  fs.writeFileSync(NORMALIZED_CSV_PATH, toCsv(normalized.records), 'utf8');
  const outputChecksum = normalizedChecksum(normalized.records);
  const manifest = {
    sourceFile: path.basename(SOURCE_PATH),
    sourceSha256: inspection.file.sha256,
    sourceYear: SOURCE_YEAR,
    sourceVersion: SOURCE_VERSION,
    recordCount: normalized.records.length,
    normalizedSha256: outputChecksum,
    batchId: buildBatchId(normalized.records, inspection.file.sha256),
    defaultPlatformStatus: 'pending',
    activeCount: normalized.records.filter((record) => record.platformStatus === 'active').length
  };
  fs.writeFileSync(
    path.join(path.dirname(NORMALIZED_JSON_PATH), 'manifest.json'),
    stableJson(manifest),
    'utf8'
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.code || 'BUILD_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
}
