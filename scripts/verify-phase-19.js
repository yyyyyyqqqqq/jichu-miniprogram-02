const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SCHOOL_A = `s_${'a'.repeat(32)}`;
const SCHOOL_B = `s_${'b'.repeat(32)}`;
let checks = 0;

function check(value, message) {
  assert(value, message);
  checks += 1;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function createCollection(records, command) {
  return {
    where(condition) {
      const query = {
        limit() {
          return query;
        },
        async get() {
          return {
            data: records.filter((record) => Object.entries(condition).every(
              ([key, expected]) => expected && Array.isArray(expected.$in)
                ? expected.$in.includes(record[key])
                : record[key] === expected
            ))
          };
        }
      };
      return query;
    }
  };
}

function loadCloudFunction(relativePath) {
  const functionPath = path.join(ROOT, relativePath);
  const originalLoad = Module._load;
  const command = {
    in(values) {
      return { $in: values };
    },
    and(values) {
      return { $and: values };
    },
    or(values) {
      return { $or: values };
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
  const database = {
    command,
    collection() {
      return createCollection([], command);
    },
    RegExp({ regexp, options }) {
      return new RegExp(regexp, options);
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'phase19-verification',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return {};
    }
  };
  Module._load = function mockLoad(request, parent, isMain) {
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

async function verifyDetailAccess() {
  const productQuery = loadCloudFunction('cloudfunctions/productQuery/index.js');
  const MarketCore = require(path.join(
    ROOT,
    'cloudfunctions/productQuery/market-core.js'
  ));
  const product = {
    _id: 'phase19-product-a',
    title: '学校 A 商品',
    description: '跨校详情只读验证商品',
    price: 19,
    categoryId: 'books',
    categoryName: '书籍',
    condition: '九成新',
    images: ['cloud://phase19/products/a/image.jpg'],
    coverImage: 'cloud://phase19/products/a/image.jpg',
    location: '图书馆公共区域',
    schoolId: SCHOOL_A,
    schoolName: '学校 A',
    sellerId: 'u_seller_phase19',
    sellerOpenid: 'seller-openid-phase19',
    sellerName: '卖家',
    status: 'available',
    createdAt: new Date('2026-08-09T00:00:00.000Z')
  };
  const appId = 'phase19-app';
  const sameOpenId = 'same-school-viewer';
  const crossOpenId = 'cross-school-viewer';
  const sameIdentity = {
    appId,
    openId: sameOpenId,
    userId: MarketCore.createUserId(appId, sameOpenId)
  };
  const crossIdentity = {
    appId,
    openId: crossOpenId,
    userId: MarketCore.createUserId(appId, crossOpenId)
  };
  const users = [{
    _id: sameIdentity.userId,
    openid: sameOpenId,
    status: 'active',
    profileCompleted: true,
    nickname: '同校用户',
    avatarUrl: 'cloud://phase19/avatar-a.jpg',
    schoolId: SCHOOL_A
  }, {
    _id: crossIdentity.userId,
    openid: crossOpenId,
    status: 'active',
    profileCompleted: true,
    nickname: '跨校用户',
    avatarUrl: 'cloud://phase19/avatar-b.jpg',
    schoolId: SCHOOL_B
  }];
  const dependencies = {
    productsCollection: createCollection([product]),
    usersCollection: createCollection(users)
  };

  const same = await productQuery.__test.getProductDetail(
    { productId: product._id },
    sameIdentity,
    dependencies
  );
  check(same.success === true, 'same-school detail was rejected');
  check(same.data.access.mode === 'sameSchool', 'same-school detail mode is wrong');
  check(same.data.access.canCreateRelation === true, 'same-school relation access was disabled');
  check(!Object.prototype.hasOwnProperty.call(same.data.product, 'sellerOpenid'), 'detail leaked seller openid');

  const cross = await productQuery.__test.getProductDetail(
    { productId: product._id, schoolId: SCHOOL_B },
    crossIdentity,
    dependencies
  );
  check(cross.success === true, 'cross-school detail by legal id was rejected');
  check(cross.data.access.mode === 'crossSchoolReadonly', 'cross-school detail is not readonly');
  check(cross.data.access.isCrossSchool === true, 'cross-school detail flag is missing');
  check(cross.data.access.canCreateRelation === false, 'cross-school detail can create a relation');
  check(cross.data.product.schoolId === SCHOOL_A, 'detail trusted a forged query school');

  const owner = await productQuery.__test.resolveDetailAccess(product, {
    appId,
    openId: product.sellerOpenid,
    userId: MarketCore.createUserId(appId, product.sellerOpenid)
  }, dependencies);
  check(owner.mode === 'owner' && owner.isOwner === true, 'seller historical product access is not preserved');

  const anonymous = await productQuery.__test.resolveDetailAccess(
    product,
    { appId: '', openId: '', userId: '' },
    dependencies
  );
  check(anonymous.mode === 'anonymous', 'anonymous share detail mode is invalid');

  const missing = await productQuery.__test.getProductDetail(
    { productId: 'missing-phase19-product' },
    crossIdentity,
    dependencies
  );
  check(missing.success === false && missing.code === 'PRODUCT_NOT_FOUND', 'random product id was not rejected');

  const hidden = await productQuery.__test.getProductDetail(
    { productId: 'hidden-phase19-product' },
    crossIdentity,
    {
      ...dependencies,
      productsCollection: createCollection([{
        ...product,
        _id: 'hidden-phase19-product',
        status: 'offline'
      }])
    }
  );
  check(hidden.success === false && hidden.code === 'PRODUCT_NOT_FOUND', 'offline product leaked by id');
}

function expectForbidden(module, user, openId, product, message) {
  check(
    module.__test.canCreateSchoolRelation(user, openId, product) === false,
    `${message}: cross-school predicate allowed creation`
  );
  try {
    module.__test.assertCanCreateSchoolRelation(user, openId, product);
  } catch (error) {
    check(
      error && error.businessCode === 'CROSS_SCHOOL_RELATION_FORBIDDEN',
      `${message}: unified error code is missing`
    );
    return;
  }
  throw new Error(`${message}: guard did not reject creation`);
}

function verifyRelationGuards() {
  const modules = [
    ['收藏', loadCloudFunction('cloudfunctions/favoriteProduct/index.js')],
    ['会话', loadCloudFunction('cloudfunctions/messageAction/index.js')],
    ['预约', loadCloudFunction('cloudfunctions/appointmentAction/index.js')]
  ];
  const openId = 'phase19-buyer';
  const sameUser = {
    openid: openId,
    status: 'active',
    schoolId: SCHOOL_A
  };
  const crossUser = {
    ...sameUser,
    schoolId: SCHOOL_B
  };
  const product = { schoolId: SCHOOL_A };
  modules.forEach(([label, module]) => {
    check(
      module.__test.canCreateSchoolRelation(sameUser, openId, product) === true,
      `${label}: same-school creation was rejected`
    );
    expectForbidden(module, crossUser, openId, product, label);
    expectForbidden(module, sameUser, openId, { schoolId: '' }, `${label}历史无学校商品`);
  });

  const favoriteSource = read('cloudfunctions/favoriteProduct/index.js');
  const favoriteAdd = favoriteSource.slice(
    favoriteSource.indexOf('async function addFavorite'),
    favoriteSource.indexOf('async function removeFavorite')
  );
  check(favoriteAdd.indexOf('const existing') < favoriteAdd.indexOf('assertCanCreateSchoolRelation'), 'historical favorite reuse runs after the new-relation guard');
  const messageSource = read('cloudfunctions/messageAction/index.js');
  const conversationCreate = messageSource.slice(
    messageSource.indexOf('async function createOrGetConversation'),
    messageSource.indexOf('async function sendMessage')
  );
  check(conversationCreate.indexOf('const existing') < conversationCreate.indexOf('assertCanCreateSchoolRelation'), 'historical conversation reuse runs after the new-relation guard');
  const appointmentSource = read('cloudfunctions/appointmentAction/index.js');
  const appointmentCreate = appointmentSource.slice(
    appointmentSource.indexOf('async function createAppointment'),
    appointmentSource.indexOf('function assertAppointmentParticipant')
  );
  check(appointmentCreate.indexOf('const existing') < appointmentCreate.indexOf('assertCanCreateSchoolRelation'), 'historical appointment idempotency runs after the new-relation guard');
}

function verifyClientAndOwnerBoundaries() {
  const detailPage = read('pages/product-detail/index.js');
  const detailTemplate = read('pages/product-detail/index.wxml');
  const productService = read('services/product-service.js');
  const favoriteService = read('services/favorite-service.js');
  const messageService = read('services/message-service.js');
  const appointmentService = read('services/appointment-service.js');
  const manageProduct = read('cloudfunctions/manageProduct/index.js');
  const transitionSource = manageProduct.slice(
    manageProduct.indexOf('function buildTransitionData'),
    manageProduct.indexOf('async function performTransition')
  );

  check(/crossSchoolReadonly/.test(productService), 'client does not normalize detail access mode');
  check(/该商品来自其他学校，仅支持查看/.test(detailPage), 'cross-school readonly notice is missing');
  check(/isCrossSchoolReadonly/.test(detailTemplate), 'readonly state is not rendered');
  check(/其他学校 · 仅可查看/.test(detailTemplate), 'contact disabled copy is missing');
  check(/!this\.data\.isFavorited/.test(detailPage), 'historical favorite removal is blocked by the detail page');
  check(/onShareAppMessage/.test(detailPage) && /PRODUCT_DETAIL\}\?id=/.test(detailPage), 'app-message share path is missing product id');
  check(/onShareTimeline/.test(detailPage) && /query:\s*`id=/.test(detailPage), 'timeline share query is missing product id');
  const shareSource = detailPage.slice(detailPage.indexOf('onShareAppMessage'));
  check(!/schoolId/.test(shareSource), 'share link carries a client-trusted school id');
  check(/其他学校商品仅展示卖家信息/.test(detailPage), 'cross-school seller-profile entry is not guarded');
  [favoriteService, messageService, appointmentService].forEach((source) => {
    check(/CROSS_SCHOOL_RELATION_FORBIDDEN/.test(source), 'client lacks a unified cross-school error mapping');
  });
  check(/product\.sellerOpenid\s*!==\s*openId/.test(manageProduct), 'historical product management lost owner verification');
  check(!/PRODUCT_SCHOOL_MISMATCH/.test(manageProduct), 'owner management is still blocked by current-school mismatch');
  check(!/schoolId\s*:/.test(transitionSource), 'status transition can mutate historical product school');

  const productQuery = read('cloudfunctions/productQuery/index.js');
  check(/SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL\s*=\s*true/.test(productQuery), 'Phase 18 strict-for-all was disabled');
  check(/buildSchoolScopedCondition/.test(productQuery) && /scopeSchoolId/.test(productQuery), 'Phase 18 list scope or cursor binding is missing');
  check(/PUBLIC_DETAIL_STATUSES/.test(productQuery) && /status:\s*command\.in\(PUBLIC_DETAIL_STATUSES\)/.test(productQuery), 'detail by id no longer enforces public statuses');
}

(async () => {
  await verifyDetailAccess();
  verifyRelationGuards();
  verifyClientAndOwnerBoundaries();
  process.stdout.write(`Phase 19 cross-school detail and relation verification succeeded: ${checks} checks passed.\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
