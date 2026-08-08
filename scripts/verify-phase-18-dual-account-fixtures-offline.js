const { isDeepStrictEqual } = require('util');
const {
  loadEnvironmentId,
  queryCollection
} = require('./phase-18-canary-core');
const {
  loadDualAccountPrivate,
  maskId,
  assert,
  writePrivateJson,
  PRIVATE_DUAL_ACCOUNT_PATH
} = require('./phase-18-dual-account-core');

const IMMUTABLE_FIELDS = [
  '_id', 'title', 'description', 'price', 'categoryId', 'condition',
  'location', 'locationDetail', 'video', 'schoolId', 'schoolName',
  'sellerId', 'sellerName', 'createdAt'
];

function readSnapshots(environmentId) {
  const projections = [
    {
      _id: 1, title: 1, price: 1, categoryId: 1, status: 1, version: 1,
      schoolId: 1, schoolName: 1, sellerId: 1, sellerName: 1
    },
    {
      _id: 1, title: 1, description: 1, condition: 1,
      location: 1, locationDetail: 1, video: 1
    },
    { _id: 1, title: 1, createdAt: 1, updatedAt: 1, offlineAt: 1 }
  ];
  const batches = projections.map((projection) => queryCollection(environmentId, 'products', {
    filter: {}, projection, limit: 1000
  }));
  assert(batches.every((batch) => batch.length === batches[0].length), 'offline snapshot query is incomplete');
  return batches[0].map((summary) => batches.slice(1).reduce((merged, batch) => {
    const matching = batch.find((item) => item._id === summary._id);
    assert(matching, 'offline supplemental snapshot is unavailable');
    return Object.assign(merged, matching);
  }, Object.assign({}, summary)));
}

function verifyFixture(rows, initial, expectedId, label) {
  const after = rows.find((row) => row._id === expectedId);
  assert(after, `${label} offline fixture is missing`);
  assert(after.status === 'offline', `${label} fixture is not offline`);
  assert(Number(after.version) === Number(initial.version) + 1, `${label} fixture version did not increment exactly once`);
  assert(after.offlineAt, `${label} fixture offlineAt is missing`);
  for (const field of IMMUTABLE_FIELDS) {
    assert(isDeepStrictEqual(after[field], initial[field]), `${label} fixture mutated immutable field ${field}`);
  }
  return after;
}

function run() {
  const privateData = loadDualAccountPrivate();
  assert(privateData.fixtureAInitial && privateData.fixtureBInitial, 'initial fixture snapshots are missing');
  const rows = readSnapshots(loadEnvironmentId());
  const fixtureA = verifyFixture(rows, privateData.fixtureAInitial, privateData.fixtureAId, 'A');
  const fixtureB = verifyFixture(rows, privateData.fixtureBInitial, privateData.fixtureBId, 'B');
  privateData.fixtureAAfterOffline = fixtureA;
  privateData.fixtureBAfterOffline = fixtureB;
  privateData.fixturesOfflineVerifiedAt = new Date().toISOString();
  writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, privateData);
  return {
    passed: true,
    immutableFieldsVerified: IMMUTABLE_FIELDS.filter((field) => field !== '_id'),
    fixtures: [
      {
        title: fixtureA.title,
        productId: maskId(fixtureA._id),
        status: fixtureA.status,
        versionBefore: privateData.fixtureAInitial.version,
        versionAfter: fixtureA.version
      },
      {
        title: fixtureB.title,
        productId: maskId(fixtureB._id),
        status: fixtureB.status,
        versionBefore: privateData.fixtureBInitial.version,
        versionAfter: fixtureB.version
      }
    ],
    deleted: false
  };
}

try {
  process.stdout.write(`${JSON.stringify(run(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`PHASE18_DUAL_ACCOUNT_OFFLINE_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}
