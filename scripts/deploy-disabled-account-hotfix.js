'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT,
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const { readFunctionDetail } = require('./phase-18-canary-core');
const { runCloudBase } = require('./schools/cloud-cli');
const {
  HOTFIX_FUNCTION_CANDIDATES,
  sha256,
  stableStringify,
  resolvePrivatePath,
  assertPrivateDirectory,
  assertSafeTemporaryDirectory,
  removeSafeTemporaryDirectory,
  writePrivateJson,
  readJson,
  environmentVariables,
  summarizeFunction,
  assertFunctionAvailable,
  functionConfigurationFingerprint,
  gitHead,
  localFunctionPackage,
  enumeratePackageFiles,
  hashFiles,
  sameObject,
  sanitizeErrorMessage
} = require('./disabled-account-rollout-core');

const OWNER_AUTHORIZATION =
  'POST RELEASE DISABLED ACCOUNT REVOCATION HOTFIX PRODUCTION';
const ROLLBACK_AUTHORIZATION =
  'POST RELEASE DISABLED ACCOUNT REVOCATION HOTFIX EMERGENCY ROLLBACK';
const DEFAULT_STAGING_MANIFEST = path.join(
  ROOT,
  'tmp',
  'disabled-account-hotfix-staging-deployment.json'
);
const DEFAULT_PRODUCTION_MANIFEST = path.join(
  ROOT,
  'tmp',
  'disabled-account-hotfix-production-deployment.json'
);
const DEFAULT_STAGING_RUNTIME = path.join(
  ROOT,
  'tmp',
  'disabled-account-staging-runtime.json'
);
const DEFAULT_PRODUCTION_PRE = path.join(
  ROOT,
  'tmp',
  'disabled-account-production-integrity-pre.json'
);
const ACTIONS = Object.freeze(['prepare', 'deploy', 'verify', 'rollback']);
const DEPLOY_ORDER = Object.freeze([
  'authUser',
  'productQuery',
  'userQuery',
  'messageQuery',
  'appointmentQuery',
  'manageProduct',
  'favoriteProduct',
  'productViewAction',
  'messageAction',
  'appointmentAction',
  'feedbackAction'
]);
const REASONS = Object.freeze({
  authUser: 'fail closed for every non-active existing account while preserving onboarding',
  productQuery: 'enforce authoritative active status for myProducts',
  userQuery: 'require an authoritative active viewer and hide non-active public targets',
  manageProduct: 'revoke all owner management actions for disabled accounts',
  favoriteProduct: 'revoke private relation reads, idempotent reuse, and mutations',
  productViewAction: 'revoke authenticated view writes and counter updates',
  messageQuery: 'revoke all private message and conversation reads',
  messageAction: 'revoke all conversation and message mutations before reuse',
  appointmentQuery: 'revoke all private appointment reads',
  appointmentAction: 'revoke all appointment mutations before reuse/state checks',
  feedbackAction: 'revoke feedback persistence and mail before validation/reuse'
});
const STAGING_CREATE_CONFIGS = Object.freeze({
  manageProduct: Object.freeze({
    runtime: 'Nodejs16.13',
    handler: 'index.main',
    timeout: 10,
    memorySize: 256,
    installDependency: 'TRUE',
    envVariables: Object.freeze({})
  }),
  productViewAction: Object.freeze({
    runtime: 'Nodejs18.15',
    handler: 'index.main',
    timeout: 10,
    memorySize: 256,
    installDependency: 'TRUE',
    envVariables: Object.freeze({})
  })
});

