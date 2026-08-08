const fs = require('fs');
const path = require('path');
const readiness = require('./audit-phase-18-user-school-readiness');
const {
  ROOT,
  PRIVATE_SNAPSHOT_PATH,
  sourceConfig,
  functionSummary,
  readProductIndexes,
  readProductsAcl,
  loadEnvironmentId,
  maskEnvironmentId,
  readFunctionDetail,
  assert
} = require('./phase-18-final-cutover-core');

function parseArguments(argv) {
  const options = { confirmTarget: '', output: PRIVATE_SNAPSHOT_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--output') options.output = path.resolve(String(argv[++index] || ''));
    else throw new Error(`unsupported argument: ${value}`);
  }
  return options;
}

async function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --confirm-target ${targetMasked}`);
  const functions = {};
  for (const name of ['productQuery', 'authUser', 'manageProduct']) {
    const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions', name, 'index.js'), 'utf8');
    functions[name] = functionSummary(readFunctionDetail(environmentId, name), source);
  }
  const indexes = readProductIndexes(environmentId);
  const productsAcl = await readProductsAcl(environmentId);
  const readinessReport = readiness.runAudit({ confirmTarget: targetMasked });
  const productQuerySource = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'productQuery', 'index.js'), 'utf8');
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    targetEnvironmentId: environmentId,
    sourceConfig: sourceConfig(productQuerySource),
    functions,
    environment: {
      cursorHmacPresent: functions.productQuery.cursorHmacPresent,
      cursorHmacLengthQualified: functions.productQuery.cursorHmacLengthQualified,
      productSeedEnabled: functions.productQuery.productSeedEnabled
    },
    database: {
      productsAcl,
      productIndexCount: indexes.length,
      productIndexNames: indexes.map((item) => item.name)
    },
    readiness: readinessReport,
    privacy: {
      cursorHmacValueStored: false,
      openidStored: false,
      privateSnapshotIgnored: true
    }
  };
  assert(productsAcl === 'ADMINONLY', 'products ACL is not ADMINONLY');
  assert(indexes.length === 19, 'products index count is not 19');
  assert(functions.productQuery.cursorHmacLengthQualified, 'cursor HMAC is missing or too short');
  assert(functions.productQuery.productSeedEnabled === 'false', 'product seed must remain disabled');
  assert(readinessReport.decision.strictForAllRecommendedNow === true, 'readiness does not permit strict-for-all');
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    passed: true,
    target: `cloud:${targetMasked}`,
    sourceConfig: snapshot.sourceConfig,
    functions: Object.fromEntries(Object.entries(functions).map(([name, value]) => [name, {
      status: value.status,
      hashMatches: value.hashMatches,
      localSha256: value.localSha256,
      remoteSha256: value.remoteSha256
    }])),
    cursorHmacPresent: true,
    cursorHmacLengthQualified: true,
    productSeedEnabled: false,
    productsAcl,
    productIndexCount: indexes.length,
    usersReady: `${readinessReport.users.validActiveSchool}/${readinessReport.users.total}`,
    publicProductsReady: `${readinessReport.products.publicStrictReady}/${readinessReport.products.publicTotal}`,
    snapshotPath: path.relative(ROOT, options.output),
    snapshotIgnored: true
  };
}

run(parseArguments(process.argv.slice(2))).then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error.code || 'PHASE18_FINAL_CUTOVER_AUDIT_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { parseArguments, run };
