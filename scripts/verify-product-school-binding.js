const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

function read(projectRoot, relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createCheckCollector() {
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

function createProductId(userId, requestId) {
  return `p_${crypto
    .createHash('sha256')
    .update(`${userId}:${requestId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function createSimpleCollection(store) {
  return {
    where(query) {
      return {
        limit() {
          return this;
        },
        async get() {
          const record = store.get(query._id);
          return {
            data: record ? [clone(record)] : []
          };
        }
      };
    },
    doc(id) {
      return {
        async set({ data }) {
          store.set(id, Object.assign({ _id: id }, clone(data)));
        }
      };
    }
  };
}

async function verifyCreateBinding(projectRoot, collector) {
  const functionPath = path.join(
    projectRoot,
    'cloudfunctions/createProduct/index.js'
  );
  const originalLoad = Module._load;
  const users = new Map();
  const schools = new Map();
  const products = new Map();
  const appId = 'phase17-verification-app';
  const openId = 'phase17-verification-user';
  const userId = createUserId(appId, openId);
  const schoolId = `s_${'a'.repeat(32)}`;
  let context = {
    APPID: appId,
    OPENID: openId
  };

  const validUser = {
    _id: userId,
    openid: openId,
    nickname: '学校绑定验收同学',
    avatarUrl: 'cloud://test-env.bucket/avatars/phase17/avatar.jpg',
    campus: '客户端历史校园文本',
    status: 'active',
    profileCompleted: true,
    schoolId,
    schoolName: '用户记录中的旧学校名称'
  };
  const validSchool = {
    _id: schoolId,
    name: '权威验证大学',
    officialStatus: 'valid',
    platformStatus: 'active',
    authority: '内部主管部门',
    sourceRow: 17
  };
  users.set(userId, clone(validUser));
  schools.set(schoolId, clone(validSchool));

  const db = {
    collection(name) {
      if (name === 'users') {
        return createSimpleCollection(users);
      }
      if (name === 'schools') {
        return createSimpleCollection(schools);
      }
      if (name === 'products') {
        return createSimpleCollection(products);
      }
      throw new Error(`unexpected createProduct collection ${name}`);
    },
    serverDate() {
      return {
        $serverDate: true
      };
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return context;
    }
  };

  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const validProduct = {
    title: '学校绑定验证商品',
    description: '用于验证新发布商品学校归属的完整描述。',
    price: 17.5,
    categoryId: 'books',
    condition: '九成新',
    location: '图书馆公共区域',
    locationDetail: {
      name: '图书馆公共区域',
      address: '验证大学图书馆南侧公共区域',
      latitude: 31.23,
      longitude: 121.47
    },
    images: [
      `cloud://test-env.bucket/products/${userId}/20260729/phase17.jpg`
    ],
    video: null,
    schoolId: `s_${'f'.repeat(32)}`,
    schoolName: '客户端伪造大学',
    schoolBoundAt: 'client-time',
    campus: '客户端伪造校园',
    sellerId: 'u_spoofed',
    sellerOpenid: 'spoofed-openid',
    sellerName: '伪造卖家',
    status: 'sold'
  };

  try {
    delete require.cache[require.resolve(functionPath)];
    const createProduct = require(functionPath);

    context = {};
    const unauthorized = await createProduct.main({
      requestId: 'phase17_auth_required_001',
      product: validProduct
    });
    collector.check(
      unauthorized.success === false
        && unauthorized.code === 'AUTH_CONTEXT_MISSING',
      'createProduct accepts a missing trusted cloud identity'
    );

    context = {
      APPID: appId,
      OPENID: 'missing-phase17-user'
    };
    const missingUser = await createProduct.main({
      requestId: 'phase17_missing_user_001',
      product: validProduct
    });
    collector.check(
      missingUser.success === false && missingUser.code === 'USER_NOT_FOUND',
      'createProduct accepts an identity without a user record'
    );

    context = {
      APPID: appId,
      OPENID: openId
    };
    users.set(userId, Object.assign({}, validUser, {
      profileCompleted: false
    }));
    const incomplete = await createProduct.main({
      requestId: 'phase17_profile_incomplete_001',
      product: validProduct
    });
    collector.check(
      incomplete.success === false && incomplete.code === 'PROFILE_INCOMPLETE',
      'createProduct accepts an incomplete profile'
    );

    users.set(userId, Object.assign({}, validUser, {
      schoolId: '',
      schoolName: ''
    }));
    const noSchool = await createProduct.main({
      requestId: 'phase17_school_required_001',
      product: validProduct
    });
    collector.check(
      noSchool.success === false
        && noSchool.code === 'SCHOOL_SELECTION_REQUIRED',
      'createProduct accepts a user without a selected school'
    );

    users.set(userId, Object.assign({}, validUser, {
      schoolId: 'malformed-school'
    }));
    const malformedSchool = await createProduct.main({
      requestId: 'phase17_school_malformed_001',
      product: validProduct
    });
    collector.check(
      malformedSchool.success === false
        && malformedSchool.code === 'SCHOOL_UNAVAILABLE',
      'createProduct accepts a malformed stored school id'
    );

    const missingSchoolId = `s_${'b'.repeat(32)}`;
    users.set(userId, Object.assign({}, validUser, {
      schoolId: missingSchoolId
    }));
    const missingSchool = await createProduct.main({
      requestId: 'phase17_school_missing_001',
      product: validProduct
    });
    collector.check(
      missingSchool.success === false
        && missingSchool.code === 'SCHOOL_UNAVAILABLE',
      'createProduct accepts a school that does not exist'
    );

    users.set(userId, clone(validUser));
    schools.set(schoolId, Object.assign({}, validSchool, {
      platformStatus: 'pending'
    }));
    const pendingSchool = await createProduct.main({
      requestId: 'phase17_school_pending_001',
      product: validProduct
    });
    collector.check(
      pendingSchool.success === false
        && pendingSchool.code === 'SCHOOL_UNAVAILABLE',
      'createProduct accepts a pending school'
    );

    schools.set(schoolId, Object.assign({}, validSchool, {
      platformStatus: 'inactive'
    }));
    const inactiveSchool = await createProduct.main({
      requestId: 'phase17_school_inactive_001',
      product: validProduct
    });
    collector.check(
      inactiveSchool.success === false
        && inactiveSchool.code === 'SCHOOL_UNAVAILABLE',
      'createProduct accepts an inactive school'
    );

    schools.set(schoolId, Object.assign({}, validSchool, {
      officialStatus: 'invalid'
    }));
    const invalidOfficialSchool = await createProduct.main({
      requestId: 'phase17_school_official_invalid_001',
      product: validProduct
    });
    collector.check(
      invalidOfficialSchool.success === false
        && invalidOfficialSchool.code === 'SCHOOL_UNAVAILABLE',
      'createProduct accepts an officially invalid school'
    );

    schools.set(schoolId, clone(validSchool));
    users.set(userId, Object.assign({}, validUser, {
      status: 'disabled'
    }));
    const disabledUser = await createProduct.main({
      requestId: 'phase17_user_disabled_001',
      product: validProduct
    });
    collector.check(
      disabledUser.success === false && disabledUser.code === 'USER_DISABLED',
      'createProduct accepts a disabled user'
    );

    users.set(userId, clone(validUser));
    const requestId = 'phase17_active_school_001';
    const created = await createProduct.main({
      requestId,
      product: validProduct
    });
    const stored = products.get(created.data && created.data.productId);
    collector.check(
      created.success === true && created.data.reused === false,
      'active and valid school cannot create a product'
    );
    collector.check(
      stored && stored.schoolId === schoolId,
      'new product does not store the verified user school id'
    );
    collector.check(
      stored && stored.schoolName === validSchool.name,
      'new product does not store the authoritative school name'
    );
    collector.check(
      stored
        && stored.schoolId !== validProduct.schoolId
        && stored.schoolName !== validProduct.schoolName,
      'client school fields override the server school binding'
    );
    collector.check(
      stored
        && stored.sellerId === userId
        && stored.sellerOpenid === openId
        && stored.sellerName === validUser.nickname,
      'client seller fields override trusted seller identity'
    );
    collector.check(
      stored
        && stored.campus === validUser.campus
        && stored.campus !== validProduct.campus,
      'client legacy campus text influences the product school binding'
    );
    collector.check(
      !Object.prototype.hasOwnProperty.call(stored, 'schoolBoundAt')
        && stored.createdAt
        && stored.createdAt.$serverDate === true,
      'school binding timestamp duplicates or replaces the trusted creation time'
    );
    collector.check(
      created.data.schoolId === schoolId
        && created.data.schoolName === validSchool.name,
      'create response omits the safe school summary'
    );
    const safeResponse = JSON.stringify(created);
    collector.check(
      !/officialStatus|platformStatus|authority|sourceRow|openid/i.test(
        safeResponse
      ),
      'create response leaks internal user or school fields'
    );

    const repeated = await createProduct.main({
      requestId,
      product: Object.assign({}, validProduct, {
        schoolId: `s_${'e'.repeat(32)}`,
        schoolName: '再次伪造大学'
      })
    });
    collector.check(
      repeated.success === true
        && repeated.data.reused === true
        && products.size === 1,
      'repeated publish request is not idempotent'
    );
    collector.check(
      products.get(created.data.productId).schoolId === schoolId
        && products.get(created.data.productId).schoolName === validSchool.name,
      'idempotent retry changes the original school snapshot'
    );

    const legacyRequestId = 'phase17_legacy_retry_001';
    const legacyProductId = createProductId(userId, legacyRequestId);
    products.set(legacyProductId, {
      _id: legacyProductId,
      sellerId: userId,
      sellerOpenid: openId,
      title: '历史发布结果',
      status: 'available'
    });
    users.set(userId, Object.assign({}, validUser, {
      schoolId: '',
      schoolName: ''
    }));
    const legacyRetry = await createProduct.main({
      requestId: legacyRequestId,
      product: validProduct
    });
    collector.check(
      legacyRetry.success === true
        && legacyRetry.data.reused === true
        && legacyRetry.data.schoolId === ''
        && legacyRetry.data.schoolName === '',
      'legacy idempotent publish retry is forced through school migration'
    );
    collector.check(
      !Object.prototype.hasOwnProperty.call(
        products.get(legacyProductId),
        'schoolId'
      ),
      'legacy idempotent publish retry backfills a school'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

function createManageCollection(store) {
  function find(query) {
    return [...store.values()].filter((record) => (
      Object.keys(query).every((key) => record[key] === query[key])
    ));
  }
  return {
    where(query) {
      return {
        limit() {
          return this;
        },
        async get() {
          return {
            data: clone(find(query))
          };
        },
        async update({ data }) {
          let updated = 0;
          find(query).forEach((record) => {
            Object.assign(record, clone(data));
            updated += 1;
          });
          return {
            stats: {
              updated
            }
          };
        }
      };
    },
    doc(id) {
      return {
        async get() {
          return {
            data: clone(store.get(id))
          };
        },
        async update({ data }) {
          const record = store.get(id);
          if (!record) {
            throw new Error('document does not exist');
          }
          Object.assign(record, clone(data));
        }
      };
    }
  };
}

async function verifyImmutableEditing(projectRoot, collector) {
  const functionPath = path.join(
    projectRoot,
    'cloudfunctions/manageProduct/index.js'
  );
  const originalLoad = Module._load;
  const products = new Map();
  const openId = 'phase17-owner-openid';
  const sellerId = `u_${'c'.repeat(32)}`;
  const schoolId = `s_${'d'.repeat(32)}`;
  const baseProduct = {
    _id: 'p_phase17_modern',
    sellerId,
    sellerOpenid: openId,
    title: '编辑前标题',
    description: '编辑前的完整商品描述。',
    price: 20,
    categoryId: 'life',
    categoryName: '生活',
    condition: '九成新',
    location: '图书馆南门',
    locationDetail: {
      name: '图书馆南门',
      address: '图书馆南侧公共区域',
      latitude: 31.23,
      longitude: 121.47
    },
    images: [
      `cloud://test-env.bucket/products/${sellerId}/20260729/modern.jpg`
    ],
    coverImage: `cloud://test-env.bucket/products/${sellerId}/20260729/modern.jpg`,
    video: null,
    status: 'available',
    version: 1,
    schoolId,
    schoolName: '不可变验证大学'
  };
  const legacyProduct = Object.assign({}, baseProduct, {
    _id: 'p_phase17_legacy',
    title: '历史无学校商品'
  });
  delete legacyProduct.schoolId;
  delete legacyProduct.schoolName;
  products.set(baseProduct._id, clone(baseProduct));
  products.set(legacyProduct._id, clone(legacyProduct));

  const collection = createManageCollection(products);
  const db = {
    command: {
      all(value) {
        return {
          $all: value
        };
      }
    },
    collection(name) {
      if (name !== 'products') {
        throw new Error(`unexpected manageProduct collection ${name}`);
      }
      return collection;
    },
    serverDate() {
      return {
        $serverDate: true
      };
    },
    async runTransaction(callback) {
      return {
        result: await callback({
          collection(name) {
            if (name !== 'products') {
              throw new Error(`unexpected transaction collection ${name}`);
            }
            return collection;
          }
        })
      };
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return {
        OPENID: openId
      };
    },
    async deleteFile() {
      return {
        fileList: []
      };
    }
  };
  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const updatePayload = {
    title: '编辑后标题',
    description: '编辑后仍然是完整且合法的商品描述。',
    price: 21,
    categoryId: 'life',
    categoryName: '生活',
    condition: '八成新',
    location: baseProduct.location,
    locationDetail: clone(baseProduct.locationDetail),
    images: baseProduct.images.slice(),
    video: null
  };

  try {
    delete require.cache[require.resolve(functionPath)];
    const manageProduct = require(functionPath);
    const forged = await manageProduct.main({
      action: 'updateProduct',
      productId: baseProduct._id,
      expectedVersion: 1,
      mutationId: 'phase17_forged_school_001',
      product: Object.assign({}, updatePayload, {
        schoolId: `s_${'f'.repeat(32)}`,
        schoolName: '伪造编辑大学'
      })
    });
    collector.check(
      forged.success === false && forged.code === 'INVALID_PRODUCT_FIELD',
      'manageProduct accepts editable school fields'
    );
    collector.check(
      products.get(baseProduct._id).schoolId === schoolId
        && products.get(baseProduct._id).schoolName === baseProduct.schoolName,
      'rejected forged edit changes the school snapshot'
    );

    const updated = await manageProduct.main({
      action: 'updateProduct',
      productId: baseProduct._id,
      expectedVersion: 1,
      mutationId: 'phase17_normal_edit_001',
      product: updatePayload
    });
    collector.check(
      updated.success === true && updated.data.version === 2,
      'ordinary product editing regressed'
    );
    collector.check(
      products.get(baseProduct._id).schoolId === schoolId
        && products.get(baseProduct._id).schoolName === baseProduct.schoolName,
      'ordinary product editing changes the school snapshot'
    );

    const offline = await manageProduct.main({
      action: 'takeOffline',
      productId: baseProduct._id
    });
    collector.check(
      offline.success === true
        && products.get(baseProduct._id).status === 'offline',
      'product status transition regressed'
    );
    collector.check(
      products.get(baseProduct._id).schoolId === schoolId
        && products.get(baseProduct._id).schoolName === baseProduct.schoolName,
      'product status transition changes or clears the school snapshot'
    );

    const legacyUpdated = await manageProduct.main({
      action: 'updateProduct',
      productId: legacyProduct._id,
      expectedVersion: 1,
      mutationId: 'phase17_legacy_edit_001',
      product: Object.assign({}, updatePayload, {
        title: '历史商品正常编辑'
      })
    });
    collector.check(
      legacyUpdated.success === true,
      'legacy product editing regressed'
    );
    collector.check(
      !Object.prototype.hasOwnProperty.call(
        products.get(legacyProduct._id),
        'schoolId'
      )
        && !Object.prototype.hasOwnProperty.call(
          products.get(legacyProduct._id),
          'schoolName'
        ),
      'editing a legacy product silently backfills a school'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

function createQueryCollection(records) {
  const chain = {
    orderBy() {
      return this;
    },
    skip() {
      return this;
    },
    limit() {
      return this;
    },
    async count() {
      return {
        total: records.length
      };
    },
    async get() {
      return {
        data: clone(records)
      };
    }
  };
  return {
    where() {
      return Object.create(chain);
    }
  };
}

async function verifyQueryCompatibility(projectRoot, collector) {
  const functionPath = path.join(
    projectRoot,
    'cloudfunctions/productQuery/index.js'
  );
  const originalLoad = Module._load;
  const schoolId = `s_${'e'.repeat(32)}`;
  const records = [
    {
      _id: 'p_phase17_query_modern',
      title: '新学校商品',
      description: '新学校商品描述',
      price: 18,
      categoryId: 'books',
      categoryName: '书籍',
      condition: '九成新',
      status: 'available',
      schoolId,
      schoolName: '查询验证大学',
      createdAt: new Date('2026-07-29T00:00:00.000Z')
    },
    {
      _id: 'p_phase17_query_legacy',
      title: '历史无学校商品',
      description: '历史无学校商品描述',
      price: 19,
      categoryId: 'books',
      categoryName: '书籍',
      condition: '八成新',
      status: 'available',
      createdAt: new Date('2026-07-28T00:00:00.000Z')
    }
  ];
  const db = {
    command: {
      in(value) {
        return {
          $in: value
        };
      },
      and(value) {
        return {
          $and: value
        };
      },
      or(value) {
        return {
          $or: value
        };
      }
    },
    RegExp(value) {
      return value;
    },
    collection(name) {
      if (name !== 'products') {
        throw new Error(`unexpected productQuery collection ${name}`);
      }
      return createQueryCollection(records);
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return {
        OPENID: 'phase17-query-user'
      };
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
    const productQuery = require(functionPath);
    const response = await productQuery.main({
      action: 'list',
      data: {
        page: 1,
        pageSize: 6
      }
    });
    const modern = response.data.list.find(
      (item) => item._id === records[0]._id
    );
    const legacy = response.data.list.find(
      (item) => item._id === records[1]._id
    );
    collector.check(
      response.success === true && response.data.list.length === 2,
      'public list hides legacy products or applies school filtering'
    );
    collector.check(
      modern.schoolId === schoolId
        && modern.schoolName === records[0].schoolName,
      'new product query omits its school summary'
    );
    collector.check(
      legacy.schoolId === '' && legacy.schoolName === '',
      'legacy product school serialization is unstable'
    );
    collector.check(
      !/officialStatus|platformStatus|authority|sourceRow|openid/i.test(
        JSON.stringify(response)
      ),
      'product query leaks internal user or school fields'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

function verifyStaticBoundaries(projectRoot, collector) {
  const createSource = read(
    projectRoot,
    'cloudfunctions/createProduct/index.js'
  );
  const manageSource = read(
    projectRoot,
    'cloudfunctions/manageProduct/index.js'
  );
  const querySource = read(
    projectRoot,
    'cloudfunctions/productQuery/index.js'
  );
  const productServiceSource = read(
    projectRoot,
    'services/product-service.js'
  );
  const publishServiceSource = read(
    projectRoot,
    'services/product-publish-service.js'
  );
  const publishPageSource = read(projectRoot, 'pages/publish/index.js');
  const publishTemplate = read(projectRoot, 'pages/publish/index.wxml');
  const detailTemplate = read(projectRoot, 'pages/product-detail/index.wxml');
  const favoriteSource = read(
    projectRoot,
    'cloudfunctions/favoriteProduct/index.js'
  );
  const messageSource = read(
    projectRoot,
    'cloudfunctions/messageAction/index.js'
  );
  const appointmentSource = read(
    projectRoot,
    'cloudfunctions/appointmentAction/index.js'
  );
  const authSource = read(projectRoot, 'cloudfunctions/authUser/index.js');
  const listConditionSource = querySource.slice(
    querySource.indexOf('function buildQueryCondition'),
    querySource.indexOf('function applySort')
  );
  const updateFieldSource = manageSource.slice(
    manageSource.indexOf('const ALLOWED_UPDATE_FIELDS'),
    manageSource.indexOf('const VIDEO_FIELDS')
  );
  const publishRequestSource = publishServiceSource.slice(
    publishServiceSource.indexOf('const result = await callCreateProduct'),
    publishServiceSource.indexOf('if (\n      result.reused')
  );

  collector.check(
    /cloud\.getWXContext\(\)/.test(createSource)
      && /users\.where/.test(createSource)
      && /schools\.where/.test(createSource),
    'createProduct does not use trusted identity, user, and school records'
  );
  collector.check(
    /profileCompleted\s*===\s*true/.test(createSource)
      && /PROFILE_INCOMPLETE/.test(createSource),
    'createProduct does not enforce the existing profile completion boundary'
  );
  collector.check(
    /platformStatus\s*!==\s*['"]active['"]/.test(createSource)
      && /officialStatus\s*!==\s*['"]valid['"]/.test(createSource),
    'createProduct does not require an active and officially valid school'
  );
  collector.check(
    !/schoolId|schoolName|schoolBoundAt|publisherSchoolVersion/.test(
      updateFieldSource
    )
      && /Object\.keys\(value\)\.some/.test(manageSource),
    'manageProduct update whitelist permits school mutation'
  );
  collector.check(
    /schoolId:\s*normalizeText\(record\.schoolId\)/.test(querySource)
      && /schoolName:\s*normalizeText\(record\.schoolName\)/.test(querySource),
    'productQuery lacks stable school summary serialization'
  );
  collector.check(
    /schoolId:\s*normalizeString\(record\.schoolId\)/.test(
      productServiceSource
    )
      && /schoolName:\s*normalizeString\(record\.schoolName\)/.test(
        productServiceSource
      ),
    'ProductService does not normalize school summaries and legacy blanks'
  );
  collector.check(
    !/schoolId|schoolName/.test(publishRequestSource),
    'publish service sends editable school fields in the create request'
  );
  collector.check(
    /publish-school__value/.test(publishTemplate)
      && /\{\{schoolName\}\}/.test(publishTemplate)
      && /AuthStore\.getCurrentUser\(\)/.test(publishPageSource),
    'publish page lacks a read-only AuthStore school prompt'
  );
  collector.check(
    /SCHOOL_SELECTION_REQUIRED/.test(publishServiceSource)
      && /SCHOOL_UNAVAILABLE/.test(publishServiceSource)
      && /AuthStore\.refreshCurrentUser\(\)/.test(publishPageSource),
    'client school publication failures are not mapped back to school selection'
  );
  collector.check(
    /wx:if="\{\{product\.schoolName\}\}"/.test(detailTemplate),
    'product detail does not safely hide a missing historical school'
  );
  collector.check(
    !/schoolId/.test(listConditionSource),
    'phase 17 filters the public product market by school'
  );
  collector.check(
    !/SCHOOL_SELECTION_REQUIRED|SCHOOL_UNAVAILABLE|schoolId/.test(
      favoriteSource
    ),
    'phase 17 changes favorite school permissions'
  );
  collector.check(
    !/SCHOOL_SELECTION_REQUIRED|SCHOOL_UNAVAILABLE|schoolId/.test(
      messageSource
    ),
    'phase 17 changes messaging school permissions'
  );
  collector.check(
    !/SCHOOL_SELECTION_REQUIRED|SCHOOL_UNAVAILABLE|schoolId/.test(
      appointmentSource
    ),
    'phase 17 changes appointment school permissions'
  );
  collector.check(
    !/switchSchool|changeSchool/.test(authSource),
    'phase 17 implements school switching'
  );
  const migrationFiles = [];
  const scriptDirectory = path.join(projectRoot, 'scripts');
  fs.readdirSync(scriptDirectory, { withFileTypes: true }).forEach((entry) => {
    if (
      entry.isFile()
      && /migrat|backfill/i.test(entry.name)
      && /product|school/i.test(entry.name)
    ) {
      migrationFiles.push(entry.name);
    }
  });
  collector.check(
    migrationFiles.length === 0,
    'phase 17 adds a historical product school migration script'
  );
}

async function verifyProductSchoolBindingFlow(projectRoot) {
  const collector = createCheckCollector();
  verifyStaticBoundaries(projectRoot, collector);
  await verifyCreateBinding(projectRoot, collector);
  await verifyImmutableEditing(projectRoot, collector);
  await verifyQueryCompatibility(projectRoot, collector);
  return {
    checks: collector.count()
  };
}

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, '..');
  verifyProductSchoolBindingFlow(projectRoot)
    .then((result) => {
      console.log(
        `Product school binding verification succeeded: ${result.checks} checks passed.`
      );
    })
    .catch((error) => {
      console.error(`Product school binding verification failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  verifyProductSchoolBindingFlow
};
