'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const { queryCollection } = require('./phase-24-staging-core');
const { runNoSql } = require('./schools/cloud-cli');
const { extractCommandResults } = require('./schools/cloud-cli');
const { ACTOR_PATH } = require('./manage-final-release-step-4b1-favorites-fixtures');
const {
  sha256,
  stableStringify,
  resolvePrivatePath,
  writePrivateJson,
  readJson,
  sanitizeErrorMessage
} = require('./disabled-account-rollout-core');

const DEFAULT_MANIFEST_PATH = path.join(
  ROOT,
  'tmp',
  'disabled-account-staging-actor-manifest.json'
);
const USER_ID_PATTERN = /^u_[0-9a-f]{32}$/;
const ACTIONS = Object.freeze(['prepare', 'disable', 'restore', 'audit']);

function parseArguments(argv) {
  const options = {
    environmentName: '',
    action: '',
    confirmTarget: '',
    confirmActor: '',
    actorPath: ACTOR_PATH,
    manifestPath: DEFAULT_MANIFEST_PATH,
    allowStatusMutation: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--action') options.action = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--confirm-actor') options.confirmActor = String(argv[++index] || '').trim();
    else if (value === '--actor') options.actorPath = resolvePrivatePath(argv[++index], ACTOR_PATH);
    else if (value === '--manifest') options.manifestPath = resolvePrivatePath(argv[++index], DEFAULT_MANIFEST_PATH);
    else if (value === '--allow-staging-status-mutation') options.allowStatusMutation = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'staging', 'this workflow accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
  assert(ACTIONS.includes(options.action), '--action prepare|disable|restore|audit is required', 'INVALID_ACTION');
  if (['disable', 'restore'].includes(options.action)) {
    assert(options.allowStatusMutation, '--allow-staging-status-mutation is required', 'STAGING_MUTATION_CONFIRMATION_REQUIRED');
  }
  return options;
}

function actorConfirmation(userId) {
  return sha256(Buffer.from(String(userId || ''), 'utf8')).slice(0, 16);
}

function environmentFingerprint(environmentId) {
  return sha256(Buffer.from(`staging:${environmentId}`, 'utf8'));
}

function recordDigests(record) {
  const full = { ...record };
  const nonStatus = { ...record };
  delete nonStatus.status;
  return {
    fullSha256: sha256(Buffer.from(stableStringify(full), 'utf8')),
    nonStatusSha256: sha256(Buffer.from(stableStringify(nonStatus), 'utf8'))
  };
}

function statusMutationLeftoverCount(currentStatus, originalStatus) {
  if (currentStatus === originalStatus) return 0;
  if (currentStatus === 'disabled' && originalStatus === 'active') return 1;
  return null;
}

function loadActor(preflight, options) {
  const actorPath = resolvePrivatePath(options.actorPath, ACTOR_PATH);
  assert(fs.existsSync(actorPath), 'private staging actor file is missing', 'STAGING_ACTOR_MISSING');
  const actor = readJson(actorPath, 'STAGING_ACTOR_MISSING');
  assert(actor.environmentRole === 'staging', 'actor is not marked staging', 'STAGING_ACTOR_INVALID');
  assert(USER_ID_PATTERN.test(String(actor.userId || '')), 'actor user ID is invalid', 'STAGING_ACTOR_INVALID');
  assert(actor.environmentFingerprint === environmentFingerprint(preflight.environmentId), 'actor environment fingerprint drifted', 'STAGING_ACTOR_ENVIRONMENT_MISMATCH');
  assert(options.confirmActor === actorConfirmation(actor.userId), `confirm actor with --confirm-actor ${actorConfirmation(actor.userId)}`, 'ACTOR_CONFIRMATION_REQUIRED');
  return actor;
}

