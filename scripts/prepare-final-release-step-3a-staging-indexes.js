const {
  runPreflight,
  publicSummary,
  assert,
  maskIdentifier
} = require('./environment-preflight');
const {
  INDEX_DEFINITIONS,
  readIndexes,
  createIndexes,
  indexMatches
} = require('./phase-24-staging-core');

const REQUIRED_INDEX_NAMES = Object.freeze([
  'idx_officialCode_unique',
  'idx_school_active_name_id',
  'idx_school_active_province_name_id'
]);

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--apply') options.apply = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

async function run(options) {
  assert(options.environmentName === 'staging', '--env staging is required', 'PRODUCTION_WRITE_REJECTED');
  const preflight = runPreflight({
    environmentName: 'staging',
    action: options.apply ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget,
    allowInactiveRead: !options.apply,
    allowInactiveStagingWrite: options.apply
  });
  const definitions = INDEX_DEFINITIONS.schools.filter((item) => REQUIRED_INDEX_NAMES.includes(item.name));
  assert(definitions.length === REQUIRED_INDEX_NAMES.length, 'required school index definitions are incomplete', 'INDEX_DEFINITION_MISSING');
  const before = await readIndexes(preflight.environmentId, 'schools');
  const byName = new Map(before.map((item) => [item.name, item]));
  for (const definition of definitions) {
    const actual = byName.get(definition.name);
    assert(!actual || indexMatches(actual, definition), `${definition.name} definition drift`, 'INDEX_DEFINITION_DRIFT');
  }
  const missing = definitions.filter((definition) => !byName.has(definition.name));
  if (!options.apply) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      existingIndexNames: before.map((item) => item.name),
      wouldCreate: missing.map((item) => item.name),
      collection: 'schools',
      productionChanges: 0
    };
  }
  if (missing.length) await createIndexes(preflight.environmentId, 'schools', missing);
  const after = await readIndexes(preflight.environmentId, 'schools');
  const afterByName = new Map(after.map((item) => [item.name, item]));
  for (const definition of definitions) {
    assert(indexMatches(afterByName.get(definition.name) || {}, definition), `${definition.name} verification failed`, 'INDEX_VERIFICATION_FAILED');
  }
  return {
    mode: missing.length ? 'applied-and-verified' : 'verified-idempotent',
    environment: publicSummary(preflight),
    created: missing.map((item) => item.name),
    required: REQUIRED_INDEX_NAMES,
    collection: 'schools',
    productionChanges: 0
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    let message = String(error && error.message || error);
    try {
      const targets = require('../config/cloud.targets.private');
      for (const id of Object.values(targets).filter(Boolean)) message = message.split(id).join(maskIdentifier(id));
    } catch (ignored) {
      // Target registry errors are already fail-closed.
    }
    process.stderr.write(`${error.code || 'STEP3A_STAGING_INDEX_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { REQUIRED_INDEX_NAMES, parseArguments, run };