function defaultManifest(environmentName) {
  return environmentName === 'production'
    ? DEFAULT_PRODUCTION_MANIFEST
    : DEFAULT_STAGING_MANIFEST;
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    action: '',
    functionName: '',
    confirmTarget: '',
    manifestPath: '',
    stagingRuntimePath: DEFAULT_STAGING_RUNTIME,
    productionPrePath: DEFAULT_PRODUCTION_PRE,
    ownerAuthorization: '',
    allowStagingHotfix: false,
    allowProductionHotfix: false,
    allowEmergencyRollback: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--action') options.action = String(argv[++index] || '').trim();
    else if (value === '--function') options.functionName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--manifest') options.manifestPath = resolvePrivatePath(argv[++index], '');
    else if (value === '--staging-runtime') {
      options.stagingRuntimePath = resolvePrivatePath(argv[++index], DEFAULT_STAGING_RUNTIME);
    } else if (value === '--production-pre') {
      options.productionPrePath = resolvePrivatePath(argv[++index], DEFAULT_PRODUCTION_PRE);
    } else if (value === '--owner-authorization') {
      options.ownerAuthorization = String(argv[++index] || '').trim();
    } else if (value === '--allow-staging-hotfix') options.allowStagingHotfix = true;
    else if (value === '--allow-production-hotfix') options.allowProductionHotfix = true;
    else if (value === '--allow-emergency-rollback') options.allowEmergencyRollback = true;
    else {
      throw Object.assign(new Error(`unsupported argument: ${value}`), {
        code: 'INVALID_ARGUMENT'
      });
    }
  }
  assert(['staging', 'production'].includes(options.environmentName),
    '--env staging|production is required', 'ENVIRONMENT_ROLE_REQUIRED');
  assert(ACTIONS.includes(options.action),
    '--action prepare|deploy|verify|rollback is required', 'INVALID_ACTION');
  if (!options.manifestPath) {
    options.manifestPath = defaultManifest(options.environmentName);
  }
  if (['deploy', 'rollback'].includes(options.action)) {
    assert(DEPLOY_ORDER.includes(options.functionName),
      '--function must name one hotfix function', 'FUNCTION_REQUIRED');
  }
  return options;
}

function environmentIdFingerprint(environmentName, environmentId) {
  return sha256(Buffer.from(`${environmentName}:${environmentId}`, 'utf8'));
}

function remoteState(environmentId, functionName) {
  const detail = readFunctionDetail(environmentId, functionName);
  const summary = summarizeFunction(detail);
  assertFunctionAvailable(summary, functionName);
  return {
    detail,
    summary: {
      ...summary,
      configurationFingerprint: functionConfigurationFingerprint(summary)
    }
  };
}

function isMissingFunctionError(error, functionName) {
  const message = String(error && error.message || error || '').toLowerCase();
  return message.includes('resource_not_found')
    && message.includes(String(functionName || '').toLowerCase())
    && message.includes('function does not exist');
}

function remoteStateOrNull(environmentId, functionName, allowMissing) {
  try {
    return remoteState(environmentId, functionName);
  } catch (error) {
    if (allowMissing && isMissingFunctionError(error, functionName)) return null;
    throw error;
  }
}

function syntheticFunctionDetail(config) {
  return {
    Status: 'Active',
    AvailableStatus: 'Available',
    Runtime: config.runtime,
    Handler: config.handler,
    Timeout: config.timeout,
    MemorySize: config.memorySize,
    InstallDependency: config.installDependency,
    Environment: {
      Variables: Object.entries(config.envVariables || {}).map(([Key, Value]) => ({
        Key,
        Value
      }))
    },
    Triggers: [],
    CodeInfo: ''
  };
}

function expectedCreatedConfiguration(functionName) {
  const config = STAGING_CREATE_CONFIGS[functionName];
  assert(config, `${functionName} is not approved for staging creation`,
    'STAGING_FUNCTION_CREATION_NOT_ALLOWED');
  const summary = summarizeFunction(syntheticFunctionDetail(config));
  return {
    ...summary,
    configurationFingerprint: functionConfigurationFingerprint(summary)
  };
}

function downloadRemotePackage(environmentId, functionName, directory) {
  assertPrivateDirectory(path.dirname(directory));
  assert(!fs.existsSync(directory),
    `${functionName} rollback directory already exists`, 'ROLLBACK_DIRECTORY_EXISTS');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  runCloudBase([
    'fn', 'code', 'download', functionName, directory,
    '--env-id', environmentId
  ], { timeoutMs: 300000, json: false });
  return directory;
}

