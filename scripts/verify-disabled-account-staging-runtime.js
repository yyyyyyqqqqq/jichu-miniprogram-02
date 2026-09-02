'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const { queryAll } = require('./final-release-product-cleanup-dry-run');
const { hashRecords } = require('./final-release-step-3b-core');
const { ACTOR_PATH } = require('./manage-final-release-step-4b1-favorites-fixtures');
const {
  DEFAULT_MANIFEST_PATH: DEFAULT_ACTOR_MANIFEST,
  actorConfirmation,
  run: manageActor
} = require('./manage-disabled-account-staging-actor');
const {
  DEFAULT_STAGING_MANIFEST,
  DEPLOY_ORDER
} = require('./deploy-disabled-account-hotfix');
const {
  HOTFIX_CASES,
  EXISTING_ACTIVE_REQUIRED_CASES
} = require('./verify-disabled-account-revocation');
const {
  PRODUCTION_COLLECTION_NAMES,
  resolvePrivatePath,
  writePrivateJson,
  readJson,
  sameObject,
  sanitizeErrorMessage
} = require('./disabled-account-rollout-core');

const DEFAULT_OUTPUT = path.join(
  ROOT,
  'tmp',
  'disabled-account-staging-runtime.json'
);

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    confirmActor: '',
    allowStatusMutation: false,
    actorPath: ACTOR_PATH,
    actorManifestPath: DEFAULT_ACTOR_MANIFEST,
    deploymentManifestPath: DEFAULT_STAGING_MANIFEST,
    outputPath: DEFAULT_OUTPUT
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--confirm-actor') options.confirmActor = String(argv[++index] || '').trim();
    else if (value === '--allow-staging-status-mutation') options.allowStatusMutation = true;
    else if (value === '--actor') options.actorPath = resolvePrivatePath(argv[++index], ACTOR_PATH);
    else if (value === '--actor-manifest') {
      options.actorManifestPath = resolvePrivatePath(argv[++index], DEFAULT_ACTOR_MANIFEST);
    } else if (value === '--deployment-manifest') {
      options.deploymentManifestPath = resolvePrivatePath(argv[++index], DEFAULT_STAGING_MANIFEST);
    } else if (value === '--output') {
      options.outputPath = resolvePrivatePath(argv[++index], DEFAULT_OUTPUT);
    } else {
      throw Object.assign(new Error(`unsupported argument: ${value}`), {
        code: 'INVALID_ARGUMENT'
      });
    }
  }
  assert(options.environmentName === 'staging', '--env staging is required', 'PRODUCTION_TARGET_REJECTED');
  assert(options.allowStatusMutation,
    '--allow-staging-status-mutation is required',
    'STAGING_MUTATION_CONFIRMATION_REQUIRED');
  return options;
}

function withTimeout(promise, label, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error(`${label} timed out`), {
        code: 'STAGING_RUNTIME_TIMEOUT'
      })),
      timeoutMs
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function automationOptions() {
  const modulePath = process.env.PHASE23_AUTOMATOR_MODULE
    || process.env.PHASE22_AUTOMATOR_MODULE
    || path.join(ROOT, 'tmp', 'step4b1-automator', 'node_modules', 'miniprogram-automator');
  const cliPath = process.env.PHASE23_DEVTOOLS_CLI_PATH
    || process.env.PHASE22_DEVTOOLS_CLI_PATH
    || 'D:\\program\\微信web开发者工具\\cli.bat';
  const wsEndpoint = process.env.PHASE23_AUTOMATOR_WS_ENDPOINT || '';
  assert(modulePath && fs.existsSync(modulePath),
    'miniprogram automator module is unavailable', 'AUTOMATOR_UNAVAILABLE');
  assert(wsEndpoint || (cliPath && fs.existsSync(cliPath)),
    'DevTools endpoint or CLI is unavailable', 'DEVTOOLS_UNAVAILABLE');
  return { modulePath, cliPath, wsEndpoint };
}

function collectionSnapshot(environmentId) {
  return Object.fromEntries(PRODUCTION_COLLECTION_NAMES.map((name) => {
    const records = queryAll(environmentId, name, undefined);
    return [name, {
      count: records.length,
      sha256: hashRecords(records)
    }];
  }));
}

