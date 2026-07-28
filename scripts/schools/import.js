const fs = require('fs');
const path = require('path');
const {
  NORMALIZED_JSON_PATH,
  REPORT_DIR,
  SOURCE_PATH,
  SOURCE_YEAR,
  hashFile,
  stableJson,
  validateSchools,
  buildBatchId,
  diffSchools,
  countBy,
  ensureDirectories
} = require('./core');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  readAllSchools,
  applyChanges
} = require('./cloud-cli');

function parseArguments(argv) {
  const options = {
    apply: false,
    confirm: '',
    localOnly: false,
    maxWrites: 5000,
    batchSize: 20
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--dry-run') {
      options.apply = false;
    } else if (argument === '--confirm') {
      options.confirm = argv[++index] || '';
    } else if (argument === '--local-only') {
      options.localOnly = true;
    } else if (argument === '--max-writes') {
      options.maxWrites = Number(argv[++index]);
    } else if (argument === '--batch-size') {
      options.batchSize = Number(argv[++index]);
    } else {
      const error = new Error(`unknown argument: ${argument}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

function buildImportReport(records, existing, sourceChecksum, target) {
  const validation = validateSchools(records);
  if (!validation.valid) {
    const error = new Error('normalized data failed P0 validation');
    error.code = 'VALIDATION_FAILED';
    throw error;
  }
  const diff = diffSchools(records, existing);
  return {
    mode: 'dry-run',
    target,
    sourceYear: SOURCE_YEAR,
    sourceSha256: sourceChecksum,
    batchId: buildBatchId(records, sourceChecksum),
    normalizedRecordCount: records.length,
    existingRecordCount: existing.length,
    additions: diff.additions.length,
    updates: diff.updates.length,
    identical: diff.identical.length,
    conflicts: diff.conflicts.length,
    invalid: diff.invalid.length,
    statusPlan: countBy(records, 'platformStatus'),
    activeSchools: records.filter((record) => record.platformStatus === 'active').map((record) => record.name),
    diff
  };
}

function main() {
  ensureDirectories();
  const options = parseArguments(process.argv.slice(2));
  const records = JSON.parse(fs.readFileSync(NORMALIZED_JSON_PATH, 'utf8'));
  const sourceChecksum = hashFile(SOURCE_PATH);
  const batchId = buildBatchId(records, sourceChecksum);
  if (options.apply && options.confirm !== batchId) {
    const error = new Error(`use --confirm ${batchId}`);
    error.code = 'IMPORT_CONFIRMATION_REQUIRED';
    throw error;
  }
  if (options.apply && options.localOnly) {
    const error = new Error('cannot combine --apply with --local-only');
    error.code = 'TARGET_ENV_UNCONFIRMED';
    throw error;
  }
  let environmentId = '';
  let existing = [];
  let target = 'local-empty-baseline';
  if (!options.localOnly) {
    environmentId = loadEnvironmentId();
    target = `cloud:${maskEnvironmentId(environmentId)}`;
    existing = readAllSchools(environmentId);
  }
  const report = buildImportReport(records, existing, sourceChecksum, target);
  const dryRunPath = path.join(REPORT_DIR, 'cloud-dry-run-report.json');
  fs.writeFileSync(dryRunPath, stableJson({
    ...report,
    diff: {
      additions: report.diff.additions.map((record) => record._id),
      updates: report.diff.updates.map((item) => ({
        id: item.id,
        changedFields: item.changedFields
      })),
      identical: report.diff.identical,
      conflicts: report.diff.conflicts
    }
  }), 'utf8');
  process.stdout.write(`${JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    target,
    batchId,
    sourceYear: SOURCE_YEAR,
    sourceSha256Prefix: sourceChecksum.slice(0, 12),
    additions: report.additions,
    updates: report.updates,
    identical: report.identical,
    conflicts: report.conflicts,
    invalid: report.invalid,
    defaultStatus: 'pending',
    active: report.statusPlan.active || 0
  }, null, 2)}\n`);
  if (report.conflicts > 0 || report.invalid > 0) {
    const error = new Error('dry-run contains conflicts or invalid records');
    error.code = 'IMPORT_CONFLICT';
    throw error;
  }
  if (!options.apply) {
    return;
  }
  const result = applyChanges(environmentId, report.diff.additions, report.diff.updates, options);
  const importReport = {
    mode: 'apply',
    target,
    batchId,
    sourceYear: SOURCE_YEAR,
    sourceSha256: sourceChecksum,
    planned: {
      additions: report.additions,
      updates: report.updates,
      identical: report.identical
    },
    result
  };
  fs.writeFileSync(
    path.join(REPORT_DIR, 'import-report.json'),
    stableJson(importReport),
    'utf8'
  );
  if (result.failed > 0) {
    const error = new Error(`${result.failed} write(s) failed`);
    error.code = 'IMPORT_PARTIAL_FAILURE';
    throw error;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code || 'IMPORT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArguments,
  buildImportReport
};