function rollbackRoot(environmentName) {
  return path.join(ROOT, 'tmp', `disabled-account-${environmentName}-rollback`);
}

function packageHashes(directory, relativeFiles) {
  const actual = enumeratePackageFiles(directory);
  assert(sameObject(actual, relativeFiles),
    'remote function package contains untracked or missing files',
    'REMOTE_PACKAGE_TRACKING_DRIFT');
  const files = hashFiles(directory, relativeFiles);
  return {
    files,
    aggregateSha256: sha256(stableStringify(files))
  };
}

function prepareManifest(preflight, options) {
  const manifestPath = resolvePrivatePath(
    options.manifestPath,
    defaultManifest(options.environmentName)
  );
  assert(!fs.existsSync(manifestPath),
    'deployment manifest already exists; use it or choose a new private path',
    'DEPLOYMENT_MANIFEST_EXISTS');
  const root = rollbackRoot(options.environmentName);
  assert(!fs.existsSync(root),
    'rollback root already exists; preserve or move the prior evidence first',
    'ROLLBACK_DIRECTORY_EXISTS');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const functions = {};
  try {
    for (const name of DEPLOY_ORDER) {
      const local = localFunctionPackage(name);
      const mayCreateInStaging = options.environmentName === 'staging'
        && Object.prototype.hasOwnProperty.call(STAGING_CREATE_CONFIGS, name);
      const before = remoteStateOrNull(
        preflight.environmentId,
        name,
        mayCreateInStaging
      );
      if (!before) {
        const expected = expectedCreatedConfiguration(name);
        functions[name] = {
          order: DEPLOY_ORDER.indexOf(name) + 1,
          reason: REASONS[name],
          status: 'prepared',
          oldState: 'absent',
          oldSourceSha256: '',
          newSourceSha256: local.indexSha256,
          oldPackageAggregateSha256: '',
          newPackageAggregateSha256: local.aggregateSha256,
          packageJsonChanged: false,
          packageLockChanged: false,
          trackedFiles: local.relativeFiles,
          oldFileHashes: {},
          newFileHashes: local.files,
          configurationBefore: null,
          configurationExpected: expected,
          rollbackDirectory: '',
          rollbackStrategy: 'delete-created-staging-function'
        };
        continue;
      }
      assert(before.summary.sourceSha256 !== local.indexSha256,
        `${name} remote source already matches local or is not a changed hotfix target`,
        'HOTFIX_FUNCTION_SET_DRIFT');
      const directory = downloadRemotePackage(
        preflight.environmentId,
        name,
        path.join(root, name)
      );
      const rollback = packageHashes(directory, local.relativeFiles);
      assert(rollback.files['index.js'] === before.summary.sourceSha256,
        `${name} rollback source differs from function detail`,
        'ROLLBACK_SOURCE_DRIFT');
      functions[name] = {
        order: DEPLOY_ORDER.indexOf(name) + 1,
        reason: REASONS[name],
        status: 'prepared',
        oldState: 'present',
        oldSourceSha256: before.summary.sourceSha256,
        newSourceSha256: local.indexSha256,
        oldPackageAggregateSha256: rollback.aggregateSha256,
        newPackageAggregateSha256: local.aggregateSha256,
        packageJsonChanged: rollback.files['package.json'] !== local.packageSha256,
        packageLockChanged: rollback.files['package-lock.json'] !== local.lockSha256,
        trackedFiles: local.relativeFiles,
        oldFileHashes: rollback.files,
        newFileHashes: local.files,
        configurationBefore: before.summary,
        rollbackDirectory: path.relative(ROOT, directory).replace(/\\/g, '/'),
        rollbackStrategy: 'restore-package'
      };
    }
  } catch (error) {
    const failed = {
      schemaVersion: 1,
      environmentRole: options.environmentName,
      environmentFingerprint: environmentIdFingerprint(
        options.environmentName,
        preflight.environmentId
      ),
      status: 'prepare-failed',
      failureCode: error.code || 'PREPARE_FAILED',
      functions
    };
    writePrivateJson(manifestPath, failed);
    throw error;
  }

  assert(sameObject(Object.keys(functions), [...DEPLOY_ORDER]),
    'deployment manifest is not exactly the eleven hotfix functions',
    'HOTFIX_FUNCTION_SET_DRIFT');
  for (const [name, entry] of Object.entries(functions)) {
    assert(entry.packageJsonChanged === false && entry.packageLockChanged === false,
      `${name} dependency manifest changed`, 'DEPENDENCY_DRIFT');
  }
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    environmentRole: options.environmentName,
    environmentMasked: preflight.environmentIdMasked,
    environmentFingerprint: environmentIdFingerprint(
      options.environmentName,
      preflight.environmentId
    ),
    gitBase: gitHead(),
    status: 'prepared',
    deployOrder: [...DEPLOY_ORDER],
    changedFunctions: [...DEPLOY_ORDER],
    functions,
    rollbackReady: true,
    dependencyDrift: false,
    configurationDrift: false,
    businessDataWritesPlanned: 0
  };
  writePrivateJson(manifestPath, manifest);
  return manifest;
}