function assertDeploymentReady(manifest) {
  assert(manifest.schemaVersion === 1 && manifest.environmentRole === 'staging',
    'staging deployment manifest is invalid', 'STAGING_DEPLOYMENT_EVIDENCE_INVALID');
  assert(manifest.status === 'deployed-and-verified',
    'staging hotfix is not fully deployed', 'STAGING_DEPLOYMENT_INCOMPLETE');
  assert(sameObject(manifest.changedFunctions, [...DEPLOY_ORDER]),
    'staging deployment function set drifted', 'HOTFIX_FUNCTION_SET_DRIFT');
  assert(DEPLOY_ORDER.every((name) => (
    manifest.functions[name]
    && manifest.functions[name].status === 'deployed-and-verified'
  )), 'one or more staging functions are unverified', 'STAGING_DEPLOYMENT_INCOMPLETE');
}

function assertEnvelope(result, label) {
  assert(result && typeof result === 'object', `${label} response is missing`, 'STAGING_RUNTIME_RESPONSE_INVALID');
  assert(typeof result.success === 'boolean'
    && typeof result.code === 'string'
    && typeof result.message === 'string'
    && Object.prototype.hasOwnProperty.call(result, 'data'),
  `${label} response envelope drifted`, 'STAGING_RUNTIME_RESPONSE_INVALID');
}

function assertDenied(result, expectedCodes, label) {
  assertEnvelope(result, label);
  assert(result.success === false && expectedCodes.includes(result.code),
    `${label} returned ${result.code}`, 'STAGING_REVOCATION_BYPASS');
  assert(result.data === null, `${label} returned private data`, 'STAGING_REVOCATION_BYPASS');
  const allowedKeys = new Set(['success', 'code', 'message', 'data', 'traceId']);
  assert(Object.keys(result).every((key) => allowedKeys.has(key)),
    `${label} returned unexpected response metadata`, 'STAGING_RESPONSE_PRIVACY_FAILED');
  const forbiddenKeys = new Set([
    'openid', 'openId', 'appid', 'appId', 'user', 'record', 'status',
    'error', 'errCode', 'errMsg', 'stack', 'databaseError'
  ]);
  assert(!Object.keys(result).some((key) => forbiddenKeys.has(key)),
    `${label} leaked identity/status/error metadata`, 'STAGING_RESPONSE_PRIVACY_FAILED');
}

function actorOptions(options, action) {
  return {
    environmentName: 'staging',
    action,
    confirmTarget: options.confirmTarget,
    confirmActor: options.confirmActor,
    actorPath: options.actorPath,
    manifestPath: options.actorManifestPath,
    allowStatusMutation: options.allowStatusMutation
  };
}

async function waitFor(call, predicate, label, attempts = 12) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await call();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Object.assign(new Error(`${label} did not converge (${last && last.code || 'NO_RESPONSE'})`), {
    code: 'STAGING_RUNTIME_CONVERGENCE_FAILED'
  });
}

async function activeReadSmoke(call, actor, label) {
  const current = await call('authUser', { action: 'current', data: {} });
  assertEnvelope(current, `${label}/authUser.current`);
  assert(current.success === true && current.data.user.id === actor.userId,
    `${label} DevTools identity differs from the staging actor`,
    'STAGING_ACTOR_IDENTITY_MISMATCH');
  for (const [name, payload] of [
    ['productQuery', { action: 'myProducts', data: { page: 1, pageSize: 1 } }],
    ['favoriteProduct', { action: 'listMyFavorites', data: { page: 1, pageSize: 1 } }],
    ['messageQuery', { action: 'listConversations', data: { pageSize: 1 } }],
    ['appointmentQuery', { action: 'listMine', data: { pageSize: 1 } }],
    ['schoolQuery', { action: 'list', pageSize: 1 }]
  ]) {
    const result = await call(name, payload);
    assertEnvelope(result, `${label}/${name}`);
    assert(result.success === true,
      `${label}/${name} active smoke returned ${result.code}`,
      'STAGING_ACTIVE_REGRESSION');
  }
  return 6;
}

