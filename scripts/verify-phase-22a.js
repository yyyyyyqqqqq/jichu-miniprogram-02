const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const {
  COLLECTION_PROJECTIONS,
  PRODUCT_STATUSES,
  APPOINTMENT_STATUSES,
  buildFindCommand,
  buildListIndexesCommand,
  assertReadOnlyCommand,
  schoolReferenceState,
  createAudit,
  parseArguments
} = require('./phase-22a-school-data-audit');

const ROOT = path.resolve(__dirname, '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFixture() {
  const activeSchoolId = `s_${'a'.repeat(32)}`;
  const pendingSchoolId = `s_${'b'.repeat(32)}`;
  const users = [
    {
      _id: 'u_ready',
      openid: 'openid_ready',
      status: 'active',
      schoolId: activeSchoolId,
      schoolName: '验证大学',
      schoolSelectedAt: '2026-07-01T00:00:00.000Z'
    },
    {
      _id: 'u_legacy',
      openid: 'openid_legacy',
      status: 'active'
    },
    {
      _id: 'u_pending',
      openid: 'openid_pending',
      status: 'disabled',
      schoolId: pendingSchoolId,
      schoolName: '待开放大学'
    }
  ];
  const products = [
    {
      _id: 'p_modern',
      status: 'available',
      schoolId: activeSchoolId,
      schoolName: '验证大学',
      sellerId: 'u_ready',
      sellerOpenid: 'openid_ready',
      createdAt: '2026-07-20T00:00:00.000Z',
      title: '普通商品'
    },
    {
      _id: 'p_legacy',
      status: 'reserved',
      sellerId: 'u_legacy',
      sellerOpenid: 'openid_legacy',
      campus: '旧校区文本',
      createdAt: '2026-06-01T00:00:00.000Z',
      title: '历史商品'
    },
    {
      _id: 'p_test',
      status: 'deleted',
      schoolId: '',
      sellerId: 'u_ready',
      sellerOpenid: 'openid_ready',
      createdAt: '2026-07-20T00:00:00.000Z',
      title: '阶段22A测试商品'
    }
  ];
  return {
    users,
    products,
    favorites: [{
      _id: 'f_1',
      userOpenid: 'openid_legacy',
      productId: 'p_legacy'
    }],
    conversations: [{
      _id: 'c_1',
      productId: 'p_legacy',
      participantAOpenid: 'openid_ready',
      participantBOpenid: 'openid_legacy',
      productSnapshot: { productId: 'p_legacy' },
      lastMessageAt: new Date().toISOString()
    }],
    messages: [
      {
        _id: 'm_1',
        conversationId: 'c_1',
        senderOpenid: 'openid_ready',
        type: 'text'
      },
      {
        _id: 'm_2',
        conversationId: 'c_1',
        senderOpenid: 'openid_legacy',
        type: 'product',
        product: { productId: 'p_legacy' }
      }
    ],
    appointments: [{
      _id: 'a_1',
      productId: 'p_legacy',
      buyerOpenid: 'openid_ready',
      sellerOpenid: 'openid_legacy',
      status: 'accepted',
      isDeleted: false
    }],
    productViews: [{
      _id: 'v_1',
      productId: 'p_legacy',
      viewerOpenid: 'openid_ready'
    }],
    schools: [
      {
        _id: activeSchoolId,
        name: '验证大学',
        officialStatus: 'valid',
        platformStatus: 'active'
      },
      {
        _id: pendingSchoolId,
        name: '待开放大学',
        officialStatus: 'valid',
        platformStatus: 'pending'
      }
    ]
  };
}

function verifyCommandAllowlist() {
  const find = buildFindCommand('users', { _id: 1 }, 0, 10);
  assert.strictEqual(assertReadOnlyCommand(find), true);
  assert.strictEqual(JSON.parse(find.Command).find, 'users');
  const indexes = buildListIndexesCommand('products');
  assert.strictEqual(assertReadOnlyCommand(indexes), true);
  assert.strictEqual(JSON.parse(indexes.Command).listIndexes, 'products');
  [
    { CommandType: 'INSERT', Command: '{"insert":"users"}' },
    { CommandType: 'UPDATE', Command: '{"update":"users"}' },
    { CommandType: 'DELETE', Command: '{"delete":"users"}' },
    { CommandType: 'COMMAND', Command: '{"aggregate":"users"}' }
  ].forEach((command) => {
    assert.throws(() => assertReadOnlyCommand({
      TableName: 'users',
      ...command
    }));
  });
}

function verifyAggregateAudit() {
  const before = createFixture();
  const after = clone(before);
  const indexes = [{
    name: 'idx_status_createdAt_id',
    fields: [
      { field: 'status', direction: 'asc' },
      { field: 'createdAt', direction: 'desc' },
      { field: '_id', direction: 'asc' }
    ],
    unique: false
  }];
  const report = createAudit(before, after, indexes, 'cloud1***test');
  assert.strictEqual(report.mode, 'dry-run-read-only');
  assert.strictEqual(report.users.total, 3);
  assert.strictEqual(report.users.authoritativeSchoolComplete, 1);
  assert.strictEqual(report.users.schoolIdMissing, 1);
  assert.strictEqual(report.users.pendingOrInactiveSchoolReference, 1);
  assert.strictEqual(report.users.noSchoolWithBusinessData.any, 1);
  assert.strictEqual(report.products.total, 3);
  assert.strictEqual(report.products.statusCounts.available, 1);
  assert.strictEqual(report.products.statusCounts.reserved, 1);
  assert.strictEqual(report.products.statusCounts.deleted, 1);
  assert.strictEqual(report.products.authoritativeSchoolComplete, 1);
  assert.strictEqual(report.products.byStatus.reserved.noSchool, 1);
  assert.strictEqual(report.references.favorites.records, 1);
  assert.strictEqual(report.references.conversations.records, 1);
  assert.strictEqual(report.references.messages.relatedRecords, 2);
  assert.strictEqual(report.references.messages.productCardMessages, 1);
  assert.strictEqual(report.references.appointments.byStatus.accepted, 1);
  assert.strictEqual(
    report.references.appointments.effectivePendingOrAccepted,
    1
  );
  assert.strictEqual(report.references.productViews.records, 1);
  assert.strictEqual(report.testDataBoundary.recognizableProductCandidates, 1);
  assert.strictEqual(report.stopConditions.triggered, true);
  assert(report.stopConditions.conditions.includes(
    'MOST_PUBLIC_PRODUCTS_LACK_AUTHORITATIVE_SCHOOL'
  ));
  assert(report.stopConditions.conditions.includes(
    'ACTIVE_APPOINTMENTS_REFERENCE_UNASSIGNED_PRODUCTS'
  ));
  assert.strictEqual(report.noWriteProof.countsUnchanged, true);
  assert.strictEqual(report.noWriteProof.projectedSnapshotsUnchanged, true);
  assert.strictEqual(report.noWriteProof.writeApiCalled, false);
  assert.strictEqual(report.noWriteProof.transactionExecuted, false);

  const mutated = clone(after);
  mutated.products[0].status = 'offline';
  const changed = createAudit(before, mutated, indexes, 'cloud1***test');
  assert.strictEqual(changed.noWriteProof.countsUnchanged, true);
  assert.strictEqual(changed.noWriteProof.projectedSnapshotsUnchanged, false);
}

function verifySchoolClassification() {
  const schoolId = `s_${'c'.repeat(32)}`;
  const schoolById = {
    [schoolId]: {
      _id: schoolId,
      name: '权威大学',
      platformStatus: 'active',
      officialStatus: 'valid'
    }
  };
  assert.strictEqual(schoolReferenceState({}, schoolById).bucket, 'missing');
  assert.strictEqual(
    schoolReferenceState({ schoolId: null }, schoolById).bucket,
    'null'
  );
  assert.strictEqual(
    schoolReferenceState({ schoolId: '' }, schoolById).bucket,
    'empty'
  );
  assert.strictEqual(
    schoolReferenceState({ schoolId: 123 }, schoolById).bucket,
    'wrongType'
  );
  assert.strictEqual(
    schoolReferenceState({ schoolId: 'bad' }, schoolById).bucket,
    'invalidFormat'
  );
  assert.strictEqual(
    schoolReferenceState({
      schoolId,
      schoolName: '错误名称'
    }, schoolById).bucket,
    'nameMismatch'
  );
  assert.strictEqual(
    schoolReferenceState({
      schoolId,
      schoolName: '权威大学'
    }, schoolById).authoritative,
    true
  );
}

function verifyStaticSafety() {
  const source = fs.readFileSync(
    path.join(ROOT, 'scripts/phase-22a-school-data-audit.js'),
    'utf8'
  );
  const forbiddenDatabaseWrites = [
    /CommandType:\s*['"](?:INSERT|UPDATE|DELETE)['"]/,
    /"\$(?:set|unset|inc|push|pull|currentDate)"/,
    /\.collection\(/,
    /\.doc\(/,
    /\bcollection\s*\.\s*add\(/,
    /\b(?:collection|document)\s*\.\s*remove\(/,
    /\b(?:collection|document)\s*\.\s*update\(/,
    /\b(?:collection|document)\s*\.\s*set\(/,
    /startTransaction|runTransaction/
  ];
  forbiddenDatabaseWrites.forEach((pattern) => {
    assert(!pattern.test(source), `write capability found: ${pattern}`);
  });
  assert(/TARGET_ENV_CONFIRMATION_REQUIRED/.test(source));
  assert(/confirmTarget !== targetMasked/.test(source));
  assert(/aggregate-only-output/.test(source));
  assert(!/console\.log/.test(source));
  [
    'users',
    'products',
    'favorites',
    'conversations',
    'messages',
    'appointments',
    'productViews',
    'schools'
  ].forEach((collection) => {
    assert(COLLECTION_PROJECTIONS[collection]);
  });
  PRODUCT_STATUSES.forEach((status) => assert(source.includes(`'${status}'`)));
  APPOINTMENT_STATUSES.forEach(
    (status) => assert(source.includes(`'${status}'`))
  );
}

function verifyNoConfirmationNoCloudAccess() {
  const modulePath = path.join(
    ROOT,
    'scripts/phase-22a-school-data-audit.js'
  );
  const originalLoad = Module._load;
  let cloudCalls = 0;
  Module._load = function loadWithMock(request, parent, isMain) {
    if (request === './schools/cloud-cli' && parent.filename === modulePath) {
      return {
        loadEnvironmentId() {
          return 'cloud1-verification-target';
        },
        maskEnvironmentId() {
          return 'cloud1***test';
        },
        runNoSql() {
          cloudCalls += 1;
          throw new Error('cloud access should not occur');
        },
        extractCommandResults() {
          return [];
        },
        extractDocuments() {
          return [];
        },
        decodeExtendedJson(value) {
          return value;
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(modulePath)];
    const auditModule = require(modulePath);
    const described = auditModule.runAudit({ describeTarget: true });
    assert.strictEqual(described.databaseAccessed, false);
    assert.strictEqual(cloudCalls, 0);
    assert.throws(
      () => auditModule.runAudit({}),
      (error) => error.code === 'TARGET_ENV_CONFIRMATION_REQUIRED'
    );
    assert.strictEqual(cloudCalls, 0);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(modulePath)];
  }
}

function verifyArgumentParsing() {
  assert.deepStrictEqual(parseArguments([]), {
    describeTarget: false,
    confirmTarget: '',
    output: ''
  });
  assert.deepStrictEqual(parseArguments([
    '--confirm-target',
    'cloud1***test',
    '--output',
    'audit.json'
  ]), {
    describeTarget: false,
    confirmTarget: 'cloud1***test',
    output: 'audit.json'
  });
  assert.throws(() => parseArguments(['--migrate']));
  assert.throws(() => parseArguments(['--apply']));
}

function run() {
  verifyCommandAllowlist();
  verifyAggregateAudit();
  verifySchoolClassification();
  verifyStaticSafety();
  verifyNoConfirmationNoCloudAccess();
  verifyArgumentParsing();
  process.stdout.write(
    'Phase 22A verification succeeded: 6 groups passed.\n'
  );
}

if (require.main === module) {
  run();
}

module.exports = {
  run
};