function loadManifest(preflight, options) {
  const manifestPath = resolvePrivatePath(
    options.manifestPath,
    defaultManifest(options.environmentName)
  );
  const manifest = readJson(manifestPath, 'DEPLOYMENT_MANIFEST_MISSING');
  assert(manifest.schemaVersion === 1
    && manifest.environmentRole === options.environmentName,
  'deployment manifest role/version mismatch', 'DEPLOYMENT_MANIFEST_INVALID');
  assert(manifest.environmentFingerprint === environmentIdFingerprint(
    options.environmentName,
    preflight.environmentId
  ), 'deployment manifest environment mismatch', 'DEPLOYMENT_MANIFEST_INVALID');
  assert(sameObject(manifest.deployOrder, [...DEPLOY_ORDER])
    && sameObject(manifest.changedFunctions, [...DEPLOY_ORDER]),
  'deployment manifest function set drifted', 'HOTFIX_FUNCTION_SET_DRIFT');
  return { manifestPath, manifest };
}

function assertLocalFreeze(manifest, functionName) {
  const entry = manifest.functions[functionName];
  assert(entry, `${functionName} is absent from the manifest`, 'FUNCTION_NOT_ALLOWED');
  const local = localFunctionPackage(functionName);
  assert(sameObject(local.relativeFiles, entry.trackedFiles),
    `${functionName} tracked files changed`, 'SOURCE_FREEZE_DRIFT');
  assert(sameObject(local.files, entry.newFileHashes),
    `${functionName} local package changed after prepare`, 'SOURCE_FREEZE_DRIFT');
  assert(local.indexSha256 === entry.newSourceSha256,
    `${functionName} local source changed after prepare`, 'SOURCE_FREEZE_DRIFT');
  return local;
}

function assertRemoteBefore(entry, current, functionName) {
  if (entry.oldState === 'absent') {
    assert(current === null, `${functionName} unexpectedly appeared after prepare`,
      'REMOTE_SOURCE_DRIFT');
    return;
  }
  assert(current, `${functionName} disappeared after prepare`, 'REMOTE_SOURCE_DRIFT');
  assert(current.summary.sourceSha256 === entry.oldSourceSha256,
    `${functionName} remote source changed after prepare`, 'REMOTE_SOURCE_DRIFT');
  assert(current.summary.configurationFingerprint
    === entry.configurationBefore.configurationFingerprint,
  `${functionName} configuration changed after prepare`,
  'FUNCTION_CONFIGURATION_DRIFT');
}

function expectedConfigurationFingerprint(entry) {
  return entry.oldState === 'absent'
    ? entry.configurationExpected.configurationFingerprint
    : entry.configurationBefore.configurationFingerprint;
}

