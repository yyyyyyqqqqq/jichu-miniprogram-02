const path = require('path');
const core = require('./phase-18-data-migration-core');

function exactIdsEqual(left, right) {
  return left.length === right.length
    && [...left].sort().every((id, index) => id === [...right].sort()[index]);
}

function verifyAlreadyApplied(context, section) {
  if (!section || !Array.isArray(section.candidates) || section.candidates.length !== core.EXPECTED_MISSING_USERS) return null;
  const records = core.queryExact(
    context.environmentId,
    'users',
    section.candidates.map((item) => item.userId),
    core.USER_PROJECTION
  );
  if (records.length !== core.EXPECTED_MISSING_USERS) return null;
  const beforeById = new Map(section.candidates.map((item) => [item.userId, item.before]));
  const allApplied = records.every((user) => {
    const before = beforeById.get(user._id);
    return before
      && user.schoolId === context.targetSchool._id
      && user.schoolName === context.targetSchool.name
      && Number(user.schoolVersion) === 1
      && core.userProtectedFingerprint(user) === before.protectedFingerprint;
  });
  return allApplied ? records : null;
}

function run(options) {
  const context = core.prepareContext(options);
  const existing = core.loadPrivateResult(options.output);
  const appliedRecords = verifyAlreadyApplied(context, existing && existing.users);
  if (appliedRecords) {
    core.updatePrivateResult(options.output, {
      readinessAfter: core.readinessSummary(context.report),
      users: Object.assign({}, existing.users, {
        idempotentRerunAt: new Date().toISOString(),
        idempotentChangedCount: 0
      })
    });
    return {
      mode: 'already-applied',
      target: `cloud:${context.targetMasked}`,
      targetSchool: core.publicTargetSchool(context.targetSchool),
      expectedMissingUsers: core.EXPECTED_MISSING_USERS,
      actualMissingUsers: context.report.users.schoolStateCounts.missing || 0,
      changed: 0,
      skipped: appliedRecords.length,
      failed: 0,
      writesExecuted: false
    };
  }

  const plan = core.buildUserPlan(context);
  const publicPlan = plan.map((item) => ({
    userId: core.maskId(item.userId),
    currentSchoolId: item.before.schoolId ? core.maskId(item.before.schoolId) : '',
    currentSchoolName: item.before.schoolName,
    currentSchoolVersion: item.before.schoolVersion,
    targetSchool: context.targetSchool.name,
    reason: 'owner-authorized-missing-school-backfill'
  }));

  if (!options.apply) {
    core.updatePrivateResult(options.output, {
      target: `cloud:${context.targetMasked}`,
      targetSchool: core.privateTargetSchool(context.targetSchool),
      readinessBefore: existing && existing.readinessBefore
        ? existing.readinessBefore
        : core.readinessSummary(context.report),
      users: {
        dryRunAt: new Date().toISOString(),
        expectedCount: core.EXPECTED_MISSING_USERS,
        actualCount: plan.length,
        candidates: plan,
        applyAt: null,
        changedCount: 0,
        skippedCount: 0,
        failedCount: 0
      }
    });
    return {
      mode: 'dry-run',
      target: `cloud:${context.targetMasked}`,
      targetSchool: core.publicTargetSchool(context.targetSchool),
      expectedMissingUsers: core.EXPECTED_MISSING_USERS,
      actualMissingUsers: plan.length,
      writesPlanned: plan.length,
      writesExecuted: false,
      users: publicPlan,
      privateOutput: path.relative(core.ROOT, options.output).replace(/\\/g, '/')
    };
  }

  core.assert(existing && existing.users, 'run user migration dry-run before apply');
  core.assert(
    exactIdsEqual(plan.map((item) => item.userId), existing.users.candidates.map((item) => item.userId)),
    'user migration plan changed after dry-run'
  );
  const storedBefore = new Map(existing.users.candidates.map((item) => [item.userId, item.before]));
  plan.forEach((item) => {
    core.assert(
      item.before.protectedFingerprint === storedBefore.get(item.userId).protectedFingerprint,
      'user protected fields changed after dry-run'
    );
  });
  const current = core.queryExact(context.environmentId, 'users', plan.map((item) => item.userId), core.USER_PROJECTION);
  const currentById = new Map(current.map((item) => [item._id, item]));
  const updates = plan.map((item) => {
    const user = currentById.get(item.userId);
    core.assert(user && user.status === 'active' && !String(user.schoolId || '').trim(), 'user no longer satisfies apply condition');
    return {
      q: {
        _id: user._id,
        status: 'active',
        schoolId: core.missingFieldCondition(user, 'schoolId'),
        schoolName: core.missingFieldCondition(user, 'schoolName')
      },
      u: {
        $set: {
          schoolId: context.targetSchool._id,
          schoolName: context.targetSchool.name,
          schoolVersion: 1
        },
        $currentDate: {
          schoolUpdatedAt: true,
          updatedAt: true
        }
      },
      multi: false,
      upsert: false
    };
  });
  core.applyUpdates(context.environmentId, 'users', updates);
  const after = core.queryExact(context.environmentId, 'users', plan.map((item) => item.userId), core.USER_PROJECTION);
  const beforeById = new Map(plan.map((item) => [item.userId, item.before]));
  after.forEach((user) => {
    const before = beforeById.get(user._id);
    core.assert(user.schoolId === context.targetSchool._id && user.schoolName === context.targetSchool.name, 'user school readback failed');
    core.assert(Number(user.schoolVersion) === 1, 'migrated user schoolVersion is not one');
    core.assert(core.userProtectedFingerprint(user) === before.protectedFingerprint, 'user protected fields changed');
  });
  core.updatePrivateResult(options.output, {
    users: Object.assign({}, existing.users, {
      applyAt: new Date().toISOString(),
      changedCount: after.length,
      skippedCount: 0,
      failedCount: 0,
      after: after.map((user) => ({
        userId: user._id,
        schoolId: user.schoolId,
        schoolName: user.schoolName,
        schoolVersion: user.schoolVersion,
        schoolSelectedAt: user.schoolSelectedAt || null,
        protectedFingerprint: core.userProtectedFingerprint(user)
      }))
    })
  });
  return {
    mode: 'applied',
    target: `cloud:${context.targetMasked}`,
    targetSchool: core.publicTargetSchool(context.targetSchool),
    expectedMissingUsers: core.EXPECTED_MISSING_USERS,
    actualMissingUsers: plan.length,
    changed: after.length,
    skipped: 0,
    failed: 0,
    users: after.map((user) => core.maskId(user._id)),
    privateOutput: path.relative(core.ROOT, options.output).replace(/\\/g, '/')
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(core.parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE18_USER_SCHOOL_MIGRATION_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run, verifyAlreadyApplied, exactIdsEqual };
