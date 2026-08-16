const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  maskIdentifier,
  readPrivateEnvironmentConfiguration,
  assert
} = require('./environment-preflight');
const { OWNER_AUTHORIZATION } = require('./migrate-phase-24-pair-conversations');

const FAULTS = Object.freeze([
  'after-archives',
  'during-canonicals',
  'during-messages',
  'during-appointments',
  'before-validation'
]);
const REPORT_PATH = path.join(ROOT, 'tmp', 'phase-114-staging-fault-drills-private.json');

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs || 300000,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (options.expectFailure) {
    assert(result.status !== 0, `${args.join(' ')} unexpectedly succeeded`, 'FAULT_INJECTION_DID_NOT_FAIL');
    return result;
  }
  if (result.status !== 0) {
    const error = new Error([result.stderr, result.stdout].filter(Boolean).join('\n').trim());
    error.code = 'STAGING_DRILL_COMMAND_FAILED';
    throw error;
  }
  return result;
}

function rollbackWithRetry(args) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    last = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    });
    if (last.error) throw last.error;
    if (last.status === 0) return last;
  }
  const error = new Error([last.stderr, last.stdout].filter(Boolean).join('\n').trim());
  error.code = 'STAGING_ROLLBACK_RETRIES_EXHAUSTED';
  throw error;
}

function run() {
  const { active, targets } = readPrivateEnvironmentConfiguration();
  assert(active.environmentName === 'staging' && active.environmentId === targets.staging, 'active target must be staging', 'ACTIVE_ENVIRONMENT_MISMATCH');
  const confirmed = maskIdentifier(targets.staging);
  const results = [];
  for (const fault of FAULTS) {
    const manifestPath = path.join(ROOT, 'tmp', `phase-114-staging-fault-${fault}-private.json`);
    runNode([
      'scripts/migrate-phase-24-pair-conversations.js',
      '--env', 'staging',
      '--output', manifestPath
    ]);
    let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    runNode([
      'scripts/manage-phase-24-pair-maintenance.js',
      '--env', 'staging', '--status', 'on',
      '--migration-run-id', manifest.migrationRunId,
      '--confirm-target', confirmed,
      '--owner-authorization', OWNER_AUTHORIZATION
    ]);
    const applied = runNode([
      'scripts/migrate-phase-24-pair-conversations.js',
      '--env', 'staging', '--apply',
      '--input', manifestPath,
      '--fault', fault,
      '--confirm-target', confirmed,
      '--owner-authorization', OWNER_AUTHORIZATION
    ], { expectFailure: true, timeoutMs: 300000 });
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(manifest.mode === 'apply-interrupted', `${fault} did not persist interrupted mode`, 'FAULT_STATE_MISSING');
    assert(manifest.interruption && manifest.interruption.faultPoint === fault, `${fault} failed at an unexpected point: ${applied.stderr}`, 'FAULT_POINT_MISMATCH');
    assert(['partial', 'after'].includes(manifest.observedState.classification), `${fault} produced an unknown state`, 'FAULT_STATE_UNKNOWN');
    const rollbackArgs = [
      'scripts/migrate-phase-24-pair-conversations.js',
      '--env', 'staging', '--rollback',
      '--input', manifestPath,
      '--confirm-target', confirmed,
      '--owner-authorization', OWNER_AUTHORIZATION
    ];
    rollbackWithRetry(rollbackArgs);
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(manifest.mode === 'rollback-complete', `${fault} rollback did not complete`, 'FAULT_ROLLBACK_INCOMPLETE');
    assert(manifest.rollback.verification.fullHashMatches, `${fault} rollback hash differs`, 'FAULT_ROLLBACK_HASH_MISMATCH');
    results.push({
      fault,
      interruptedState: manifest.rollback.stateBefore.classification,
      interruptedCounts: manifest.rollback.stateBefore.counts,
      rollbackHash: manifest.rollback.verification.rollback.combined,
      rollbackHashMatches: true
    });
  }
  const report = {
    schemaVersion: 1,
    mode: 'phase-114-staging-fault-drills',
    completedAt: new Date().toISOString(),
    results
  };
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, reportPath: path.relative(ROOT, REPORT_PATH) }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE114_FAULT_DRILL_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FAULTS, REPORT_PATH, run };
