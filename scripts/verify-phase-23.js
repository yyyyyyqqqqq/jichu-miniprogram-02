const assert = require('assert');
const fs = require('fs');
const path = require('path');
const productionAudit = require('./phase-23-production-audit');
const performance = require('./phase-23-performance');
const securityProbes = require('./phase-23-security-probes');
const deploy = require('./deploy-phase-23');

const ROOT = path.resolve(__dirname, '..');
const FUNCTION_NAMES = productionAudit.FUNCTION_NAMES;
const WRITE_FUNCTIONS = [
  'authUser',
  'createProduct',
  'manageProduct',
  'favoriteProduct',
  'messageAction',
  'appointmentAction',
  'productViewAction'
];
let checks = 0;

function check(value, message) {
  assert(value, message);
  checks += 1;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function verifyDependencies() {
  const withWs = new Set(deploy.FUNCTIONS.map((item) => item.name));
  for (const name of FUNCTION_NAMES) {
    const packageJson = JSON.parse(read(`cloudfunctions/${name}/package.json`));
    const lock = JSON.parse(read(`cloudfunctions/${name}/package-lock.json`));
    check(lock.lockfileVersion === 3, `${name} does not use lockfile v3`);
    check(packageJson.dependencies['wx-server-sdk'] === '^4.0.2' || packageJson.dependencies['wx-server-sdk'] === '4.0.2', `${name} wx-server-sdk range drifted`);
    check(lock.packages['node_modules/wx-server-sdk'].version === '4.0.2', `${name} wx-server-sdk lock drifted`);
    if (withWs.has(name)) {
      check(packageJson.dependencies.ws === '8.21.3', `${name} ws is not pinned to 8.21.3`);
      check(lock.packages['node_modules/ws'].version === '8.21.3', `${name} ws lock is not 8.21.3`);
    } else {
      check(!packageJson.dependencies.ws, `${name} gained an unexplained ws dependency`);
    }
  }
}

function verifyIdentityAndAuthorization() {
  for (const name of WRITE_FUNCTIONS) {
    const source = read(`cloudfunctions/${name}/index.js`);
    check(/cloud\.getWXContext\(\)/.test(source), `${name} does not use trusted WX context`);
    check(!/\b(?:request|data|event)\.(?:openid|OPENID|userId|schoolName)\b/.test(source), `${name} trusts a forged identity field`);
    check(!/console\.(?:log|info|warn|error)\(\s*(?:event|request|data)\b/.test(source), `${name} logs a raw request object`);
    check(!/console\.(?:log|info|warn|error)\([^\n]*JSON\.stringify\(\s*(?:event|request|data)\b/.test(source), `${name} serializes raw request data into logs`);
  }
  check(/assertProductAccess\(product, openId\)/.test(read('cloudfunctions/manageProduct/index.js')), 'manageProduct owner guard is missing');
  check(/assertCanCreateSchoolRelation/.test(read('cloudfunctions/favoriteProduct/index.js')), 'favorite school guard is missing');
  check(/assertCanCreateSchoolRelation/.test(read('cloudfunctions/messageAction/index.js')), 'message school guard is missing');
  check(/assertCanCreateSchoolRelation/.test(read('cloudfunctions/appointmentAction/index.js')), 'appointment school guard is missing');
  check(/assertConversationParticipants/.test(read('cloudfunctions/appointmentAction/index.js')), 'appointment participant guard is missing');
  check(/getParticipantSlot/.test(read('cloudfunctions/messageQuery/index.js')), 'message participant guard is missing');
  check(/isAppointmentParticipant/.test(read('cloudfunctions/appointmentQuery/index.js')), 'appointment query participant guard is missing');
  check(/viewer\.schoolId/.test(read('cloudfunctions/userQuery/index.js')), 'seller profile viewer-school scope is missing');
}

function verifyInputAndConcurrencyGuards() {
  const create = read('cloudfunctions/createProduct/index.js');
  const manage = read('cloudfunctions/manageProduct/index.js');
  const favorite = read('cloudfunctions/favoriteProduct/index.js');
  const message = read('cloudfunctions/messageAction/index.js');
  const appointment = read('cloudfunctions/appointmentAction/index.js');
  const view = read('cloudfunctions/productViewAction/index.js');
  check(/REQUEST_ID_PATTERN/.test(create) && /requestId/.test(create), 'createProduct idempotency key is missing');
  check(/MUTATION_ID_PATTERN/.test(manage) && /PRODUCT_VERSION_CONFLICT/.test(manage), 'manageProduct replay/version guard is missing');
  check(/runTransaction/.test(favorite) && /favoriteId/.test(favorite), 'favorite transaction/idempotency guard is missing');
  check(/CLIENT_MESSAGE_ID_PATTERN/.test(message) && /runTransaction/.test(message), 'message replay/transaction guard is missing');
  check(/APPOINTMENT_ID_PATTERN/.test(appointment) && /runTransaction/.test(appointment), 'appointment idempotency/transaction guard is missing');
  check(/viewId/.test(view) && /runTransaction/.test(view) && /cleanupAfter/.test(view), 'view de-duplication/retention guard is missing');
  for (const source of [create, manage, message, appointment]) {
    check(/MAX_/.test(source), 'a write function lacks explicit payload bounds');
  }
  check(/ALLOWED_UPDATE_FIELDS/.test(manage) && !/ALLOWED_UPDATE_FIELDS[\s\S]{0,500}schoolId/.test(manage), 'manageProduct school field whitelist is unsafe');
}

function verifyQueryBoundaries() {
  for (const name of ['productQuery', 'favoriteProduct', 'messageQuery', 'appointmentQuery', 'schoolQuery', 'userQuery']) {
    const source = read(`cloudfunctions/${name}/index.js`);
    check(/MAX_PAGE_SIZE/.test(source), `${name} lacks a page-size ceiling`);
  }
  const product = read('cloudfunctions/productQuery/index.js');
  const market = read('cloudfunctions/productQuery/market-core.js');
  check(/MAX_KEYWORD_LENGTH/.test(product) && /MAX_SEARCH_TOKENS/.test(product), 'product keyword bounds are missing');
  check(/assertCursorSecret/.test(product) && /HMAC|createHmac/i.test(market), 'product cursor signature guard is missing');
  check(/INVALID_CURSOR_SCOPE/.test(market), 'cursor scope fail-fast is missing');
  check(/scopeSchoolId/.test(market) && /pageSize/.test(market), 'cursor does not bind school/page size');
  check(!/\.skip\(/.test(product.slice(product.indexOf('async function listSchoolScopedProducts'), product.indexOf('async function listProducts'))), 'strict product list regressed to offset pagination');
}

function verifyToolsAndSafety() {
  const auditSource = read('scripts/phase-23-production-audit.js');
  const probeSource = read('scripts/phase-23-security-probes.js');
  const performanceSource = read('scripts/phase-23-performance.js');
  check(!/CommandType:\s*['"](?:UPDATE|INSERT|DELETE)['"]/.test(auditSource), 'production audit contains a database write command');
  check(!/CommandType:\s*['"](?:UPDATE|INSERT|DELETE)['"]/.test(probeSource), 'security probes contain a database write command');
  check(!/['"](?:addFavorite|removeFavorite|sendMessage|sendTextMessage|markConversationRead|create|accept|reject|cancel|complete|recordView|updateSchool|updateProfile|selectSchool)['"]/.test(performanceSource), 'performance tool includes a write action');
  check(performance.parseArguments(['--iterations', '20', '--concurrency', '5']).iterations === 20, 'performance iterations upper bound is unavailable');
  check(performance.parseArguments(['--iterations', '20', '--concurrency', '5']).concurrency === 5, 'performance concurrency upper bound is unavailable');
  check(performance.statistics([10, 20, 30, 40, 50]).p95 === 50, 'p95 calculation is incorrect');
  check(productionAudit.parseArguments(['--env', 'cloud***']).confirmTarget === 'cloud***', 'production audit target parsing failed');
  check(securityProbes.parseArguments(['--env', 'cloud***']).confirmTarget === 'cloud***', 'security probe target parsing failed');
  check(/buildNoWriteProof/.test(probeSource) && /countsUnchanged/.test(probeSource) && /projectedSnapshotsUnchanged/.test(probeSource), 'security probes lack a no-write proof');
  check(/--deploy/.test(read('scripts/deploy-phase-23.js')), 'Phase 23 deployment lacks an explicit apply gate');
}

function verifyProjectWiring() {
  const packageJson = JSON.parse(read('package.json'));
  for (const script of [
    'phase-23:verify',
    'phase-23:audit',
    'phase-23:performance',
    'phase-23:security-probes',
    'phase-23:deploy'
  ]) {
    check(typeof packageJson.scripts[script] === 'string', `${script} is not wired`);
  }
  check(fs.existsSync(path.join(ROOT, 'docs', 'phase-23-production-security-performance-hardening.md')), 'Phase 23 report is missing');
}

verifyDependencies();
verifyIdentityAndAuthorization();
verifyInputAndConcurrencyGuards();
verifyQueryBoundaries();
verifyToolsAndSafety();
verifyProjectWiring();
process.stdout.write(`Phase 23 production hardening verification succeeded: ${checks} checks passed.\n`);