function readActorUser(environmentId, actor) {
  const rows = queryCollection(environmentId, 'users', { _id: actor.userId }, 2);
  assert(rows.length === 1, 'staging actor must resolve to exactly one users record', 'STAGING_ACTOR_NOT_FOUND');
  const user = rows[0];
  assert(typeof user.openid === 'string' && user.openid, 'staging actor OPENID is unavailable', 'STAGING_ACTOR_IDENTITY_MISSING');
  assert(sha256(Buffer.from(user.openid, 'utf8')) === actor.openidSha256, 'staging actor OPENID fingerprint drifted', 'STAGING_ACTOR_IDENTITY_MISMATCH');
  assert(user.schoolId === actor.schoolId, 'staging actor school drifted', 'STAGING_ACTOR_SCHOOL_MISMATCH');
  return user;
}

function buildStatusUpdateCommand(user, fromStatus, toStatus) {
  const command = {
    TableName: 'users',
    CommandType: 'UPDATE',
    Command: JSON.stringify({
      update: 'users',
      updates: [{
        q: {
          _id: user._id,
          openid: user.openid,
          status: fromStatus
        },
        u: { $set: { status: toStatus } },
        multi: false,
        upsert: false
      }],
      ordered: true
    })
  };
  assertStatusOnlyCommand(command, user._id, fromStatus, toStatus);
  return command;
}

function assertStatusOnlyCommand(command, userId, fromStatus, toStatus) {
  assert(command && command.TableName === 'users' && command.CommandType === 'UPDATE', 'only users UPDATE is permitted', 'STATUS_COMMAND_REJECTED');
  const body = JSON.parse(command.Command);
  assert(body.update === 'users' && body.ordered === true, 'users update envelope drifted', 'STATUS_COMMAND_REJECTED');
  assert(Array.isArray(body.updates) && body.updates.length === 1, 'exactly one users update is required', 'STATUS_COMMAND_REJECTED');
  const operation = body.updates[0];
  assert(operation.multi === false && operation.upsert === false, 'multi/upsert status mutation is forbidden', 'STATUS_COMMAND_REJECTED');
  assert(stableStringify(Object.keys(operation.q).sort()) === stableStringify(['_id', 'openid', 'status']), 'status mutation selector allowlist failed', 'STATUS_COMMAND_REJECTED');
  assert(operation.q._id === userId && typeof operation.q.openid === 'string' && operation.q.openid, 'status mutation identity selector failed', 'STATUS_COMMAND_REJECTED');
  assert(operation.q.status === fromStatus, 'status mutation compare-and-set source drifted', 'STATUS_COMMAND_REJECTED');
  assert(operation.u && stableStringify(Object.keys(operation.u)) === stableStringify(['$set']), 'status mutation operator allowlist failed', 'STATUS_COMMAND_REJECTED');
  assert(stableStringify(Object.keys(operation.u.$set)) === stableStringify(['status']), 'status must be the only mutated field', 'STATUS_COMMAND_REJECTED');
  assert(operation.u.$set.status === toStatus, 'status mutation target drifted', 'STATUS_COMMAND_REJECTED');
  assert(['active', 'disabled'].includes(fromStatus) && ['active', 'disabled'].includes(toStatus) && fromStatus !== toStatus, 'unsupported status transition', 'STATUS_COMMAND_REJECTED');
  return true;
}

function applyStatus(environmentId, user, fromStatus, toStatus) {
  const response = runNoSql(environmentId, [
    buildStatusUpdateCommand(user, fromStatus, toStatus)
  ]);
  const results = extractCommandResults(response);
  return { responseObserved: Boolean(response), commandResults: results.length };
}

function loadManifest(options, preflight, actor) {
  const manifestPath = resolvePrivatePath(options.manifestPath, DEFAULT_MANIFEST_PATH);
  const manifest = readJson(manifestPath, 'STAGING_STATUS_MANIFEST_MISSING');
  assert(manifest.schemaVersion === 1, 'staging status manifest version drifted', 'STAGING_STATUS_MANIFEST_INVALID');
  assert(manifest.environmentRole === 'staging'
    && manifest.environmentFingerprint === environmentFingerprint(preflight.environmentId),
  'staging status manifest environment mismatch', 'STAGING_STATUS_MANIFEST_INVALID');
  assert(manifest.actorUserId === actor.userId
    && manifest.actorOpenidSha256 === actor.openidSha256,
  'staging status manifest actor mismatch', 'STAGING_STATUS_MANIFEST_INVALID');
  return { manifestPath, manifest };
}