function createDeployConfiguration(
  environmentId,
  functionName,
  detail,
  functionRoot
) {
  return {
    envId: environmentId,
    functionRoot,
    functions: [{
      name: functionName,
      runtime: String(detail.Runtime || ''),
      handler: String(detail.Handler || ''),
      timeout: Number(detail.Timeout || 0),
      memorySize: Number(detail.MemorySize || 0),
      envVariables: environmentVariables(detail)
    }]
  };
}

function deployPackage(environmentId, functionName, detail, functionRoot) {
  const prefix = `disabled-account-${functionName}-`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(directory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(createDeployConfiguration(
      environmentId,
      functionName,
      detail,
      functionRoot
    ), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase([
      '--config-file', configPath,
      '--env-id', environmentId,
      'fn', 'deploy', functionName,
      '--force', '--json'
    ], { timeoutMs: 600000, json: false });
  } finally {
    removeSafeTemporaryDirectory(directory, prefix);
  }
}

function deleteCreatedStagingFunction(environmentId, functionName) {
  assert(Object.prototype.hasOwnProperty.call(STAGING_CREATE_CONFIGS, functionName),
    `${functionName} is not approved for staging deletion`,
    'STAGING_FUNCTION_DELETION_NOT_ALLOWED');
  runCloudBase([
    'fn', 'delete', functionName,
    '--env-id', environmentId,
    '--json'
  ], { timeoutMs: 300000, json: false });
}

function downloadAndVerify(
  environmentId,
  functionName,
  relativeFiles,
  expectedFiles
) {
  const prefix = `disabled-account-verify-${functionName}-`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    runCloudBase([
      'fn', 'code', 'download', functionName, directory,
      '--env-id', environmentId
    ], { timeoutMs: 300000, json: false });
    const remotePackage = packageHashes(directory, relativeFiles);
    const files = remotePackage.files;
    assert(sameObject(files, expectedFiles),
      `${functionName} remote package differs`, 'REMOTE_PACKAGE_DRIFT');
    return {
      files,
      aggregateSha256: sha256(stableStringify(files)),
      matches: true
    };
  } finally {
    removeSafeTemporaryDirectory(directory, prefix);
  }
}

function readRequiredArtifact(filePath, code) {
  return readJson(resolvePrivatePath(filePath, filePath), code);
}

async function assertProductionGates(options) {
  assert(options.allowProductionHotfix,
    '--allow-production-hotfix is required', 'PRODUCTION_HOTFIX_CONFIRMATION_REQUIRED');
  assert(options.ownerAuthorization === OWNER_AUTHORIZATION,
    `owner authorization must be ${OWNER_AUTHORIZATION}`,
    'OWNER_AUTHORIZATION_REQUIRED');
  const staging = readRequiredArtifact(
    options.stagingRuntimePath,
    'STAGING_RUNTIME_EVIDENCE_MISSING'
  );
  assert(staging.passed === true && staging.actorRestored === true
    && staging.leftoverStatusMutationCount === 0,
  'staging runtime evidence is not fully restored/PASS',
  'STAGING_RUNTIME_GATE_FAILED');
  const productionPre = readRequiredArtifact(
    options.productionPrePath,
    'PRODUCTION_PRE_EVIDENCE_MISSING'
  );
  assert(productionPre.passed === true && productionPre.phase === 'pre'
    && productionPre.nineCollectionsExact === true
    && productionPre.publicMarketZero === true
    && productionPre.schools2952Active === true
    && sameObject(
      [...productionPre.changedFunctions].sort(),
      [...DEPLOY_ORDER].sort()
    ),
  'production PRE integrity evidence is incomplete',
  'PRODUCTION_PRE_GATE_FAILED');
  const { verifyDisabledAccountRevocation } = require(
    './verify-disabled-account-revocation'
  );
  const local = await verifyDisabledAccountRevocation();
  assert(local.passed === true && local.protectedFunctions === 11,
    'local disabled-account verifier failed', 'LOCAL_REVOCATION_GATE_FAILED');
}

