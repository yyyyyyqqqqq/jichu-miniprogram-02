const fs = require('fs');
const path = require('path');
const Module = require('module');

function createCollector() {
  let checks = 0;
  return {
    check(value, message) {
      if (!value) {
        throw new Error(message);
      }
      checks += 1;
    },
    count() {
      return checks;
    }
  };
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function createCollection(records, createQuery) {
  return {
    where(condition) {
      return createQuery(records, condition);
    }
  };
}

function createDatabaseHarness(records) {
  function compareActual(actual, expected) {
    const left = actual instanceof Date ? actual.getTime() : actual;
    const right = expected instanceof Date ? expected.getTime() : expected;
    return { left, right };
  }

  function matches(record, condition) {
    if (!condition || typeof condition !== 'object') {
      return true;
    }
    if (Array.isArray(condition.$and)) {
      return condition.$and.every((item) => matches(record, item));
    }
    if (Array.isArray(condition.$or)) {
      return condition.$or.some((item) => matches(record, item));
    }
    return Object.entries(condition).every(([key, expected]) => {
      if (expected && Array.isArray(expected.$in)) {
        return expected.$in.includes(record[key]);
      }
      if (expected && Object.prototype.hasOwnProperty.call(expected, '$lte')) {
        const compared = compareActual(record[key], expected.$lte);
        return compared.left <= compared.right;
      }
      if (expected && Object.prototype.hasOwnProperty.call(expected, '$lt')) {
        const compared = compareActual(record[key], expected.$lt);
        return compared.left < compared.right;
      }
      if (expected && Object.prototype.hasOwnProperty.call(expected, '$gt')) {
        const compared = compareActual(record[key], expected.$gt);
        return compared.left > compared.right;
      }
      if (expected && expected.$regexp instanceof RegExp) {
        const text = Array.isArray(record[key])
          ? record[key].join(' ')
          : String(record[key] || '');
        return expected.$regexp.test(text);
      }
      const compared = compareActual(record[key], expected);
      return compared.left === compared.right;
    });
  }

  function createQuery(sourceRecords, condition) {
    const orderRules = [];
    let offset = 0;
    let limit = sourceRecords.length;
    const query = {
      orderBy(field, direction) {
        orderRules.push({ field, direction });
        return query;
      },
      skip(value) {
        offset = value;
        return query;
      },
      limit(value) {
        limit = value;
        return query;
      },
      async count() {
        return {
          total: sourceRecords.filter((record) => matches(record, condition)).length
        };
      },
      async get() {
        const filtered = sourceRecords
          .filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const rule of orderRules) {
              const compared = compareActual(left[rule.field], right[rule.field]);
              if (compared.left === compared.right) {
                continue;
              }
              const direction = rule.direction === 'desc' ? -1 : 1;
              return (compared.left > compared.right ? 1 : -1) * direction;
            }
            return 0;
          });
        return {
          data: filtered.slice(offset, offset + limit)
        };
      }
    };
    return query;
  }

  const command = {
    in(value) {
      return { $in: value };
    },
    and(value) {
      return { $and: value };
    },
    or(value) {
      return { $or: value };
    },
    lte(value) {
      return { $lte: value };
    },
    lt(value) {
      return { $lt: value };
    },
    gt(value) {
      return { $gt: value };
    }
  };
  const collections = new Map();
  collections.set('products', createCollection(records, createQuery));
  return {
    command,
    createQuery,
    collection(name) {
      if (!collections.has(name)) {
        collections.set(name, createCollection([], createQuery));
      }
      return collections.get(name);
    },
    RegExp({ regexp, options }) {
      return { $regexp: new RegExp(regexp, options) };
    }
  };
}

function loadProductQuery(root, database, contextRef) {
  const functionPath = path.join(root, 'cloudfunctions/productQuery/index.js');
  const originalLoad = Module._load;
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return contextRef.current;
    }
  };
  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(functionPath)];
    return require(functionPath);
  } finally {
    Module._load = originalLoad;
  }
}

async function expectCode(operation, code, collector, message) {
  try {
    await operation();
  } catch (error) {
    collector.check(error && (error.code || error.businessCode) === code, message);
    return;
  }
  throw new Error(message);
}

