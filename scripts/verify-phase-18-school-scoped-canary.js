const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const MarketCore = require('../cloudfunctions/productQuery/market-core');
const {
  ROOT,
  PRIVATE_CANARY_PATH,
  buildFixtureSpecs
} = require('./phase-18-canary-core');

let checks = 0;
function check(condition, message) {
  assert(condition, message);
  checks += 1;
}
function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const query = read('cloudfunctions/productQuery/index.js');
const service = read('services/product-service.js');
const home = read('pages/home/index.js');
const fixtureTool = read('scripts/prepare-phase-18-school-scoped-fixtures.js');
const deploymentTool = read('scripts/deploy-phase-18-school-scoped-canary.js');
const rollbackTool = read('scripts/rollback-phase-18-school-scoped-canary.js');
const allowlist = query.slice(query.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST'), query.indexOf('CURSOR_SECRET_ENV_NAME'));
const hashes = allowlist.match(/sha256:[0-9a-f]{64}/g) || [];

check(/SCHOOL_SCOPED_MARKET_ENABLED\s*=\s*true/.test(query), 'canary master is not enabled');
check(/SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*true/.test(query), 'strict-for-all is not enabled');
check(hashes.length === 0, 'final allowlist is not empty');
check(!/u_[0-9a-f]{32}/.test(allowlist), 'allowlist source exposes a full internal userId');
check(!/requestData\.schoolId|requestData\.allowlist|requestData\.rollout/.test(service), 'client submits trusted rollout fields');
check(/requestVersion !== this\.requestVersion/.test(home), 'home late-response guard is missing');
check(/this\.requestVersion \+= 1/.test(home), 'home invalidation is missing');
check(/options = \{[\s\S]*apply: false/.test(fixtureTool), 'fixture tool is not dry-run by default');
check(/--apply-fixtures/.test(fixtureTool) && /--confirm-target/.test(fixtureTool), 'fixture apply guards are missing');
check(/sellerId: privateData\.userId[\s\S]*title: item\.title/.test(fixtureTool), 'fixture update is not exact-owner/title scoped');
check(/updates: updates\.slice/.test(fixtureTool) && /multi: false/.test(fixtureTool) && /upsert: false/.test(fixtureTool), 'fixture updates are not bounded');
check(/FUNCTION[\s\S]*name: 'productQuery'/.test(deploymentTool), 'deployment is not productQuery-only');
check(/cursor HMAC environment was not preserved/.test(deploymentTool), 'deployment does not guard HMAC preservation');
check(/targetConfig:\s*'legacy'/.test(rollbackTool)
  && /--confirm-target/.test(rollbackTool)
  && /--deploy/.test(rollbackTool), 'rollback path safety gates are missing');
check(fs.existsSync(PRIVATE_CANARY_PATH), 'private canary evidence is missing');
const ignored = execFileSync('git', ['check-ignore', PRIVATE_CANARY_PATH], { cwd: ROOT, encoding: 'utf8' }).trim();
check(Boolean(ignored), 'private canary evidence is not ignored');

const fixtures = buildFixtureSpecs();
const aPublic = fixtures.filter((item) => item.school === 'A' && item.public);
const bPublic = fixtures.filter((item) => item.school === 'B' && item.public && !item.removeSchool);
check(fixtures.length === 20, 'fixture total is not 20');
check(aPublic.length === 12 && aPublic.filter((item) => item.status === 'available').length >= 10, 'school A public volume is insufficient');
check(aPublic.some((item) => item.status === 'reserved') && fixtures.some((item) => item.school === 'A' && !item.public), 'school A status coverage is incomplete');
check(new Set(aPublic.map((item) => item.categoryId)).size >= 2, 'school A category coverage is incomplete');
check(bPublic.length === 5 && bPublic.some((item) => item.status === 'reserved'), 'school B public coverage is incomplete');
check(fixtures.some((item) => item.removeSchool), 'no-school fixture is missing');
check(aPublic.filter((item) => item.favoriteCount === 9 && item.viewCount === 90).length >= 3, 'heat tie boundary is missing');
check(aPublic.filter((item) => item.price === 10).length >= 3, 'price tie boundary is missing');

const target = `u_${'8'.repeat(32)}`;
const targetHash = MarketCore.hashAllowlistIdentity(target);
const other = `u_${'9'.repeat(32)}`;
check(MarketCore.decideMarketMode({ enabled: true, strictForAll: false, allowlist: [targetHash], userId: '' }) === 'legacy_market', 'anonymous simulation is not legacy');
check(MarketCore.decideMarketMode({ enabled: true, strictForAll: false, allowlist: [targetHash], userId: other }) === 'legacy_market', 'non-target simulation is not legacy');
check(MarketCore.decideMarketMode({ enabled: true, strictForAll: false, allowlist: [targetHash], userId: target }) === 'school_scoped_market', 'target simulation is not strict');
check(/INVALID_CURSOR_SCOPE/.test(query) && !/catch[\s\S]{0,300}listLegacyProducts/.test(query), 'strict failure boundary is missing');
check(!/[A-Za-z0-9+/_=-]{64}/.test(query.slice(query.indexOf('CURSOR_SECRET_ENV_NAME'), query.indexOf('const ERROR_CODES'))), 'HMAC appears hard-coded');

process.stdout.write(`Phase 18 canary verification succeeded: ${checks} checks passed.\n`);
