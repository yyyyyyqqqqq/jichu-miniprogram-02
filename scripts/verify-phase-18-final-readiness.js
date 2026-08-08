const assert = require('assert');
const fs = require('fs');
const path = require('path');
const audit = require('./audit-phase-18-user-school-readiness');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function check(condition, message) {
  assert(condition, message);
  checks += 1;
}

const schoolA = { _id: `s_${'1'.repeat(32)}`, name: '学校 A', platformStatus: 'active', officialStatus: 'valid' };
const schoolB = { _id: `s_${'2'.repeat(32)}`, name: '学校 B', platformStatus: 'active', officialStatus: 'valid' };
const users = [
  { _id: `u_${'1'.repeat(32)}`, status: 'active', profileCompleted: true, nickname: '甲', avatarUrl: 'cloud://avatar', schoolId: schoolA._id, schoolName: schoolA.name, schoolVersion: 2 },
  { _id: `u_${'2'.repeat(32)}`, status: 'active', profileCompleted: false, nickname: '', avatarUrl: '', schoolId: '', schoolName: '' }
];
const products = [
  { _id: `p_${'1'.repeat(32)}`, title: '普通商品', status: 'available', schoolId: schoolA._id, schoolName: schoolA.name, sellerId: users[0]._id },
  { _id: `p_${'2'.repeat(32)}`, title: '历史商品', status: 'available', sellerId: users[1]._id },
  { _id: `p_${'3'.repeat(32)}`, title: `${audit.FIXTURE_PREFIX}A-01`, status: 'offline', schoolId: schoolB._id, schoolName: schoolB.name, sellerId: users[0]._id }
];
const snapshot = { users, products, schools: [schoolA, schoolB] };
const report = audit.createReport(snapshot, JSON.parse(JSON.stringify(snapshot)), 'cloud1***test');

check(report.mode === 'dry-run-read-only', 'mode is not read-only');
check(report.users.total === 2 && report.users.active === 2, 'user totals are wrong');
check(report.users.fullyValidProfile === 1, 'profile readiness is wrong');
check(report.users.validActiveSchool === 1 && report.users.schoolStateCounts.missing === 1, 'user school readiness is wrong');
check(report.users.anomalySamples[0].id.includes('***'), 'user anomaly ID is not masked');
check(report.products.total === 3 && report.products.publicTotal === 2, 'product totals are wrong');
check(report.products.publicStrictReady === 1 && report.products.publicNotStrictReady === 1, 'public readiness is wrong');
check(report.products.publicReadinessRatio === 0.5, 'readiness ratio is wrong');
check(report.fixtures.total === 1 && report.fixtures.statusCounts.offline === 1, 'fixture aggregate is wrong');
check(report.businessProductsExcludingFixtures.total === 2, 'business product total is wrong');
check(report.businessProductsExcludingFixtures.publicTotal === 2, 'business public total is wrong');
check(report.businessProductsExcludingFixtures.publicStrictReady === 1, 'business public readiness is wrong');
check(report.decision.strictForAllRecommendedNow === false, 'unsafe strict-for-all was recommended');
check(report.decision.phase22bStillRequired === true, 'Phase 22B requirement was missed');
check(report.noWriteProof.writeApiCalled === false && report.noWriteProof.projectedHashesUnchanged === true, 'no-write proof failed');

const query = audit.buildFindCommand('users', { _id: 1 }, 0, 100);
check(audit.assertReadOnlyCommand(query) === true, 'valid query was rejected');
assert.throws(() => audit.assertReadOnlyCommand({ TableName: 'users', CommandType: 'UPDATE', Command: '{}' }));
checks += 1;
check(audit.parseArguments(['--describe-target']).describeTarget === true, 'describe parsing failed');
check(audit.parseArguments(['--confirm-target', 'cloud***']).confirmTarget === 'cloud***', 'target parsing failed');

const source = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-phase-18-user-school-readiness.js'), 'utf8');
check(!/CommandType:\s*['"](?:UPDATE|INSERT|DELETE)['"]/.test(source), 'audit source contains a write command');
check(!/\.collection\([^)]*\)\.(?:add|update|remove|set)\(/.test(source), 'audit source contains a database write API');
check(!/openid\s*:\s*1/.test(source), 'audit projection includes openid');
check(/--confirm-target/.test(source) && /projectedHashesUnchanged/.test(source), 'audit safety gates are incomplete');

const myProductsTemplate = fs.readFileSync(path.join(ROOT, 'pages', 'my-products', 'index.wxml'), 'utf8');
check(/发布校园：\{\{item\.schoolName\}\}/.test(myProductsTemplate), 'historical product school is not visible');
check(/历史商品：未标校园/.test(myProductsTemplate), 'legacy product school fallback is missing');

process.stdout.write(`Phase 18 final readiness verification succeeded: ${checks} checks passed.\n`);
