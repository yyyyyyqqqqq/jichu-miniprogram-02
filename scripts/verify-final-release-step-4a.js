const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAVORITE_SOURCE = path.join(ROOT, 'cloudfunctions', 'favoriteProduct', 'index.js');
const BASELINE_SCRIPT = path.join(ROOT, 'scripts', 'final-release-step-4a-runtime-baseline.js');
const CANDIDATE_REPORT = path.join(ROOT, 'docs', 'final-release-step-4a-performance-candidates.md');
const FINAL_REPORT = path.join(ROOT, 'docs', 'final-release-step-4a-low-risk-performance-optimization.md');
const BEFORE_RESULT = path.join(ROOT, 'tmp', 'final-release-step-4a-favorites-before.json');
const AFTER_RESULT = path.join(ROOT, 'tmp', 'final-release-step-4a-favorites-after.json');

let checks = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  checks += 1;
}

function readText(filePath) {
  assert(fs.existsSync(filePath), `missing file: ${path.relative(ROOT, filePath)}`);
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function main() {
  const favoriteSource = readText(FAVORITE_SOURCE);
  const baselineSource = readText(BASELINE_SCRIPT);
  const candidates = readText(CANDIDATE_REPORT);
  const report = readText(FINAL_REPORT);
  const before = readJson(BEFORE_RESULT);
  const after = readJson(AFTER_RESULT);

  assert(/const MAX_PAGE_SIZE = 20;/.test(favoriteSource), 'favorite concurrency is not bounded by page size 20');
  assert(/Promise\.all\(relations\.map\(async \(relation\)/.test(favoriteSource), 'favorite hydration is not concurrent');
  assert(!/for \(const relation of relations\)/.test(favoriteSource), 'serial favorite hydration is still present');
  assert(/ALLOWED_LIST_STATUSES\.has\(product\.status\)/.test(favoriteSource), 'favorite status filter changed');
  assert(/toFavoriteProduct\(product, relation\.createdAt\)/.test(favoriteSource), 'favorite projection changed');

  assert(/const ALLOWED_READ_ACTIONS = Object\.freeze/.test(baselineSource), 'runtime baseline lacks a read allowlist');
  assert(!/['"](?:addFavorite|removeFavorite|recordView|markAsRead|updateSchool)['"]/.test(baselineSource), 'runtime baseline contains a write action');
  assert(/samples >= 3 && options\.samples <= 8/.test(baselineSource), 'runtime sample count is not conservatively bounded');

  assert(before.businessWrites === 0 && after.businessWrites === 0, 'benchmark recorded a business write');
  assert(before.resultCount === after.resultCount, 'favorite result count changed');
  assert(before.stableOrder === true && after.stableOrder === true, 'favorite order is not stable');
  assert(after.p50Ms < before.p50Ms, 'favorite p50 did not improve');
  assert(after.p95Ms < before.p95Ms, 'favorite p95 did not improve');

  for (const id of ['P4A-01', 'P4A-02', 'P4A-03', 'P4A-04', 'P4A-05', 'P4A-06', 'P4A-07', 'P4A-08', 'P4A-09']) {
    assert(candidates.includes(id), `candidate report is missing ${id}`);
  }
  for (let section = 1; section <= 14; section += 1) {
    assert(new RegExp(`^## ${section}\\. `, 'm').test(report), `final report is missing section ${section}`);
  }
  assert(report.includes('PASS — STEP 4A COMPLETE'), 'final report does not contain the required final decision');
  assert(report.includes('NOT EXECUTED / MANUAL'), 'final report does not disclose remaining device tests');

  process.stdout.write(`Final Release Step 4A verification succeeded: ${checks} checks passed.\n`);
}

try {
  main();
} catch (error) {
  console.error(`Final Release Step 4A verification failed: ${error.message}`);
  process.exitCode = 1;
}