async function disabledMatrix(call, actor) {
  const results = [];
  const invokeDenied = async (functionName, event, expectedCodes) => {
    const result = await call(functionName, event);
    const label = `${functionName}/${event.action || 'create'}`;
    assertDenied(result, expectedCodes, label);
    assert(!JSON.stringify(result).includes(String(actor.userId || '')),
      `${label} leaked the actor user ID`, 'STAGING_RESPONSE_PRIVACY_FAILED');
    results.push({ functionName, action: event.action || 'create', code: result.code });
  };

  await invokeDenied('authUser', { action: 'current', data: {} }, ['USER_DISABLED']);
  await invokeDenied('authUser', { action: 'loginIdentity', data: {} }, ['USER_DISABLED']);
  for (const [functionName, cases] of Object.entries(HOTFIX_CASES)) {
    const expected = functionName === 'productQuery'
      ? ['USER_INACTIVE']
      : ['USER_DISABLED'];
    for (const event of cases) {
      await invokeDenied(functionName, event, expected);
    }
  }
  for (const event of EXISTING_ACTIVE_REQUIRED_CASES.userQuery) {
    await invokeDenied('userQuery', event, ['UNAUTHORIZED', 'USER_DISABLED']);
  }
  for (const event of EXISTING_ACTIVE_REQUIRED_CASES.createProduct) {
    await invokeDenied('createProduct', event, ['USER_DISABLED']);
  }

  const publicDetail = await call('productQuery', {
    action: 'detail',
    data: { productId: 'disabled-public-missing' }
  });
  assertEnvelope(publicDetail, 'productQuery/detail-public');
  assert(publicDetail.success === false && publicDetail.code === 'PRODUCT_NOT_FOUND',
    `public detail was blocked by account status (${publicDetail.code})`,
    'STAGING_PUBLIC_REGRESSION');

  const schoolList = await call('schoolQuery', { action: 'list', pageSize: 1 });
  const schoolSearch = await call('schoolQuery', {
    action: 'search',
    keyword: '大学',
    pageSize: 1
  });
  const schoolDetail = await call('schoolQuery', {
    action: 'detail',
    schoolId: actor.schoolId
  });
  for (const [label, result] of [
    ['schoolQuery/list', schoolList],
    ['schoolQuery/search', schoolSearch],
    ['schoolQuery/detail', schoolDetail]
  ]) {
    assertEnvelope(result, label);
    assert(result.success === true, `${label} returned ${result.code}`,
      'STAGING_ONBOARDING_REGRESSION');
  }
  return {
    denied: results,
    deniedCount: results.length,
    publicOnboardingChecks: 4
  };
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: 'staging',
    action: 'cleanup',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: false,
    allowInactiveStagingWrite: false
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.staging,
    'active client target must be registered staging', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId !== targets.production,
    'production target is forbidden', 'PRODUCTION_TARGET_REJECTED');

  const actor = readJson(resolvePrivatePath(options.actorPath, ACTOR_PATH), 'STAGING_ACTOR_MISSING');
  assert(options.confirmActor === actorConfirmation(actor.userId),
    `confirm actor with --confirm-actor ${actorConfirmation(actor.userId)}`,
    'ACTOR_CONFIRMATION_REQUIRED');
  const deployment = readJson(
    resolvePrivatePath(options.deploymentManifestPath, DEFAULT_STAGING_MANIFEST),
    'STAGING_DEPLOYMENT_EVIDENCE_MISSING'
  );
  assertDeploymentReady(deployment);

  const before = collectionSnapshot(preflight.environmentId);
  manageActor(actorOptions(options, 'prepare'));
  const automation = automationOptions();
  const automator = require(automation.modulePath);
  let miniProgram;
  let disabledObserved = false;
  let disableStarted = false;
  let actorRestored = false;
  let runtimeResult;
  try {
    miniProgram = automation.wsEndpoint
      ? await withTimeout(
        automator.connect({ wsEndpoint: automation.wsEndpoint }),
        'DevTools automation connection'
      )
      : await withTimeout(automator.launch({
        cliPath: automation.cliPath,
        projectPath: ROOT,
        trustProject: true,
        timeout: 90000
      }), 'DevTools automation launch');
    const call = async (name, data) => {
      const response = await withTimeout(miniProgram.evaluate(
        async function invokeCloudFunction(functionName, functionData) {
          return wx.cloud.callFunction({ name: functionName, data: functionData });
        },
        name,
        data
      ), `${name}/${data && data.action || 'create'}`);
      return response && response.result;
    };

    const activeChecksBefore = await activeReadSmoke(call, actor, 'before-disable');
    disableStarted = true;
    manageActor(actorOptions(options, 'disable'));
    await waitFor(
      () => call('authUser', { action: 'current', data: {} }),
      (result) => result && result.success === false && result.code === 'USER_DISABLED',
      'disabled account propagation'
    );
    disabledObserved = true;
    const matrix = await disabledMatrix(call, actor);
    runtimeResult = {
      activeChecksBefore,
      ...matrix
    };
  } finally {
    try {
      if (disableStarted) {
        manageActor(actorOptions(options, 'restore'));
      }
      actorRestored = true;
    } finally {
      if (miniProgram) await miniProgram.disconnect();
    }
  }

  const audit = manageActor(actorOptions(options, 'audit'));
  assert(audit.passed === true && audit.actorRestored === true
    && audit.leftoverStatusMutationCount === 0,
  'staging actor did not restore exactly', 'STAGING_ACTOR_RESTORE_FAILED');

  const automationAfter = automationOptions();
  const automatorAfter = require(automationAfter.modulePath);
  let miniProgramAfter;
  let activeChecksAfter = 0;
  try {
    miniProgramAfter = automationAfter.wsEndpoint
      ? await withTimeout(
        automatorAfter.connect({ wsEndpoint: automationAfter.wsEndpoint }),
        'post-restore DevTools connection'
      )
      : await withTimeout(automatorAfter.launch({
        cliPath: automationAfter.cliPath,
        projectPath: ROOT,
        trustProject: true,
        timeout: 90000
      }), 'post-restore DevTools launch');
    const call = async (name, data) => {
      const response = await withTimeout(miniProgramAfter.evaluate(
        async function invokeCloudFunction(functionName, functionData) {
          return wx.cloud.callFunction({ name: functionName, data: functionData });
        }, name, data
      ), `post-restore/${name}`);
      return response && response.result;
    };
    await waitFor(
      () => call('authUser', { action: 'current', data: {} }),
      (result) => result && result.success === true,
      'active account restoration'
    );
    activeChecksAfter = await activeReadSmoke(call, actor, 'after-restore');
  } finally {
    if (miniProgramAfter) await miniProgramAfter.disconnect();
  }

  const after = collectionSnapshot(preflight.environmentId);
  assert(sameObject(after, before),
    'staging nine-collection snapshot changed after exact restore',
    'STAGING_DATA_INTEGRITY_DRIFT');
  const report = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    mode: 'DISABLED_ACCOUNT_STAGING_REAL_RUNTIME',
    environment: publicSummary(preflight),
    actorFingerprint: actorConfirmation(actor.userId),
    disabledObserved,
    actorRestored,
    leftoverStatusMutationCount: audit.leftoverStatusMutationCount,
    activeChecksBefore: runtimeResult.activeChecksBefore,
    activeChecksAfter,
    disabledDeniedCount: runtimeResult.deniedCount,
    disabledResults: runtimeResult.denied,
    publicOnboardingChecks: runtimeResult.publicOnboardingChecks,
    nineCollectionPrePostExact: true,
    feedbackMailAttempts: 0,
    productionWrites: 0,
    passed: true
  };
  writePrivateJson(options.outputPath, report);
  return report;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => run(parseArguments(process.argv.slice(2))))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || 'STAGING_RUNTIME_FAILED'}: ${sanitizeErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_OUTPUT,
  parseArguments,
  automationOptions,
  collectionSnapshot,
  assertDeploymentReady,
  assertDenied,
  activeReadSmoke,
  disabledMatrix,
  run
};