async function deployOne(preflight, options, loaded) {
  const { manifestPath, manifest } = loaded;
  const name = options.functionName;
  const entry = manifest.functions[name];
  assert(entry && DEPLOY_ORDER.includes(name), 'function is not in manifest', 'FUNCTION_NOT_ALLOWED');
  const priorNames = DEPLOY_ORDER.slice(0, DEPLOY_ORDER.indexOf(name));
  assert(priorNames.every((prior) => manifest.functions[prior].status === 'deployed-and-verified'),
    `${name} cannot deploy before prior functions`, 'DEPLOYMENT_ORDER_VIOLATION');
  assertLocalFreeze(manifest, name);
  if (options.environmentName === 'production') {
    await assertProductionGates(options);
  } else {
    assert(options.allowStagingHotfix,
      '--allow-staging-hotfix is required', 'STAGING_HOTFIX_CONFIRMATION_REQUIRED');
  }

  const current = remoteStateOrNull(
    preflight.environmentId,
    name,
    options.environmentName === 'staging' && entry.oldState === 'absent'
  );
  if (entry.status === 'deployed-and-verified') {
    assert(current && current.summary.sourceSha256 === entry.newSourceSha256,
      `${name} manifest says deployed but remote differs`, 'REMOTE_SOURCE_DRIFT');
    return { idempotent: true, functionName: name, status: entry.status };
  }
  assert(['prepared', 'deploy-started'].includes(entry.status),
    `${name} manifest state is not deployable`, 'DEPLOYMENT_STATE_INVALID');
  if (entry.status === 'prepared') {
    assertRemoteBefore(entry, current, name);
    entry.status = 'deploy-started';
    entry.deployStartedAt = new Date().toISOString();
    writePrivateJson(manifestPath, manifest);
  } else {
    assert(
      current === null
      || [entry.oldSourceSha256, entry.newSourceSha256]
        .includes(current.summary.sourceSha256),
      `${name} interrupted deploy has an unknown remote source`,
      'REMOTE_SOURCE_DRIFT'
    );
    if (current) {
      assert(current.summary.configurationFingerprint
        === expectedConfigurationFingerprint(entry),
      `${name} configuration changed during interrupted deploy`,
      'FUNCTION_CONFIGURATION_DRIFT');
    }
  }
  if (!current || current.summary.sourceSha256 === entry.oldSourceSha256) {
    const deployDetail = current
      ? current.detail
      : syntheticFunctionDetail(STAGING_CREATE_CONFIGS[name]);
    deployPackage(
      preflight.environmentId,
      name,
      deployDetail,
      'cloudfunctions'
    );
  }
  const after = remoteState(preflight.environmentId, name);
  assert(after.summary.sourceSha256 === entry.newSourceSha256,
    `${name} deployed source differs from manifest`, 'REMOTE_SOURCE_DRIFT');
  assert(after.summary.configurationFingerprint
    === expectedConfigurationFingerprint(entry),
  `${name} configuration changed during deploy`, 'FUNCTION_CONFIGURATION_DRIFT');
  const remotePackage = downloadAndVerify(
    preflight.environmentId,
    name,
    entry.trackedFiles,
    entry.newFileHashes
  );
  entry.status = 'deployed-and-verified';
  entry.deployedAt = new Date().toISOString();
  entry.configurationAfter = after.summary;
  entry.remotePackageAfter = remotePackage;
  manifest.status = DEPLOY_ORDER.every((item) => (
    manifest.functions[item].status === 'deployed-and-verified'
  )) ? 'deployed-and-verified' : 'deploying';
  manifest.updatedAt = new Date().toISOString();
  writePrivateJson(manifestPath, manifest);
  return {
    functionName: name,
    oldSourceSha256: entry.oldSourceSha256,
    newSourceSha256: entry.newSourceSha256,
    configurationUnchanged: true,
    remotePackageMatches: true,
    status: entry.status
  };
}

