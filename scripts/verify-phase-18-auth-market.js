const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function check(value, message) {
  assert(value, message);
  checks += 1;
}

function createQuery(records, condition = {}) {
  const query = {
    orderBy() { return query; },
    skip() { return query; },
    limit() { return query; },
    async count() { return { total: records.length }; },
    async get() {
      const filtered = records.filter((record) => Object.entries(condition).every(([key, value]) => record[key] === value));
      return { data: filtered };
    }
  };
  return query;
}

function createCollection(records) {
  return { where(condition) { return createQuery(records, condition); } };
}

function loadWithCloudMock(relativePath, database, contextRef) {
  const functionPath = path.join(ROOT, relativePath);
  const originalLoad = Module._load;
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() { return database; },
    getWXContext() { return contextRef.current; },
    async deleteFile() { return { fileList: [] }; }
  };
  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloudMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(functionPath)];
    return require(functionPath);
  } finally {
    Module._load = originalLoad;
  }
}

async function expectBusinessCode(operation, code, message) {
  try {
    await operation();
  } catch (error) {
    check(error && error.businessCode === code, message);
    return;
  }
  throw new Error(message);
}

async function verifyAuthMarket() {
  const MarketCore = require(path.join(ROOT, 'cloudfunctions/productQuery/market-core.js'));
  const schoolId = 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const appId = 'wx-auth-market-test';
  const openId = 'openid-auth-market-test';
  const userId = MarketCore.createUserId(appId, openId);
  const command = {
    in(value) { return { $in: value }; },
    and(value) { return { $and: value }; },
    or(value) { return { $or: value }; },
    lte(value) { return { $lte: value }; },
    lt(value) { return { $lt: value }; },
    gt(value) { return { $gt: value }; }
  };
  const db = {
    command,
    collection() { return createCollection([]); },
    RegExp({ regexp, options }) { return { $regexp: new RegExp(regexp, options) }; }
  };
  const contextRef = { current: {} };
  const queryFunction = loadWithCloudMock('cloudfunctions/productQuery/index.js', db, contextRef);
  const validUser = {
    _id: userId,
    openid: openId,
    status: 'active',
    profileCompleted: true,
    nickname: '测试用户',
    avatarUrl: 'cloud://avatar',
    schoolId,
    schoolName: '学校 A'
  };
  const validSchool = { _id: schoolId, name: '学校 A', platformStatus: 'active', officialStatus: 'valid' };
  const strictDependencies = {
    rolloutConfig: { enabled: true, strictForAll: false, accessRequiresAuth: true, allowlist: [userId] },
    usersCollection: createCollection([validUser]),
    schoolsCollection: createCollection([validSchool]),
    productsCollection: createCollection([]),
    cursorSecret: 'phase-18-auth-market-secret-32-bytes',
    nowMs: Date.parse('2026-08-07T00:00:00.000Z')
  };

  await expectBusinessCode(
    () => queryFunction.__test.listProducts({}, { openId: '', appId: '', userId: '' }, strictDependencies),
    'AUTH_REQUIRED',
    'anonymous list was not actively rejected'
  );
  await expectBusinessCode(
    () => queryFunction.__test.listProducts({}, { openId, appId, userId }, {
      ...strictDependencies,
      usersCollection: createCollection([{ ...validUser, profileCompleted: false }])
    }),
    'PROFILE_INCOMPLETE',
    'incomplete profile was not rejected'
  );
  await expectBusinessCode(
    () => queryFunction.__test.listProducts({}, { openId, appId, userId }, {
      ...strictDependencies,
      usersCollection: createCollection([{ ...validUser, schoolId: '', schoolName: '' }])
    }),
    'SCHOOL_REQUIRED',
    'missing school was not rejected'
  );
  await expectBusinessCode(
    () => queryFunction.__test.listProducts({}, { openId, appId, userId }, {
      ...strictDependencies,
      schoolsCollection: createCollection([])
    }),
    'SCHOOL_UNAVAILABLE',
    'unavailable school was not rejected'
  );
  const strictResult = await queryFunction.__test.listProducts({}, { openId, appId, userId }, strictDependencies);
  check(strictResult.success === true && strictResult.data.marketMode === 'schoolScoped', 'valid allowlisted user did not enter schoolScoped');
  check(strictResult.data.scope.schoolId === schoolId, 'strict response scope is not authoritative');
  check(queryFunction.__test.getDefaultRolloutConfig().accessRequiresAuth === true, 'default auth market policy is not enabled');

  const authGuard = fs.readFileSync(path.join(ROOT, 'services/auth-guard.js'), 'utf8');
  const home = fs.readFileSync(path.join(ROOT, 'pages/home/index.js'), 'utf8');
  check(/state\.status !== 'authenticated'[\s\S]{0,100}return false/.test(authGuard), 'client allows anonymous market access');
  check(/profileCompleted !== true[\s\S]{0,80}return false/.test(authGuard), 'client allows incomplete profile market access');
  check(/登录后查看你的校园二手市场/.test(home), 'anonymous market guide copy is missing');
  check(/if \(!allowed\)[\s\S]{0,240}showMarketGuide/.test(home), 'home does not stop before list loading');
}

