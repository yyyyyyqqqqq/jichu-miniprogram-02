const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  NORMALIZED_JSON_PATH,
  REPORT_DIR,
  buildSchoolId,
  ensureDirectories,
  stableJson
} = require('./core');
const {
  loadEnvironmentId,
  maskEnvironmentId,
  readAllSchools,
  applyPlatformStatusOperation
} = require('./cloud-cli');

const TOOL_VERSION = 'school-platform-status-v1';
const MAX_BATCH_SIZE = 2;
const ALLOWED_STATUSES = new Set(['pending', 'active', 'inactive', 'merged']);
const PROTECTED_FIELDS = [
  '_id',
  'officialCode',
  'name',
  'nameNormalized',
  'province',
  'city',
  'educationLevel',
  'authority',
  'remark',
  'officialStatus',
  'dataSource',
  'sourceYear',
  'sourceVersion',
  'sourceRow',
  'createdAt',
  'lastSeenAt'
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArguments(argv) {
  const options = {
    apply: false,
    confirm: '',
    schoolIds: [],
    status: '',
    reason: '',
    report: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--dry-run') {
      options.apply = false;
    } else if (argument === '--confirm') {
      options.confirm = argv[++index] || '';
    } else if (argument === '--school-id') {
      options.schoolIds.push(argv[++index] || '');
    } else if (argument === '--status') {
      options.status = argv[++index] || '';
    } else if (argument === '--reason') {
      options.reason = argv[++index] || '';
    } else if (argument === '--report') {
      options.report = argv[++index] || '';
    } else {
      fail('INVALID_ARGUMENT', `unknown argument: ${argument}`);
    }
  }
  options.schoolIds = [...new Set(options.schoolIds.map((value) => String(value).trim()))];
  options.status = String(options.status).trim().toLowerCase();
  options.reason = String(options.reason).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (options.schoolIds.length < 1 || options.schoolIds.length > MAX_BATCH_SIZE) {
    fail('STATUS_BATCH_LIMIT', `one or two --school-id values are required`);
  }
  if (options.schoolIds.some((value) => !/^s_[0-9a-f]{32}$/.test(value))) {
    fail('INVALID_SCHOOL_ID', 'school IDs must use the deterministic s_ format');
  }
  if (!ALLOWED_STATUSES.has(options.status)) {
    fail('INVALID_PLATFORM_STATUS', `status must be one of ${[...ALLOWED_STATUSES].join(', ')}`);
  }
  if (options.reason.length < 8 || options.reason.length > 160) {
    fail('INVALID_REASON', 'reason must contain 8 to 160 characters');
  }
  if (
    options.report
    && (!/^[a-z0-9][a-z0-9._-]*\.json$/i.test(options.report)
      || options.report.includes('..'))
  ) {
    fail('INVALID_REPORT_NAME', 'report must be a JSON filename without directories');
  }
  return options;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildOperationId(schoolIds, status, reason) {
  const payload = [
    TOOL_VERSION,
    status,
    reason,
    ...[...schoolIds].sort()
  ].join('\n');
  return `school-status-${sha256(payload).slice(0, 24)}`;
}

function protectedSnapshot(record) {
  return Object.fromEntries(
    PROTECTED_FIELDS.map((field) => [
      field,
      record && record[field] === undefined ? null : record && record[field]
    ])
  );
}

function protectedSnapshotHash(record) {
  return sha256(JSON.stringify(protectedSnapshot(record)));
}

function maskSchoolId(schoolId) {
  return `${schoolId.slice(0, 8)}...${schoolId.slice(-4)}`;
}

function buildPlan({ schoolIds, status, reason, normalizedRecords, cloudRecords, target }) {
  const operationId = buildOperationId(schoolIds, status, reason);
  const targets = [];
  const conflicts = [];
  if (normalizedRecords.some((record) => Object.prototype.hasOwnProperty.call(record, 'note'))) {
    conflicts.push({ code: 'LOCAL_LEGACY_NOTE_FIELD_PRESENT' });
  }
  if (cloudRecords.some((record) => Object.prototype.hasOwnProperty.call(record, 'note'))) {
    conflicts.push({ code: 'CLOUD_LEGACY_NOTE_FIELD_PRESENT' });
  }
  for (const schoolId of [...schoolIds].sort()) {
    const normalizedMatches = normalizedRecords.filter((record) => record._id === schoolId);
    const cloudMatches = cloudRecords.filter((record) => record._id === schoolId);
    if (normalizedMatches.length !== 1) {
      conflicts.push({
        schoolId: maskSchoolId(schoolId),
        code: normalizedMatches.length ? 'LOCAL_ID_NOT_UNIQUE' : 'LOCAL_SCHOOL_NOT_FOUND'
      });
      continue;
    }
    if (cloudMatches.length !== 1) {
      conflicts.push({
        schoolId: maskSchoolId(schoolId),
        code: cloudMatches.length ? 'CLOUD_ID_NOT_UNIQUE' : 'CLOUD_SCHOOL_NOT_FOUND'
      });
      continue;
    }
    const normalized = normalizedMatches[0];
    const current = cloudMatches[0];
    const targetConflicts = [];
    if (buildSchoolId(normalized.officialCode) !== schoolId) {
      targetConflicts.push('DETERMINISTIC_ID_MISMATCH');
    }
    if (current.officialCode !== normalized.officialCode) {
      targetConflicts.push('OFFICIAL_CODE_MISMATCH');
    }
    if (cloudRecords.filter((record) => record.officialCode === current.officialCode).length !== 1) {
      targetConflicts.push('CLOUD_OFFICIAL_CODE_NOT_UNIQUE');
    }
    const officialFields = [
      'name', 'nameNormalized', 'province', 'city', 'educationLevel', 'authority',
      'remark', 'officialStatus', 'dataSource', 'sourceYear', 'sourceVersion', 'sourceRow'
    ];
    if (officialFields.some((field) => (
      (current[field] === undefined ? null : current[field])
      !== (normalized[field] === undefined ? null : normalized[field])
    ))) {
      targetConflicts.push('OFFICIAL_FIELDS_OUT_OF_SYNC');
    }
    if (!ALLOWED_STATUSES.has(current.platformStatus)) {
      targetConflicts.push('CURRENT_PLATFORM_STATUS_INVALID');
    }
    if (status === 'active' && current.officialStatus !== 'valid') {
      targetConflicts.push('OFFICIAL_STATUS_NOT_VALID');
    }
    let action = 'update';
    if (current.platformStatus === status) {
      if (current.platformStatusOperationId === operationId) {
        action = 'skip';
      } else {
        targetConflicts.push('ALREADY_TARGET_STATUS_DIFFERENT_OPERATION');
      }
    } else if (status === 'active' && current.platformStatus !== 'pending') {
      targetConflicts.push('ACTIVATION_REQUIRES_PENDING');
    }
    const targetRecord = {
      schoolId,
      schoolIdMasked: maskSchoolId(schoolId),
      officialCode: current.officialCode,
      name: current.name,
      province: current.province,
      city: current.city,
      educationLevel: current.educationLevel,
      officialStatus: current.officialStatus,
      fromStatus: current.platformStatus,
      toStatus: status,
      action,
      eligible: targetConflicts.length === 0,
      conflicts: targetConflicts,
      protectedBeforeHash: protectedSnapshotHash(current),
      createdAtBefore: current.createdAt || null,
      current
    };
    targets.push(targetRecord);
    targetConflicts.forEach((code) => conflicts.push({
      schoolId: maskSchoolId(schoolId),
      code
    }));
  }
  return {
    mode: 'dry-run',
    target,
    operationId,
    toolVersion: TOOL_VERSION,
    status,
    reason,
    targetCount: schoolIds.length,
    maxBatchSize: MAX_BATCH_SIZE,
    targets,
    conflicts,
    risks: status === 'active'
      ? ['Only officialStatus=valid, platformStatus=pending records may be activated']
      : ['Applying this plan requires a new explicit confirmation']
  };
}

function publicReport(plan) {
  return {
    mode: plan.mode,
    target: plan.target,
    operationId: plan.operationId,
    toolVersion: plan.toolVersion,
    status: plan.status,
    reason: plan.reason,
    targetCount: plan.targetCount,
    maxBatchSize: plan.maxBatchSize,
    targets: plan.targets.map((item) => ({
      schoolId: item.schoolIdMasked,
      officialCode: item.officialCode,
      name: item.name,
      province: item.province,
      city: item.city,
      educationLevel: item.educationLevel,
      officialStatus: item.officialStatus,
      fromStatus: item.fromStatus,
      toStatus: item.toStatus,
      action: item.action,
      eligible: item.eligible,
      conflicts: item.conflicts,
      plannedFields: [
        'platformStatus',
        'platformStatusPrevious',
        'platformStatusReason',
        'platformStatusOperationId',
        'platformStatusToolVersion',
        'updatedAt',
        'platformStatusUpdatedAt',
        ...(plan.status === 'active' ? ['activatedAt'] : [])
      ]
    })),
    conflicts: plan.conflicts,
    risks: plan.risks,
    result: plan.result || null,
    statusCounts: plan.statusCounts || null
  };
}

function writeReport(filename, report) {
  if (!filename) {
    return;
  }
  ensureDirectories();
  fs.writeFileSync(path.join(REPORT_DIR, filename), stableJson(report), 'utf8');
}

function verifyAppliedPlan(plan, recordsAfter) {
  const failures = [];
  let updated = 0;
  let skipped = 0;
  for (const target of plan.targets) {
    const current = recordsAfter.find((record) => record._id === target.schoolId);
    if (!current) {
      failures.push({ schoolId: target.schoolIdMasked, code: 'POST_APPLY_NOT_FOUND' });
      continue;
    }
    if (current.platformStatus !== plan.status) {
      failures.push({ schoolId: target.schoolIdMasked, code: 'POST_APPLY_STATUS_MISMATCH' });
    }
    if (current.platformStatusOperationId !== plan.operationId) {
      failures.push({ schoolId: target.schoolIdMasked, code: 'POST_APPLY_OPERATION_MISMATCH' });
    }
    if (protectedSnapshotHash(current) !== target.protectedBeforeHash) {
      failures.push({ schoolId: target.schoolIdMasked, code: 'PROTECTED_FIELDS_CHANGED' });
    }
    if (
      !current.updatedAt
      || !current.platformStatusUpdatedAt
      || (plan.status === 'active' && !current.activatedAt)
    ) {
      failures.push({ schoolId: target.schoolIdMasked, code: 'SERVER_AUDIT_TIME_MISSING' });
    }
    if (target.action === 'skip') {
      skipped += 1;
    } else {
      updated += 1;
    }
  }
  const operationRecordCount = recordsAfter.filter(
    (record) => record.platformStatusOperationId === plan.operationId
  ).length;
  if (operationRecordCount !== plan.targetCount) {
    failures.push({ code: 'OPERATION_SCOPE_MISMATCH', operationRecordCount });
  }
  return {
    updated,
    skipped,
    conflicts: plan.conflicts.length,
    failed: failures.length,
    failures
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const environmentId = loadEnvironmentId();
  const normalizedRecords = JSON.parse(fs.readFileSync(NORMALIZED_JSON_PATH, 'utf8'));
  const cloudRecords = readAllSchools(environmentId);
  const plan = buildPlan({
    ...options,
    normalizedRecords,
    cloudRecords,
    target: `cloud:${maskEnvironmentId(environmentId)}`
  });
  let report = publicReport(plan);
  if (!options.apply) {
    writeReport(options.report, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (plan.conflicts.length > 0) {
      fail('STATUS_PLAN_CONFLICT', 'dry-run contains conflicts');
    }
    return;
  }
  if (options.confirm !== plan.operationId) {
    fail('STATUS_CONFIRMATION_REQUIRED', `use --confirm ${plan.operationId}`);
  }
  if (plan.conflicts.length > 0) {
    fail('STATUS_PLAN_CONFLICT', 'apply contains conflicts');
  }
  const changes = plan.targets.filter((target) => target.action === 'update');
  if (changes.length > 0) {
    applyPlatformStatusOperation(environmentId, changes, {
      operationId: plan.operationId,
      toolVersion: plan.toolVersion,
      status: plan.status,
      reason: plan.reason
    });
  }
  const recordsAfter = readAllSchools(environmentId);
  plan.mode = 'apply';
  plan.result = verifyAppliedPlan(plan, recordsAfter);
  plan.statusCounts = recordsAfter.reduce((counts, record) => {
    counts[record.platformStatus] = (counts[record.platformStatus] || 0) + 1;
    return counts;
  }, {});
  report = publicReport(plan);
  writeReport(options.report, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (plan.result.failed > 0 || plan.result.conflicts > 0) {
    fail('STATUS_APPLY_VERIFICATION_FAILED', 'post-apply verification failed');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code || 'STATUS_OPERATION_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  TOOL_VERSION,
  MAX_BATCH_SIZE,
  ALLOWED_STATUSES,
  PROTECTED_FIELDS,
  parseArguments,
  buildOperationId,
  protectedSnapshotHash,
  maskSchoolId,
  buildPlan,
  publicReport,
  verifyAppliedPlan
};