function verifyAll(preflight, loaded) {
  const { manifestPath, manifest } = loaded;
  const functions = {};
  for (const name of DEPLOY_ORDER) {
    const entry = manifest.functions[name];
    assertLocalFreeze(manifest, name);
    const current = remoteState(preflight.environmentId, name);
    assert(current.summary.sourceSha256 === entry.newSourceSha256,
      `${name} remote source does not match the hotfix`, 'REMOTE_SOURCE_DRIFT');
    assert(current.summary.configurationFingerprint
      === expectedConfigurationFingerprint(entry),
    `${name} configuration changed`, 'FUNCTION_CONFIGURATION_DRIFT');
    downloadAndVerify(
      preflight.environmentId,
      name,
      entry.trackedFiles,
      entry.newFileHashes
    );
    entry.status = 'deployed-and-verified';
    functions[name] = {
      sourceSha256: current.summary.sourceSha256,
      configurationFingerprint: current.summary.configurationFingerprint,
      passed: true
    };
  }
  manifest.status = 'deployed-and-verified';
  manifest.verifiedAt = new Date().toISOString();
  writePrivateJson(manifestPath, manifest);
  return {
    mode: 'DISABLED_ACCOUNT_HOTFIX_DEPLOYMENT_VERIFIED',
    functions,
    functionsPassed: Object.keys(functions).length,
    passed: true
  };
}

function rollbackOne(preflight, options, loaded) {
  const { manifestPath, manifest } = loaded;
  const name = options.functionName;
  const entry = manifest.functions[name];
  assert(options.allowEmergencyRollback,
    '--allow-emergency-rollback is required', 'ROLLBACK_CONFIRMATION_REQUIRED');
  if (options.environmentName === 'production') {
    assert(options.allowProductionHotfix,
      '--allow-production-hotfix is required', 'PRODUCTION_HOTFIX_CONFIRMATION_REQUIRED');
    assert(options.ownerAuthorization === ROLLBACK_AUTHORIZATION,
      `rollback authorization must be ${ROLLBACK_AUTHORIZATION}`,
      'OWNER_AUTHORIZATION_REQUIRED');
  }
  const current = remoteState(preflight.environmentId, name);
  assert(current.summary.sourceSha256 === entry.newSourceSha256,
    `${name} is not at the hotfix source`, 'ROLLBACK_SOURCE_DRIFT');
  assert(current.summary.configurationFingerprint
    === expectedConfigurationFingerprint(entry),
  `${name} configuration drift blocks rollback`, 'FUNCTION_CONFIGURATION_DRIFT');
  if (entry.oldState === 'absent') {
    assert(options.environmentName === 'staging'
      && entry.rollbackStrategy === 'delete-created-staging-function',
    `${name} absence rollback is staging-only`, 'ROLLBACK_STRATEGY_INVALID');
    entry.status = 'rollback-started';
    entry.rollbackStartedAt = new Date().toISOString();
    writePrivateJson(manifestPath, manifest);
    deleteCreatedStagingFunction(preflight.environmentId, name);
    const afterDeletion = remoteStateOrNull(preflight.environmentId, name, true);
    assert(afterDeletion === null, `${name} staging absence was not restored`,
      'ROLLBACK_SOURCE_DRIFT');
    entry.status = 'rolled-back-and-verified';
    entry.rolledBackAt = new Date().toISOString();
    manifest.status = 'emergency-rollback-partial';
    writePrivateJson(manifestPath, manifest);
    return {
      functionName: name,
      status: entry.status,
      restoredState: 'absent',
      warning: 'rollback deleted the staging-only function and removes revocation enforcement'
    };
  }
  const rollbackDirectory = path.resolve(ROOT, entry.rollbackDirectory);
  assertPrivateDirectory(rollbackDirectory);
  assert(sameObject(
    hashFiles(rollbackDirectory, entry.trackedFiles),
    entry.oldFileHashes
  ), `${name} rollback package changed`, 'ROLLBACK_SOURCE_DRIFT');
  entry.status = 'rollback-started';
  entry.rollbackStartedAt = new Date().toISOString();
  writePrivateJson(manifestPath, manifest);
  deployPackage(
    preflight.environmentId,
    name,
    current.detail,
    rollbackRoot(options.environmentName)
  );
  const after = remoteState(preflight.environmentId, name);
  assert(after.summary.sourceSha256 === entry.oldSourceSha256,
    `${name} rollback source verification failed`, 'ROLLBACK_SOURCE_DRIFT');
  assert(after.summary.configurationFingerprint
    === entry.configurationBefore.configurationFingerprint,
  `${name} configuration changed during rollback`, 'FUNCTION_CONFIGURATION_DRIFT');
  downloadAndVerify(
    preflight.environmentId,
    name,
    entry.trackedFiles,
    entry.oldFileHashes
  );
  entry.status = 'rolled-back-and-verified';
  entry.rolledBackAt = new Date().toISOString();
  manifest.status = 'emergency-rollback-partial';
  writePrivateJson(manifestPath, manifest);
  return {
    functionName: name,
    status: entry.status,
    warning: 'rollback restores the pre-hotfix source and removes revocation enforcement'
  };
}

