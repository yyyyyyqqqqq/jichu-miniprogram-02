'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, runPreflight, publicSummary, assert } = require('./environment-preflight');
const { readFunctionDetail } = require('./phase-18-canary-core');
const { runCloudBase } = require('./schools/cloud-cli');
const {
  APPROVED_SOURCE_SHA256,
  DEFAULT_CONFIGURATION,
  dependencySummary
} = require('./deploy-feedback-staging');

const FUNCTION_NAME = 'feedbackAction';
const REQUIRED_ENVIRONMENT_KEYS = Object.freeze([
  'FEEDBACK_ENVIRONMENT', 'FEEDBACK_MAIL_HOST', 'FEEDBACK_MAIL_PORT',
  'FEEDBACK_MAIL_SECRET', 'FEEDBACK_MAIL_USER'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', deploy: false, authorized: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else if (value === '--allow-feedback-production-rollout') options.authorized = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'production', 'deployment accepts only --env production', 'STAGING_TARGET_REJECTED');
  if (options.deploy) assert(options.authorized, '--allow-feedback-production-rollout is required', 'PRODUCTION_AUTHORIZATION_REQUIRED');
  return options;
}

function readPrivateMailConfiguration() {
  const secrets = require('../config/cloud.secrets.private');
  const production = secrets && secrets.production && typeof secrets.production === 'object'
    ? secrets.production
    : {};
  const value = (key) => typeof production[key] === 'string' ? production[key].trim() : '';
  return {
    FEEDBACK_MAIL_HOST: value('FEEDBACK_MAIL_HOST'),
    FEEDBACK_MAIL_PORT: value('FEEDBACK_MAIL_PORT'),
    FEEDBACK_MAIL_USER: value('FEEDBACK_MAIL_USER'),
    FEEDBACK_MAIL_SECRET: value('FEEDBACK_MAIL_SECRET')
  };
}

function buildEnvironmentVariables(configuration) {
  assert(configuration.FEEDBACK_MAIL_HOST === 'smtp.qq.com', 'FEEDBACK_MAIL_HOST must be smtp.qq.com', 'MAIL_CONFIG_INVALID');
  assert(configuration.FEEDBACK_MAIL_PORT === '465', 'FEEDBACK_MAIL_PORT must be 465', 'MAIL_CONFIG_INVALID');
  assert(configuration.FEEDBACK_MAIL_USER, 'production mail username is missing', 'MAIL_CONFIG_MISSING');
  assert(configuration.FEEDBACK_MAIL_SECRET, 'production mail authorization code is missing', 'MAIL_CONFIG_MISSING');
  return {
    FEEDBACK_ENVIRONMENT: 'production',
    FEEDBACK_MAIL_HOST: configuration.FEEDBACK_MAIL_HOST,
    FEEDBACK_MAIL_PORT: configuration.FEEDBACK_MAIL_PORT,
    FEEDBACK_MAIL_USER: configuration.FEEDBACK_MAIL_USER,
    FEEDBACK_MAIL_SECRET: configuration.FEEDBACK_MAIL_SECRET
  };
}

function environmentVariables(detail) {
  return Object.fromEntries((detail && detail.Environment && detail.Environment.Variables || [])
    .map((item) => [String(item.Key || item.key || ''), String(item.Value || item.value || '')])
    .filter(([key]) => key));
}

function summarize(detail) {
  const variables = environmentVariables(detail);
  return {
    status: String(detail.Status || ''),
    availableStatus: String(detail.AvailableStatus || ''),
    runtime: String(detail.Runtime || ''),
    handler: String(detail.Handler || ''),
    timeout: Number(detail.Timeout || 0),
    memorySize: Number(detail.MemorySize || 0),
    sourceSha256: sha256(Buffer.from(String(detail.CodeInfo || ''), 'utf8')),
    environmentVariableKeys: Object.keys(variables).sort(),
    credentialsConfigured: Boolean(variables.FEEDBACK_MAIL_USER && variables.FEEDBACK_MAIL_SECRET),
    productionMarker: variables.FEEDBACK_ENVIRONMENT === 'production'
  };
}

function readExisting(environmentId) {
  try {
    return summarize(readFunctionDetail(environmentId, FUNCTION_NAME));
  } catch (error) {
    if (/RESOURCE_NOT_FOUND|Function does not exist|not found|not exist/i.test(String(error && error.message || error))) return null;
    throw error;
  }
}

function assertTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  assert(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'temporary directory escaped temp root');
  assert(path.basename(resolved).startsWith('feedback-production-deploy-'), 'temporary directory prefix mismatch');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary deploy directory is unsafe');
}

function deployOnly(environmentId, envVariables) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-production-deploy-'));
  const configPath = path.join(directory, 'cloudbaserc.json');
  try {
    assertTemporaryDirectory(directory);
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
      assertTemporaryDirectory(directory);
      fs.rmSync(directory, { recursive: true, force: false });
    }
  }
}

function assertRemote(summary) {
  assert(summary.status === 'Active' && summary.availableStatus === 'Available', 'feedbackAction is not Active/Available');
  assert(summary.runtime === DEFAULT_CONFIGURATION.runtime, 'feedbackAction runtime drifted');
  assert(summary.handler === DEFAULT_CONFIGURATION.handler, 'feedbackAction handler drifted');
  assert(summary.timeout === DEFAULT_CONFIGURATION.timeout, 'feedbackAction timeout drifted');
  assert(summary.memorySize === DEFAULT_CONFIGURATION.memorySize, 'feedbackAction memory drifted');
  assert(summary.sourceSha256 === APPROVED_SOURCE_SHA256, 'feedbackAction remote source hash drifted');
  assert(JSON.stringify(summary.environmentVariableKeys) === JSON.stringify([...REQUIRED_ENVIRONMENT_KEYS].sort()),
    'feedbackAction environment key set drifted');
  assert(summary.credentialsConfigured && summary.productionMarker, 'production mail environment is not configured');
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.deploy ? 'deploy' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: options.deploy
  });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.production,
    'active target must be registered production', 'PRODUCTION_TARGET_MISMATCH');
  assert(preflight.environmentId !== targets.staging, 'staging target is forbidden', 'STAGING_TARGET_REJECTED');
  const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', FUNCTION_NAME, 'index.js'));
  assert(sha256(source) === APPROVED_SOURCE_SHA256, 'feedbackAction approved source drift', 'SOURCE_FREEZE_DRIFT');
  const dependencies = dependencySummary();
  const variables = buildEnvironmentVariables(readPrivateMailConfiguration());
  const before = readExisting(preflight.environmentId);

  if (!options.deploy) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      functionName: FUNCTION_NAME,
      functionExists: Boolean(before),
      credentialsReady: true,
      desiredEnvironmentVariableKeys: Object.keys(variables).sort(),
      approvedSourceSha256: APPROVED_SOURCE_SHA256,
      dependencies,
      currentRemote: before,
      productionWrites: 0
    };
  }

  deployOnly(preflight.environmentId, variables);
  const after = summarize(readFunctionDetail(preflight.environmentId, FUNCTION_NAME));
  assertRemote(after);
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
  Promise.resolve().then(() => run(parseArguments(process.argv.slice(2)))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_PRODUCTION_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { FUNCTION_NAME, parseArguments, readPrivateMailConfiguration, buildEnvironmentVariables, run };
