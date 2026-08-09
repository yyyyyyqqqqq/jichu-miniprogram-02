const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
let checks = 0;

function check(condition, message) {
  assert(condition, message);
  checks += 1;
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function verifySchoolRelationHelper() {
  const helper = require(path.join(root, 'utils/school-relation'));
  const schoolA = `s_${'a'.repeat(32)}`;
  const schoolB = `s_${'b'.repeat(32)}`;
  const user = { id: `u_${'1'.repeat(32)}`, schoolId: schoolB, schoolVersion: 7 };
  const cross = helper.decorateHistoricalProduct({ schoolId: schoolA }, user);
  const same = helper.decorateHistoricalProduct({ schoolId: schoolB }, user);
  const legacy = helper.decorateHistoricalProduct({}, user);
  check(cross.isCrossSchool === true, 'cross-school product is not identified');
  check(cross.schoolRelationText === '其他学校商品', 'cross-school label is inconsistent');
  check(same.isCrossSchool === false, 'same-school product is mislabeled');
  check(legacy.schoolRelationKnown === false, 'legacy product without school is guessed');
  check(legacy.isCrossSchool === false, 'legacy product is incorrectly blocked');
  check(
    helper.getSchoolScopeKey(user).endsWith(`${schoolB}:7`),
    'school scope key does not include schoolVersion'
  );
  check(
    helper.decorateConversation({ product: { schoolId: schoolA } }, user)
      .product.isCrossSchool === true,
    'conversation product is not decorated'
  );
  check(
    helper.decorateAppointment({ product: { schoolId: schoolA } }, user)
      .product.isCrossSchool === true,
    'appointment product is not decorated'
  );
}

function matches(record, condition) {
  return Object.entries(condition).every(([key, value]) => {
    if (value && Array.isArray(value.$in)) {
      return value.$in.includes(record[key]);
    }
    return record[key] === value;
  });
}

function createQuery(records, condition) {
  let offset = 0;
  let limit = 100;
  const orders = [];
  const query = {
    orderBy(field, direction) {
      orders.push({ field, direction });
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
        total: [...records.values()].filter((record) => matches(record, condition)).length
      };
    },
    async get() {
      const data = [...records.values()]
        .filter((record) => matches(record, condition))
        .sort((left, right) => {
          for (const order of orders) {
            const leftValue = left[order.field] instanceof Date
              ? left[order.field].getTime()
              : left[order.field];
            const rightValue = right[order.field] instanceof Date
              ? right[order.field].getTime()
              : right[order.field];
            if (leftValue === rightValue) {
              continue;
            }
            const compared = leftValue < rightValue ? -1 : 1;
            return order.direction === 'desc' ? -compared : compared;
          }
          return 0;
        })
        .slice(offset, offset + limit)
        .map((record) => ({ ...record }));
      return { data };
    }
  };
  return query;
}

