const fs = require('fs');
const os = require('os');
const path = require('path');
const readiness = require('./audit-phase-18-user-school-readiness');
const {
  ROOT,
  PRODUCT_QUERY,
  FINAL_CONFIG,
  LEGACY_CONFIG,
  sourceConfig,
  assertConfig,
  functionSummary,
  environmentMap,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  assert
} = require('./phase-18-final-cutover-core');
const { runCloudBase } = require('./phase-18-canary-core');

function parseArguments(argv) {
  const options = { confirmTarget: '', targetConfig: '', deploy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--target-config') options.targetConfig = String(argv[++index] || '').trim();
    else if (value === '--deploy') options.deploy = true;
    else throw new Error(`unsupported argument: ${value}`);
  }
  assert(['final', 'legacy'].includes(options.targetConfig), 'explicit --target-config final|legacy is required');
  return options;
}

function expectedConfig(name) {
  return name === 'final' ? FINAL_CONFIG : LEGACY_CONFIG;
}

function deploy(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --confirm-target ${targetMasked}`);
  const sourcePath = path.join(ROOT, 'cloudfunctions', PRODUCT_QUERY.name, 'index.js');
  const localSource = fs.readFileSync(sourcePath, 'utf8');
  const localConfig = sourceConfig(localSource);
  assertConfig(localConfig, expectedConfig(options.targetConfig), `${options.targetConfig} source`);

  let readinessGate = null;
  if (options.targetConfig === 'final') {
    const report = readiness.runAudit({ confirmTarget: targetMasked });
    assert(report.decision.strictForAllRecommendedNow === true, 'strict-for-all readiness gate failed');
    readinessGate = {
      users: `${report.users.validActiveSchool}/${report.users.total}`,
      publicProducts: `${report.products.publicStrictReady}/${report.products.publicTotal}`,
      noWriteProof: report.noWriteProof.projectedHashesUnchanged === true
    };
  }

  const beforeDetail = readFunctionDetail(environmentId, PRODUCT_QUERY.name);
  const beforeEnvironment = environmentMap(beforeDetail);
  assert((beforeEnvironment.PRODUCT_QUERY_CURSOR_HMAC_SECRET || '').length >= 32, 'cursor HMAC environment is missing or too short');
  assert(Object.prototype.hasOwnProperty.call(beforeEnvironment, 'PRODUCT_SEED_ENABLED'), 'PRODUCT_SEED_ENABLED is missing');
  assert(beforeEnvironment.PRODUCT_SEED_ENABLED === 'false', 'PRODUCT_SEED_ENABLED must remain false');
  const before = functionSummary(beforeDetail, localSource);
  const publicResult = {
    target: `cloud:${targetMasked}`,
    targetConfig: options.targetConfig,
    sourceConfig: localConfig,
    deploysOnly: [PRODUCT_QUERY.name],
    databaseWrites: false,
    changesAcl: false,
    changesIndexes: false,
    changesEnvironmentVariables: false,
    readinessGate,
    before
  };
  if (!options.deploy) return { mode: 'dry-run', ...publicResult };

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-18-final-cutover-'));
  const configPath = path.join(temporaryDirectory, 'cloudbaserc.json');
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      envId: environmentId,
      functionRoot: 'cloudfunctions',
      functions: [{ ...PRODUCT_QUERY }]
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCloudBase(['--config-file', configPath, 'fn', 'deploy', PRODUCT_QUERY.name, '--force'], {
      timeoutMs: 300000,
      json: false
    });
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    fs.rmdirSync(temporaryDirectory);
  }

  const afterDetail = readFunctionDetail(environmentId, PRODUCT_QUERY.name);
  const afterEnvironment = environmentMap(afterDetail);
  const after = functionSummary(afterDetail, localSource);
  assert(after.status === 'Active', 'productQuery is not Active');
  assert(after.runtime === PRODUCT_QUERY.runtime, 'productQuery runtime changed');
  assert(after.handler === PRODUCT_QUERY.handler, 'productQuery handler changed');
  assert(after.timeout === PRODUCT_QUERY.timeout && after.memorySize === PRODUCT_QUERY.memorySize, 'productQuery resources changed');
  assert(after.hashMatches, 'productQuery remote code differs from local');
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
    process.stderr.write(`${error.code || 'PHASE18_FINAL_CUTOVER_DEPLOY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, expectedConfig, deploy };