async function run(options) {
  const write = ['deploy', 'rollback'].includes(options.action);
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: write ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: write && options.environmentName === 'production',
    allowInactiveRead: false,
    allowInactiveStagingWrite: false
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches,
    `active client target must be ${options.environmentName}`,
    'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId === targets[options.environmentName],
    'registered target mismatch', 'ENVIRONMENT_TARGET_MISMATCH');
  assert(targets.production !== targets.staging && preflight.targetsDistinct,
    'production and staging targets are not distinct', 'ENVIRONMENT_COLLISION');
  assert(sameObject(
    [...DEPLOY_ORDER].sort(),
    [...HOTFIX_FUNCTION_CANDIDATES].sort()
  ), 'deployment order drifted from the approved hotfix set', 'HOTFIX_FUNCTION_SET_DRIFT');
  assert(options.confirmTarget === preflight.environmentIdMasked,
    `confirm target with --confirm-target ${preflight.environmentIdMasked}`,
    'TARGET_CONFIRMATION_REQUIRED');

  if (options.action === 'prepare') {
    const manifest = prepareManifest(preflight, options);
    return {
      mode: 'DISABLED_ACCOUNT_HOTFIX_DEPLOYMENT_PREPARED',
      environment: publicSummary(preflight),
      manifest: path.relative(ROOT, options.manifestPath).replace(/\\/g, '/'),
      changedFunctions: manifest.changedFunctions,
      rollbackReady: manifest.rollbackReady,
      dependencyDrift: manifest.dependencyDrift,
      productionWrites: 0,
      passed: true
    };
  }
  const loaded = loadManifest(preflight, options);
  const result = options.action === 'deploy'
    ? await deployOne(preflight, options, loaded)
    : options.action === 'verify'
      ? verifyAll(preflight, loaded)
      : rollbackOne(preflight, options, loaded);
  return {
    environment: publicSummary(preflight),
    manifest: path.relative(ROOT, loaded.manifestPath).replace(/\\/g, '/'),
    ...result
  };
}

if (require.main === module) {
  Promise.resolve()
    .then(() => run(parseArguments(process.argv.slice(2))))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.code || 'HOTFIX_DEPLOYMENT_FAILED'}: ${sanitizeErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  OWNER_AUTHORIZATION,
  ROLLBACK_AUTHORIZATION,
  DEFAULT_STAGING_MANIFEST,
  DEFAULT_PRODUCTION_MANIFEST,
  ACTIONS,
  DEPLOY_ORDER,
  REASONS,
  STAGING_CREATE_CONFIGS,
  parseArguments,
  environmentIdFingerprint,
  isMissingFunctionError,
  syntheticFunctionDetail,
  expectedCreatedConfiguration,
  createDeployConfiguration,
  prepareManifest,
  assertLocalFreeze,
  assertProductionGates,
  run
};
