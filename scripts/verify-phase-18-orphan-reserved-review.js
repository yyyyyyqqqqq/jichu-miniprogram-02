const assert = require('assert');
const fs = require('fs');
const path = require('path');
const review = require('./phase-18-orphan-reserved-review');

const root = path.resolve(__dirname, '..');
const checks = [];

function record(name, callback) {
  callback();
  checks.push(name);
}

function fixtureSnapshot(overrides = {}) {
  const product = {
    _id: 'product-005',
    title: '羽毛球拍双拍套装',
    description: '两支球拍加拍包，线床状态良好，已和同学约好周末面交。',
    price: 68,
    originalPrice: 158,
    categoryId: 'sports',
    condition: '八成新',
    status: 'reserved',
    favoriteCount: 18,
    viewCount: 412,
    createdAt: '2026-07-13T07:30:00.000Z',
    updatedAt: '2026-07-13T07:30:00.000Z',
    sellerId: 'user-005',
    images: []
  };
  return {
    users: [],
    products: [Object.assign(product, overrides.product || {})],
    favorites: [],
    conversations: [],
    messages: [],
    appointments: [],
    productViews: [],
    schools: []
  };
}

function functionFixtures() {
  return [
    'appointmentAction',
    'appointmentQuery',
    'manageProduct',
    'productQuery'
  ].map((functionName) => ({
    functionName,
    status: 'Active',
    runtime: 'Nodejs18.15',
    handler: 'index.main',
    timeoutSeconds: 10,
    memoryMb: 256,
    localSha256: 'a'.repeat(64),
    remoteSha256: 'a'.repeat(64),
    hashAvailable: true,
    hashMatches: true
  }));
}

record('stable target digest and historical fingerprint', () => {
  assert.strictEqual(review.productDigest('product-005'), 'p#56853a8ed6');
  const fingerprint = review.fingerprintAudit(
    fixtureSnapshot().products[0]
  );
  assert.strictEqual(fingerprint.exactMatch, true);
  assert.strictEqual(fingerprint.matchedFields, fingerprint.totalFields);
});

record('query-only allowlist and argument validation', () => {
  const command = review.buildFindCommand(
    'products',
    review.COLLECTION_PROJECTIONS.products,
    0
  );
  assert.strictEqual(review.assertReadOnlyCommand(command), true);
  assert.throws(() => review.assertReadOnlyCommand({
    TableName: 'products',
    CommandType: 'UPDATE',
    Command: '{}'
  }));
  assert.deepStrictEqual(
    review.parseArguments([
      '--confirm-target',
      'cloud1***6d8e',
      '--product-digest',
      'p#56853a8ed6'
    ]),
    {
      describeTarget: false,
      confirmTarget: 'cloud1***6d8e',
      productDigest: 'p#56853a8ed6',
      output: ''
    }
  );
  assert.throws(() => review.parseArguments(['--repair']));
});

record('single target aggregate and broader consistency', () => {
  const before = fixtureSnapshot();
  const after = fixtureSnapshot();
  const report = review.createReview(
    before,
    after,
    functionFixtures(),
    'p#56853a8ed6',
    'cloud1***6d8e'
  );
  assert.strictEqual(report.uniqueness.matchedRecords, 1);
  assert.strictEqual(report.product.titleClass, '[历史初始化测试商品]');
  assert.strictEqual(report.product.status, 'reserved');
  assert.strictEqual(report.product.relationships.appointments.records, 0);
  assert.strictEqual(report.product.seller.recordExists, false);
  assert.strictEqual(report.broaderConsistency.targetIsOnlyOrphan, true);
  assert.strictEqual(report.safetyGate.passed, true);
  assert.strictEqual(report.noWriteProof.countsUnchanged, true);
  assert.strictEqual(
    report.noWriteProof.projectedSnapshotsUnchanged,
    true
  );
});

