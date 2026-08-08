const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  runCloudBase,
  assert
} = require('./phase-18-canary-core');
const {
  PRIVATE_DUAL_ACCOUNT_PATH,
  loadDualAccountPrivate,
  maskId
} = require('./phase-18-dual-account-core');
const {
  FUNCTION,
  environmentMap,
  summarize
} = require('./deploy-phase-18-school-scoped-canary');
const MarketCore = require('../cloudfunctions/productQuery/market-core');

function parseArguments(argv) {
  const options = {
    confirmTarget: '',
    deploy: false,
    privateInput: PRIVATE_DUAL_ACCOUNT_PATH
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else if (value === '--private-input') options.privateInput = path.resolve(String(argv[++index] || ''));
    else throw new Error(`unsupported argument: ${value}`);
  }
  return options;
}

function sourceAllowlist(source) {
  const start = source.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST');
  const end = source.indexOf('CURSOR_SECRET_ENV_NAME');
  assert(start >= 0 && end > start, 'allowlist source block is missing');
  return source.slice(start, end).match(/sha256:[0-9a-f]{64}/g) || [];
}

function validateSource(source, privateData) {
  assert(/SCHOOL_SCOPED_MARKET_ENABLED\s*=\s*true/.test(source), 'master switch must remain true');
  assert(/SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*false/.test(source), 'strict-for-all must remain false');
  assert(/MARKET_ACCESS_REQUIRES_AUTH\s*=\s*true/.test(source), 'market access must continue to require auth');
  const ids = sourceAllowlist(source);
  assert(ids.length === 2, 'allowlist must contain exactly two identity hashes');
  assert(new Set(ids).size === 2, 'allowlist identities must be distinct');
  const expected = [privateData.accountA.userId, privateData.accountB.userId]
    .map(MarketCore.hashAllowlistIdentity)
    .sort();
  assert(JSON.stringify([...ids].sort()) === JSON.stringify(expected), 'source allowlist does not match private accounts A and B');
  const block = source.slice(
    source.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST'),
    source.indexOf('CURSOR_SECRET_ENV_NAME')
  );
  assert(!/u_[0-9a-f]{32}/.test(block), 'allowlist source must not store full internal user IDs');
  return ids;
}

function deploy(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --confirm-target ${targetMasked}`);
  const privateData = loadDualAccountPrivate(options.privateInput);
  assert(privateData.accountA.schoolId !== privateData.accountB.schoolId, 'accounts must be bound to different schools before deployment');

  const functionPath = path.join(ROOT, 'cloudfunctions', FUNCTION.name);
  const localCode = fs.readFileSync(path.join(functionPath, 'index.js'), 'utf8');
  validateSource(localCode, privateData);
  const beforeDetail = readFunctionDetail(environmentId, FUNCTION.name);
  const beforeEnvironment = environmentMap(beforeDetail);
  assert((beforeEnvironment.PRODUCT_QUERY_CURSOR_HMAC_SECRET || '').length >= 32, 'cursor HMAC environment is missing or too short');
  assert(Object.prototype.hasOwnProperty.call(beforeEnvironment, 'PRODUCT_SEED_ENABLED'), 'PRODUCT_SEED_ENABLED is missing');
  const before = summarize(beforeDetail, localCode);
  const publicResult = {
    target: `cloud:${targetMasked}`,
    rollout: 'two-real-account-canary',
    accounts: [privateData.accountA, privateData.accountB].map((account) => ({
      userId: maskId(account.userId),
      schoolId: maskId(account.schoolId),
      schoolName: account.schoolName
    })),
    allowlistCount: 2,
    strictForAll: false,
    accessRequiresAuth: true,
    deploysOnly: [FUNCTION.name],
    writesDatabase: false,
    changesAcl: false,
    changesIndexes: false,
    changesEnvironmentVariables: false,
    before
  };
  if (!options.deploy) return { mode: 'dry-run', ...publicResult };

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-18-dual-account-deploy-'));
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [{ ...FUNCTION }]
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase(['--config-file', configPath, 'fn', 'deploy', FUNCTION.name, '--force'], {
      timeoutMs: 300000,
      json: false
    });
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    fs.rmdirSync(temporaryDirectory);
  }

  const afterDetail = readFunctionDetail(environmentId, FUNCTION.name);
  const afterEnvironment = environmentMap(afterDetail);
  const after = summarize(afterDetail, localCode);
  assert(after.status === 'Active', 'productQuery is not Active');
  assert(after.runtime === FUNCTION.runtime, 'productQuery runtime changed');
  assert(after.handler === FUNCTION.handler, 'productQuery handler changed');
  assert(after.timeout === FUNCTION.timeout && after.memorySize === FUNCTION.memorySize, 'productQuery resources changed');
  assert(after.hashMatches, 'productQuery remote code hash differs from local');
  assert(
    afterEnvironment.PRODUCT_QUERY_CURSOR_HMAC_SECRET === beforeEnvironment.PRODUCT_QUERY_CURSOR_HMAC_SECRET,
    'cursor HMAC environment was not preserved'
  );
  assert(afterEnvironment.PRODUCT_SEED_ENABLED === beforeEnvironment.PRODUCT_SEED_ENABLED, 'PRODUCT_SEED_ENABLED was not preserved');
  return {
    mode: 'deployed',
    ...publicResult,
    after,
    environmentPreserved: { cursorHmac: true, productSeedEnabled: true }
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(deploy(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE18_DUAL_ACCOUNT_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, sourceAllowlist, validateSource, deploy };
