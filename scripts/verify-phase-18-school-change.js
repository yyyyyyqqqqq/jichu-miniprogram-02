const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function createCollector() {
  let checks = 0;
  return {
    check(condition, message) {
      if (!condition) {
        throw new Error(message);
      }
      checks += 1;
    },
    count() {
      return checks;
    }
  };
}

function createUserId(appId, openId) {
  return `u_${crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function cloneRecord(record) {
  if (!record) {
    return record;
  }
  return {
    ...record,
    locationDetail: record.locationDetail
      ? { ...record.locationDetail }
      : record.locationDetail,
    images: Array.isArray(record.images) ? [...record.images] : record.images,
    video: record.video && typeof record.video === 'object'
      ? { ...record.video }
      : record.video
  };
}

async function verifyServerAndProductFlow(root, collector) {
  const { check } = collector;
  const authPath = path.join(root, 'cloudfunctions', 'authUser', 'index.js');
  const createPath = path.join(root, 'cloudfunctions', 'createProduct', 'index.js');
  const originalLoad = Module._load;
  const users = new Map();
  const schools = new Map();
  const products = new Map();
  const writes = { users: 0, products: 0 };
  const collectionReads = { users: 0, schools: 0, products: 0 };
  let failNextUserUpdate = false;
  let context = {};

  function collection(name) {
    const records = name === 'users'
      ? users
      : name === 'schools'
        ? schools
        : name === 'products'
          ? products
          : null;
    if (!records) {
      throw new Error(`unexpected collection ${name}`);
    }
    collectionReads[name] += 1;
    return {
      where(condition) {
        return {
          limit() {
            return this;
          },
          async get() {
            const record = records.get(condition._id);
            return { data: record ? [cloneRecord(record)] : [] };
          }
        };
      },
      doc(id) {
        return {
          async get() {
            const record = records.get(id);
            if (!record) {
              throw new Error('document with _id does not exist');
            }
            return { data: cloneRecord(record) };
          },
          async set({ data }) {
            records.set(id, { _id: id, ...cloneRecord(data) });
            if (name === 'products') {
              writes.products += 1;
            }
          },
          async update({ data }) {
            if (name === 'users' && failNextUserUpdate) {
              failNextUserUpdate = false;
              const error = new Error('database update failed');
              error.errCode = 'DATABASE_UPDATE_FAILED';
              throw error;
            }
            const record = records.get(id);
            if (!record) {
              throw new Error('document with _id does not exist');
            }
            records.set(id, { ...record, ...cloneRecord(data), _id: id });
            if (name === 'users') {
              writes.users += 1;
            }
          }
        };
      }
    };
  }

  const db = {
    collection,
    serverDate() {
      return new Date('2026-08-01T08:00:00.000Z');
    },
    async runTransaction(callback) {
      return callback({ collection });
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return { ...context };
    }
  };
  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const appId = 'phase18-school-change-app';
  const openId = 'phase18-school-change-user';
  const userId = createUserId(appId, openId);
  const otherOpenId = 'phase18-other-user';
  const otherUserId = createUserId(appId, otherOpenId);
  const schoolA = `s_${'a'.repeat(32)}`;
  const schoolB = `s_${'b'.repeat(32)}`;
  const pendingSchool = `s_${'c'.repeat(32)}`;
  const invalidOfficialSchool = `s_${'d'.repeat(32)}`;
  const blankNameSchool = `s_${'e'.repeat(32)}`;
  const missingSchool = `s_${'f'.repeat(32)}`;
  const selectedAt = new Date('2026-07-28T08:00:00.000Z');
  const baseUser = {
    _id: userId,
    openid: openId,
    nickname: '换校验证用户',
    avatarUrl: `cloud://test.bucket/avatars/${userId}/20260801/avatar.png`,
    profileCompleted: true,
    status: 'active',
    schoolId: schoolA,
    schoolName: '用户缓存旧名称',
    schoolSelectedAt: selectedAt,
    schoolUpdatedAt: selectedAt,
    schoolVersion: 1,
    createdAt: selectedAt,
    updatedAt: selectedAt
  };
  schools.set(schoolA, {
    _id: schoolA,
    name: '第一验证大学',
    platformStatus: 'active',
    officialStatus: 'valid'
  });
  schools.set(schoolB, {
    _id: schoolB,
    name: '第二验证学院',
    platformStatus: 'active',
    officialStatus: 'valid'
  });
  schools.set(pendingSchool, {
    _id: pendingSchool,
    name: '待开放大学',
    platformStatus: 'pending',
    officialStatus: 'valid'
  });
  schools.set(invalidOfficialSchool, {
    _id: invalidOfficialSchool,
    name: '官方失效大学',
    platformStatus: 'active',
    officialStatus: 'invalid'
  });
  schools.set(blankNameSchool, {
    _id: blankNameSchool,
    name: ' ',
    platformStatus: 'active',
    officialStatus: 'valid'
  });

  const validProduct = {
    title: '换校归属验证商品',
    description: '用于验证用户换校前后商品学校归属保持独立。',
    price: 18,
    categoryId: 'books',
    condition: '九成新',
    location: '图书馆公共区域',
    locationDetail: {
      name: '图书馆公共区域',
      address: '验证校园图书馆公共区域',
      latitude: 31.23,
      longitude: 121.47
    },
    images: [
      `cloud://test.bucket/products/${userId}/20260801/school-change.jpg`
    ],
    video: null,
    schoolId: missingSchool,
    schoolName: '客户端伪造学校'
  };

  try {
    delete require.cache[require.resolve(authPath)];
    delete require.cache[require.resolve(createPath)];
    const authUser = require(authPath);
    const createProduct = require(createPath);

    const noIdentity = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: schoolB }
    });
    check(noIdentity.code === 'AUTH_FAILED', 'school change without trusted identity is rejected');

    context = { APPID: appId, OPENID: openId };
    const missingUserResult = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: schoolB }
    });
    check(missingUserResult.code === 'USER_NOT_FOUND', 'missing current user is rejected');

    users.set(userId, { ...baseUser, status: 'disabled' });
    const disabled = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: schoolB }
    });
    check(disabled.code === 'USER_DISABLED', 'disabled current user is rejected');

    users.set(userId, { ...baseUser, profileCompleted: false });
    const incomplete = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: schoolB }
    });
    check(incomplete.code === 'PROFILE_INCOMPLETE', 'incomplete profile is rejected');

    users.set(userId, { ...baseUser, schoolId: '', schoolName: '' });
    const unbound = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: schoolB }
    });
    check(unbound.code === 'SCHOOL_REQUIRED', 'unbound user cannot use change action');

    users.set(userId, cloneRecord(baseUser));
    const invalidId = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: 'invalid-school-id' }
    });
    check(invalidId.code === 'INVALID_SCHOOL_ID', 'malformed target school id is rejected');
    const missingTarget = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: missingSchool }
    });
    check(missingTarget.code === 'SCHOOL_NOT_FOUND', 'missing target school is rejected');
    const pendingTarget = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: pendingSchool }
    });
    check(pendingTarget.code === 'SCHOOL_NOT_ACTIVE', 'pending target school is rejected');
    const invalidOfficial = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: invalidOfficialSchool }
    });
    check(invalidOfficial.code === 'SCHOOL_NOT_ACTIVE', 'officially invalid school is rejected');
    const blankName = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: blankNameSchool }
    });
    check(blankName.code === 'SCHOOL_NOT_ACTIVE', 'school without authoritative name is rejected');

    const productAResult = await createProduct.main({
      requestId: 'phase18_school_a_product_001',
      product: validProduct
    });
    check(productAResult.success === true, 'school A product is created before school change');
    const productAId = productAResult.data.productId;
    check(products.get(productAId).schoolId === schoolA, 'school A product uses server-side user school');

    const otherProduct = {
      _id: 'p_other_history',
      schoolId: schoolA,
      schoolName: '第一验证大学',
      sellerOpenid: otherOpenId
    };
    products.set(otherProduct._id, cloneRecord(otherProduct));
    users.set(otherUserId, {
      ...baseUser,
      _id: otherUserId,
      openid: otherOpenId,
      avatarUrl: `cloud://test.bucket/avatars/${otherUserId}/20260801/avatar.png`
    });
    const otherBefore = cloneRecord(users.get(otherUserId));
    const productSnapshot = JSON.stringify([...products.entries()]);
    const userWritesBefore = writes.users;
    const changed = await authUser.main({
      action: 'updateSchool',
      userId: otherUserId,
      OPENID: otherOpenId,
      data: {
        schoolId: schoolB,
        schoolName: '客户端伪造名称',
        userId: otherUserId,
        openid: otherOpenId
      }
    });
    check(changed.success === true, 'active target school change succeeds');
    check(changed.data.user.id === userId, 'trusted identity selects the updated user');
    check(changed.data.user.schoolId === schoolB, 'safe DTO returns new school id');
    check(changed.data.user.schoolName === '第二验证学院', 'safe DTO uses authoritative school name');
    check(changed.data.user.schoolVersion === 2, 'school change increments school version');
    check(changed.data.user.schoolSelectedAt === selectedAt.toISOString(), 'school change preserves first selection time');
    check(Boolean(changed.data.user.schoolUpdatedAt), 'school change returns updated school time');
    check(users.get(userId).schoolId === schoolB, 'current user record is updated');
    check(users.get(userId).schoolName === '第二验证学院', 'stored school name is authoritative');
    check(JSON.stringify(users.get(otherUserId)) === JSON.stringify(otherBefore), 'forged user id cannot modify another user');
    check(JSON.stringify([...products.entries()]) === productSnapshot, 'school change does not modify products');
    check(writes.users === userWritesBefore + 1, 'successful school change performs one user write');
    check(collectionReads.products > 0 && writes.products === 1, 'only explicit pre-change publish wrote a product');
    check(!/openid|OPENID/.test(JSON.stringify(changed)), 'school change response omits internal identity fields');

    const repeatedWrites = writes.users;
    const repeated = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: schoolB }
    });
    check(repeated.code === 'SCHOOL_UNCHANGED', 'same-school repeated request is rejected stably');
    check(writes.users === repeatedWrites, 'same-school repeated request performs no write');

    const productAAfterChange = cloneRecord(products.get(productAId));
    const productBResult = await createProduct.main({
      requestId: 'phase18_school_b_product_001',
      product: validProduct
    });
    check(productBResult.success === true, 'school B product is created after school change');
    check(products.get(productBResult.data.productId).schoolId === schoolB, 'new product uses changed user school');
    check(products.get(productAId).schoolId === schoolA, 'historical product keeps school A ownership');
    check(JSON.stringify(products.get(productAId)) === JSON.stringify(productAAfterChange), 'historical product is not rewritten by later publish');

    users.set(userId, { ...baseUser });
    failNextUserUpdate = true;
    const failedUpdate = await authUser.main({
      action: 'updateSchool',
      data: { schoolId: schoolB }
    });
    check(failedUpdate.code === 'SCHOOL_UPDATE_FAILED', 'database failure is not reported as success');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(authPath)];
    delete require.cache[require.resolve(createPath)];
  }
}

