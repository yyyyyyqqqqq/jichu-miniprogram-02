const path = require('path');
const {
  ROOT,
  FIXTURE_PREFIX,
  PRIVATE_CANARY_PATH,
  loadEnvironmentId,
  maskEnvironmentId,
  loadJson,
  queryCollection,
  writePrivateJson,
  runNoSql,
  assert,
  normalizeText
} = require('./phase-18-canary-core');

const OUTPUT_PATH = path.join(ROOT, 'tmp', 'phase-18-fixture-closure-private.json');
const PUBLIC_STATUSES = new Set(['available', 'reserved']);
const OPERATION_ID = 'phase18-fifth-round-offline-fixtures-v1';

function aggregateStatuses(records) {
  return Object.fromEntries([...records.reduce((map, record) => {
    const status = normalizeText(record.status) || '(missing)';
    map.set(status, (map.get(status) || 0) + 1);
    return map;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

function parseArguments(argv) {
  const options = {
    confirmTarget: '',
    applyOffline: false,
    privateInput: PRIVATE_CANARY_PATH,
    output: OUTPUT_PATH
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') options.confirmTarget = normalizeText(argv[++index]);
    else if (value === '--apply-offline') options.applyOffline = true;
    else if (value === '--private-input') options.privateInput = path.resolve(normalizeText(argv[++index]));
    else if (value === '--output') options.output = path.resolve(normalizeText(argv[++index]));
    else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

function readState(environmentId, privateData) {
  const expected = Array.isArray(privateData.fixtures) ? privateData.fixtures : [];
  assert(expected.length === 20, 'private fixture manifest must contain exactly 20 items');
  const ids = expected.map((item) => item.productId);
  assert(new Set(ids).size === 20, 'private fixture IDs are not unique');
  const products = queryCollection(environmentId, 'products', {
    filter: { _id: { $in: ids } },
    projection: {
      _id: 1,
      title: 1,
      sellerId: 1,
      status: 1,
      schoolId: 1,
      schoolName: 1,
      version: 1
    },
    limit: 100
  });
  assert(products.length === expected.length, 'fixture readback count mismatch');
  const manifestById = new Map(expected.map((item) => [item.productId, item]));
  products.forEach((product) => {
    const manifest = manifestById.get(product._id);
    assert(manifest, 'unexpected product entered the fixture set');
    assert(product.sellerId === privateData.userId, 'fixture owner mismatch');
    assert(product.title === manifest.title && product.title.startsWith(FIXTURE_PREFIX), 'fixture title mismatch');
  });
  const appointments = queryCollection(environmentId, 'appointments', {
    filter: { productId: { $in: ids } },
    projection: { _id: 1, productId: 1, status: 1, isDeleted: 1 },
    limit: 1000
  });
  const activeAppointments = appointments.filter((item) => (
    item.isDeleted !== true && ['pending', 'accepted'].includes(item.status)
  ));
  assert(activeAppointments.length === 0, 'fixture has an active appointment and cannot be offlined');
  return { products, appointments, activeAppointments };
}

function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, `confirm target with --confirm-target ${targetMasked}`);
  const privateData = loadJson(options.privateInput);
  const before = readState(environmentId, privateData);
  const candidates = before.products.filter((product) => PUBLIC_STATUSES.has(product.status));
  if (!options.applyOffline) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      operationId: OPERATION_ID,
      fixtureCount: before.products.length,
      currentStatuses: aggregateStatuses(before.products),
      wouldOffline: candidates.length,
      activeAppointments: 0,
      writesExecuted: false,
      schoolFieldsWouldChange: false,
      deletesWouldExecute: false
    };
  }

  const updates = candidates.map((product) => ({
    q: {
      _id: product._id,
      sellerId: privateData.userId,
      title: product.title,
      status: product.status,
      version: product.version
    },
    u: {
      $set: {
        status: 'offline',
        phase18FixtureClosure: {
          operationId: OPERATION_ID,
          reason: 'fifth-round-public-market-cleanup'
        }
      },
      $inc: { version: 1 },
      $currentDate: { offlineAt: true, updatedAt: true }
    },
    multi: false,
    upsert: false
  }));
  for (let offset = 0; offset < updates.length; offset += 4) {
    runNoSql(environmentId, [{
      TableName: 'products',
      CommandType: 'UPDATE',
      Command: JSON.stringify({
        update: 'products',
        updates: updates.slice(offset, offset + 4),
        ordered: true
      })
    }]);
  }
  const after = readState(environmentId, privateData);
  assert(after.products.every((product) => product.status === 'offline'), 'not every fixture is offline after update');
  const beforeById = new Map(before.products.map((product) => [product._id, product]));
  after.products.forEach((product) => {
    const previous = beforeById.get(product._id);
    assert(product.schoolId === previous.schoolId, 'fixture schoolId changed');
    assert(product.schoolName === previous.schoolName, 'fixture schoolName changed');
    const expectedVersion = PUBLIC_STATUSES.has(previous.status)
      ? Number(previous.version) + 1
      : Number(previous.version);
    assert(Number(product.version) === expectedVersion, 'fixture version did not change exactly once');
  });
  const privateResult = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    target: `cloud:${targetMasked}`,
    operationId: OPERATION_ID,
    userId: privateData.userId,
    before: before.products.map((product) => ({
      productId: product._id,
      title: product.title,
      status: product.status,
      version: product.version,
      schoolId: product.schoolId || '',
      schoolName: product.schoolName || ''
    })),
    after: after.products.map((product) => ({
      productId: product._id,
      title: product.title,
      status: product.status,
      version: product.version,
      schoolId: product.schoolId || '',
      schoolName: product.schoolName || ''
    })),
    activeAppointments: 0,
    changedCount: candidates.length,
    schoolFieldsChanged: false,
    deletedCount: 0
  };
  writePrivateJson(options.output, privateResult);
  return {
    mode: candidates.length > 0 ? 'applied' : 'already-applied',
    target: privateResult.target,
    operationId: OPERATION_ID,
    fixtureCount: after.products.length,
    changedCount: candidates.length,
    finalStatuses: aggregateStatuses(after.products),
    activeAppointments: 0,
    schoolFieldsChanged: false,
    deletedCount: 0,
    privateOutput: path.relative(ROOT, options.output).replace(/\\/g, '/')
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE18_FIXTURE_CLOSURE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { OPERATION_ID, OUTPUT_PATH, aggregateStatuses, parseArguments, readState, run };