function verifyStaticBoundaries(root, collector) {
  const querySource = read(root, 'cloudfunctions/productQuery/index.js');
  const coreSource = read(root, 'cloudfunctions/productQuery/market-core.js');
  const serviceSource = read(root, 'services/product-service.js');
  const homeSource = read(root, 'pages/home/index.js');
  const detailSource = querySource.slice(
    querySource.indexOf('async function getProductDetail'),
    querySource.indexOf('async function listMyProducts')
  );
  const myProductsSource = querySource.slice(
    querySource.indexOf('async function listMyProducts'),
    querySource.indexOf('exports.main')
  );

  collector.check(
    /SCHOOL_SCOPED_MARKET_ENABLED\s*=\s*true/.test(querySource),
    'strict market canary is not enabled'
  );
  collector.check(
    /SCHOOL_SCOPED_MARKET_ALLOWLIST\s*=\s*Object\.freeze\(\[\s*[\s\S]*?\]\)/.test(querySource)
      && ((querySource.slice(
        querySource.indexOf('SCHOOL_SCOPED_MARKET_ALLOWLIST'),
        querySource.indexOf('CURSOR_SECRET_ENV_NAME')
      ).match(/sha256:[0-9a-f]{64}/g) || []).length === 0)
      && /SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*true/.test(querySource),
    'final rollout must enable strict-for-all with an empty allowlist'
  );
  collector.check(
    /legacy_market/.test(coreSource) && /school_scoped_market/.test(coreSource),
    'internal market modes are missing'
  );
  collector.check(
    /PRODUCT_QUERY_CURSOR_HMAC_SECRET/.test(querySource)
      && !/[A-Za-z0-9+/=_-]{48,}/.test(
        querySource.slice(
          querySource.indexOf('CURSOR_SECRET_ENV_NAME'),
          querySource.indexOf('const ERROR_CODES')
        )
      ),
    'cursor secret is hard-coded or not injectable'
  );
  collector.check(
    /timingSafeEqual/.test(coreSource)
      && /createHmac\(['"]sha256['"]/.test(coreSource),
    'cursor HMAC or constant-time comparison is missing'
  );
  collector.check(
    /createdAt:\s*command\.lte/.test(querySource)
      && /buildSeekCondition/.test(querySource),
    'snapshot or seek query boundary is missing'
  );
  collector.check(
    /\.skip\(offset\)\.limit\(pageSize\)/.test(querySource),
    'legacy offset pagination was removed'
  );
  collector.check(
    /schoolId:\s*options\.schoolId/.test(querySource),
    'strict query does not force the server school'
  );
  collector.check(
    !/schoolId/.test(detailSource),
    'product detail was expanded into phase 19'
  );
  collector.check(
    /sellerOpenid:\s*openId/.test(myProductsSource)
      && !/scopeSchoolId/.test(myProductsSource),
    'myProducts was changed to current-school filtering'
  );
  collector.check(
    !/requestData\.schoolId|requestData\.marketMode|allowlistUserId/.test(serviceSource),
    'ProductService submits a trusted market or school selector'
  );
  collector.check(
    /marketMode/.test(homeSource)
      && /marketScope/.test(homeSource)
      && /nextCursor/.test(homeSource)
      && /queryScopeKey/.test(homeSource),
    'home market state is incomplete'
  );
  collector.check(
    /requestVersion/.test(homeSource)
      && /result\.marketMode\s*!==\s*requestScope\.marketMode/.test(homeSource)
      && /responseSchoolId\s*!==\s*requestScope\.schoolId/.test(homeSource),
    'home stale market/school response rejection is missing'
  );
  collector.check(
    /nextCursor:\s*''/.test(homeSource)
      && /queryScopeKey:\s*''/.test(homeSource),
    'home does not reset strict pagination state'
  );
  collector.check(
    /viewState:\s*['"]guide['"]/.test(homeSource)
      && /AUTH_REQUIRED/.test(homeSource)
      && /SCHOOL_UNAVAILABLE/.test(homeSource),
    'home shell guidance states are missing'
  );
  collector.check(
    /marketModeHint\s*===\s*MARKET_MODE\.SCHOOL_SCOPED[\s\S]{0,160}requestData\.cursor/.test(
      serviceSource
    )
      && /else\s*\{\s*requestData\.page\s*=\s*page/.test(serviceSource),
    'ProductService does not separate cursor and offset request shapes'
  );
  collector.check(
    /onKeywordInput[\s\S]{0,260}nextCursor:\s*''[\s\S]{0,80}queryScopeKey:\s*''/.test(
      homeSource
    ),
    'keyword changes do not clear the strict cursor'
  );
  collector.check(
    /onCategoryChange[\s\S]{0,300}nextCursor:\s*''[\s\S]{0,80}queryScopeKey:\s*''/.test(
      homeSource
    ),
    'category changes do not clear the strict cursor'
  );
  collector.check(
    /onSortChange[\s\S]{0,340}nextCursor:\s*''[\s\S]{0,80}queryScopeKey:\s*''/.test(
      homeSource
    ),
    'sort changes do not clear the strict cursor'
  );
  collector.check(
    /mode\s*===\s*['"]refresh['"][\s\S]{0,180}nextCursor:\s*''[\s\S]{0,80}queryScopeKey:\s*''/.test(
      homeSource
    ),
    'pull-down refresh does not reset the strict window'
  );
  collector.check(
    /mergeProducts[\s\S]{0,260}seenIds/.test(homeSource),
    'client product-id de-duplication is missing'
  );
  collector.check(
    /mode\s*===\s*['"]loadMore['"][\s\S]{0,2600}loadMoreError:\s*true/.test(
      homeSource
    ),
    'load-more failure does not preserve the existing list'
  );
  collector.check(
    /buildAuthScopeKey/.test(homeSource)
      && /nextAuthScopeKey\s*!==\s*this\.authScopeKey/.test(homeSource),
    'login or school state changes do not reset the market window'
  );
  collector.check(
    /requestVersion\s*!==\s*this\.requestVersion/.test(homeSource)
      && /isRequestScopeCurrent/.test(homeSource),
    'old request versions or filters can overwrite the current page'
  );
  collector.check(
    !/getProducts\([\s\S]{0,120}catch[\s\S]{0,120}getProducts/.test(
      serviceSource
    ),
    'ProductService contains an automatic legacy retry'
  );
}

async function verifyCoreAndServer(root, collector) {
  const core = require(path.join(
    root,
    'cloudfunctions/productQuery/market-core.js'
  ));
  const schoolA = 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const schoolB = 's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const appId = 'wx-phase18-test-app';
  const openIdA = 'openid-phase18-a';
  const openIdB = 'openid-phase18-b';
  const userIdA = core.createUserId(appId, openIdA);
  const userIdB = core.createUserId(appId, openIdB);
  const secret = 'phase-18-local-test-hmac-secret-32-bytes';
  const nowMs = Date.parse('2026-07-29T12:00:00.000Z');

  collector.check(
    core.decideMarketMode({ enabled: false, userId: userIdA })
      === core.MARKET_MODE.LEGACY,
    'disabled rollout did not choose legacy'
  );
  collector.check(
    core.decideMarketMode({ enabled: true, allowlist: [], userId: userIdA })
      === core.MARKET_MODE.LEGACY,
    'empty allowlist did not choose legacy'
  );
  collector.check(
    core.decideMarketMode({
      enabled: true,
      allowlist: [userIdB],
      userId: userIdA
    }) === core.MARKET_MODE.LEGACY,
    'non-allowlisted user entered strict mode'
  );
  collector.check(
    core.decideMarketMode({
      enabled: true,
      allowlist: [userIdA],
      userId: userIdA
    }) === core.MARKET_MODE.SCHOOL_SCOPED,
    'allowlisted user did not enter strict mode'
  );
  collector.check(
    core.decideMarketMode({
      enabled: true,
      strictForAll: true,
      userId: ''
    }) === core.MARKET_MODE.SCHOOL_SCOPED,
    'formal strict mode cannot fail closed for anonymous callers'
  );
  collector.check(
    core.createKeywordDigest('  测试   商品 ', 'life')
      === core.createKeywordDigest('测试 商品', 'life'),
    'keyword digest normalization is unstable'
  );
  collector.check(
    core.createKeywordDigest('测试 商品', 'life')
      !== core.createKeywordDigest('测试 商品', 'books'),
    'keyword digest is not bound to category'
  );

  const cursorPayload = core.buildCursorPayload({
    scopeSchoolId: schoolA,
    categoryId: 'all',
    normalizedKeywordDigest: core.createKeywordDigest('', 'all'),
    sortBy: 'default',
    pageSize: 2,
    snapshotAt: new Date(nowMs).toISOString(),
    lastRecord: {
      _id: 'product-cursor',
      favoriteCount: 3,
      viewCount: 4,
      createdAt: new Date('2026-07-29T11:00:00.000Z')
    }
  });
  const cursor = core.createCursor(cursorPayload, secret, nowMs);
  const expectedScope = {
    marketMode: core.MARKET_MODE.SCHOOL_SCOPED,
    scopeSchoolId: schoolA,
    action: core.CURSOR_ACTION,
    categoryId: 'all',
    normalizedKeywordDigest: core.createKeywordDigest('', 'all'),
    sortBy: 'default',
    statuses: ['available', 'reserved'],
    pageSize: 2
  };
  collector.check(
    core.parseCursor(cursor, secret, expectedScope, nowMs).lastItemId
      === 'product-cursor',
    'valid signed cursor did not round-trip'
  );
  collector.check(!cursor.includes('测试'), 'cursor leaked raw search content');
  await expectCode(
    () => core.parseCursor(`${cursor.slice(0, 5)}x${cursor.slice(6)}`, secret, expectedScope, nowMs),
    'INVALID_CURSOR_SCOPE',
    collector,
    'tampered cursor payload was accepted'
  );
  await expectCode(
    () => {
      const [encoded, signature] = cursor.split('.');
      const replacement = signature[0] === 'A' ? 'B' : 'A';
      return core.parseCursor(
        `${encoded}.${replacement}${signature.slice(1)}`,
        secret,
        expectedScope,
        nowMs
      );
    },
    'INVALID_CURSOR_SCOPE',
    collector,
    'tampered cursor signature was accepted'
  );
  for (const [field, value, label] of [
    ['scopeSchoolId', schoolB, 'school'],
    ['categoryId', 'life', 'category'],
    ['normalizedKeywordDigest', core.createKeywordDigest('other', 'all'), 'keyword'],
    ['sortBy', 'newest', 'sort'],
    ['pageSize', 3, 'pageSize'],
    ['marketMode', core.MARKET_MODE.LEGACY, 'mode']
  ]) {
    await expectCode(
      () => core.parseCursor(cursor, secret, {
        ...expectedScope,
        [field]: value
      }, nowMs),
      'INVALID_CURSOR_SCOPE',
      collector,
      `cross-${label} cursor was accepted`
    );
  }
  await expectCode(
    () => core.createCursor(cursorPayload, '', nowMs),
    'CURSOR_SECRET_UNAVAILABLE',
    collector,
    'missing HMAC secret did not fail explicitly'
  );
  await expectCode(
    () => core.parseCursor('x'.repeat(5000), secret, expectedScope, nowMs),
    'INVALID_CURSOR_SCOPE',
    collector,
    'oversized cursor was accepted'
  );

  const records = [
    {
      _id: 'product-a1',
      title: '测试 台灯',
      description: '学校 A 商品',
      categoryId: 'life',
      categoryName: '生活',
      condition: '九成新',
      location: '校内',
      tags: ['测试'],
      schoolId: schoolA,
      schoolName: '学校 A',
      status: 'available',
      price: 20,
      favoriteCount: 5,
      viewCount: 9,
      createdAt: new Date('2026-07-29T11:30:00.000Z')
    },
    {
      _id: 'product-a2',
      title: '测试 键盘',
      description: '学校 A 商品',
      categoryId: 'digital',
      categoryName: '数码',
      condition: '八成新',
      location: '校内',
      tags: ['测试'],
      schoolId: schoolA,
      schoolName: '学校 A',
      status: 'reserved',
      price: 10,
      favoriteCount: 5,
      viewCount: 9,
      createdAt: new Date('2026-07-29T11:30:00.000Z')
    },
    {
      _id: 'product-a3',
      title: '测试 图书',
      description: '学校 A 商品',
      categoryId: 'books',
      categoryName: '书籍',
      condition: '七成新',
      location: '校内',
      tags: ['测试'],
      schoolId: schoolA,
      schoolName: '学校 A',
      status: 'available',
      price: 30,
      favoriteCount: 2,
      viewCount: 7,
      createdAt: new Date('2026-07-29T10:00:00.000Z')
    },
    {
      _id: 'product-b1',
      title: '测试 学校 B',
      description: '学校 B 商品',
      categoryId: 'life',
      categoryName: '生活',
      condition: '九成新',
      location: '校内',
      tags: ['测试'],
      schoolId: schoolB,
      schoolName: '学校 B',
      status: 'available',
      price: 15,
      favoriteCount: 20,
      viewCount: 20,
      createdAt: new Date('2026-07-29T11:00:00.000Z')
    },
    {
      _id: 'product-legacy',
      title: '测试 无学校',
      description: '历史商品',
      categoryId: 'life',
      categoryName: '生活',
      condition: '九成新',
      location: '校内',
      tags: ['测试'],
      status: 'available',
      price: 1,
      favoriteCount: 99,
      viewCount: 99,
      createdAt: new Date('2026-07-29T11:00:00.000Z')
    },
    {
      _id: 'product-new-after-snapshot',
      title: '测试 新商品',
      description: '晚于窗口',
      categoryId: 'life',
      categoryName: '生活',
      condition: '九成新',
      location: '校内',
      tags: ['测试'],
      schoolId: schoolA,
      schoolName: '学校 A',
      status: 'available',
      price: 2,
      favoriteCount: 50,
      viewCount: 50,
      createdAt: new Date('2026-07-29T12:01:00.000Z')
    }
  ];
  const database = createDatabaseHarness(records);
  const contextRef = {
    current: { APPID: appId, OPENID: openIdA }
  };
  const productQuery = loadProductQuery(root, database, contextRef);
  const users = [
    {
      _id: userIdA,
      openid: openIdA,
      status: 'active',
      profileCompleted: true,
      nickname: '用户 A',
      avatarUrl: 'cloud://avatar/a.png',
      schoolId: schoolA,
      schoolName: '旧学校名称'
    },
    {
      _id: userIdB,
      openid: openIdB,
      status: 'active',
      profileCompleted: true,
      nickname: '用户 B',
      avatarUrl: 'cloud://avatar/b.png',
      schoolId: schoolB,
      schoolName: '学校 B'
    }
  ];
  const schoolRecords = [
    {
      _id: schoolA,
      name: '学校 A 权威名称',
      platformStatus: 'active',
      officialStatus: 'valid'
    },
    {
      _id: schoolB,
      name: '学校 B',
      platformStatus: 'active',
      officialStatus: 'valid'
    }
  ];
  const dependencies = {
    rolloutConfig: {
      enabled: true,
      strictForAll: false,
      allowlist: [userIdA, userIdB]
    },
    cursorSecret: secret,
    nowMs,
    productsCollection: createCollection(records, database.createQuery),
    usersCollection: createCollection(users, database.createQuery),
    schoolsCollection: createCollection(schoolRecords, database.createQuery)
  };
  const identityA = {
    appId,
    openId: openIdA,
    userId: userIdA
  };
  const first = await productQuery.__test.listProducts({
    page: 99,
    pageSize: 2,
    categoryId: 'all',
    sortBy: 'default',
    schoolId: schoolB,
    marketMode: 'legacy',
    allowlistUserId: userIdB
  }, identityA, dependencies);
  collector.check(first.success === true, 'strict first page failed');
  collector.check(
    first.data.marketMode === 'schoolScoped'
      && first.data.scope.schoolId === schoolA
      && first.data.scope.schoolName === '学校 A 权威名称',
    'strict response lacks authoritative scope'
  );
  collector.check(
    first.data.list.every((product) => product.schoolId === schoolA),
    'school A query leaked another school'
  );
  collector.check(
    !first.data.list.some((product) => product._id === 'product-legacy'),
    'strict query returned a no-school product'
  );
  collector.check(
    !first.data.list.some((product) => product._id === 'product-new-after-snapshot'),
    'snapshot window included a later product'
  );
  collector.check(
    first.data.total === null && first.data.page === null,
    'strict response fabricated offset pagination totals'
  );
  collector.check(
    first.data.hasMore === true && Boolean(first.data.nextCursor),
    'strict first page did not create a signed next cursor'
  );
  const second = await productQuery.__test.listProducts({
    pageSize: 2,
    categoryId: 'all',
    sortBy: 'default',
    cursor: first.data.nextCursor
  }, identityA, dependencies);
  const combinedIds = first.data.list.concat(second.data.list)
    .map((product) => product._id);
  collector.check(
    combinedIds.length === new Set(combinedIds).size,
    'strict pages contain duplicate product ids'
  );
  collector.check(
    combinedIds.includes('product-a1')
      && combinedIds.includes('product-a2')
      && combinedIds.includes('product-a3'),
    'strict pages omitted an in-scope product'
  );
  collector.check(
    combinedIds.indexOf('product-a1') < combinedIds.indexOf('product-a2'),
    '_id ASC did not break equal comprehensive sort values'
  );

  for (const sortBy of ['default', 'newest', 'priceAsc', 'priceDesc']) {
    const sortedRecords = records
      .filter((record) => (
        record.schoolId === schoolA
        && ['available', 'reserved'].includes(record.status)
        && record.createdAt.getTime() <= nowMs
      ))
      .sort((left, right) => core.compareRecords(left, right, sortBy));
    const observed = [];
    let nextCursor = '';
    do {
      const response = await productQuery.__test.listProducts({
        pageSize: 2,
        categoryId: 'all',
        sortBy,
        cursor: nextCursor
      }, identityA, dependencies);
      observed.push(...response.data.list.map((product) => product._id));
      nextCursor = response.data.nextCursor;
    } while (nextCursor);
    collector.check(
      JSON.stringify(observed) === JSON.stringify(
        sortedRecords.map((record) => record._id)
      ),
      `${sortBy} seek pagination order is unstable`
    );
    collector.check(
      observed.length === new Set(observed).size,
      `${sortBy} seek pagination returned duplicates`
    );
  }

  const identityB = {
    appId,
    openId: openIdB,
    userId: userIdB
  };
  const schoolBResult = await productQuery.__test.listProducts({
    pageSize: 20,
    categoryId: 'all',
    sortBy: 'newest',
    schoolId: schoolA
  }, identityB, dependencies);
  collector.check(
    schoolBResult.data.list.length === 1
      && schoolBResult.data.list[0]._id === 'product-b1',
    'school B query leaked school A data'
  );
  await expectCode(
    () => productQuery.__test.listProducts({
      pageSize: 3,
      categoryId: 'all',
      sortBy: 'default',
      cursor: first.data.nextCursor
    }, identityA, dependencies),
    'INVALID_CURSOR_SCOPE',
    collector,
    'pageSize-changing strict cursor was accepted'
  );
  await expectCode(
    () => productQuery.__test.listProducts({
      pageSize: 2,
      categoryId: 'life',
      sortBy: 'default',
      cursor: first.data.nextCursor
    }, identityA, dependencies),
    'INVALID_CURSOR_SCOPE',
    collector,
    'category-changing strict cursor was accepted'
  );
  await expectCode(
    () => productQuery.__test.listProducts({
      pageSize: 2,
      categoryId: 'all',
      keyword: '不同关键词',
      sortBy: 'default',
      cursor: first.data.nextCursor
    }, identityA, dependencies),
    'INVALID_CURSOR_SCOPE',
    collector,
    'keyword-changing strict cursor was accepted'
  );
  await expectCode(
    () => productQuery.__test.listProducts({
      pageSize: 2,
      categoryId: 'all',
      sortBy: 'newest',
      cursor: first.data.nextCursor
    }, identityA, dependencies),
    'INVALID_CURSOR_SCOPE',
    collector,
    'sort-changing strict cursor was accepted'
  );
  await expectCode(
    () => productQuery.__test.listProducts({
      pageSize: 2,
      categoryId: 'all',
      sortBy: 'default',
      cursor: first.data.nextCursor
    }, identityB, dependencies),
    'INVALID_CURSOR_SCOPE',
    collector,
    'cross-school strict cursor was accepted'
  );
  await expectCode(
    () => productQuery.__test.listSchoolScopedProducts({
      pageSize: 2,
      categoryId: 'all',
      sortBy: 'default'
    }, null, dependencies),
    'AUTH_REQUIRED',
    collector,
    'formal strict anonymous request queried the market'
  );
  await expectCode(
    () => productQuery.__test.listSchoolScopedProducts({
      pageSize: 2,
      categoryId: 'all',
      sortBy: 'default'
    }, identityA, { ...dependencies, cursorSecret: '' }),
    'CURSOR_SECRET_UNAVAILABLE',
    collector,
    'strict mode continued without a cursor secret'
  );
  const failedProducts = {
    where() {
      return {
        orderBy() {
          return this;
        },
        limit() {
          return this;
        },
        async get() {
          throw Object.assign(new Error('index not found'), {
            errCode: 'DATABASE_INDEX_NOT_FOUND'
          });
        }
      };
    }
  };
  let indexFailureObserved = false;
  try {
    await productQuery.__test.listSchoolScopedProducts({
      pageSize: 2,
      categoryId: 'all',
      sortBy: 'default'
    }, identityA, {
      ...dependencies,
      productsCollection: failedProducts
    });
  } catch (error) {
    indexFailureObserved = error && error.errCode === 'DATABASE_INDEX_NOT_FOUND';
  }
  collector.check(indexFailureObserved, 'strict index failure was swallowed or retried without school');

  const invalidSort = await productQuery.__test.listProducts({
    categoryId: 'all',
    sortBy: 'unknown',
    pageSize: 2
  }, identityA, dependencies);
  collector.check(
    invalidSort.success === false && invalidSort.code === 'INVALID_PARAMS',
    'unknown strict sort was not rejected'
  );

  const contextVariants = [
    {
      user: null,
      schools: schoolRecords,
      code: 'USER_NOT_FOUND'
    },
    {
      user: { ...users[0], status: 'disabled' },
      schools: schoolRecords,
      code: 'USER_INACTIVE'
    },
    {
      user: { ...users[0], schoolId: '' },
      schools: schoolRecords,
      code: 'SCHOOL_REQUIRED'
    },
    {
      user: { ...users[0], schoolId: 'bad-school' },
      schools: schoolRecords,
      code: 'SCHOOL_INVALID'
    },
    {
      user: users[0],
      schools: [],
      code: 'SCHOOL_UNAVAILABLE'
    },
    {
      user: users[0],
      schools: [{ ...schoolRecords[0], platformStatus: 'pending' }],
      code: 'SCHOOL_UNAVAILABLE'
    },
    {
      user: users[0],
      schools: [{ ...schoolRecords[0], officialStatus: 'invalid' }],
      code: 'SCHOOL_UNAVAILABLE'
    },
    {
      user: { ...users[0], openid: 'forged-openid' },
      schools: schoolRecords,
      code: 'SCHOOL_CONTEXT_MISMATCH'
    }
  ];
  const incompleteProfileContext = await productQuery.__test.resolveMarketSchoolContext(
    identityA,
    {
      usersCollection: createCollection(
        [{ ...users[0], nickname: '', avatarUrl: '', profileCompleted: false }],
        database.createQuery
      ),
      schoolsCollection: createCollection(schoolRecords, database.createQuery)
    }
  );
  collector.check(
    incompleteProfileContext.schoolId === schoolA,
    'school-ready identity with incomplete display profile lost strict market access'
  );
  for (const variant of contextVariants) {
    await expectCode(
      () => productQuery.__test.resolveMarketSchoolContext(identityA, {
        usersCollection: createCollection(
          variant.user ? [variant.user] : [],
          database.createQuery
        ),
        schoolsCollection: createCollection(
          variant.schools,
          database.createQuery
        )
      }),
      variant.code,
      collector,
      `school context did not fail closed with ${variant.code}`
    );
  }
}

async function verifyClientService(root, collector) {
  const servicePath = path.join(root, 'services/product-service.js');
  const cloudServicePath = path.join(root, 'services/cloud-service.js');
  const originalWx = global.wx;
  const originalCloudService = require.cache[require.resolve(cloudServicePath)];
  const requests = [];
  let nextResponse = null;
  require.cache[require.resolve(cloudServicePath)] = {
    id: cloudServicePath,
    filename: cloudServicePath,
    loaded: true,
    exports: {
      ensureCloudReady: async () => true
    }
  };
  global.wx = {
    cloud: {
      callFunction({ data, success }) {
        requests.push(data);
        success({ result: nextResponse });
      }
    }
  };
  try {
    delete require.cache[require.resolve(servicePath)];
    const ProductService = require(servicePath);
    nextResponse = {
      success: true,
      code: 'OK',
      message: '',
      data: {
        list: [],
        total: 0,
        page: 1,
        pageSize: 6,
        hasMore: false,
        nextCursor: '',
        marketMode: 'legacy',
        scope: { schoolId: '', schoolName: '' }
      }
    };
    const legacy = await ProductService.getProducts({
      page: 1,
      pageSize: 6,
      schoolId: 'forged-school',
      marketMode: ''
    });
    collector.check(legacy.marketMode === 'legacy', 'legacy service response mode is wrong');
    collector.check(requests[0].data.page === 1, 'legacy first page omitted page');
    collector.check(
      !Object.prototype.hasOwnProperty.call(requests[0].data, 'schoolId')
        && !Object.prototype.hasOwnProperty.call(requests[0].data, 'marketMode'),
      'client submitted a school or market selector'
    );

    nextResponse = {
      success: true,
      code: 'OK',
      message: '',
      data: {
        list: [],
        total: null,
        page: null,
        pageSize: 6,
        hasMore: true,
        nextCursor: 'signed-cursor',
        marketMode: 'schoolScoped',
        scope: {
          schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          schoolName: '学校 A'
        }
      }
    };
    const strict = await ProductService.getProducts({
      marketMode: ProductService.MARKET_MODE.SCHOOL_SCOPED,
      cursor: 'previous-cursor',
      page: 99,
      pageSize: 6,
      schoolId: 's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    });
    const strictRequest = requests[1].data;
    collector.check(strict.marketMode === 'schoolScoped', 'strict service mode is wrong');
    collector.check(strict.total === null && strict.page === null, 'strict service fabricated totals');
    collector.check(strict.nextCursor === 'signed-cursor', 'strict service lost nextCursor');
    collector.check(
      strictRequest.cursor === 'previous-cursor'
        && !Object.prototype.hasOwnProperty.call(strictRequest, 'page'),
      'strict loading did not use cursor-only pagination'
    );
    collector.check(
      !Object.prototype.hasOwnProperty.call(strictRequest, 'schoolId')
        && !Object.prototype.hasOwnProperty.call(strictRequest, 'marketMode'),
      'strict client request exposed trusted rollout inputs'
    );

    const requestCountBeforeFailure = requests.length;
    nextResponse = {
      success: false,
      code: 'DATABASE_ERROR',
      message: '校园市场查询失败',
      data: null
    };
    let failed = false;
    try {
      await ProductService.getProducts({
        marketMode: ProductService.MARKET_MODE.SCHOOL_SCOPED,
        cursor: '',
        pageSize: 6
      });
    } catch (error) {
      failed = error && error.code === 'DATABASE_ERROR';
    }
    collector.check(failed, 'strict query failure was not surfaced');
    collector.check(
      requests.length === requestCountBeforeFailure + 1,
      'strict query failure retried the legacy market'
    );
  } finally {
    delete require.cache[require.resolve(servicePath)];
    if (originalCloudService) {
      require.cache[require.resolve(cloudServicePath)] = originalCloudService;
    } else {
      delete require.cache[require.resolve(cloudServicePath)];
    }
    global.wx = originalWx;
  }
}

async function verifyPhase18Flow(root) {
  const collector = createCollector();
  verifyStaticBoundaries(root, collector);
  await verifyCoreAndServer(root, collector);
  await verifyClientService(root, collector);
  return {
    checks: collector.count()
  };
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  verifyPhase18Flow(root)
    .then((result) => {
      console.log(
        `Phase 18 school-scoped market verification succeeded: ${result.checks} checks passed.`
      );
    })
    .catch((error) => {
      console.error(
        `Phase 18 school-scoped market verification failed: ${error.message}`
      );
      process.exitCode = 1;
    });
}

module.exports = {
  verifyPhase18Flow
};