async function verifyViewerScopedUserQuery() {
  const functionPath = path.join(root, 'cloudfunctions/userQuery/index.js');
  const originalLoad = Module._load;
  const users = new Map();
  const schools = new Map();
  const products = new Map();
  const identity = { appId: 'phase21-app', token: 'phase21-viewer' };
  const viewerId = `u_${crypto.createHash('sha256')
    .update(`${identity.appId}:${identity.token}`)
    .digest('hex').slice(0, 32)}`;
  const sellerId = `u_${'9'.repeat(32)}`;
  const schoolA = `s_${'a'.repeat(32)}`;
  const schoolB = `s_${'b'.repeat(32)}`;
  schools.set(schoolA, {
    _id: schoolA,
    name: 'A 校',
    platformStatus: 'active',
    officialStatus: 'valid'
  });
  schools.set(schoolB, {
    _id: schoolB,
    name: 'B 校',
    platformStatus: 'active',
    officialStatus: 'valid'
  });
  users.set(viewerId, {
    _id: viewerId,
    openid: identity.token,
    status: 'active',
    profileCompleted: true,
    schoolId: schoolA,
    schoolVersion: 3
  });
  users.set(sellerId, {
    _id: sellerId,
    openid: 'phase21-seller',
    status: 'active',
    nickname: '跨校卖家',
    createdAt: new Date('2026-01-01T00:00:00.000Z')
  });
  [schoolA, schoolA, schoolB, schoolB, schoolB].forEach((schoolId, index) => {
    products.set(`product-${index}`, {
      _id: `product-${index}`,
      title: `商品 ${index}`,
      price: index + 1,
      sellerId,
      sellerOpenid: 'phase21-seller',
      schoolId,
      schoolName: schoolId === schoolA ? 'A 校' : 'B 校',
      status: index === 4 ? 'reserved' : 'available',
      createdAt: new Date(`2026-02-0${index + 1}T00:00:00.000Z`)
    });
  });
  const collections = { users, schools, products };
  const database = {
    command: {
      in(values) {
        return { $in: values };
      }
    },
    collection(name) {
      const records = collections[name];
      return {
        doc(id) {
          return {
            async get() {
              const record = records.get(id);
              return { data: record ? { ...record } : null };
            }
          };
        },
        where(condition) {
          return createQuery(records, condition);
        }
      };
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return {
        APPID: identity.appId,
        OPENID: identity.token
      };
    }
  };
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(functionPath)];
  try {
    const userQuery = require(functionPath);
    const aProfile = await userQuery.main({
      action: 'publicProfile',
      data: { publicUserId: sellerId, schoolId: schoolB }
    });
    const aProducts = await userQuery.main({
      action: 'publicProducts',
      data: { publicUserId: sellerId, page: 1, pageSize: 10, schoolId: schoolB }
    });
    check(aProfile.success === true, 'A viewer profile query fails');
    check(aProfile.data.profile.activeProductCount === 2, 'A viewer count leaks B products');
    check(aProfile.data.scope.schoolId === schoolA, 'client school for profile is trusted');
    check(aProducts.data.list.length === 2, 'A viewer does not get exactly A products');
    check(aProducts.data.list.every((item) => item.schoolId === schoolA), 'A viewer receives B product');
    users.set(viewerId, {
      ...users.get(viewerId),
      schoolId: schoolB,
      schoolVersion: 4
    });
    const bProfile = await userQuery.main({
      action: 'publicProfile',
      data: { publicUserId: sellerId, schoolId: schoolA }
    });
    const bProducts = await userQuery.main({
      action: 'publicProducts',
      data: { publicUserId: sellerId, page: 1, pageSize: 10, schoolId: schoolA }
    });
    check(bProfile.data.profile.activeProductCount === 3, 'B viewer count is not viewer scoped');
    check(bProfile.data.scope.schoolVersion === 4, 'viewer schoolVersion is stale');
    check(bProducts.data.list.length === 3, 'B viewer does not get exactly B products');
    check(bProducts.data.list.every((item) => item.schoolId === schoolB), 'B viewer receives A product');
    check(
      bProducts.data.list.every((item) => !Object.prototype.hasOwnProperty.call(item, 'sellerOpenid')),
      'seller profile leaks internal identity'
    );
    users.set(viewerId, { ...users.get(viewerId), profileCompleted: false });
    const incomplete = await userQuery.main({
      action: 'publicProducts',
      data: { publicUserId: sellerId }
    });
    check(incomplete.code === 'PROFILE_INCOMPLETE', 'incomplete viewer is not rejected');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

function verifyStaticBoundaries() {
  const favorite = read('cloudfunctions/favoriteProduct/index.js');
  const messageQuery = read('cloudfunctions/messageQuery/index.js');
  const messageAction = read('cloudfunctions/messageAction/index.js');
  const appointmentQuery = read('cloudfunctions/appointmentQuery/index.js');
  const appointmentAction = read('cloudfunctions/appointmentAction/index.js');
  const productQuery = read('cloudfunctions/productQuery/index.js');
  const userQuery = read('cloudfunctions/userQuery/index.js');
  const detail = read('pages/product-detail/index.wxml');
  const favoritesPage = read('pages/favorites/index.js');
  const favoritesTemplate = read('pages/favorites/index.wxml');
  const messagesPage = read('pages/messages/index.js');
  const messagesTemplate = read('pages/messages/index.wxml');
  const chatPage = read('pages/chat/index.js');
  const chatTemplate = read('pages/chat/index.wxml');
  const appointmentsPage = read('pages/appointments/index.js');
  const appointmentsTemplate = read('pages/appointments/index.wxml');
  const appointmentDetail = read('pages/appointment-detail/index.js');
  const publicProfile = read('pages/user-profile/index.js');
  const publicTemplate = read('pages/user-profile/index.wxml');
  const deploy = read('scripts/deploy-phase-21.js');
  const devtools = read('scripts/verify-phase-21-devtools.js');
  const myProducts = read('cloudfunctions/productQuery/index.js')
    .slice(productQuery.indexOf('async function listMyProducts'));

  check(/condition = \{ userOpenid: openId \}/.test(favorite), 'favorites are school-filtered');
  check(/schoolId: record\.schoolId/.test(favorite), 'favorite product omits authoritative school');
  check(/participantAOpenid/.test(messageQuery) && /participantBOpenid/.test(messageQuery), 'conversations are not participant scoped');
  check(!/function buildCursorCondition[\s\S]{0,500}schoolId/.test(messageQuery), 'conversation list adds a school filter');
  check(/schoolId: normalizeString\(source\.schoolId\)/.test(messageQuery), 'conversation product omits school');
  check(/buyerOpenid/.test(appointmentQuery) && /sellerOpenid/.test(appointmentQuery), 'appointments are not role scoped');
  check(!/function buildCursorCondition[\s\S]{0,600}schoolId/.test(appointmentQuery), 'appointment list adds a school filter');
  check(/schoolId: normalizeString\(source\.schoolId\)/.test(appointmentQuery), 'appointment product omits school');
  check(/sellerOpenid: openId/.test(myProducts), 'my products are not owner scoped');
  check(!/sellerOpenid: openId,[\s\S]{0,100}schoolId/.test(myProducts), 'my products are school-filtered');
  check(/schoolId: viewer\.schoolId/.test(userQuery), 'seller profile is not viewer-school scoped');
  check(/resolveViewerContext\(cloud\.getWXContext\(\)\)/.test(userQuery), 'seller profile does not use server identity');
  check(!/data\.(?:schoolId|viewerSchoolId)/.test(userQuery), 'seller profile trusts client school');
  check(/assertCanCreateSchoolRelation/.test(messageAction), 'new conversation school guard was removed');
  check(/trace\.step = 'conversation\.read_existing'[\s\S]*assertCanCreateSchoolRelation/.test(messageAction), 'existing conversation is not reused before new-relation guard');
  const sendBlock = messageAction.slice(
    messageAction.indexOf('async function sendMessage'),
    messageAction.indexOf('async function sendTextMessage')
  );
  check(!/assertCanCreateSchoolRelation/.test(sendBlock), 'historical conversation sending semantics changed');
  check(/assertCanCreateSchoolRelation/.test(appointmentAction), 'new appointment school guard was removed');
  check(/CROSS_SCHOOL_RELATION_FORBIDDEN/.test(appointmentAction), 'new appointment cross-school error is missing');
  check(/decorateHistoricalProduct/.test(favoritesPage), 'favorite history lacks relation decoration');
  check(/其他学校商品|schoolRelationText/.test(favoritesTemplate), 'favorite cross-school badge is missing');
  check(/decorateConversation/.test(messagesPage), 'conversation list lacks relation decoration');
  check(/schoolRelationText/.test(messagesTemplate), 'conversation cross-school badge is missing');
  check(/decorateAppointment/.test(appointmentsPage), 'appointment list lacks relation decoration');
  check(/schoolRelationText/.test(appointmentsTemplate), 'appointment cross-school badge is missing');
  check(/product\.isCrossSchool/.test(chatPage), 'chat appointment precheck is missing');
  check(/历史消息可继续查看和发送/.test(chatTemplate), 'chat cross-school semantics are not explained');
  check(/decorateAppointment/.test(appointmentDetail), 'appointment detail lacks cross-school decoration');
  check(/getSchoolScopeKey/.test(favoritesPage), 'favorite page does not observe schoolVersion');
  check(/getSchoolScopeKey/.test(messagesPage), 'messages page does not observe schoolVersion');
  check(/getSchoolScopeKey/.test(appointmentsPage), 'appointments page does not observe schoolVersion');
  check(/getSchoolScopeKey/.test(publicProfile), 'seller profile does not observe schoolVersion');
  check(/当前学校暂无可见商品/.test(publicTemplate), 'seller profile empty state is misleading');
  check(/seller-card--readonly/.test(detail) && /!isCrossSchoolReadonly/.test(detail), 'Phase 19 cross-school seller entry changed');
  check(/SCHOOL_CHANGE_COOLDOWN_MS\s*=\s*7 \* 24 \* 60 \* 60 \* 1000/.test(read('cloudfunctions/authUser/index.js')), 'Phase 20 cooldown changed');
  check(/authScopeKey/.test(read('pages/home/index.js')) && /requestVersion/.test(read('pages/home/index.js')), 'Phase 18/20 market invalidation changed');
  check(/idx_seller_school_status_createdAt_id/.test(deploy), 'seller scope index deployment guard is missing');
  check(/sellerOpenid:\s*1[\s\S]*schoolId:\s*1[\s\S]*status:\s*1[\s\S]*createdAt:\s*-1[\s\S]*_id:\s*1/.test(deploy), 'seller scope index definition is incorrect');
  check(/validateIndexState/.test(deploy) && /conflicting definition/.test(deploy), 'index conflict guard is missing');
  check(/wouldDeployOnly/.test(deploy) && /writesBusinessData:\s*false/.test(deploy), 'deploy dry-run safety summary is missing');
  check(/environmentFingerprint/.test(deploy), 'function environment fingerprint guard is missing');
  check(!/dropIndexes|deleteIndexes|removeIndex/.test(deploy), 'deploy script can remove an index');
  check(/readProductionState/.test(devtools) && /projection changed/.test(devtools), 'DevTools zero-write projection guard is missing');
  check(/sellerScopeVerified/.test(devtools), 'DevTools seller scope validation is missing');
  check(/phase18HomeStrict/.test(devtools), 'DevTools Phase 18 market regression is missing');
  check(/consoleErrors === 0 && exceptions === 0/.test(devtools), 'DevTools runtime error gate is missing');
}

async function main() {
  verifySchoolRelationHelper();
  await verifyViewerScopedUserQuery();
  verifyStaticBoundaries();
  console.log(`Phase 21 historical relation school adaptation verification succeeded: ${checks} checks passed.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Phase 21 verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  verifyPhase21Flow: main
};
