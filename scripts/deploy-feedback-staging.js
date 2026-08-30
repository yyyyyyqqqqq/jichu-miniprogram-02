'use strict';

const crypto = require('crypto');
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

const FUNCTION_NAME = 'feedbackAction';
const APPROVED_SOURCE_SHA256 = '2f34e04a346bc554e1f15f660727f10281dddb0533880c34a5e3fc04812a7688';
const DEFAULT_CONFIGURATION = Object.freeze({
  runtime: 'Nodejs18.15',
  handler: 'index.main',
  timeout: 20,
  memorySize: 256
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    confirmTarget: '',
    deploy: false,
    allowMissingMailCredentials: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else if (value === '--allow-missing-mail-credentials') options.allowMissingMailCredentials = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'staging', 'feedback deployment accepts only --env staging', 'PRODUCTION_TARGET_REJECTED');
  return options;
}

function readPrivateMailConfiguration() {
  let secrets;
  try {
    secrets = require('../config/cloud.secrets.private');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') secrets = {};
    else throw error;
  }
  const staging = secrets && secrets.staging && typeof secrets.staging === 'object'
    ? secrets.staging
    : {};
  const value = (key) => typeof staging[key] === 'string' ? staging[key].trim() : '';
  return {
    FEEDBACK_MAIL_HOST: value('FEEDBACK_MAIL_HOST'),
    FEEDBACK_MAIL_PORT: value('FEEDBACK_MAIL_PORT'),
    FEEDBACK_MAIL_USER: value('FEEDBACK_MAIL_USER'),
    FEEDBACK_MAIL_SECRET: value('FEEDBACK_MAIL_SECRET')
  };
}

function buildEnvironmentVariables(configuration, allowMissing) {
  assert(configuration.FEEDBACK_MAIL_HOST === 'smtp.qq.com', 'FEEDBACK_MAIL_HOST must be smtp.qq.com', 'MAIL_CONFIG_INVALID');
  assert(configuration.FEEDBACK_MAIL_PORT === '465', 'FEEDBACK_MAIL_PORT must be 465', 'MAIL_CONFIG_INVALID');
  const userPresent = Boolean(configuration.FEEDBACK_MAIL_USER);
  const secretPresent = Boolean(configuration.FEEDBACK_MAIL_SECRET);
  assert(userPresent === secretPresent, 'mail username and authorization code must be configured together', 'MAIL_CONFIG_PARTIAL');
  assert(userPresent || allowMissing, 'mail credentials are missing', 'MAIL_CONFIG_MISSING');
  const variables = {
    FEEDBACK_ENVIRONMENT: 'staging',
    FEEDBACK_MAIL_HOST: configuration.FEEDBACK_MAIL_HOST,
    FEEDBACK_MAIL_PORT: configuration.FEEDBACK_MAIL_PORT
  };
  if (userPresent) {
    variables.FEEDBACK_MAIL_USER = configuration.FEEDBACK_MAIL_USER;
    variables.FEEDBACK_MAIL_SECRET = configuration.FEEDBACK_MAIL_SECRET;
  }
  return variables;
}

function dependencySummary() {
  const directory = path.join(ROOT, 'cloudfunctions', FUNCTION_NAME);
  const packageSource = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
  const lockSource = fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8');
  const manifest = JSON.parse(packageSource);
  const lock = JSON.parse(lockSource);
  assert(manifest.dependencies.nodemailer === '9.0.6', 'nodemailer must remain pinned to 9.0.6');
  assert(manifest.dependencies.ws === '8.21.3', 'ws must remain pinned to 8.21.3');
  assert(['4.0.2', '^4.0.2'].includes(manifest.dependencies['wx-server-sdk']), 'wx-server-sdk range drifted');
  assert(lock.packages['node_modules/nodemailer'].version === '9.0.6', 'nodemailer lock version drifted');
  assert(lock.packages['node_modules/ws'].version === '8.21.3', 'ws lock version drifted');
  assert(lock.packages['node_modules/wx-server-sdk'].version === '4.0.2', 'wx-server-sdk lock version drifted');
  return {
    packageSha256: sha256(packageSource),
    lockSha256: sha256(lockSource),
    nodemailer: '9.0.6',
    ws: '8.21.3',
    wxServerSdk: '4.0.2'
  };
}

function environmentVariables(detail) {
  return Object.fromEntries(
    (detail && detail.Environment && detail.Environment.Variables || [])
      .map((item) => [String(item.Key || item.key || ''), String(item.Value || item.value || '')])
      .filter(([key]) => key)
  );
}

