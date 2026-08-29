const {
  AUTHORIZATION_PHRASE,
  REQUIRED_INDEXES,
  readIndexes,
  assert,
  publicSummary
} = require('./final-release-step-3b-core');
const { runPreflight, maskIdentifier } = require('./environment-preflight');
const {
  createIndexes,
  indexMatches,
  delay
} = require('./phase-24-staging-core');
const {
  runNoSql,
  extractCommandResults,
  extractDocuments
} = require('./schools/cloud-cli');

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', authorization: '', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--authorization') options.authorization = String(argv[++index] || '').trim();
    else if (value === '--apply') options.apply = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function extractRows(response) {
  const results = extractCommandResults(response);
  return results.length > 0
    ? results.flatMap((item) => extractDocuments(item))
    : extractDocuments(response);
}

function querySmoke(environmentId, definition) {
  const provinceScoped = definition.name === 'idx_school_active_province_name_id';
  const officialCodeScoped = definition.name === 'idx_officialCode_unique';
  const filter = officialCodeScoped
    ? { officialCode: '4131010856' }
    : {
      platformStatus: 'active',
      officialStatus: 'valid',
      ...(provinceScoped ? { province: '上海市' } : {})
    };
  const sort = officialCodeScoped
    ? { officialCode: 1 }
    : {
      ...(provinceScoped ? { province: 1 } : {}),
      nameNormalized: 1,
      _id: 1
    };
  const response = runNoSql(environmentId, [{
    TableName: 'schools',
    CommandType: 'QUERY',
    Command: JSON.stringify({
      find: 'schools',
      filter,
      projection: { _id: 1, officialCode: 1, platformStatus: 1, officialStatus: 1 },
      sort,
      limit: 2
    })
  }]);
  const rows = extractRows(response);
  assert(rows.length > 0, `${definition.name} query smoke returned no rows`, 'INDEX_QUERY_SMOKE_FAILED');
  assert(rows.every((row) => row.officialStatus === 'valid' && row.platformStatus === 'active'), `${definition.name} query smoke exposed invalid row`, 'INDEX_QUERY_SMOKE_FAILED');
  return { passed: true, rows: rows.length };
}

async function waitUntilOperational(environmentId, definition) {
  let lastError;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const indexes = await readIndexes(environmentId, 'schools');
      const actual = indexes.find((index) => index.name === definition.name);
      assert(indexMatches(actual || {}, definition), `${definition.name} definition mismatch`, 'INDEX_DEFINITION_DRIFT');
      const smoke = querySmoke(environmentId, definition);
      return { attempts: attempt, smoke };
    } catch (error) {
      lastError = error;
      if (attempt < 60) await delay(10000);
    }
  }
  throw lastError || Object.assign(new Error(`${definition.name} did not become operational`), { code: 'INDEX_NOT_READY' });
}

async function run(options) {
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  const preflight = runPreflight({
    environmentName: 'production',
    action: options.apply ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget,
    allowProductionWrite: options.apply
  });
  if (options.apply) assert(options.authorization === AUTHORIZATION_PHRASE, 'exact Step 3B authorization phrase is required', 'OWNER_AUTHORIZATION_REQUIRED');
  const before = await readIndexes(preflight.environmentId, 'schools');
  const beforeByName = new Map(before.map((index) => [index.name, index]));
  for (const definition of REQUIRED_INDEXES) {
    const actual = beforeByName.get(definition.name);
    assert(!actual || indexMatches(actual, definition), `${definition.name} definition drift`, 'INDEX_DEFINITION_DRIFT');
  }
  const missing = REQUIRED_INDEXES.filter((definition) => !beforeByName.has(definition.name));
  if (!options.apply) {
    return {
      mode: 'dry-run',
      environment: publicSummary(preflight),
      existing: before.map((index) => index.name),
      wouldCreateSequentially: missing.map((definition) => definition.name),
      required: REQUIRED_INDEXES.map((definition) => definition.name)
    };
  }
  const created = [];
  const readiness = {};
  for (const definition of REQUIRED_INDEXES) {
    if (!beforeByName.has(definition.name)) {
      await createIndexes(preflight.environmentId, 'schools', [definition]);
      created.push(definition.name);
    }
    readiness[definition.name] = await waitUntilOperational(preflight.environmentId, definition);
  }
  const after = await readIndexes(preflight.environmentId, 'schools');
  const afterByName = new Map(after.map((index) => [index.name, index]));
  for (const definition of REQUIRED_INDEXES) {
    assert(indexMatches(afterByName.get(definition.name) || {}, definition), `${definition.name} verification failed`, 'INDEX_VERIFICATION_FAILED');
  }
  return {
    mode: created.length ? 'created-sequentially-and-verified' : 'verified-idempotent',
    environment: publicSummary(preflight),
    created,
    required: REQUIRED_INDEXES.map((definition) => definition.name),
    readiness,
    allOperational: true,
    aclChanged: false
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
      // Environment configuration failures are already fail-closed.
    }
    process.stderr.write(`${error.code || 'STEP3B_INDEX_FAILED'}: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, querySmoke, waitUntilOperational, run };
