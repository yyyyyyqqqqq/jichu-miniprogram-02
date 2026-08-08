const assert = require('assert');
const fs = require('fs');
const path = require('path');
const fix = require('./phase-18-fix-orphan-reserved-product');

const root = path.resolve(__dirname, '..');
const mutationId =
  'maintenance-phase18-orphan-reserved-offline-'
  + 'a'.repeat(32);
const checks = [];

function record(name, callback) {
  callback();
  checks.push(name);
}

function fixtureSnapshot(productOverrides = {}, relationshipOverrides = {}) {
  const product = Object.assign({
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
  }, productOverrides);
  return {
    users: relationshipOverrides.users || [],
    products: [product].concat(relationshipOverrides.otherProducts || []),
    favorites: relationshipOverrides.favorites || [],
    conversations: relationshipOverrides.conversations || [],
    messages: relationshipOverrides.messages || [],
    appointments: relationshipOverrides.appointments || [],
    productViews: relationshipOverrides.productViews || [],
    schools: relationshipOverrides.schools || []
  };
}

record('default and argument gates reject unauthorized modes', () => {
  assert.deepStrictEqual(fix.parseArguments([]), {
    describeTarget: false,
    confirmTarget: '',
    productDigest: '',
    mutationId: '',
    dryRun: false,
    apply: false,
    output: ''
  });
  assert.throws(() => fix.parseArguments(['--status', 'available']));
  assert.throws(() => fix.parseArguments(['--soft-delete']));
  assert.throws(() => fix.parseArguments(['--batch']));
  assert.throws(() => fix.parseArguments(['--dry-run', '--apply']));
  assert.throws(() => fix.validateExecutionOptions({
    confirmTarget: '',
    productDigest: fix.TARGET_DIGEST,
    mutationId,
    dryRun: true,
    apply: false
  }, 'cloud1***6d8e'));
  assert.throws(() => fix.validateExecutionOptions({
    confirmTarget: 'cloud1***6d8e',
    productDigest: '',
    mutationId,
    dryRun: true,
    apply: false
  }, 'cloud1***6d8e'));
  assert.throws(() => fix.validateExecutionOptions({
    confirmTarget: 'cloud1***6d8e',
    productDigest: fix.TARGET_DIGEST,
    mutationId: '',
    dryRun: true,
    apply: false
  }, 'cloud1***6d8e'));
});

record('complete preflight accepts only the exact empty-relation fixture', () => {
  const preflight = fix.createPreflight(
    fixtureSnapshot(),
    fix.TARGET_DIGEST,
    mutationId
  );
  assert.strictEqual(preflight.safe.writeReady, true);
  assert.strictEqual(preflight.safe.fingerprint.matchedFields, 12);
  assert.strictEqual(preflight.safe.fingerprint.totalFields, 12);
  assert.strictEqual(preflight.safe.target.versionFieldAbsent, true);
  assert.strictEqual(preflight.safe.globalConsistency.orphanReserved, 1);
  assert.strictEqual(preflight.safe.globalConsistency.targetIsOnlyOrphan, true);
  assert.strictEqual(
    preflight.safe.globalConsistency.activeAppointments,
    0
  );
});

record('preflight rejects state, version, relations, media and identity changes', () => {
  [
    [{ status: 'available' }, {}, 'TARGET_STATUS_NOT_RESERVED'],
    [{ version: 0 }, {}, 'FIELD_MUST_BE_ABSENT:version'],
    [{ reservedAppointmentId: 'appointment' }, {},
      'FIELD_MUST_BE_ABSENT:reservedAppointmentId'],
    [{ reservedAt: '2026-07-29T00:00:00.000Z' }, {},
      'FIELD_MUST_BE_ABSENT:reservedAt'],
    [{ sellerOpenid: 'openid-private' }, {},
      'FIELD_MUST_BE_ABSENT:sellerOpenid'],
    [{ schoolId: 'school-private' }, {},
      'FIELD_MUST_BE_ABSENT:schoolId'],
    [{ images: ['cloud://private/image.jpg'] }, {},
      'TARGET_RELATIONSHIP_BASELINE_CHANGED'],
    [{}, {
      favorites: [{ _id: 'f', productId: 'product-005' }]
    }, 'TARGET_RELATIONSHIP_BASELINE_CHANGED'],
    [{}, {
      appointments: [{
        _id: 'a',
        productId: 'product-005',
        status: 'accepted',
        isDeleted: false
      }]
    }, 'GLOBAL_ACTIVE_APPOINTMENT_APPEARED'],
    [{}, {
      users: [{ _id: 'user-005', status: 'active' }]
    }, 'REAL_SELLER_APPEARED']
  ].forEach(([product, relationships, reason]) => {
    const result = fix.createPreflight(
      fixtureSnapshot(product, relationships),
      fix.TARGET_DIGEST,
      mutationId
    );
    assert.strictEqual(result.safe.writeReady, false);
    assert(result.safe.rejectionReasons.includes(reason), reason);
  });
});

