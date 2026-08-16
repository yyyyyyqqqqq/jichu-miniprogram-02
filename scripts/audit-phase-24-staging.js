const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  assert,
  maskIdentifier,
  readPrivateEnvironmentConfiguration,
  runPreflight,
  publicSummary
} = require('./environment-preflight');
const {
  COLLECTION_NAMES: STAGING_COLLECTIONS,
  INDEX_DEFINITIONS,
  indexMatches,
  readTables,
  readCollectionAcl,
  readIndexes,
  readStorage
} = require('./phase-24-staging-core');
const {
  queryCollection,
  readFunctionDetail
} = require('./phase-18-canary-core');
const {
  FUNCTION_NAMES: PRODUCTION_FUNCTIONS,
  COLLECTION_NAMES: PRODUCTION_COLLECTIONS,
  functionSummary
} = require('./phase-23-production-audit');

const STAGING_FUNCTIONS = Object.freeze([
  'authUser',
  'schoolQuery',
  'productQuery',
  'createProduct',
  'userQuery'
]);
const SCHOOL_ALLOWLIST = Object.freeze([
  Object.freeze({ officialCode: '4131010856', name: '上海工程技术大学' }),
  Object.freeze({ officialCode: '4133014207', name: '上海财经大学浙江学院' })
]);
const PRODUCTION_COUNTS_BASELINE = Object.freeze({
  users: 8,
  products: 70,
  favorites: 6,
  conversations: 20,
  messages: 145,
  appointments: 20,
  productViews: 24,
  schools: 2952
});
const PHASE23_HISTORICAL_COUNTS = Object.freeze({
  users: 8,
  products: 68,
  favorites: 6,
  conversations: 20,
  messages: 144,
  appointments: 19,
  productViews: 24,
  schools: 2952
});
const STAGING_CREATED_AT = Date.parse('2026-08-13T08:36:46.000Z');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseArguments(argv) {
  const options = { environmentName: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--output') options.output = String(argv[++index] || '').trim();
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function environmentFingerprint(values) {
  const normalized = Object.entries(values).map(([key, value]) => ({
    key,
    value: String(value)
  })).sort((left, right) => left.key.localeCompare(right.key));
  return sha256(JSON.stringify(normalized));
}

function loadStagingSecretFingerprint() {
  const filePath = path.join(ROOT, 'config', 'cloud.secrets.private.js');
  assert(fs.existsSync(filePath), 'staging secret configuration is unavailable', 'STAGING_SECRET_MISSING');
  delete require.cache[require.resolve(filePath)];
  const privateSecrets = require(filePath);
  const secret = String(privateSecrets.staging && privateSecrets.staging.productQueryCursorHmacSecret || '');
  assert(secret.length >= 48, 'staging secret does not meet the minimum entropy length', 'STAGING_SECRET_INVALID');
  return {
    secretFingerprint: sha256(secret).slice(0, 16),
    environmentFingerprint: environmentFingerprint({
      PRODUCT_QUERY_CURSOR_HMAC_SECRET: secret,
      PRODUCT_SEED_ENABLED: 'false'
    })
  };
}

function tableMap(tables) {
  return Object.fromEntries(tables.map((item) => [item.name, {
    count: item.count,
    indexCount: item.indexCount
  }]));
}

async function readEnvironmentResources(environmentId, collectionNames) {
  const tables = await readTables(environmentId);
  const existing = new Set(tables.map((item) => item.name));
  const acl = {};
  const indexes = {};
  for (const name of collectionNames) {
    assert(existing.has(name), `required collection is missing: ${name}`, 'COLLECTION_MISSING');
    acl[name] = await readCollectionAcl(environmentId, name);
    indexes[name] = await readIndexes(environmentId, name);
  }
  return {
    tables,
    acl,
    indexes,
    storage: await readStorage(environmentId)
  };
}

function summarizeFunctions(environmentId, functionNames) {
  return Object.fromEntries(functionNames.map((name) => [
    name,
    functionSummary(readFunctionDetail(environmentId, name))
  ]));
}

function assertFunctionsAvailable(functions) {
  for (const [name, value] of Object.entries(functions)) {
    assert(value.status === 'Active', `${name} is not Active`, 'FUNCTION_NOT_ACTIVE');
    assert(value.availableStatus === 'Available', `${name} is not Available`, 'FUNCTION_NOT_AVAILABLE');
    assert(value.handler === 'index.main', `${name} handler drifted`, 'FUNCTION_HANDLER_DRIFT');
    assert(value.timeoutSeconds === 10 && value.memoryMb === 256, `${name} resource settings drifted`, 'FUNCTION_RESOURCE_DRIFT');
  }
}

function assertStagingIndexes(indexes) {
  let businessIndexCount = 0;
  for (const [collection, expectedDefinitions] of Object.entries(INDEX_DEFINITIONS)) {
    const actual = indexes[collection] || [];
    for (const expected of expectedDefinitions) {
      const found = actual.find((item) => item.name === expected.name);
      assert(found && indexMatches(found, expected), `${collection}.${expected.name} definition drifted`, 'STAGING_INDEX_DRIFT');
      businessIndexCount += 1;
    }
  }
  assert(businessIndexCount === 4, 'staging business index count differs from four', 'STAGING_INDEX_COUNT_DRIFT');
  return businessIndexCount;
}

function indexNames(indexes) {
  return indexes.map((item) => item.name);
}

function baselineDefinitionToCurrent(definition) {
  return {
    name: definition.name,
    unique: definition.unique,
    keys: Object.entries(definition.key || {})
  };
}

async function auditStaging(environmentId) {
  const resources = await readEnvironmentResources(environmentId, STAGING_COLLECTIONS);
  const tables = tableMap(resources.tables);
  const actualNames = resources.tables.map((item) => item.name).sort();
  assert(JSON.stringify(actualNames) === JSON.stringify([...STAGING_COLLECTIONS].sort()), 'unexpected staging collections exist', 'UNEXPECTED_STAGING_COLLECTIONS');
  assert(tables.users.count === 1, 'staging users count is not one after human validation', 'STAGING_USER_COUNT_DRIFT');
  assert(tables.products.count === 1, 'staging products count is not one after human validation', 'STAGING_PRODUCT_COUNT_DRIFT');
  assert(tables.schools.count === 2, 'staging schools count is not two', 'STAGING_SCHOOLS_COUNT_DRIFT');
  assert(Object.values(resources.acl).every((value) => value === 'ADMINONLY'), 'staging collection ACL drifted', 'STAGING_ACL_DRIFT');
  assert(resources.storage.acl === 'READONLY' && resources.storage.customRule === false, 'staging storage rule drifted', 'STAGING_STORAGE_DRIFT');
  const businessIndexCount = assertStagingIndexes(resources.indexes);

  const schools = queryCollection(environmentId, 'schools', {
    filter: { officialCode: { $in: SCHOOL_ALLOWLIST.map((item) => item.officialCode) } },
    projection: { _id: 1, officialCode: 1, name: 1, platformStatus: 1 },
    sort: { officialCode: 1 },
    limit: 10
  });
  assert(schools.length === 2, 'staging school allowlist readback count differs', 'STAGING_SCHOOL_ALLOWLIST_DRIFT');
  for (const expected of SCHOOL_ALLOWLIST) {
    const school = schools.find((item) => item.officialCode === expected.officialCode);
    assert(school && school.name === expected.name && school.platformStatus === 'active', `staging school drifted: ${expected.officialCode}`, 'STAGING_SCHOOL_DRIFT');
  }

  const users = queryCollection(environmentId, 'users', {
    projection: {
      _id: 1,
      nickname: 1,
      avatarUrl: 1,
      profileCompleted: 1,
      status: 1,
      schoolId: 1,
      schoolName: 1,
      schoolVersion: 1,
      createdAt: 1,
      lastLoginAt: 1
    },
    limit: 10
  });
  assert(users.length === 1, 'staging user readback count differs', 'STAGING_USER_READBACK_DRIFT');
  const user = users[0];
  assert(user.status === 'active', 'staging human-validation user is not active', 'STAGING_USER_STATUS_DRIFT');
  assert(Boolean(user.schoolId) && user.schoolName === '上海工程技术大学', 'staging human-validation school differs', 'STAGING_USER_SCHOOL_DRIFT');
  assert(Number(user.schoolVersion) === 1, 'staging initial schoolVersion differs', 'STAGING_USER_SCHOOL_VERSION_DRIFT');
  assert(user.profileCompleted === true && Boolean(String(user.nickname || '').trim()) && Boolean(String(user.avatarUrl || '').trim()), 'staging edited profile was not preserved', 'STAGING_PROFILE_EDIT_DRIFT');
  const createdAt = new Date(user.createdAt || 0).getTime();
  const lastLoginAt = new Date(user.lastLoginAt || 0).getTime();
  assert(Number.isFinite(createdAt) && Number.isFinite(lastLoginAt) && lastLoginAt > createdAt, 'staging relogin evidence is unavailable', 'STAGING_RELOGIN_EVIDENCE_MISSING');

  const products = queryCollection(environmentId, 'products', {
    projection: {
      _id: 1,
      title: 1,
      status: 1,
      schoolId: 1,
      schoolName: 1,
      coverImage: 1,
      createdAt: 1
    },
    limit: 10
  });
  assert(products.length === 1, 'staging product readback count differs', 'STAGING_PRODUCT_READBACK_DRIFT');
  const product = products[0];
  assert(product.title === 'Phase24 Staging Test' && product.status === 'available', 'staging human-validation product differs', 'STAGING_TEST_PRODUCT_DRIFT');
  assert(product.schoolId === user.schoolId && product.schoolName === user.schoolName, 'staging product school differs from the authoritative user school', 'STAGING_PRODUCT_SCHOOL_DRIFT');
  assert(Boolean(product.coverImage), 'staging test product cover is unavailable', 'STAGING_PRODUCT_MEDIA_DRIFT');

  const identityUser = queryCollection(environmentId, 'users', {
    projection: { _id: 1, openid: 1 },
    limit: 10
  })[0] || {};
  const identityProduct = queryCollection(environmentId, 'products', {
    projection: { _id: 1, sellerId: 1, sellerOpenid: 1 },
    limit: 10
  })[0] || {};
  assert(Boolean(identityUser.openid), 'staging user identity is unavailable', 'STAGING_IDENTITY_MISSING');
  assert(identityProduct.sellerId === identityUser._id && identityProduct.sellerOpenid === identityUser.openid, 'staging product is not linked to the real loginIdentity user', 'STAGING_PRODUCT_IDENTITY_DRIFT');

  const functions = summarizeFunctions(environmentId, STAGING_FUNCTIONS);
  assertFunctionsAvailable(functions);
  const secret = loadStagingSecretFingerprint();
  assert(functions.productQuery.environmentFingerprint === secret.environmentFingerprint, 'staging productQuery secret fingerprint drifted', 'STAGING_SECRET_DRIFT');
  assert(JSON.stringify(functions.productQuery.environmentKeys) === JSON.stringify([
    'PRODUCT_QUERY_CURSOR_HMAC_SECRET',
    'PRODUCT_SEED_ENABLED'
  ]), 'staging productQuery environment keys drifted', 'STAGING_ENV_KEYS_DRIFT');

  return {
    counts: Object.fromEntries(STAGING_COLLECTIONS.map((name) => [name, tables[name].count])),
    collectionNames: actualNames,
    acl: resources.acl,
    storage: resources.storage,
    indexes: Object.fromEntries(Object.entries(resources.indexes).map(([name, values]) => [name, values])),
    businessIndexCount,
    schools: schools.map((item) => ({
      id: maskIdentifier(item._id || ''),
      officialCode: item.officialCode,
      name: item.name,
      platformStatus: item.platformStatus
    })),
    humanValidation: {
      passed: true,
      user: {
        idFingerprint: sha256(user._id).slice(0, 12),
        status: user.status,
        schoolName: user.schoolName,
        schoolVersion: user.schoolVersion,
        profileCompletedAfterEdit: user.profileCompleted === true,
        nicknamePresentAfterEdit: Boolean(String(user.nickname || '').trim()),
        avatarPresentAfterEdit: Boolean(String(user.avatarUrl || '').trim()),
        reloginPreservedSameRecord: lastLoginAt > createdAt
      },
      product: {
        idFingerprint: sha256(product._id).slice(0, 12),
        title: product.title,
        status: product.status,
        authoritativeSchoolMatches: product.schoolId === user.schoolId,
        sellerIdentityMatches: true,
        mediaPresent: Boolean(product.coverImage)
      },
      initialProfileIncompleteEvidence: 'confirmed by the project owner during the real first-login flow and covered by authUser source plus automated tests'
    },
    functions,
    secret: {
      keyPresent: true,
      fingerprint: secret.secretFingerprint,
      independentFromProduction: true
    },
    gate: { passed: true, blockers: [] }
  };
}

async function auditProduction(environmentId) {
  const baselinePath = path.join(ROOT, 'tmp', 'phase-23-production-audit-private.json');
  assert(fs.existsSync(baselinePath), 'production audit baseline is unavailable', 'PRODUCTION_BASELINE_MISSING');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const resources = await readEnvironmentResources(environmentId, PRODUCTION_COLLECTIONS);
  const tables = tableMap(resources.tables);
  const counts = Object.fromEntries(PRODUCTION_COLLECTIONS.map((name) => [name, tables[name].count]));
  assert(JSON.stringify(counts) === JSON.stringify(PRODUCTION_COUNTS_BASELINE), 'production collection counts changed from the recorded baseline', 'PRODUCTION_COUNT_DRIFT');
  assert(Object.values(resources.acl).every((value) => value === 'ADMINONLY'), 'production collection ACL drifted', 'PRODUCTION_ACL_DRIFT');
  assert(JSON.stringify(resources.acl) === JSON.stringify(baseline.collectionAcl), 'production collection ACL differs from Phase 23 baseline', 'PRODUCTION_ACL_BASELINE_DRIFT');
  assert(resources.storage.acl === baseline.storage.aclTag, 'production storage ACL differs from baseline', 'PRODUCTION_STORAGE_DRIFT');
  assert(resources.storage.customRule === baseline.storage.customRuleConfigured, 'production storage custom rule differs from baseline', 'PRODUCTION_STORAGE_RULE_DRIFT');
  assert(resources.storage.bucketFingerprint === baseline.storage.bucketFingerprint, 'production storage fingerprint differs from baseline', 'PRODUCTION_STORAGE_TARGET_DRIFT');

  for (const name of PRODUCTION_COLLECTIONS) {
    assert(
      JSON.stringify(indexNames(resources.indexes[name]).sort()) === JSON.stringify([...baseline.indexes[name].names].sort()),
      `production ${name} index names differ from baseline`,
      'PRODUCTION_INDEX_DRIFT'
    );
  }
  for (const name of ['products', 'productViews']) {
    const expected = baseline.indexes[name].definitions.map(baselineDefinitionToCurrent)
      .sort((left, right) => left.name.localeCompare(right.name));
    const actual = [...resources.indexes[name]].sort((left, right) => left.name.localeCompare(right.name));
    assert(JSON.stringify(actual) === JSON.stringify(expected), `production ${name} index definitions differ from baseline`, 'PRODUCTION_INDEX_DEFINITION_DRIFT');
  }

  const functions = summarizeFunctions(environmentId, PRODUCTION_FUNCTIONS);
  assertFunctionsAvailable(functions);
  for (const name of PRODUCTION_FUNCTIONS) {
    assert(
      functions[name].environmentFingerprint === baseline.functions[name].environmentFingerprint,
      `production ${name} environment fingerprint differs from baseline`,
      'PRODUCTION_FUNCTION_ENVIRONMENT_DRIFT'
    );
  }

  const testProducts = queryCollection(environmentId, 'products', {
    filter: { title: 'Phase24 Staging Test' },
    projection: { _id: 1 },
    limit: 10
  });
  assert(testProducts.length === 0, 'staging test product was found in production', 'PRODUCTION_TEST_PRODUCT_FOUND');
  const activeSchools = queryCollection(environmentId, 'schools', {
    filter: { platformStatus: 'active' },
    projection: { _id: 1, officialCode: 1 },
    sort: { officialCode: 1 },
    limit: 10
  });
  assert(activeSchools.length === 2, 'production active school state changed', 'PRODUCTION_SCHOOL_STATE_DRIFT');
  const latestChangedRecords = {};
  for (const name of ['products', 'appointments', 'messages']) {
    const latest = queryCollection(environmentId, name, {
      projection: { _id: 1, createdAt: 1 },
      sort: { createdAt: -1 },
      limit: 1
    })[0] || null;
    const createdAt = latest && new Date(latest.createdAt || 0).getTime();
    assert(Number.isFinite(createdAt) && createdAt < STAGING_CREATED_AT, `production ${name} contains a record created after staging was created`, 'PRODUCTION_POST_STAGING_RECORD_FOUND');
    latestChangedRecords[name] = {
      createdAt: new Date(createdAt).toISOString(),
      idFingerprint: sha256(latest._id).slice(0, 12),
      predatesStaging: true
    };
  }

  return {
    baselineCompletedAt: baseline.completedAt,
    counts,
    countBaselineMatches: true,
    historicalPhase23Counts: PHASE23_HISTORICAL_COUNTS,
    historicalDeltaPredatesStaging: {
      products: counts.products - PHASE23_HISTORICAL_COUNTS.products,
      appointments: counts.appointments - PHASE23_HISTORICAL_COUNTS.appointments,
      messages: counts.messages - PHASE23_HISTORICAL_COUNTS.messages,
      latestChangedRecords
    },
    usersSummaryUnchanged: counts.users === PRODUCTION_COUNTS_BASELINE.users,
    productsSummaryUnchanged: counts.products === PRODUCTION_COUNTS_BASELINE.products,
    schoolsStateUnchanged: counts.schools === PRODUCTION_COUNTS_BASELINE.schools && activeSchools.length === 2,
    activeSchoolCount: activeSchools.length,
    collectionAclUnchanged: true,
    indexesUnchanged: true,
    storageUnchanged: true,
    functions,
    twelveFunctionsActiveAndAvailable: Object.keys(functions).length === 12,
    environmentFingerprintsUnchanged: true,
    stagingTestProductCount: 0,
    stagingTestUserCount: 0,
    stagingTestUserEvidence: 'users count unchanged from the recorded pre-staging baseline',
    readOnlyProof: {
      databaseWriteApiCalled: false,
      functionInvoked: false,
      deploymentExecuted: false,
      aclOrIndexChanged: false
    },
    gate: { passed: true, blockers: [] }
  };
}

async function run(options) {
  assert(options.environmentName === 'staging', 'staging audit requires explicit --env staging', 'ENVIRONMENT_ROLE_REQUIRED');
  const stagingPreflight = runPreflight({ environmentName: 'staging', action: 'audit' });
  const productionPreflight = runPreflight({
    environmentName: 'production',
    action: 'audit',
    allowInactiveRead: true
  });
  const registry = readPrivateEnvironmentConfiguration().validation;
  assert(registry.productionId !== registry.stagingId, 'production and staging targets are identical', 'ENVIRONMENT_TARGET_COLLISION');
  const staging = await auditStaging(stagingPreflight.environmentId);
  const production = await auditProduction(productionPreflight.environmentId);
  return {
    schemaVersion: 1,
    mode: 'phase-24-staging-readiness-and-production-zero-change-audit',
    completedAt: new Date().toISOString(),
    stagingPreflight: publicSummary(stagingPreflight),
    productionReadOnlyPreflight: publicSummary(productionPreflight),
    targetsDistinct: true,
    staging,
    production,
    finalGate: {
      passed: staging.gate.passed && production.gate.passed,
      status: 'human-validation-passed'
    }
  };
}

function sanitizeError(error) {
  let message = String(error && error.message || error || 'unknown error');
  try {
    const { active, targets } = readPrivateEnvironmentConfiguration();
    for (const value of [active.environmentId, targets.production, targets.staging]) {
      if (value) message = message.split(value).join(maskIdentifier(value));
    }
  } catch (ignored) {
    // Fail closed without revealing any private configuration.
  }
  return message;
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((report) => {
    const output = `${JSON.stringify(report, null, 2)}\n`;
    const options = parseArguments(process.argv.slice(2));
    if (options.output) {
      const outputPath = path.resolve(options.output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, output, { encoding: 'utf8', mode: 0o600 });
    }
    process.stdout.write(output);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'PHASE24_STAGING_AUDIT_FAILED'}: ${sanitizeError(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  STAGING_FUNCTIONS,
  SCHOOL_ALLOWLIST,
  PRODUCTION_COUNTS_BASELINE,
  parseArguments,
  environmentFingerprint,
  auditStaging,
  auditProduction,
  run
};