async function verifyCrossSchoolRelist() {
  const schoolA = 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const schoolB = 's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const products = new Map([['product-relist-school', {
    _id: 'product-relist-school',
    sellerOpenid: 'owner-openid',
    sellerId: 'u_owner',
    schoolId: schoolA,
    schoolName: '学校 A',
    status: 'offline',
    version: 2,
    offlineAt: { original: true }
  }]]);
  const users = new Map([['u_owner', {
    _id: 'u_owner',
    openid: 'owner-openid',
    status: 'active',
    schoolId: schoolB,
    schoolName: '学校 B'
  }]]);
  const schools = new Map([[schoolA, {
    _id: schoolA,
    name: '学校 A',
    platformStatus: 'active',
    officialStatus: 'valid'
  }]]);
  const db = {
    command: { all(value) { return { $all: value }; } },
    collection() { return createCollection([]); },
    serverDate() { return { $serverDate: true }; },
    async runTransaction(callback) {
      const transaction = {
        collection(name) {
          const records = name === 'products'
            ? products
            : (name === 'schools' ? schools : users);
          return { doc(id) { return {
            async get() { return { data: records.get(id) || null }; },
            async update({ data }) { records.set(id, { ...records.get(id), ...data }); return { stats: { updated: 1 } }; }
          }; } };
        }
      };
      return { result: await callback(transaction) };
    }
  };
  const contextRef = { current: { OPENID: 'owner-openid' } };
  const manageProduct = loadWithCloudMock('cloudfunctions/manageProduct/index.js', db, contextRef);
  const allowed = await manageProduct.main({ action: 'relist', productId: 'product-relist-school' });
  check(allowed.success === true && allowed.data.status === 'available', 'historical product owner could not relist the product');
  check(products.get('product-relist-school').schoolId === schoolA, 'historical product relist changed product school');
  check(users.get('u_owner').schoolId === schoolB, 'historical product relist changed the owner school');

  products.set('product-relist-unassigned', {
    _id: 'product-relist-unassigned',
    sellerOpenid: 'owner-openid',
    sellerId: 'u_owner',
    status: 'offline',
    version: 1,
    offlineAt: { original: true }
  });
  const rejected = await manageProduct.main({
    action: 'relist',
    productId: 'product-relist-unassigned'
  });
  check(
    rejected.success === false
      && rejected.code === 'PRODUCT_SCHOOL_UNAVAILABLE',
    'unassigned historical product was allowed to relist'
  );
  check(
    products.get('product-relist-unassigned').status === 'offline',
    'rejected unassigned relist changed product status'
  );
}

(async () => {
  await verifyAuthMarket();
  await verifyCrossSchoolRelist();
  process.stdout.write(`Phase 18 authenticated market verification succeeded: ${checks} checks passed.\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