async function verifyClientStateFlow(root, collector) {
  const { check } = collector;
  const authServicePath = path.join(root, 'services', 'auth-service.js');
  const cloudServicePath = path.join(root, 'services', 'cloud-service.js');
  const authStorePath = path.join(root, 'store', 'auth-store.js');
  const CloudService = require(cloudServicePath);
  const originalEnsure = CloudService.ensureCloudReady;
  const originalWx = global.wx;
  const storage = new Map();
  const calls = [];
  const schoolA = `s_${'a'.repeat(32)}`;
  const schoolB = `s_${'b'.repeat(32)}`;
  const readyA = {
    id: `u_${'1'.repeat(32)}`,
    nickname: '客户端换校用户',
    avatarUrl: 'cloud://test/avatar.png',
    profileCompleted: true,
    status: 'active',
    schoolId: schoolA,
    schoolName: '第一验证大学',
    schoolVersion: 1,
    schoolRequired: false,
    schoolUnavailable: false
  };
  const readyB = {
    ...readyA,
    schoolId: schoolB,
    schoolName: '第二验证学院',
    schoolVersion: 2,
    schoolUpdatedAt: '2026-08-01T08:00:00.000Z'
  };
  global.wx = {
    cloud: {
      callFunction(options) {
        calls.push(options.data);
        options.success({
          result: {
            success: true,
            code: 'OK',
            data: { user: readyB }
          }
        });
      }
    },
    getStorageSync(key) {
      return storage.get(key);
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    }
  };
  CloudService.ensureCloudReady = async () => true;
  delete require.cache[require.resolve(authServicePath)];
  const AuthService = require(authServicePath);
  const originalMethods = {
    getCurrentUser: AuthService.getCurrentUser,
    updateSchool: AuthService.updateSchool
  };

  try {
    const serviceUser = await AuthService.updateSchool(schoolB);
    check(serviceUser.schoolId === schoolB, 'AuthService accepts authoritative updated user DTO');
    check(calls.length === 1, 'AuthService sends one update request');
    check(calls[0].action === 'updateSchool', 'AuthService uses dedicated updateSchool action');
    check(
      JSON.stringify(calls[0].data) === JSON.stringify({ schoolId: schoolB }),
      'AuthService sends only candidate school id'
    );
    let invalidRejected = false;
    try {
      await AuthService.updateSchool('invalid');
    } catch (error) {
      invalidRejected = error.code === 'INVALID_SCHOOL_ID';
    }
    check(invalidRejected && calls.length === 1, 'invalid client school id is rejected before cloud call');

    storage.set('auth:user-summary', readyA);
    AuthService.getCurrentUser = async () => ({ ...readyA });
    delete require.cache[require.resolve(authStorePath)];
    const AuthStore = require(authStorePath);
    await AuthStore.bootstrap();
    let updateCalls = 0;
    let resolveUpdate;
    AuthService.updateSchool = async () => {
      updateCalls += 1;
      return new Promise((resolve) => {
        resolveUpdate = resolve;
      });
    };
    const first = AuthStore.updateSchool(schoolB);
    const second = AuthStore.updateSchool(schoolB);
    check(first === second, 'concurrent school changes reuse one store promise');
    check(AuthStore.getState().updatingSchool === true, 'store exposes school change loading state');
    resolveUpdate({ ...readyB });
    await first;
    check(updateCalls === 1, 'concurrent taps invoke school service once');
    check(AuthStore.getCurrentUser().schoolId === schoolB, 'store updates current school immediately');
    check(storage.get('auth:user-summary').schoolId === schoolB, 'persistent user cache updates after school change');
    check(AuthStore.getState().updatingSchool === false, 'school change loading state always finishes');

    let resolveStale;
    AuthService.updateSchool = async () => new Promise((resolve) => {
      resolveStale = resolve;
    });
    const staleOperation = AuthStore.updateSchool(schoolA);
    AuthStore.clearSession();
    resolveStale({ ...readyA, schoolVersion: 3 });
    await staleOperation;
    check(AuthStore.getCurrentUser() === null, 'late school response cannot overwrite newer logout state');
    check(!storage.has('auth:user-summary'), 'late school response cannot restore cleared cache');
  } finally {
    AuthService.getCurrentUser = originalMethods.getCurrentUser;
    AuthService.updateSchool = originalMethods.updateSchool;
    CloudService.ensureCloudReady = originalEnsure;
    delete require.cache[require.resolve(authServicePath)];
    delete require.cache[require.resolve(authStorePath)];
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

function verifyStaticBoundaries(root, collector) {
  const { check } = collector;
  const profileJs = read(root, 'pages/profile/index.js');
  const profileWxml = read(root, 'pages/profile/index.wxml');
  const schoolJs = read(root, 'pages/school-select/index.js');
  const schoolWxml = read(root, 'pages/school-select/index.wxml');
  const homeJs = read(root, 'pages/home/index.js');
  const createJs = read(root, 'cloudfunctions/createProduct/index.js');
  const productQueryJs = read(root, 'cloudfunctions/productQuery/index.js');
  const authJs = read(root, 'cloudfunctions/authUser/index.js');
  const myProductsBlock = productQueryJs.slice(
    productQueryJs.indexOf('async function listMyProducts'),
    productQueryJs.indexOf('exports.main')
  );

  check(/openSchoolChange/.test(profileJs) && /修改学校/.test(profileWxml), 'profile exposes a controlled school change entry');
  check(/mode=change/.test(read(root, 'services/auth-guard.js')), 'school change route uses an explicit mode');
  check(/this\.isChangeMode/.test(schoolJs), 'school page separates first selection from change mode');
  check(/当前学校：/.test(schoolJs) && /此前发布的商品仍保留在原学校/.test(schoolJs), 'change confirmation explains both schools and immutable history');
  check(/isConfirming/.test(schoolJs) && /isSubmitting/.test(schoolJs), 'page protects modal and submission concurrency');
  check(/school\.id === this\.data\.currentSchoolId/.test(schoolJs), 'current school selection is blocked before request');
  check(/AuthStore\.updateSchool\(school\.id\)/.test(schoolJs), 'change mode calls the controlled store action');
  check(/safeNavigateBack/.test(schoolJs), 'successful change returns through the existing page stack');
  check(/当前学校/.test(schoolWxml) && /school-item--current/.test(schoolWxml), 'current school is visibly marked');
  check(/buildAuthScopeKey/.test(homeJs) && /user\.schoolVersion/.test(homeJs), 'home scope binds user school version');
  check(/nextAuthScopeKey\s*!==\s*this\.authScopeKey/.test(homeJs), 'home detects changed school context on show');
  ['products', 'page', 'total', 'hasMore', 'nextCursor', 'queryScopeKey'].forEach((field) => {
    check(new RegExp(`${field}:`).test(homeJs), `home reset covers ${field}`);
  });
  check(/marketMode:\s*''/.test(homeJs) && /marketScope:\s*\{/.test(homeJs), 'home clears market mode and scope after auth scope change');
  check(/this\.requestVersion \+= 1/.test(homeJs), 'home invalidates earlier request versions');
  check(/requestVersion !== this\.requestVersion/.test(homeJs), 'late home responses are discarded');
  check(/findUser\(userId\)/.test(createJs) && /findSchool\(schoolId\)/.test(createJs), 'product creation resolves user and school on server');
  check(/schoolSummary/.test(createJs) && /toSellerFields/.test(createJs), 'product creation persists trusted school and seller fields');
  check(/sellerOpenid:\s*openId/.test(myProductsBlock), 'myProducts remains scoped to trusted seller identity');
  check(!/schoolId/.test(myProductsBlock), 'myProducts does not hide cross-school historical products');
  check(/SCHOOL_SCOPED_MARKET_ENABLED\s*=\s*true/.test(productQueryJs), 'school-scoped market canary is enabled');
  check(/SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*true/.test(productQueryJs), 'strict-for-all is not enabled');
  const allowlistBlock = productQueryJs.slice(
    productQueryJs.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST'),
    productQueryJs.indexOf('CURSOR_SECRET_ENV_NAME')
  );
  check(
    /Object\.freeze\(\[/.test(allowlistBlock)
      && (allowlistBlock.match(/sha256:[0-9a-f]{64}/g) || []).length === 0
      && !/u_[0-9a-f]{32}/.test(allowlistBlock),
    'final strict allowlist is not empty'
  );
  check(!/collection\(['"]products['"]\)/.test(authJs), 'auth school change cannot bulk-update products');
  check(!/\.collection\(['"]users['"]\).*\.update/.test(schoolJs), 'client page does not directly update users collection');
}

async function verifyPhase18SchoolChangeFlow(root = path.resolve(__dirname, '..')) {
  const collector = createCollector();
  await verifyServerAndProductFlow(root, collector);
  await verifyClientStateFlow(root, collector);
  verifyStaticBoundaries(root, collector);
  return { checks: collector.count() };
}

if (require.main === module) {
  verifyPhase18SchoolChangeFlow()
    .then((result) => {
      process.stdout.write(
        `Phase 18 school change verification succeeded: ${result.checks} checks passed.\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`Phase 18 school change verification failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  verifyPhase18SchoolChangeFlow
};