function safeResult(preflight, actor, manifestPath, manifest, extra = {}) {
  return {
    mode: `DISABLED_ACCOUNT_STAGING_ACTOR_${String(manifest.status || '').toUpperCase().replace(/-/g, '_')}`,
    environment: publicSummary(preflight),
    actorFingerprint: actorConfirmation(actor.userId),
    manifest: path.relative(ROOT, manifestPath).replace(/\\/g, '/'),
    manifestStatus: manifest.status,
    originalStatus: manifest.originalStatus,
    currentStatus: extra.currentStatus || '',
    statusOnlyMutation: manifest.statusOnlyMutation === true,
    writesExecuted: Boolean(extra.writesExecuted),
    actorRestored: Boolean(extra.actorRestored),
    ...extra
  };
}

function run(options) {
  const write = ['disable', 'restore'].includes(options.action);
  const preflight = runPreflight({
    environmentName: 'staging',
    action: write ? 'cleanup' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: false,
    allowInactiveRead: false,
    allowInactiveStagingWrite: false
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches, 'active client target must be staging', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId === targets.staging && preflight.environmentId !== targets.production,
    'registered staging target mismatch', 'STAGING_TARGET_MISMATCH');
  assert(options.confirmTarget === preflight.environmentIdMasked,
    `confirm target with --confirm-target ${preflight.environmentIdMasked}`, 'TARGET_CONFIRMATION_REQUIRED');
  const actor = loadActor(preflight, options);
  const manifestPath = resolvePrivatePath(options.manifestPath, DEFAULT_MANIFEST_PATH);

  if (options.action === 'prepare') {
    if (fs.existsSync(manifestPath)) {
      const prior = readJson(manifestPath);
      assert(['restored-and-verified', 'prepared'].includes(prior.status),
        'an unfinished status manifest already exists; restore it first', 'STAGING_STATUS_MANIFEST_UNFINISHED');
    }
    const user = readActorUser(preflight.environmentId, actor);
    assert(user.status === 'active', 'staging actor must start active', 'STAGING_ACTOR_NOT_ACTIVE');
    const digests = recordDigests(user);
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      environmentRole: 'staging',
      environmentMasked: preflight.environmentIdMasked,
      environmentFingerprint: environmentFingerprint(preflight.environmentId),
      actorUserId: actor.userId,
      actorUserIdSha256: sha256(Buffer.from(actor.userId, 'utf8')),
      actorOpenidSha256: actor.openidSha256,
      actorSchoolIdSha256: sha256(Buffer.from(String(actor.schoolId || ''), 'utf8')),
      originalStatus: 'active',
      preFullRecordSha256: digests.fullSha256,
      nonStatusRecordSha256: digests.nonStatusSha256,
      statusOnlyMutation: true,
      status: 'prepared'
    };
    writePrivateJson(manifestPath, manifest);
    return safeResult(preflight, actor, manifestPath, manifest, {
      currentStatus: user.status,
      writesExecuted: false,
      actorRestored: true
    });
  }

  const loaded = loadManifest(options, preflight, actor);
  const manifest = loaded.manifest;
  const user = readActorUser(preflight.environmentId, actor);
  const digests = recordDigests(user);
  assert(digests.nonStatusSha256 === manifest.nonStatusRecordSha256,
    'actor non-status fields changed since PRE', 'STAGING_ACTOR_NON_STATUS_DRIFT');

  if (options.action === 'audit') {
    const restored = user.status === manifest.originalStatus
      && digests.fullSha256 === manifest.preFullRecordSha256;
    return safeResult(preflight, actor, loaded.manifestPath, manifest, {
      currentStatus: user.status,
      writesExecuted: false,
      actorRestored: restored,
      leftoverStatusMutationCount: statusMutationLeftoverCount(
        user.status,
        manifest.originalStatus
      ),
      passed: ['prepared', 'restored-and-verified'].includes(manifest.status)
        ? restored
        : user.status === 'disabled'
    });
  }

  if (options.action === 'disable') {
    assert(manifest.status === 'prepared', 'manifest is not ready for disable', 'STAGING_STATUS_STATE_INVALID');
    assert(user.status === manifest.originalStatus && digests.fullSha256 === manifest.preFullRecordSha256,
      'actor no longer matches PRE before disable', 'STAGING_ACTOR_PRE_DRIFT');
    manifest.status = 'disable-started';
    manifest.disableStartedAt = new Date().toISOString();
    writePrivateJson(loaded.manifestPath, manifest);
    applyStatus(preflight.environmentId, user, manifest.originalStatus, 'disabled');
    const after = readActorUser(preflight.environmentId, actor);
    const afterDigests = recordDigests(after);
    assert(after.status === 'disabled', 'staging actor disable did not take effect', 'STAGING_ACTOR_DISABLE_FAILED');
    assert(afterDigests.nonStatusSha256 === manifest.nonStatusRecordSha256,
      'disable changed non-status fields', 'STAGING_ACTOR_NON_STATUS_DRIFT');
    manifest.status = 'disabled-and-verified';
    manifest.disabledAt = new Date().toISOString();
    manifest.disabledFullRecordSha256 = afterDigests.fullSha256;
    writePrivateJson(loaded.manifestPath, manifest);
    return safeResult(preflight, actor, loaded.manifestPath, manifest, {
      currentStatus: after.status,
      writesExecuted: true,
      actorRestored: false
    });
  }

  assert(['disable-started', 'disabled-and-verified', 'restore-started', 'restored-and-verified'].includes(manifest.status),
    'manifest is not restorable', 'STAGING_STATUS_STATE_INVALID');
  if (user.status === manifest.originalStatus) {
    assert(digests.fullSha256 === manifest.preFullRecordSha256,
      'active actor does not match PRE', 'STAGING_ACTOR_RESTORE_DRIFT');
    manifest.status = 'restored-and-verified';
    manifest.restoredAt = manifest.restoredAt || new Date().toISOString();
    manifest.leftoverStatusMutationCount = 0;
    writePrivateJson(loaded.manifestPath, manifest);
    return safeResult(preflight, actor, loaded.manifestPath, manifest, {
      currentStatus: user.status,
      writesExecuted: false,
      actorRestored: true,
      leftoverStatusMutationCount: 0
    });
  }
  assert(user.status === 'disabled', 'actor has an unexpected status during restore', 'STAGING_ACTOR_RESTORE_BLOCKED');
  manifest.status = 'restore-started';
  manifest.restoreStartedAt = new Date().toISOString();
  writePrivateJson(loaded.manifestPath, manifest);
  applyStatus(preflight.environmentId, user, 'disabled', manifest.originalStatus);
  const restored = readActorUser(preflight.environmentId, actor);
  const restoredDigests = recordDigests(restored);
  assert(restored.status === manifest.originalStatus, 'staging actor restore did not take effect', 'STAGING_ACTOR_RESTORE_FAILED');
  assert(restoredDigests.fullSha256 === manifest.preFullRecordSha256,
    'restored actor differs from PRE', 'STAGING_ACTOR_RESTORE_DRIFT');
  manifest.status = 'restored-and-verified';
  manifest.restoredAt = new Date().toISOString();
  manifest.restoredFullRecordSha256 = restoredDigests.fullSha256;
  manifest.leftoverStatusMutationCount = 0;
  writePrivateJson(loaded.manifestPath, manifest);
  return safeResult(preflight, actor, loaded.manifestPath, manifest, {
    currentStatus: restored.status,
    writesExecuted: true,
    actorRestored: true,
    leftoverStatusMutationCount: 0
  });
}

if (require.main === module) {
  try {
    const result = run(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'STAGING_ACTOR_STATUS_FAILED'}: ${sanitizeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_MANIFEST_PATH,
  ACTIONS,
  USER_ID_PATTERN,
  parseArguments,
  actorConfirmation,
  environmentFingerprint,
  recordDigests,
  statusMutationLeftoverCount,
  buildStatusUpdateCommand,
  assertStatusOnlyCommand,
  run
};