function summarize(detail) {
  const variables = environmentVariables(detail);
  return {
    status: detail.Status || '',
    availableStatus: detail.AvailableStatus || '',
    runtime: detail.Runtime || '',
    handler: detail.Handler || '',
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    sourceSha256: sha256(Buffer.from(String(detail.CodeInfo || ''), 'utf8')),
    environmentVariableKeys: Object.keys(variables).sort(),
    credentialsConfigured: Boolean(variables.FEEDBACK_MAIL_USER && variables.FEEDBACK_MAIL_SECRET)
  };
}

function readExisting(environmentId) {
  try {
    return summarize(readFunctionDetail(environmentId, FUNCTION_NAME));
  } catch (error) {
    if (/RESOURCE_NOT_FOUND|Function does not exist/i.test(String(error && error.message || error))) return null;
    throw error;
  }
}

function assertSafeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  assert(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'temporary directory escaped temp root');
  assert(path.basename(resolved).startsWith('feedback-staging-deploy-'), 'temporary directory prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary deploy directory is unsafe');
}

function deployOnly(environmentId, envVariables) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-staging-deploy-'));
  const configPath = path.join(directory, 'cloudbaserc.json');
  try {
    assertSafeTemporaryDirectory(directory);
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [{
        name: FUNCTION_NAME,
        runtime: DEFAULT_CONFIGURATION.runtime,
        handler: DEFAULT_CONFIGURATION.handler,
        timeout: DEFAULT_CONFIGURATION.timeout,
        memorySize: DEFAULT_CONFIGURATION.memorySize,
        envVariables
      }]
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase([
      '--config-file', configPath,
      '--env-id', environmentId,
      'fn', 'deploy', FUNCTION_NAME,
      '--force', '--json'
    ], { timeoutMs: 600000, json: false });
  } finally {
    if (fs.existsSync(directory)) {
      assertSafeTemporaryDirectory(directory);
      fs.rmSync(directory, { recursive: true, force: false });
    }
  }
}

function assertRemote(summary, expectedVariableKeys) {
  assert(summary.status === 'Active' && summary.availableStatus === 'Available', 'feedbackAction is not Active/Available');
  assert(summary.runtime === DEFAULT_CONFIGURATION.runtime, 'feedbackAction runtime drifted');
  assert(summary.handler === DEFAULT_CONFIGURATION.handler, 'feedbackAction handler drifted');
  assert(summary.timeout === DEFAULT_CONFIGURATION.timeout, 'feedbackAction timeout drifted');
  assert(summary.memorySize === DEFAULT_CONFIGURATION.memorySize, 'feedbackAction memory drifted');
  assert(summary.sourceSha256 === APPROVED_SOURCE_SHA256, 'feedbackAction remote source hash drifted');
  assert(JSON.stringify(summary.environmentVariableKeys) === JSON.stringify(expectedVariableKeys.sort()), 'feedbackAction env key set drifted');
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !options.deploy,
    allowInactiveStagingWrite: options.deploy
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.environmentId === targets.staging && preflight.environmentId !== targets.production,
    'registered staging target is required', 'STAGING_TARGET_MISMATCH');
  const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', FUNCTION_NAME, 'index.js'));
  assert(sha256(source) === APPROVED_SOURCE_SHA256, 'feedbackAction approved source drift', 'SOURCE_FREEZE_DRIFT');
  const dependencies = dependencySummary();
  const privateConfiguration = readPrivateMailConfiguration();
  const desiredVariables = buildEnvironmentVariables(
    privateConfiguration,
    options.allowMissingMailCredentials
  );
  const before = readExisting(preflight.environmentId);
  if (!options.deploy) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      functionName: FUNCTION_NAME,
      functionExists: Boolean(before),
      credentialsReady: Boolean(privateConfiguration.FEEDBACK_MAIL_USER && privateConfiguration.FEEDBACK_MAIL_SECRET),
      desiredEnvironmentVariableKeys: Object.keys(desiredVariables).sort(),
      approvedSourceSha256: APPROVED_SOURCE_SHA256,
      dependencies,
      currentRemote: before
    };
  }
  deployOnly(preflight.environmentId, desiredVariables);
  const after = summarize(readFunctionDetail(preflight.environmentId, FUNCTION_NAME));
  assertRemote(after, Object.keys(desiredVariables));
  return {
    mode: 'deployed-and-verified',
    environment: publicSummary(preflight),
    deployedOnly: [FUNCTION_NAME],
    createdFunction: !before,
    approvedSourceSha256: APPROVED_SOURCE_SHA256,
    dependencies,
    remote: after,
    businessDataMutation: 0,
    realMailSent: false
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_STAGING_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FUNCTION_NAME,
  APPROVED_SOURCE_SHA256,
  DEFAULT_CONFIGURATION,
  parseArguments,
  readPrivateMailConfiguration,
  buildEnvironmentVariables,
  dependencySummary,
  run
};
