const {
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const {
  COLLECTION_NAMES,
  INDEX_DEFINITIONS,
  indexMatches,
  readResourceSnapshot,
  createCollection,
  setCollectionAcl,
  createIndexes,
  setStorageReadonly,
  delay
} = require('./phase-24-staging-core');

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

function resourcePlan(snapshot) {
  const existingNames = snapshot.tables.map((item) => item.name);
  const unexpectedCollections = existingNames.filter((name) => !COLLECTION_NAMES.includes(name));
  const missingCollections = COLLECTION_NAMES.filter((name) => !existingNames.includes(name));
  const aclChanges = COLLECTION_NAMES.filter((name) => (
    existingNames.includes(name) && snapshot.acl[name] !== 'ADMINONLY'
  ));
  const indexChanges = {};
  for (const [collectionName, definitions] of Object.entries(INDEX_DEFINITIONS)) {
    if (!existingNames.includes(collectionName)) {
      indexChanges[collectionName] = definitions;
      continue;
    }
    const actual = snapshot.indexes[collectionName] || [];
    const byName = new Map(actual.map((item) => [item.name, item]));
    for (const definition of definitions) {
      const sameName = byName.get(definition.name);
      assert(!sameName || indexMatches(sameName, definition), `${collectionName}.${definition.name} definition drift`, 'INDEX_DEFINITION_DRIFT');
    }
    indexChanges[collectionName] = definitions.filter((definition) => !byName.has(definition.name));
  }
  return {
    unexpectedCollections,
    missingCollections,
    aclChanges,
    indexChanges,
    storageChange: snapshot.storage.acl !== 'READONLY'
  };
}

async function waitForCollections(environmentId) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const snapshot = await readResourceSnapshot(environmentId);
    if (COLLECTION_NAMES.every((name) => snapshot.tables.some((item) => item.name === name))) return snapshot;
    await delay(2000);
  }
  throw Object.assign(new Error('collections did not become readable in time'), { code: 'COLLECTION_INITIALIZATION_TIMEOUT' });
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.apply ? 'resource-create' : 'audit',
    confirmTarget: options.confirmTarget
  });
  assert(preflight.environmentName === 'staging', 'resource setup only supports staging', 'PRODUCTION_WRITE_REJECTED');
  const before = await readResourceSnapshot(preflight.environmentId);
  const plan = resourcePlan(before);
  assert(plan.unexpectedCollections.length === 0, `unexpected collections: ${plan.unexpectedCollections.join(',')}`, 'UNEXPECTED_COLLECTIONS');
  if (!options.apply) {
    return {
      mode: 'dry-run',
      preflight: publicSummary(preflight),
      before: {
        tables: before.tables,
        storage: before.storage,
        acl: before.acl,
        indexNames: Object.fromEntries(Object.entries(before.indexes).map(([name, indexes]) => [name, indexes.map((item) => item.name)]))
      },
      wouldCreateCollections: plan.missingCollections,
      wouldSetAclAdminOnly: [...new Set([...plan.missingCollections, ...plan.aclChanges])],
      wouldCreateIndexes: Object.fromEntries(Object.entries(plan.indexChanges).map(([name, indexes]) => [name, indexes.map((item) => item.name)])),
      wouldSetStorageReadonly: plan.storageChange
    };
  }

  for (const name of plan.missingCollections) await createCollection(preflight.environmentId, name);
  let current = plan.missingCollections.length ? await waitForCollections(preflight.environmentId) : before;
  for (const name of COLLECTION_NAMES) {
    if (current.acl[name] !== 'ADMINONLY') await setCollectionAcl(preflight.environmentId, name);
  }
  current = await readResourceSnapshot(preflight.environmentId);
  const afterAclPlan = resourcePlan(current);
  for (const [name, definitions] of Object.entries(afterAclPlan.indexChanges)) {
    if (definitions.length) await createIndexes(preflight.environmentId, name, definitions);
  }
  if (current.storage.acl !== 'READONLY') setStorageReadonly(preflight.environmentId);
  await delay(2000);
  const after = await readResourceSnapshot(preflight.environmentId);
  const finalPlan = resourcePlan(after);
  assert(finalPlan.missingCollections.length === 0, 'required collection missing after apply');
  assert(finalPlan.aclChanges.length === 0, 'collection ACL verification failed');
  assert(Object.values(finalPlan.indexChanges).every((items) => items.length === 0), 'index verification failed');
  assert(after.storage.acl === 'READONLY', 'storage ACL verification failed');
  assert(after.tables.every((table) => table.count === 0), 'staging collections must be empty before school seed', 'STAGING_NOT_EMPTY');
  return {
    mode: 'applied-and-verified',
    preflight: publicSummary(preflight),
    collections: after.tables,
    acl: after.acl,
    indexes: Object.fromEntries(Object.entries(after.indexes).map(([name, indexes]) => [name, indexes])),
    storage: after.storage
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'PHASE24_STAGING_RESOURCE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, resourcePlan, run };
