const fs = require('fs');
const path = require('path');
const {
  NORMALIZED_JSON_PATH,
  REPORT_DIR,
  SOURCE_PATH,
  SOURCE_YEAR,
  hashFile,
  stableJson,
  buildBatchId,
  diffSchools,
  countBy,
  ensureDirectories
} = require('./core');

function parseArguments(argv) {
  const options = { current: '', output: path.join(REPORT_DIR, 'dry-run-report.json') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--current') {
      options.current = argv[++index] || '';
    } else if (argv[index] === '--output') {
      options.output = argv[++index] || options.output;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function buildReport(desired, existing, sourceChecksum, target) {
  const diff = diffSchools(desired, existing);
  return {
    mode: 'dry-run',
    target,
    sourceYear: SOURCE_YEAR,
    sourceSha256: sourceChecksum,
    batchId: buildBatchId(desired, sourceChecksum),
    sourceRecords: desired.length,
    includedRecords: desired.length,
    excludedRecords: 0,
    additions: diff.additions.length,
    updates: diff.updates.length,
    identical: diff.identical.length,
    conflicts: diff.conflicts.length,
    invalid: diff.invalid.length,
    duplicates: 0,
    statusPlan: countBy(desired, 'platformStatus'),
    operations: {
      additions: diff.additions.map((record) => record._id),
      updates: diff.updates.map((record) => ({
        id: record.id,
        changedFields: record.changedFields
      })),
      conflicts: diff.conflicts
    }
  };
}

function toMarkdown(report) {
  return `# 学校导入 dry-run

- 模式：${report.mode}
- 目标：${report.target}
- 批次 ID：\`${report.batchId}\`
- 来源年份：${report.sourceYear}
- 来源 SHA-256：\`${report.sourceSha256}\`
- 源记录：${report.sourceRecords}
- 新增：${report.additions}
- 更新：${report.updates}
- 完全相同：${report.identical}
- 冲突：${report.conflicts}
- 无效：${report.invalid}
- pending：${report.statusPlan.pending || 0}
- active：${report.statusPlan.active || 0}

此报告本身不执行任何数据库写入。
`;
}

function main() {
  ensureDirectories();
  const options = parseArguments(process.argv.slice(2));
  const desired = JSON.parse(fs.readFileSync(NORMALIZED_JSON_PATH, 'utf8'));
  const existing = options.current
    ? JSON.parse(fs.readFileSync(path.resolve(options.current), 'utf8'))
    : [];
  if (!Array.isArray(existing)) {
    throw new Error('current snapshot must be a JSON array');
  }
  const report = buildReport(
    desired,
    existing,
    hashFile(SOURCE_PATH),
    options.current ? `snapshot:${path.basename(options.current)}` : 'local-empty-baseline'
  );
  fs.writeFileSync(options.output, stableJson(report), 'utf8');
  const markdownPath = options.output.replace(/\.json$/i, '.md');
  fs.writeFileSync(markdownPath, toMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.conflicts > 0 || report.invalid > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`DRY_RUN_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildReport
};
