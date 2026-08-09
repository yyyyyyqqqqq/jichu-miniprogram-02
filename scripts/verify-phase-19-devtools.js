const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvironmentId,
  queryCollection,
  maskId
} = require('./phase-18-canary-core');
const { assert } = require('./phase-18-dual-account-core');

const AUTOMATOR_MODULE = process.env.PHASE19_AUTOMATOR_MODULE;
const DEVTOOLS_CLI_PATH = process.env.PHASE19_DEVTOOLS_CLI_PATH;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE19_AUTOMATOR_WS_ENDPOINT;

function withTimeout(promise, label, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function payload(response) {
  const value = response && response.result;
  assert(value && typeof value.success === 'boolean', 'invalid cloud response');
  return value;
}

function hashProjection(value) {
  const sorted = value.slice().sort((left, right) => (
    String(left._id || '').localeCompare(String(right._id || ''))
  ));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function readRelationSnapshot(environmentId) {
  const favorites = queryCollection(environmentId, 'favorites', {
    filter: {},
    projection: { _id: 1, userOpenid: 1, productId: 1 },
    limit: 1000
  });
  const conversations = queryCollection(environmentId, 'conversations', {
    filter: {},
    projection: {
      _id: 1,
      productId: 1,
      participantAOpenid: 1,
      participantBOpenid: 1
    },
    limit: 1000
  });
  const appointments = queryCollection(environmentId, 'appointments', {
    filter: {},
    projection: {
      _id: 1,
      conversationId: 1,
      productId: 1,
      buyerOpenid: 1,
      sellerOpenid: 1,
      status: 1,
      isDeleted: 1
    },
    limit: 1000
  });
  return {
    favorites,
    conversations,
    appointments,
    hashes: {
      favorites: hashProjection(favorites),
      conversations: hashProjection(conversations),
      appointments: hashProjection(appointments)
    }
  };
}

async function waitForPageData(miniProgram, predicate, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await miniProgram.evaluate(function currentPageData() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return page ? page.data : null;
    });
    if (data && predicate(data)) {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('page data did not settle');
}

function selectFixtures(options) {
  const {
    products,
    favorites,
    conversations,
    currentOpenid,
    currentSchoolId
  } = options;
  const publicProducts = products.filter((item) => (
    ['available', 'reserved', 'sold'].includes(item.status)
  ));
  const sameDetail = publicProducts.find((item) => (
    item.schoolId === currentSchoolId
  ));
  const crossDetail = publicProducts.find((item) => (
    item.schoolId
    && item.schoolId !== currentSchoolId
    && item.sellerOpenid !== currentOpenid
  ));
  const relationProduct = publicProducts.find((item) => {
    if (
      item.status !== 'available'
      || !item.schoolId
      || item.schoolId === currentSchoolId
      || item.sellerOpenid === currentOpenid
    ) {
      return false;
    }
    const hasFavorite = favorites.some((relation) => (
      relation.userOpenid === currentOpenid
      && relation.productId === item._id
    ));
    const hasConversation = conversations.some((conversation) => (
      conversation.productId === item._id
      && (
        conversation.participantAOpenid === currentOpenid
        || conversation.participantBOpenid === currentOpenid
      )
    ));
    return !hasFavorite && !hasConversation;
  });
  const appointmentConversation = conversations.find((conversation) => {
    if (
      conversation.participantAOpenid !== currentOpenid
      && conversation.participantBOpenid !== currentOpenid
    ) {
      return false;
    }
    const product = products.find((item) => item._id === conversation.productId);
    return Boolean(
      product
      && product.status === 'available'
      && product.schoolId
      && product.schoolId !== currentSchoolId
      && product.sellerOpenid !== currentOpenid
    );
  });
  return {
    sameDetail,
    crossDetail,
    relationProduct,
    appointmentConversation
  };
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(DEVTOOLS_CLI_PATH && fs.existsSync(DEVTOOLS_CLI_PATH), 'developer-tools CLI is unavailable');
  const environmentId = loadEnvironmentId();
  const automator = require(AUTOMATOR_MODULE);
  let miniProgram;
  let consoleErrors = 0;
  let exceptions = 0;
  try {
    miniProgram = AUTOMATOR_WS_ENDPOINT
      ? await withTimeout(
        automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }),
        'automation connection'
      )
      : await withTimeout(automator.launch({
        cliPath: DEVTOOLS_CLI_PATH,
        projectPath: ROOT,
        trustProject: true,
        timeout: 90000
      }), 'automation launch');
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') {
        consoleErrors += 1;
      }
    });
    miniProgram.on('exception', () => {
      exceptions += 1;
    });
    const callCloud = async (name, data) => payload(await withTimeout(
      miniProgram.evaluate(async function callCloud(functionName, request) {
        return wx.cloud.callFunction({ name: functionName, data: request });
      }, name, data),
      `${name}:${data.action || ''}`,
      45000
    ));

    const current = await callCloud('authUser', { action: 'current', data: {} });
    assert(current.success === true && current.data && current.data.user, 'current DevTools identity is unavailable');
    const currentUser = current.data.user;
    const userRecords = queryCollection(environmentId, 'users', {
      filter: { _id: currentUser.id },
      projection: { _id: 1, openid: 1, schoolId: 1 },
      limit: 1
    });
    assert(userRecords.length === 1 && userRecords[0].openid, 'current authoritative user record is unavailable');
    const currentOpenid = userRecords[0].openid;
    assert(userRecords[0].schoolId === currentUser.schoolId, 'client and server user school differ');

    const products = queryCollection(environmentId, 'products', {
      filter: {},
      projection: {
        _id: 1,
        sellerOpenid: 1,
        sellerId: 1,
        schoolId: 1,
        schoolName: 1,
        status: 1,
        title: 1,
        categoryId: 1
      },
      limit: 1000
    });
    const before = readRelationSnapshot(environmentId);
    const fixtures = selectFixtures({
      products,
      favorites: before.favorites,
      conversations: before.conversations,
      currentOpenid,
      currentSchoolId: currentUser.schoolId
    });
    assert(fixtures.sameDetail, 'no same-school public detail fixture is available');
    assert(fixtures.crossDetail, 'no cross-school public detail fixture is available');
    assert(fixtures.relationProduct, 'no relation-free cross-school product is available');

    const sameDetail = await callCloud('productQuery', {
      action: 'detail',
      data: { productId: fixtures.sameDetail._id }
    });
    assert(
      sameDetail.success === true
      && sameDetail.data.access.mode === 'sameSchool'
      && sameDetail.data.access.canCreateRelation === true,
      'real same-school detail access failed'
    );
    const crossDetail = await callCloud('productQuery', {
      action: 'detail',
      data: {
        productId: fixtures.crossDetail._id,
        schoolId: currentUser.schoolId
      }
    });
    assert(
      crossDetail.success === true
      && crossDetail.data.product.schoolId === fixtures.crossDetail.schoolId
      && crossDetail.data.access.mode === 'crossSchoolReadonly'
      && crossDetail.data.access.canCreateRelation === false,
      'real cross-school detail did not enter readonly mode'
    );
    const missing = await callCloud('productQuery', {
      action: 'detail',
      data: { productId: 'phase19-product-does-not-exist' }
    });
    assert(missing.success === false && missing.code === 'PRODUCT_NOT_FOUND', 'real random product id was not rejected');

    const favoriteRejected = await callCloud('favoriteProduct', {
      action: 'addFavorite',
      data: {
        productId: fixtures.relationProduct._id,
        schoolId: currentUser.schoolId
      }
    });
    assert(
      favoriteRejected.success === false
      && favoriteRejected.code === 'CROSS_SCHOOL_RELATION_FORBIDDEN',
      'real cross-school favorite creation was not rejected'
    );
    const conversationRejected = await callCloud('messageAction', {
      action: 'createOrGetConversation',
      data: {
        productId: fixtures.relationProduct._id,
        schoolId: currentUser.schoolId
      }
    });
    assert(
      conversationRejected.success === false
      && conversationRejected.code === 'CROSS_SCHOOL_RELATION_FORBIDDEN',
      'real cross-school conversation creation was not rejected'
    );

    let appointmentProbe = 'not-available';
    if (fixtures.appointmentConversation) {
      const appointmentRejected = await callCloud('appointmentAction', {
        action: 'create',
        data: {
          conversationId: fixtures.appointmentConversation._id,
          scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          location: {
            name: '图书馆公共区域',
            address: '校园图书馆公共区域',
            latitude: 31.2304,
            longitude: 121.4737
          },
          note: 'Phase 19 无写入权限探针',
          idempotencyKey: `phase19_${Date.now()}`,
          schoolId: currentUser.schoolId
        }
      });
      assert(
        appointmentRejected.success === false
        && appointmentRejected.code === 'CROSS_SCHOOL_RELATION_FORBIDDEN',
        'real cross-school appointment creation was not rejected'
      );
      appointmentProbe = 'passed';
    }

    await withTimeout(
      miniProgram.reLaunch(`/pages/product-detail/index?id=${encodeURIComponent(fixtures.crossDetail._id)}`),
      'cross-school detail launch'
    );
    const crossPage = await waitForPageData(miniProgram, (data) => (
      data.viewState === 'success'
      && data.product
      && data.isCrossSchoolReadonly === true
    ));
    assert(/其他学校/.test(crossPage.readonlyNotice) && /仅支持查看/.test(crossPage.readonlyNotice), 'cross-school readonly UI copy is missing');
    const shares = await miniProgram.evaluate(function readSharePayloads() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      return {
        appMessage: page.onShareAppMessage(),
        timeline: page.onShareTimeline()
      };
    });
    assert(
      shares.appMessage.path.includes(`id=${fixtures.crossDetail._id}`)
      && !shares.appMessage.path.includes('schoolId='),
      'real share path does not bind only product id'
    );
    assert(
      shares.timeline.query.includes(`id=${fixtures.crossDetail._id}`)
      && !shares.timeline.query.includes('schoolId='),
      'real timeline share query does not bind only product id'
    );

    await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'home launch');
    const home = await waitForPageData(miniProgram, (data) => (
      data.isLoading === false
      && data.marketMode === 'schoolScoped'
      && data.marketScope
      && data.marketScope.schoolId === currentUser.schoolId
    ));
    assert(
      (home.products || []).every((item) => item.schoolId === currentUser.schoolId),
      'Phase 18 home rendered a cross-school product'
    );

    const after = readRelationSnapshot(environmentId);
    assert(before.hashes.favorites === after.hashes.favorites, 'favorite probe changed production data');
    assert(before.hashes.conversations === after.hashes.conversations, 'conversation probe changed production data');
    assert(before.hashes.appointments === after.hashes.appointments, 'appointment probe changed production data');
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded console errors or exceptions');

    return {
      passed: true,
      userId: maskId(currentUser.id),
      schoolId: maskId(currentUser.schoolId),
      sameDetail: true,
      crossDetailReadonly: true,
      shareByProductId: true,
      crossSchoolFavoriteRejected: true,
      crossSchoolConversationRejected: true,
      crossSchoolAppointmentProbe: appointmentProbe,
      phase18HomeStrict: true,
      relationProjectionUnchanged: true,
      consoleErrors,
      exceptions
    };
  } finally {
    if (miniProgram) {
      miniProgram.disconnect();
    }
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE19_DEVTOOLS_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
