const {
  loadEnvironmentId,
  queryCollection
} = require('./phase-18-canary-core');
const {
  FINAL_FIXTURE_PREFIX,
  loadDualAccountPrivate,
  maskId,
  assert,
  writePrivateJson,
  PRIVATE_DUAL_ACCOUNT_PATH
} = require('./phase-18-dual-account-core');

function findFixture(rows, suffix, account) {
  const title = `${FINAL_FIXTURE_PREFIX}${suffix}`;
  const titled = rows.filter((row) => row.title === title);
  const owned = titled.filter((row) => row.sellerId === account.userId);
  assert(titled.length === 1, `${suffix} fixture title count is ${titled.length}, expected 1`);
  assert(owned.length === 1, `${suffix} fixture is not owned by the expected account`);
  const fixture = owned[0];
  assert(fixture.schoolId === account.schoolId, `${suffix} fixture school is not authoritative`);
  assert(fixture.schoolName === account.schoolName, `${suffix} fixture school name is stale`);
  assert(
    ['available', 'offline'].includes(fixture.status),
    `${suffix} fixture status is ${fixture.status}, expected available or offline`
  );
  return fixture;
}

function run() {
  const privateData = loadDualAccountPrivate();
  const environmentId = loadEnvironmentId();
  const rows = queryCollection(environmentId, 'products', {
    filter: {},
    projection: {
      _id: 1, title: 1, price: 1, categoryId: 1, status: 1, version: 1,
      schoolId: 1, schoolName: 1, sellerId: 1, sellerName: 1
    },
    limit: 1000
  });
  const summaryA = findFixture(rows, 'A', privateData.accountA);
  const summaryB = findFixture(rows, 'B', privateData.accountB);
  const supplemental = [
    { _id: 1, title: 1, description: 1, condition: 1, location: 1, locationDetail: 1, video: 1 },
    { _id: 1, title: 1, createdAt: 1, updatedAt: 1 }
  ].map((projection) => queryCollection(environmentId, 'products', {
    filter: {}, projection, limit: 1000
  }));
  assert(supplemental.every((items) => items.length === rows.length), 'fixture supplemental snapshot is incomplete');
  const hydrate = (summary) => supplemental.reduce((merged, items) => {
    const matching = items.find((item) => item._id === summary._id);
    assert(matching, `${summary.title} supplemental snapshot is unavailable`);
    return Object.assign(merged, matching);
  }, Object.assign({}, summary));
  const fixtureA = hydrate(summaryA);
  const fixtureB = hydrate(summaryB);
  privateData.fixtureAId = fixtureA._id;
  privateData.fixtureBId = fixtureB._id;
  if (!privateData.fixtureAInitial) {
    assert(fixtureA.status === 'available', 'A initial snapshot can only be captured while available');
    privateData.fixtureAInitial = fixtureA;
  }
  if (!privateData.fixtureBInitial) {
    assert(fixtureB.status === 'available', 'B initial snapshot can only be captured while available');
    privateData.fixtureBInitial = fixtureB;
  }
  privateData.fixturesVerifiedAt = new Date().toISOString();
  writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, privateData);
  return {
    passed: true,
    fixtures: [
      {
        title: fixtureA.title,
        productId: maskId(fixtureA._id),
        userId: maskId(fixtureA.sellerId),
        schoolId: maskId(fixtureA.schoolId),
        schoolName: fixtureA.schoolName,
        status: fixtureA.status
      },
      {
        title: fixtureB.title,
        productId: maskId(fixtureB._id),
        userId: maskId(fixtureB.sellerId),
        schoolId: maskId(fixtureB.schoolId),
        schoolName: fixtureB.schoolName,
        status: fixtureB.status
      }
    ]
  };
}

try {
  process.stdout.write(`${JSON.stringify(run(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`PHASE18_DUAL_ACCOUNT_FIXTURE_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}