record('hard stops reject ambiguity and new appointment evidence', () => {
  const duplicate = fixtureSnapshot();
  duplicate.products.push(Object.assign({}, duplicate.products[0]));
  assert.throws(() => review.createReview(
    duplicate,
    duplicate,
    functionFixtures(),
    'p#56853a8ed6',
    'cloud1***6d8e'
  ), /exactly one/);

  const active = fixtureSnapshot();
  active.appointments.push({
    _id: 'appointment-hidden',
    productId: 'product-005',
    status: 'accepted',
    isDeleted: false
  });
  const report = review.createReview(
    active,
    active,
    functionFixtures(),
    'p#56853a8ed6',
    'cloud1***6d8e'
  );
  assert(report.safetyGate.stopReasons.includes(
    'TARGET_HAS_ACTIVE_APPOINTMENT'
  ));
  assert(report.safetyGate.stopReasons.includes(
    'OTHER_APPOINTMENT_PRODUCT_INCONSISTENCY'
  ));
});

record('authorized offline maintenance resolves the orphan safely', () => {
  const snapshot = fixtureSnapshot({
    product: {
      status: 'offline',
      updatedAt: '2026-07-29T10:00:00.000Z',
      offlineAt: '2026-07-29T10:00:00.000Z',
      version: 1,
      maintenance: {
        type: 'orphan_reserved_to_offline',
        mutationId:
          'maintenance-phase18-orphan-reserved-offline-'
          + 'a'.repeat(32),
        appliedAt: '2026-07-29T10:00:00.000Z'
      }
    }
  });
  const report = review.createReview(
    snapshot,
    snapshot,
    functionFixtures(),
    'p#56853a8ed6',
    'cloud1***6d8e'
  );
  assert.strictEqual(
    report.product.immutableHistoricalSeedFingerprint.exactMatch,
    true
  );
  assert.strictEqual(report.product.maintenance.authorizedOffline, true);
  assert.strictEqual(report.broaderConsistency.orphanReservedCount, 0);
  assert.strictEqual(
    report.broaderConsistency.resolvedTargetNoLongerOrphan,
    true
  );
  assert.strictEqual(report.safetyGate.passed, true);
});

record('privacy-safe report contains no raw identities or content', () => {
  const snapshot = fixtureSnapshot();
  snapshot.products[0].sellerOpenid = 'openid_super_secret_value';
  snapshot.products[0].locationDetail = {
    name: '精确地点',
    address: '完整地址',
    latitude: 31.123,
    longitude: 121.456
  };
  snapshot.products[0].images = [
    'cloud://secret.example/images/private.jpg'
  ];
  snapshot.messages.push({
    _id: 'message-private',
    productId: 'product-005',
    type: 'text',
    content: '不应输出的聊天正文',
    senderOpenid: 'openid_super_secret_value'
  });
  const report = review.createReview(
    snapshot,
    snapshot,
    functionFixtures(),
    'p#56853a8ed6',
    'cloud1***6d8e'
  );
  const output = JSON.stringify(report);
  [
    'product-005',
    'user-005',
    'openid_super_secret_value',
    '不应输出的聊天正文',
    '精确地点',
    '完整地址',
    '31.123',
    '121.456',
    'cloud://secret.example'
  ].forEach((value) => assert(!output.includes(value)));
});

record('source has no database, deployment, migration or media action', () => {
  const source = fs.readFileSync(
    path.join(root, 'scripts', 'phase-18-orphan-reserved-review.js'),
    'utf8'
  );
  [
    /\.collection\([^)]*\)\.add\s*\(/,
    /\.collection\([^)]*\)\.update\s*\(/,
    /\.collection\([^)]*\)\.remove\s*\(/,
    /\.collection\([^)]*\)\.set\s*\(/,
    /runTransaction\s*\(/,
    /deleteFile\s*\(/,
    /uploadFile\s*\(/,
    /fn['"],\s*['"]deploy/,
    /--repair|--migrate|--delete/
  ].forEach((pattern) => assert(!pattern.test(source), String(pattern)));
  assert(source.includes("CommandType: 'QUERY'"));
  assert(source.includes("'fn',\n      'detail'"));
  assert(!source.includes("CommandType: 'COMMAND'"));
});

process.stdout.write(
  `Phase 18 orphan reserved review verification succeeded: `
  + `${checks.length} groups passed.\n`
);
