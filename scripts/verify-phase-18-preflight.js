const assert = require('assert');
const fs = require('fs');
const path = require('path');
const review = require('./phase-18-orphan-reserved-review');
const preflight = require('./phase-18-preflight-review');

const results = [];

function record(name, callback) {
  callback();
  results.push(name);
}

function product(index, overrides = {}) {
  return {
    _id: `candidate-${String(index).padStart(2, '0')}`,
    title: `阶段 ${index} 测试商品`,
    description: 'fixture',
    status: 'available',
    price: 10,
    originalPrice: 20,
    categoryId: 'books',
    condition: '九成新',
    sellerId: `seller-${index}`,
    favoriteCount: 0,
    viewCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

function snapshot() {
  const products = Array.from({ length: 14 }, (_, index) => (
    product(index + 1)
  ));
  products.push({
    _id: 'product-005',
    title: 'ordinary fixture title',
    description: 'fixture',
    price: 68,
    originalPrice: 158,
    categoryId: 'sports',
    condition: '八成新',
    status: 'offline',
    favoriteCount: 18,
    viewCount: 412,
    sellerId: 'seed-seller',
    createdAt: '2026-07-13T07:30:00.000Z',
    updatedAt: '2026-07-29T10:10:18.952Z',
    offlineAt: '2026-07-29T10:10:18.952Z',
    version: 1,
    maintenance: {
      type: 'orphan_reserved_to_offline',
      mutationId: 'maintenance-phase18-orphan-reserved-offline-'
        + 'a'.repeat(32),
      appliedAt: '2026-07-29T10:10:18.952Z'
    }
  });
  return {
    users: [],
    products,
    favorites: [],
    conversations: [],
    messages: [],
    appointments: [],
    productViews: [],
    schools: []
  };
}

record('arguments default to no database confirmation', () => {
  assert.deepStrictEqual(preflight.parseArguments([]), {
    describeTarget: false,
    confirmTarget: '',
    output: ''
  });
  assert.throws(
    () => preflight.parseArguments(['--apply']),
    /unsupported argument/
  );
});

record('candidate classification covers T1 through T5 safely', () => {
  const base = {
    status: 'available',
    publicVisible: true,
    activeAppointments: 0,
    hasHistoricalRelationship: false,
    favoriteRelations: 0,
    viewRelations: 0,
    hasProductMedia: false,
    realSeller: false
  };
  assert.strictEqual(
    preflight.classifyCandidate({ ...base }).classification,
    'T3'
  );
  assert.strictEqual(
    preflight.classifyCandidate({
      ...base,
      hasHistoricalRelationship: true
    }).classification,
    'T2'
  );
  assert.strictEqual(
    preflight.classifyCandidate({
      ...base,
      status: 'deleted'
    }).classification,
    'T5'
  );
  assert.strictEqual(
    preflight.classifyCandidate({
      ...base,
      activeAppointments: 1
    }).classification,
    'T4'
  );
  assert.strictEqual(
    preflight.classifyCandidate({
      ...base,
      status: 'sold'
    }).classification,
    'T4'
  );
});

record('candidate numbering and scope are deterministic', () => {
  const fixture = snapshot();
  const candidates = fixture.products
    .filter((item) => (
      preflight.TEST_PATTERN.test(item.title)
      || review.productDigest(item._id) === 'p#56853a8ed6'
    ))
    .sort((left, right) => (
      review.productDigest(left._id).localeCompare(
        review.productDigest(right._id)
      )
    ));
  assert.strictEqual(candidates.length, 15);
  const first = candidates.map((item, index) => (
    `TC-${String(index + 1).padStart(3, '0')}:${review.productDigest(item._id)}`
  ));
  const second = [...candidates].reverse().sort((left, right) => (
    review.productDigest(left._id).localeCompare(
      review.productDigest(right._id)
    )
  )).map((item, index) => (
    `TC-${String(index + 1).padStart(3, '0')}:${review.productDigest(item._id)}`
  ));
  assert.deepStrictEqual(first, second);
});

record('state consistency rejects any active or orphan reservation', () => {
  const clean = snapshot();
  const cleanResult = preflight.buildConsistency(clean);
  assert.strictEqual(cleanResult.pending, 0);
  assert.strictEqual(cleanResult.reserved, 0);

  const orphan = snapshot();
  orphan.products[0].status = 'reserved';
  const orphanResult = preflight.buildConsistency(orphan);
  assert.strictEqual(orphanResult.orphanReserved, 1);
  assert.strictEqual(orphanResult.passed, false);

  const active = snapshot();
  active.appointments.push({
    _id: 'appointment-1',
    productId: active.products[0]._id,
    status: 'pending',
    isDeleted: false
  });
  assert.strictEqual(preflight.buildConsistency(active).activeAppointments, 1);
});

record('rollout defaults fail closed and client cannot select mode', () => {
  assert.strictEqual(
    preflight.ROLLOUT_DECISIONS.schoolScopedMarketEnabled,
    false
  );
  assert.strictEqual(
    preflight.ROLLOUT_DECISIONS.clientChoosesMode,
    false
  );
  assert.strictEqual(
    preflight.ROLLOUT_DECISIONS.newModeFallsBackToLegacy,
    false
  );
  assert.strictEqual(
    preflight.ROLLOUT_DECISIONS.missingIndexBehavior,
    'explicit_error_keep_school_filter'
  );
});

record('cursor binds scope and all query dimensions with signed encoding', () => {
  [
    'version',
    'marketMode',
    'scopeSchoolId',
    'action',
    'categoryId',
    'normalizedKeywordDigest',
    'sortBy',
    'statuses',
    'pageSize',
    'snapshotAt',
    'lastSortValues',
    'lastItemId'
  ].forEach((field) => {
    assert(preflight.CURSOR_PROTOCOL.fields.includes(field));
  });
  assert.strictEqual(
    preflight.CURSOR_PROTOCOL.encoding,
    'base64url_json_plus_hmac_sha256'
  );
  assert.strictEqual(preflight.CURSOR_PROTOCOL.base64IsSecurity, false);
  assert.strictEqual(
    preflight.CURSOR_PROTOCOL.invalidCursorFallback,
    false
  );
  assert.strictEqual(preflight.CURSOR_PROTOCOL.seek.default.length, 4);
  assert.strictEqual(preflight.CURSOR_PROTOCOL.seek.newest.length, 2);
  assert.strictEqual(preflight.CURSOR_PROTOCOL.seek.priceAsc.length, 3);
  assert.strictEqual(preflight.CURSOR_PROTOCOL.seek.priceDesc.length, 3);
});

record('index plan covers four real sorts with and without category', () => {
  assert.strictEqual(preflight.INDEX_PLAN.length, 8);
  ['default', 'newest', 'priceAsc', 'priceDesc'].forEach((sort) => {
    assert(preflight.INDEX_PLAN.some(
      (item) => item.sort === sort && item.category === false
    ));
    assert(preflight.INDEX_PLAN.some(
      (item) => item.sort === sort && item.category === true
    ));
  });
  preflight.INDEX_PLAN.forEach((item) => {
    assert(item.fields.startsWith('schoolId ASC, status ASC'));
    assert(item.fields.endsWith('_id ASC'));
    assert.strictEqual(item.required, true);
  });
});

record('no-write proof compares counts and projections', () => {
  const before = snapshot();
  const after = JSON.parse(JSON.stringify(before));
  const proof = preflight.buildNoWriteProof(before, after);
  assert.strictEqual(proof.countsUnchanged, true);
  assert.strictEqual(proof.projectedSnapshotsUnchanged, true);
  assert.strictEqual(proof.databaseWriteApiCalled, false);
  assert.strictEqual(proof.transactionExecuted, false);
  assert.strictEqual(proof.deploymentExecuted, false);
  assert.strictEqual(proof.dataDeleted, false);
  after.products[0].status = 'offline';
  assert.strictEqual(
    preflight.buildNoWriteProof(before, after)
      .projectedSnapshotsUnchanged,
    false
  );
});

record('source has a read-only and privacy-safe boundary', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'phase-18-preflight-review.js'),
    'utf8'
  );
  assert(!/runCloudBase|runNoSql|CommandType:\s*['"]UPDATE|db\.collection|\.add\s*\(|\.set\s*\(|\.remove\s*\(/.test(source));
  assert(!/deploy|uploadFile|deleteFile|createIndex|dropIndex/.test(
    source.replace(/deploymentExecuted/g, '')
  ));
  assert(!/content:\s*1|locationDetail:\s*1/.test(source));
  assert(source.includes('no raw ids, identities, titles, content, locations or media URLs'));
  assert(!source.includes('softDelete('));
  assert(!source.includes('migration'));
});

record('T3 remains a recommendation and never a delete operation', () => {
  const classification = preflight.classifyCandidate({
    status: 'available',
    publicVisible: true,
    activeAppointments: 0,
    hasHistoricalRelationship: false,
    favoriteRelations: 0,
    viewRelations: 0,
    hasProductMedia: false,
    realSeller: false
  });
  assert.strictEqual(classification.classification, 'T3');
  assert(classification.suggestion.includes('本轮不删除'));
});

process.stdout.write(
  `Phase 18 preflight verification succeeded: ${results.length} groups passed.\n`
);
