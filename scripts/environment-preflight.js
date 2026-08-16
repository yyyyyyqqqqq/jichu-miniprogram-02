const fs = require('fs');
const path = require('path');
const {
  ENVIRONMENT_NAMES,
  normalizeText,
  validateEnvironmentConfiguration
} = require('../config/environment');

const ROOT = path.resolve(__dirname, '..');
const WRITE_ACTIONS = Object.freeze(new Set([
  'deploy',
  'seed',
  'cleanup',
  'resource-create'
]));
const READ_ACTIONS = Object.freeze(new Set([
  'audit',
  'build',
  'preview'
]));

function assert(condition, message, code = 'ENVIRONMENT_PREFLIGHT_FAILED') {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function maskIdentifier(value) {
  const normalized = normalizeText(value);
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}***`;
  return `${normalized.slice(0, 6)}***${normalized.slice(-4)}`;
}

function clearPrivateModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch (error) {
    // A missing private file is handled by the caller as fail closed.
  }
}

function readPrivateModule(relativePath, errorCode) {
  const absolutePath = path.join(ROOT, relativePath);
  assert(fs.existsSync(absolutePath), `${relativePath} is unavailable`, errorCode);
  clearPrivateModule(absolutePath);
  return require(absolutePath);
}

function readPrivateEnvironmentConfiguration() {
  const active = readPrivateModule(
    path.join('config', 'cloud.private.js'),
    'ACTIVE_ENVIRONMENT_CONFIG_MISSING'
  );
  const targets = readPrivateModule(
    path.join('config', 'cloud.targets.private.js'),
    'ENVIRONMENT_TARGET_REGISTRY_MISSING'
  );
  const validation = validateEnvironmentConfiguration(active, targets);
  assert(validation.valid, validation.code, validation.code);
  return { active, targets, validation };
}

function readPrivateAppId() {
  const filePath = path.join(ROOT, 'project.private.config.json');
  assert(fs.existsSync(filePath), 'project.private.config.json is unavailable', 'APP_ID_UNCONFIRMED');
  const appId = normalizeText(JSON.parse(fs.readFileSync(filePath, 'utf8')).appid);
  assert(appId && !/^YOUR_/i.test(appId), 'AppID is not explicitly configured', 'APP_ID_UNCONFIRMED');
  return appId;
}

function parseArguments(argv) {
  const options = {
    environmentName: '',
    action: '',
    confirmTarget: '',
    allowProductionWrite: false,
    allowInactiveRead: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = normalizeText(argv[++index]);
    else if (value === '--action') options.action = normalizeText(argv[++index]);
    else if (value === '--confirm-target') options.confirmTarget = normalizeText(argv[++index]);
    else if (value === '--allow-production-write') options.allowProductionWrite = true;
    else if (value === '--allow-inactive-read') options.allowInactiveRead = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function runPreflight(options) {
  const environmentName = normalizeText(options && options.environmentName);
  const action = normalizeText(options && options.action);
  assert(ENVIRONMENT_NAMES.includes(environmentName), 'explicit --env production|staging is required', 'ENVIRONMENT_ROLE_REQUIRED');
  assert(WRITE_ACTIONS.has(action) || READ_ACTIONS.has(action), 'explicit supported --action is required', 'ENVIRONMENT_ACTION_REQUIRED');

  const { active, targets, validation } = readPrivateEnvironmentConfiguration();
  const appId = readPrivateAppId();
  const environmentId = targets[environmentName];
  const write = WRITE_ACTIONS.has(action);
  const activeTargetMatches = active.environmentName === environmentName
    && active.environmentId === environmentId;
  const inactiveReadAllowed = !write
    && action === 'audit'
    && options.allowInactiveRead === true;
  assert(
    activeTargetMatches || inactiveReadAllowed,
    `active client target is ${active.environmentName}, not ${environmentName}`,
    'ACTIVE_ENVIRONMENT_MISMATCH'
  );
  if (write) {
    assert(
      options.confirmTarget === maskIdentifier(environmentId),
      `confirm target with --confirm-target ${maskIdentifier(environmentId)}`,
      'TARGET_CONFIRMATION_REQUIRED'
    );
    if (environmentName === 'production') {
      assert(options.allowProductionWrite === true, 'production writes require a dedicated authorized workflow', 'PRODUCTION_WRITE_REJECTED');
    }
  }

  return {
    label: `[ENV] ${environmentName.toUpperCase()}`,
    environmentName,
    environmentId,
    environmentIdMasked: maskIdentifier(environmentId),
    appId,
    appIdMasked: maskIdentifier(appId),
    action,
    write,
    activeTargetMatches,
    targetsDistinct: validation.productionId !== validation.stagingId
  };
}

function publicSummary(result) {
  return {
    label: result.label,
    environmentName: result.environmentName,
    environmentId: result.environmentIdMasked,
    appId: result.appIdMasked,
    action: result.action,
    write: result.write,
    activeTargetMatches: result.activeTargetMatches,
    targetsDistinct: result.targetsDistinct
  };
}

if (require.main === module) {
  try {
    const result = runPreflight(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(publicSummary(result), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'ENVIRONMENT_PREFLIGHT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ROOT,
  WRITE_ACTIONS,
  READ_ACTIONS,
  assert,
  maskIdentifier,
  readPrivateEnvironmentConfiguration,
  readPrivateAppId,
  parseArguments,
  runPreflight,
  publicSummary
};