record('atomic command is one strict non-upsert whitelist update', () => {
  const product = fixtureSnapshot().products[0];
  const command = fix.buildAtomicUpdateCommand(product, mutationId);
  assert.strictEqual(fix.assertAtomicUpdateCommand(command), true);
  const parsed = JSON.parse(command.Command);
  assert.strictEqual(parsed.updates.length, 1);
  assert.strictEqual(parsed.updates[0].multi, false);
  assert.strictEqual(parsed.updates[0].upsert, false);
  assert.strictEqual(parsed.updates[0].q.status, 'reserved');
  assert.strictEqual(parsed.updates[0].q.version.$exists, false);
  assert.strictEqual(parsed.updates[0].u.$set.status, 'offline');
  assert.strictEqual(parsed.updates[0].u.$set.version, 1);
  assert.strictEqual(
    parsed.updates[0].u.$set['maintenance.type'],
    fix.OPERATION_TYPE
  );
  assert.deepStrictEqual(
    Object.keys(parsed.updates[0].q).sort(),
    [
      '_id',
      'categoryId',
      'condition',
      'createdAt',
      'deletedAt',
      'description',
      'favoriteCount',
      'lastMutationId',
      'maintenance',
      'offlineAt',
      'originalPrice',
      'price',
      'reservedAppointmentId',
      'reservedAt',
      'schoolId',
      'schoolName',
      'sellerOpenid',
      'soldAt',
      'status',
      'title',
      'updatedAt',
      'version',
      'viewCount'
    ].sort()
  );
});

record('update result cardinality parsing requires an exact count', () => {
  assert.strictEqual(fix.extractUpdateCount({
    data: {
      Results: [JSON.stringify({ stats: { updated: 1 } })]
    }
  }), 1);
  assert.strictEqual(fix.extractUpdateCount({
    data: {
      Results: [{ modifiedCount: 0 }]
    }
  }), 0);
  assert.throws(() => fix.extractUpdateCount({}));
});

record('post-write comparison permits only the authorized fields', () => {
  const before = fixtureSnapshot();
  const afterProduct = Object.assign({}, before.products[0], {
    status: 'offline',
    offlineAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
    version: 1,
    maintenance: {
      type: fix.OPERATION_TYPE,
      mutationId,
      source: 'phase_4_seed_fixture',
      reason: 'orphan_reserved_test_product',
      appliedAt: '2026-07-29T10:00:00.000Z'
    }
  });
  const after = fixtureSnapshot(afterProduct);
  const comparison = fix.compareAfter(
    before,
    after,
    before.products[0],
    after.products[0]
  );
  assert.strictEqual(comparison.whitelistPassed, true);
  assert.strictEqual(comparison.otherProductsDigestUnchanged, true);
  assert.strictEqual(
    comparison.targetNonAuthorizedFieldsDigestUnchanged,
    true
  );

  const tamperedProduct = Object.assign({}, afterProduct, { price: 999 });
  const tampered = fixtureSnapshot(tamperedProduct);
  const rejected = fix.compareAfter(
    before,
    tampered,
    before.products[0],
    tampered.products[0]
  );
  assert.strictEqual(rejected.whitelistPassed, false);
});

record('same mutation is idempotent and different mutation is not accepted', () => {
  const product = Object.assign({}, fixtureSnapshot().products[0], {
    status: 'offline',
    offlineAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
    version: 1,
    maintenance: {
      type: fix.OPERATION_TYPE,
      mutationId,
      appliedAt: '2026-07-29T10:00:00.000Z'
    }
  });
  assert.strictEqual(fix.alreadyApplied(product, mutationId), true);
  assert.strictEqual(
    fix.alreadyApplied(
      product,
      'maintenance-phase18-orphan-reserved-offline-' + 'b'.repeat(32)
    ),
    false
  );
});

record('source is single-purpose and has no deployment, batch or media path', () => {
  const source = fs.readFileSync(
    path.join(
      root,
      'scripts',
      'phase-18-fix-orphan-reserved-product.js'
    ),
    'utf8'
  );
  assert(source.includes("CommandType: 'UPDATE'"));
  assert(source.includes("TableName: 'products'"));
  assert(source.includes("multi: false"));
  assert(source.includes("upsert: false"));
  [
    /fn['"],\s*['"]deploy/,
    /deleteFile\s*\(/,
    /uploadFile\s*\(/,
    /runTransaction\s*\(/,
    /collection\(['"](?:users|favorites|conversations|messages|appointments|productViews|schools)['"]\).*update/
  ].forEach((pattern) => assert(!pattern.test(source), String(pattern)));
  assert(!source.includes('fullProductId'));
  assert(!source.includes('OPENID'));
});

process.stdout.write(
  `Phase 18 orphan reserved fix verification succeeded: `
  + `${checks.length} groups passed.\n`
);
