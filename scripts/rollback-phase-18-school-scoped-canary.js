const fs = require('fs');
const path = require('path');
const { deploy } = require('./deploy-phase-18-final-cutover');
const {
  ROOT,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  assert
} = require('./phase-18-canary-core');

function buildRollbackDryRun(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --confirm-target ${targetMasked}`);
  const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'productQuery', 'index.js'), 'utf8');
  const block = source.slice(
    source.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST'),
    source.indexOf('CURSOR_SECRET_ENV_NAME')
  );
  const detail = readFunctionDetail(environmentId, 'productQuery');
  return {
    mode: 'dry-run',
    target: `cloud:${targetMasked}`,
    functionName: 'productQuery',
    currentLocalConfig: {
      enabled: /SCHOOL_SCOPED_MARKET_ENABLED\s*=\s*true/.test(source),
      strictForAll: /SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*true/.test(source),
      accessRequiresAuth: /MARKET_ACCESS_REQUIRES_AUTH\s*=\s*true/.test(source),
      allowlistCount: (block.match(/(?:u_[0-9a-f]{32}|sha256:[0-9a-f]{64})/g) || []).length
    },
    requiredSourceConfig: {
      enabled: false,
      strictForAll: false,
      accessRequiresAuth: false,
      allowlistCount: 0
    },
    deploymentWouldRequire: [
      'apply an explicit source patch for false/false/auth-off/empty allowlist',
      'rerun automatic verification',
      'pass --deploy with the same confirmed target'
    ],
    wouldDeployOnly: ['productQuery'],
    functionStatus: detail.Status || '',
    writesExecuted: false,
    deploymentExecuted: false,
    environmentVariablesWouldChange: false,
    indexesWouldChange: false,
    permissionsWouldChange: false
  };
}

if (require.main === module) {
  try {
    const options = { confirmTarget: '', targetConfig: 'legacy', deploy: false };
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (value === '--confirm-target') options.confirmTarget = String(args[++index] || '').trim();
      else if (value === '--target-config') {
        const targetConfig = String(args[++index] || '').trim();
        assert(targetConfig === 'legacy', 'rollback only accepts --target-config legacy');
      } else if (value === '--deploy') options.deploy = true;
      else throw new Error(`unsupported argument: ${value}`);
    }
    const result = options.deploy ? deploy(options) : buildRollbackDryRun(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE18_CANARY_ROLLBACK_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildRollbackDryRun };
