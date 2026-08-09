const assert = require('assert');
const fs = require('fs');
const path = require('path');
const audit = require('./phase-22-finalization-audit');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;

function check(value, message) {
  assert(value, message);
  checks += 1;
}

function school(id, name) {
  return {
    _id: id,
    name,
    platformStatus: 'active',
    officialStatus: 'valid'
  };
}

function user(index, schoolId, schoolName, schoolVersion = 1) {
  return {
    _id: `u_${String(index).padStart(32, '0')}`,
    openid: `openid-${index}`,
    status: 'active',
    profileCompleted: true,
    schoolId,
    schoolName,
    schoolVersion,
    schoolSelectedAt: '2026-07-20T00:00:00.000Z'
  };
}

function product(id, seller, values = {}) {
  return Object.assign({
    _id: id,
    title: '历史商品',
    description: '历史商品描述',
    sellerId: seller._id,
    sellerOpenid: seller.openid,
    status: 'offline',
    version: 1,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    favoriteCount: 0,
    viewCount: 0
  }, values);
}

function createFixture() {
  const schoolA = school(`s_${'a'.repeat(32)}`, '学校 A');
  const schoolB = school(`s_${'b'.repeat(32)}`, '学校 B');
  const users = [
    user(1, schoolB._id, schoolB.name, 2),
    user(2, schoolA._id, schoolA.name),
    user(3, schoolA._id, schoolA.name),
    user(4, schoolA._id, schoolA.name)
  ];
  const migratedProducts = Array.from({ length: 20 }, (_, index) => product(
    `migrated-product-${String(index + 1).padStart(2, '0')}`,
    users[index % users.length],
    {
      title: `授权迁移商品 ${index + 1}`,
      status: 'available',
      schoolId: schoolA._id,
      schoolName: schoolA.name
    }
  ));
  const unassigned = [
    product('legacy-t1', users[0], { title: '普通历史记录' }),
    product('legacy-t2', users[1], { title: '有历史收藏的商品', status: 'sold' }),
    product('legacy-t3', users[2], {
      title: '阶段4初始化种子商品',
      maintenance: {
        type: 'orphan_reserved_to_offline',
        mutationId: 'phase-22-test-mutation',
        appliedAt: '2026-07-29T00:00:00.000Z'
      }
    }),
    product('legacy-t4', users[2], {
      title: '验收测试商品',
      coverImage: 'cloud://fixture/image.jpg'
    }),
    product('legacy-t5', users[3], {
      title: '已删除历史商品',
      status: 'deleted',
      deletedAt: '2026-07-20T00:00:00.000Z'
    })
  ];
  const snapshot = {
    users,
    products: migratedProducts.concat(unassigned),
    favorites: [{
      _id: 'favorite-1',
      productId: 'legacy-t2',
      userOpenid: users[0].openid
    }],
    conversations: [],
    messages: [],
    appointments: [],
    productViews: [],
    schools: [schoolA, schoolB]
  };
  const privateEvidence = {
    targetSchool: { id: schoolA._id, name: schoolA.name },
    users: {
      candidates: users.map((item) => ({ userId: item._id }))
    },
    products: {
      candidates: migratedProducts.map((item) => ({ productId: item._id }))
    }
  };
  return { snapshot, privateEvidence };
}

function verifyPureAudit() {
  const { snapshot, privateEvidence } = createFixture();
  const context = {
    targetMasked: 'cloud1***test',
    privateEvidence,
    productIndexes: audit.REQUIRED_PRODUCT_INDEXES.map((name) => ({ name })),
    productsAcl: 'ADMINONLY',
    productQueryConfig: {
      enabled: true,
      strictForAll: true,
      accessRequiresAuth: true,
      allowlistCount: 0
    },
    productQueryConfigMatchesFinal: true,
    functions: {
      productQuery: { hashMatches: true },
      manageProduct: { hashMatches: true }
    }
  };
  const report = audit.createReport(
    snapshot,
    JSON.parse(JSON.stringify(snapshot)),
    context
  );
  check(report.users.active === 4, 'active user count is incorrect');
  check(report.users.validCurrentSchool === 4, 'valid user schools were not recognized');
  check(report.products.public === 20, 'public product count is incorrect');
  check(report.products.publicStrictReady === 20, 'public readiness is not complete');
  check(report.products.publicNotStrictReady === 0, 'public readiness reports a false blocker');
  check(report.remainingUnassigned.total === 5, 'unassigned historical products were lost');
  check(report.remainingUnassigned.public === 0, 'non-public history became public');
  check(report.remainingUnassigned.activeAppointments === 0, 'active appointment blocker is incorrect');
  check(report.remainingUnassigned.migrationCandidates === 0, 'owner current school became migration evidence');
  check(report.remainingUnassigned.deterministicSchoolEvidence === 0, 'text clues became authoritative evidence');
  for (const name of ['T1', 'T2', 'T3', 'T4', 'T5']) {
    check(report.remainingUnassigned.classificationCounts[name] === 1, `${name} taxonomy was not preserved`);
  }
  check(report.historicalMigrations.users.authorized === 4, 'historical user authorization count changed');
  check(report.historicalMigrations.users.present === 4, 'historical user evidence is incomplete');
  check(report.historicalMigrations.users.currentValidSchool === 4, 'later user school changes were treated as migration failure');
  check(report.historicalMigrations.users.laterLegitimateSchoolChanges === 1, 'legitimate later school change was not recognized');
  check(report.historicalMigrations.products.authorized === 20, 'historical product authorization count changed');
  check(report.historicalMigrations.products.fixedAtOriginalMigrationSchool === 20, 'migrated product school was not fixed');
  check(report.historicalMigrations.products.changed === 0, 'idempotency audit planned a product write');
  check(report.noWriteProof.countsUnchanged, 'read-only count proof failed');
  check(report.noWriteProof.projectedSnapshotsUnchanged, 'read-only projection proof failed');
  check(report.dataImpact.migrationsApplied === 0, 'audit applied a migration');
  check(report.completionGate.passed, `completion gate failed: ${report.completionGate.blockers.join(',')}`);

  const publicLeak = JSON.parse(JSON.stringify(snapshot));
  publicLeak.products.find((item) => item._id === 'legacy-t1').status = 'available';
  const blocked = audit.createReport(publicLeak, publicLeak, context);
  check(!blocked.completionGate.passed, 'public unassigned product did not block completion');
  check(
    blocked.completionGate.blockers.includes('PUBLIC_PRODUCT_NOT_STRICT_READY'),
    'public readiness blocker code is missing'
  );
}

function verifySourceBoundaries() {
  const auditSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'phase-22-finalization-audit.js'),
    'utf8'
  );
  const manageSource = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions', 'manageProduct', 'index.js'),
    'utf8'
  );
  const editSource = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions', 'manageProduct', 'index.js'),
    'utf8'
  );
  const myProductsTemplate = fs.readFileSync(
    path.join(ROOT, 'pages', 'my-products', 'index.wxml'),
    'utf8'
  );
  const detailTemplate = fs.readFileSync(
    path.join(ROOT, 'pages', 'product-detail', 'index.wxml'),
    'utf8'
  );
  const migrationSource = fs.readFileSync(
    path.join(ROOT, 'scripts', 'migrate-phase-22b-public-product-schools.js'),
    'utf8'
  );
  check(!/CommandType:\s*['"](?:UPDATE|INSERT|DELETE)['"]/.test(auditSource), 'final audit contains a database write command');
  check(!/--apply/.test(auditSource), 'final audit exposes an apply option');
  check(/TARGET_ENV_CONFIRMATION_REQUIRED/.test(auditSource), 'final audit lacks explicit target confirmation');
  check(/PRODUCT_SCHOOL_UNAVAILABLE/.test(manageSource), 'unassigned relist does not fail closed');
  check(/transaction\.collection\('schools'\)/.test(manageSource), 'relist does not verify authoritative school state');
  check(!/owner.*schoolId|user.*schoolId/i.test(manageSource.slice(manageSource.indexOf('assertProductSchoolReadyForRelist'), manageSource.indexOf('function toEditableProduct'))), 'relist infers product school from owner current school');
  check(!/schoolId|schoolName/.test(editSource.match(/const ALLOWED_UPDATE_FIELDS = new Set\(\[[\s\S]*?\]\);/)[0]), 'ordinary edit can mutate product school');
  check(/历史商品：未标校园/.test(myProductsTemplate), 'My Products hides the unassigned school state');
  check(/wx:elif="\{\{isOwnProduct\}\}"[\s\S]{0,180}历史商品：未标校园/.test(detailTemplate), 'owner detail does not disclose the unassigned school state');
  check(/multi:\s*false/.test(migrationSource) && /upsert:\s*false/.test(migrationSource), 'historical migration lost write guards');
  check(/writesExecuted:\s*false/.test(migrationSource), 'historical migration dry-run no-write result is missing');
}

function verifyArguments() {
  const parsed = audit.parseArguments([
    '--confirm-target',
    'cloud1***test',
    '--output',
    'result.json'
  ]);
  check(parsed.confirmTarget === 'cloud1***test', 'target confirmation was not parsed');
  check(parsed.output === 'result.json', 'output path was not parsed');
  check(audit.parseArguments(['--describe-target']).describeTarget, 'describe-target was not parsed');
}

verifyArguments();
verifyPureAudit();
verifySourceBoundaries();
process.stdout.write(`Phase 22 finalization verification succeeded: ${checks} checks passed.\n`);
