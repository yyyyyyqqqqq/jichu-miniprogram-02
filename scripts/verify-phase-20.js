const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function createCollector() {
  let checks = 0;
  return {
    check(condition, message) {
      if (!condition) throw new Error(message);
      checks += 1;
    },
    count() {
      return checks;
    }
  };
}

function createUserId(appId, openId) {
  return `u_${crypto.createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function clone(value) {
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, clone(item)])
  );
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

async function verifyServer(root, collector) {
  const { check } = collector;
  const functionPath = path.join(root, 'cloudfunctions', 'authUser', 'index.js');
  const originalLoad = Module._load;
  const users = new Map();
  const schools = new Map();
  const appId = 'phase20-verification-app';
  const schoolA = `s_${'a'.repeat(32)}`;
  const schoolB = `s_${'b'.repeat(32)}`;
  const schoolC = `s_${'c'.repeat(32)}`;
  const pendingSchool = `s_${'d'.repeat(32)}`;
  const missingSchool = `s_${'e'.repeat(32)}`;
  let identity = {};
  let now = new Date();
  let userWrites = 0;
  let transactionQueue = Promise.resolve();

  [
    [schoolA, '第一验证大学', 'active', 'valid'],
    [schoolB, '第二验证学院', 'active', 'valid'],
    [schoolC, '第三验证大学', 'active', 'valid'],
    [pendingSchool, '待开放大学', 'pending', 'valid']
  ].forEach(([id, name, platformStatus, officialStatus]) => {
    schools.set(id, { _id: id, name, platformStatus, officialStatus });
  });

  function collection(name) {
    const records = name === 'users' ? users : name === 'schools' ? schools : null;
    if (!records) throw new Error(`unexpected collection ${name}`);
    return {
      where(condition) {
        return {
          limit() { return this; },
          async get() {
            const record = records.get(condition._id);
            return { data: record ? [clone(record)] : [] };
          }
        };
      },
      doc(id) {
        return {
          async get() {
            const record = records.get(id);
            if (!record) throw new Error('document with _id does not exist');
            return { data: clone(record) };
          },
          async set({ data }) {
            records.set(id, { _id: id, ...clone(data) });
          },
          async update({ data }) {
            const record = records.get(id);
            if (!record) throw new Error('document with _id does not exist');
            records.set(id, { ...record, ...clone(data), _id: id });
            if (name === 'users') userWrites += 1;
          }
        };
      }
    };
  }

  const database = {
    collection,
    serverDate() {
      return new Date(now.getTime());
    },
    runTransaction(callback) {
      const operation = transactionQueue.then(() => callback({ collection }));
      transactionQueue = operation.catch(() => {});
      return operation;
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database() { return database; },
    getWXContext() { return { ...identity }; }
  };
  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloudMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  function seedUser(openId, overrides = {}) {
    identity = { APPID: appId, OPENID: openId };
    const userId = createUserId(appId, openId);
    users.set(userId, {
      _id: userId,
      openid: openId,
      nickname: 'Phase20 验证用户',
      avatarUrl: `cloud://test.bucket/avatars/${userId}/20260809/avatar.png`,
      profileCompleted: true,
      status: 'active',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      ...clone(overrides)
    });
    return userId;
  }

  async function call(action, data = {}) {
    const authUser = require(functionPath);
    return authUser.main({ action, data });
  }

  try {
    delete require.cache[require.resolve(functionPath)];
    const authUser = require(functionPath);
    const test = authUser.__test;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    check(test.SCHOOL_CHANGE_COOLDOWN_MS === sevenDays, 'cooldown is exactly seven 24-hour periods');

    const oneSecondEarly = test.getSchoolChangePolicy({
      schoolChangedAt: new Date(now.getTime() - sevenDays + 1000)
    }, now);
    check(!oneSecondEarly.canChangeSchool, '6d23:59:59 remains in cooldown');
    check(oneSecondEarly.schoolChangeRemainingMs === 1000, 'early boundary keeps exact remaining milliseconds');
    const exactBoundary = test.getSchoolChangePolicy({
      schoolChangedAt: new Date(now.getTime() - sevenDays)
    }, now);
    check(exactBoundary.canChangeSchool, 'exactly seven days is allowed');
    const afterBoundary = test.getSchoolChangePolicy({
      schoolChangedAt: new Date(now.getTime() - sevenDays - 1)
    }, now);
    check(afterBoundary.canChangeSchool, 'more than seven days is allowed');
    check(test.getSchoolChangePolicy({}, now).canChangeSchool, 'legacy user without changed time is compatible');

    const firstUserId = seedUser('phase20-first-selection');
    const first = await call('selectSchool', {
      schoolId: schoolA,
      schoolChangedAt: '2099-01-01T00:00:00.000Z',
      schoolVersion: 999,
      schoolName: '伪造名称'
    });
    check(first.success && first.data.user.schoolId === schoolA, 'first school selection succeeds');
    check(first.data.user.schoolVersion === 1, 'first selection initializes version one');
    check(first.data.user.schoolChangedAt === '', 'first selection does not start change cooldown');
    check(first.data.user.canChangeSchool === true, 'first selection remains eligible for a later real change');
    check(!users.get(firstUserId).schoolChangedAt, 'client cannot forge first-selection changed time');

    const firstWrites = userWrites;
    const repeatedSelection = await call('selectSchool', { schoolId: schoolA });
    check(repeatedSelection.success, 'same-school first-selection retry succeeds');
    check(userWrites === firstWrites, 'same-school selection retry performs no write');

    const legacyUserId = seedUser('phase20-legacy-change', {
      schoolId: schoolA,
      schoolName: '客户端旧名称',
      schoolSelectedAt: new Date('2026-08-01T00:00:00.000Z'),
      schoolUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
      schoolVersion: 1
    });
    const changeStartedAt = Date.now();
    const changed = await call('updateSchool', {
      schoolId: schoolB,
      oldSchoolId: schoolC,
      schoolName: '客户端伪造名称',
      schoolChangedAt: '2000-01-01T00:00:00.000Z',
      schoolVersion: 999
    });
    check(changed.success && changed.data.schoolChange.changed === true, 'valid school change succeeds');
    check(changed.data.user.schoolName === '第二验证学院', 'school name comes from authoritative database');
    check(changed.data.user.schoolVersion === 2, 'real change increments school version exactly once');
    const changedAtTimestamp = new Date(changed.data.user.schoolChangedAt).getTime();
    check(
      changedAtTimestamp >= changeStartedAt && changedAtTimestamp <= Date.now(),
      'real change uses cloud runtime time'
    );
    check(
      changed.data.user.schoolChangedAt === users.get(legacyUserId).schoolChangedAt.toISOString(),
      'returned changed time matches stored changed time'
    );
    check(changed.data.user.canChangeSchool === false, 'real change immediately enters cooldown');
    check(
      new Date(changed.data.user.nextSchoolChangeAllowedAt).getTime() === changedAtTimestamp + sevenDays,
      'next allowed time is exactly seven days after server change time'
    );
    check(users.get(legacyUserId).schoolId === schoolB, 'authoritative user school is updated');

    const changedWrites = userWrites;
    const changedTimestamp = users.get(legacyUserId).schoolChangedAt.toISOString();
    const noOp = await call('updateSchool', { schoolId: schoolB });
    check(noOp.success && noOp.data.schoolChange.reason === 'unchanged', 'same-school direct call returns no-op');
    check(userWrites === changedWrites, 'same-school no-op performs no write');
    check(noOp.data.user.schoolVersion === 2, 'same-school no-op preserves version');
    check(noOp.data.user.schoolChangedAt === changedTimestamp, 'same-school no-op preserves cooldown start');

    const cooldown = await call('updateSchool', {
      schoolId: schoolC,
      canChangeSchool: true,
      oldSchoolId: schoolA,
      schoolChangedAt: '1999-01-01T00:00:00.000Z',
      schoolVersion: 0
    });
    check(cooldown.code === 'SCHOOL_CHANGE_COOLDOWN', 'direct cloud call cannot bypass cooldown');
    check(
      cooldown.data
      && cooldown.data.schoolChangeRemainingMs > sevenDays - 1000
      && cooldown.data.schoolChangeRemainingMs <= sevenDays,
      'cooldown returns safe display metadata'
    );
    check(users.get(legacyUserId).schoolId === schoolB && userWrites === changedWrites, 'cooldown rejection preserves user');

    seedUser('phase20-invalid-target', {
      schoolId: schoolA,
      schoolName: '第一验证大学',
      schoolVersion: 1
    });
    const invalid = await call('updateSchool', { schoolId: 'invalid' });
    check(invalid.code === 'INVALID_SCHOOL_ID', 'malformed target school is rejected');
    const missing = await call('updateSchool', { schoolId: missingSchool });
    check(missing.code === 'SCHOOL_NOT_FOUND', 'missing target school is rejected');
    const pending = await call('updateSchool', { schoolId: pendingSchool });
    check(pending.code === 'SCHOOL_NOT_ACTIVE', 'pending target school is rejected');

    async function boundaryCase(label, elapsedMs, expectedSuccess) {
      const id = seedUser(`phase20-${label}`, {
        schoolId: schoolA,
        schoolName: '第一验证大学',
        schoolSelectedAt: new Date('2026-07-01T00:00:00.000Z'),
        schoolUpdatedAt: new Date(now.getTime() - elapsedMs),
        schoolChangedAt: new Date(now.getTime() - elapsedMs),
        schoolVersion: 4
      });
      const beforeWrites = userWrites;
      const response = await call('updateSchool', { schoolId: schoolB });
      check(response.success === expectedSuccess, `${label} success boundary matches`);
      check(
        expectedSuccess
          ? users.get(id).schoolVersion === 5 && userWrites === beforeWrites + 1
          : response.code === 'SCHOOL_CHANGE_COOLDOWN' && userWrites === beforeWrites,
        `${label} write boundary matches`
      );
    }
    await boundaryCase('one-second-early', sevenDays - 1000, false);
    await boundaryCase('exactly-seven-days', sevenDays, true);
    await boundaryCase('after-seven-days', sevenDays + 1, true);

    const concurrentUserId = seedUser('phase20-concurrent', {
      schoolId: schoolA,
      schoolName: '第一验证大学',
      schoolVersion: 1
    });
    const concurrentWrites = userWrites;
    const concurrent = await Promise.all([
      call('updateSchool', { schoolId: schoolB }),
      call('updateSchool', { schoolId: schoolC })
    ]);
    const successes = concurrent.filter((item) => item.success);
    const rejected = concurrent.filter((item) => item.code === 'SCHOOL_CHANGE_COOLDOWN');
    check(successes.length === 1 && rejected.length === 1, 'parallel different-school requests allow only one change');
    check(users.get(concurrentUserId).schoolVersion === 2, 'parallel requests increment version only once');
    check(userWrites === concurrentWrites + 1, 'parallel requests perform exactly one user write');

    const current = await call('current');
    check(current.data.user.canChangeSchool === false, 'auth current exposes authoritative cooldown');
    check(Boolean(current.data.user.nextSchoolChangeAllowedAt), 'auth current exposes next allowed time');
    check(!/openid|OPENID/.test(JSON.stringify(current)), 'cooldown response does not expose internal identity');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

function verifyClientAndStatic(root, collector) {
  const { check } = collector;
  const authSource = read(root, 'cloudfunctions/authUser/index.js');
  const authServiceSource = read(root, 'services/auth-service.js');
  const authStoreSource = read(root, 'store/auth-store.js');
  const schoolPageSource = read(root, 'pages/school-select/index.js');
  const schoolTemplate = read(root, 'pages/school-select/index.wxml');
  const profileSource = read(root, 'pages/profile/index.js');
  const appSource = read(root, 'app.js');
  const homeSource = read(root, 'pages/home/index.js');
  const productQuerySource = read(root, 'cloudfunctions/productQuery/index.js');
  const favoriteSource = read(root, 'cloudfunctions/favoriteProduct/index.js');
  const messageSource = read(root, 'cloudfunctions/messageAction/index.js');
  const appointmentSource = read(root, 'cloudfunctions/appointmentAction/index.js');
  const updateSchoolServiceBlock = authServiceSource.slice(
    authServiceSource.indexOf('async function updateSchool'),
    authServiceSource.indexOf('function isLoggedIn')
  );

  check(/7 \* 24 \* 60 \* 60 \* 1000/.test(authSource), 'server defines exact seven-day duration');
  check(/const now = new Date\(\)/.test(authSource) && /schoolChangedAt:\s*now/.test(authSource), 'cloud runtime writes authoritative changed time');
  check(/assertSchoolChangeAllowed\(existing, now\)/.test(authSource), 'server enforces cooldown from stored user');
  check(/runTransaction/.test(authSource), 'school change remains transactional');
  check(/schoolChange:\s*\{[\s\S]*changed: !result\.unchanged/.test(authSource), 'server returns explicit no-op metadata');
  check(!/input\.(?:schoolChangedAt|schoolVersion|oldSchoolId|schoolName)/.test(authSource), 'server ignores forged protected school fields');
  check(!/collection\(['"]products['"]\)/.test(authSource), 'school change does not migrate products');

  check(/SCHOOL_CHANGE_COOLDOWN/.test(authServiceSource), 'client maps cooldown error');
  check(/schoolChangedAt/.test(authServiceSource) && /nextSchoolChangeAllowedAt/.test(authServiceSource), 'client normalizes cooldown fields');
  check(
    /callCloudFunction\(['"]updateSchool['"],\s*\{\s*schoolId: normalizedSchoolId\s*\}\)/.test(updateSchoolServiceBlock)
    && !/(?:oldSchoolId|schoolName|schoolChangedAt|schoolVersion)/.test(updateSchoolServiceBlock),
    'client sends only target school id'
  );
  check(/details/.test(authServiceSource), 'client preserves safe cooldown error details');

  ['schoolChangedAt', 'canChangeSchool', 'nextSchoolChangeAllowedAt', 'schoolChangeRemainingMs'].forEach((field) => {
    check(authStoreSource.includes(field), `AuthStore persists ${field}`);
  });
  check(/if \(schoolPromise\)/.test(authStoreSource), 'client coalesces repeated school submissions');
  check(!/wx\.clearStorage/.test(authStoreSource), 'school context does not clear unrelated storage');
  check(/onShow\(\)[\s\S]*AuthStore\.refreshCurrentUser/.test(appSource), 'foreground refresh detects multi-device school changes');

  check(/AuthStore\.refreshCurrentUser\(\)/.test(schoolPageSource), 'change page reads authoritative server cooldown');
  check(/SCHOOL_CHANGE_COOLDOWN/.test(schoolPageSource), 'change page handles cooldown race rejection');
  check(/7 天内不能再次修改/.test(schoolPageSource), 'confirmation explains seven-day impact');
  check(/canChangeSchool/.test(schoolTemplate) && /学校修改冷却中/.test(schoolTemplate), 'change page renders cooldown state');
  check(/schoolChangeHint/.test(profileSource), 'profile presents current cooldown status');

  check(/user\.schoolVersion/.test(homeSource), 'home scope key includes school version');
  ['products', 'nextCursor', 'queryScopeKey', 'marketMode', 'marketScope'].forEach((field) => {
    check(homeSource.includes(`${field}:`), `home invalidation covers ${field}`);
  });
  check(/requestVersion !== this\.requestVersion/.test(homeSource), 'late old-school responses are discarded');
  check(/SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*true/.test(productQuerySource), 'Phase 18 strict market remains enabled');
  [favoriteSource, messageSource, appointmentSource].forEach((source, index) => {
    check(/CROSS_SCHOOL_RELATION_FORBIDDEN/.test(source), `Phase 19 relation guard ${index + 1} remains present`);
  });
  check(/crossSchoolReadonly/.test(productQuerySource), 'Phase 19 cross-school detail remains present');
}

async function run(root = path.resolve(__dirname, '..')) {
  const collector = createCollector();
  await verifyServer(root, collector);
  verifyClientAndStatic(root, collector);
  return { checks: collector.count() };
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`Phase 20 school change cooldown verification succeeded: ${result.checks} checks passed.\n`);
  }).catch((error) => {
    process.stderr.write(`Phase 20 school change cooldown verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run };
