const crypto = require('crypto');
const fs = require('fs');
const {
  ROOT,
  loadEnvironmentId,
  queryCollection,
  maskId,
  assert
} = require('./phase-18-canary-core');
const { readAllSchools } = require('./schools/cloud-cli');

const AUTOMATOR_MODULE = process.env.PHASE21_AUTOMATOR_MODULE;
const DEVTOOLS_CLI_PATH = process.env.PHASE21_DEVTOOLS_CLI_PATH;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE21_AUTOMATOR_WS_ENDPOINT;
const PUBLIC_STATUSES = new Set(['available', 'reserved']);

function withTimeout(promise, label, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
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

function hashRecords(records) {
  const sorted = records.slice().sort((left, right) => (
    String(left._id || '').localeCompare(String(right._id || ''))
  ));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function readProductionState(environmentId) {
  const definitions = {
    users: { _id: 1, schoolId: 1, schoolName: 1, schoolChangedAt: 1, schoolVersion: 1 },
    products: { _id: 1, schoolId: 1, schoolName: 1, status: 1, sellerId: 1 },
    favorites: { _id: 1, userOpenid: 1, productId: 1 },
    conversations: { _id: 1, productId: 1, participantAUserId: 1, participantBUserId: 1 },
    messages: { _id: 1, conversationId: 1, type: 1 },
    appointments: { _id: 1, productId: 1, status: 1, isDeleted: 1 }
  };
  const records = {};
  const summary = {};
  Object.entries(definitions).forEach(([name, projection]) => {
    records[name] = queryCollection(environmentId, name, {
      filter: {},
      projection,
      limit: 1000
    });
    summary[name] = {
      count: records[name].length,
      hash: hashRecords(records[name])
    };
  });
  const schoolRecords = readAllSchools(environmentId).map((school) => ({
    _id: school._id,
    platformStatus: school.platformStatus,
    officialStatus: school.officialStatus,
    name: school.name
  }));
  records.schools = schoolRecords;
  summary.schools = { count: schoolRecords.length, hash: hashRecords(schoolRecords) };
  return { records, summary };
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

function selectSellerSample(products, currentSchoolId) {
  const bySeller = new Map();
  products.forEach((product) => {
    if (!product.sellerId) return;
    if (!bySeller.has(product.sellerId)) bySeller.set(product.sellerId, []);
    bySeller.get(product.sellerId).push(product);
  });
  const candidates = [...bySeller.entries()].filter(([, list]) => (
    list.some((product) => (
      product.schoolId === currentSchoolId && PUBLIC_STATUSES.has(product.status)
    ))
  ));
  const crossSchool = candidates.find(([, list]) => (
    list.some((product) => (
      product.schoolId !== currentSchoolId && PUBLIC_STATUSES.has(product.status)
    ))
  ));
  const selected = crossSchool || candidates[0] || null;
  return selected
    ? {
        sellerId: selected[0],
        hasCrossSchoolPublicSample: Boolean(crossSchool)
      }
    : null;
}

async function cloudCall(miniProgram, name, action, data) {
  const response = await withTimeout(miniProgram.evaluate(async function call(input) {
    return wx.cloud.callFunction({
      name: input.name,
      data: { action: input.action, data: input.data }
    });
  }, { name, action, data }), `${name}/${action}`, 45000);
  const payload = response && response.result;
  assert(payload && payload.success === true, `${name}/${action} failed`);
  return payload.data || {};
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(DEVTOOLS_CLI_PATH && fs.existsSync(DEVTOOLS_CLI_PATH), 'developer-tools CLI is unavailable');
  const environmentId = loadEnvironmentId();
  const before = readProductionState(environmentId);
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
      if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
    });
    miniProgram.on('exception', () => { exceptions += 1; });

    const current = await cloudCall(miniProgram, 'authUser', 'current', {});
    const user = current.user;
    assert(user && user.schoolId && user.schoolVersion > 0, 'current school context is unavailable');

    const favorites = await cloudCall(miniProgram, 'favoriteProduct', 'listMyFavorites', {
      page: 1,
      pageSize: 20
    });
    const conversations = await cloudCall(miniProgram, 'messageQuery', 'listConversations', {
      pageSize: 20,
      cursor: null
    });
    const appointments = await cloudCall(miniProgram, 'appointmentQuery', 'listMine', {
      filter: 'all',
      pageSize: 20,
      cursor: null
    });
    const myProducts = await cloudCall(miniProgram, 'productQuery', 'myProducts', {
      status: 'available',
      page: 1,
      pageSize: 20
    });

    const relationLists = [favorites.list || [], conversations.list || [], appointments.list || []];
    relationLists.flat().forEach((item) => {
      const product = item.product || item;
      assert(!product.sellerOpenid, 'historical relation response leaks internal seller identity');
    });
    const crossFavoriteCount = (favorites.list || []).filter((product) => (
      product.schoolId && product.schoolId !== user.schoolId
    )).length;
    const crossConversationCount = (conversations.list || []).filter((item) => (
      item.product && item.product.schoolId && item.product.schoolId !== user.schoolId
    )).length;
    const crossAppointmentCount = (appointments.list || []).filter((item) => (
      item.product && item.product.schoolId && item.product.schoolId !== user.schoolId
    )).length;

    const sellerSample = selectSellerSample(before.records.products, user.schoolId);
    let sellerScopeVerified = false;
    let sellerHasCrossSchoolPublicSample = false;
    if (sellerSample) {
      const profile = await cloudCall(miniProgram, 'userQuery', 'publicProfile', {
        publicUserId: sellerSample.sellerId,
        schoolId: 's_ffffffffffffffffffffffffffffffff'
      });
      const products = await cloudCall(miniProgram, 'userQuery', 'publicProducts', {
        publicUserId: sellerSample.sellerId,
        page: 1,
        pageSize: 20,
        schoolId: 's_ffffffffffffffffffffffffffffffff'
      });
      assert(profile.scope.schoolId === user.schoolId, 'seller profile trusts forged school');
      assert(products.scope.schoolId === user.schoolId, 'seller products trust forged school');
      assert((products.list || []).every((product) => product.schoolId === user.schoolId), 'seller profile leaks cross-school product');
      assert(profile.profile.activeProductCount === products.total, 'seller profile scoped count differs from list total');
      sellerScopeVerified = true;
      sellerHasCrossSchoolPublicSample = sellerSample.hasCrossSchoolPublicSample;
      await withTimeout(
        miniProgram.reLaunch(`/pages/user-profile/index?userId=${encodeURIComponent(sellerSample.sellerId)}`),
        'seller profile launch'
      );
      const sellerPage = await waitForPageData(miniProgram, (data) => data.viewState === 'success');
      assert(
        (sellerPage.products || []).every((product) => product.schoolId === user.schoolId),
        'seller profile page contains another school'
      );
    }

    await withTimeout(miniProgram.reLaunch('/pages/favorites/index'), 'favorites launch');
    const favoritePage = await waitForPageData(miniProgram, (data) => (
      ['success', 'empty'].includes(data.viewState)
    ));
    assert(
      (favoritePage.favorites || []).every((item) => (
        item.isCrossSchool === Boolean(
          item.schoolId && item.schoolId !== user.schoolId
        )
      )),
      'favorite cross-school decoration differs from server data'
    );

    await withTimeout(miniProgram.reLaunch('/pages/messages/index'), 'messages launch');
    const messagePage = await waitForPageData(miniProgram, (data) => (
      ['success', 'empty'].includes(data.viewState)
    ));
    assert(
      (messagePage.conversations || []).every((item) => (
        item.product.isCrossSchool === Boolean(
          item.product.schoolId && item.product.schoolId !== user.schoolId
        )
      )),
      'conversation cross-school decoration differs from server data'
    );

    await withTimeout(miniProgram.reLaunch('/pages/appointments/index'), 'appointments launch');
    const appointmentPage = await waitForPageData(miniProgram, (data) => (
      ['success', 'empty'].includes(data.viewState)
    ));
    assert(
      (appointmentPage.appointments || []).every((item) => (
        item.product
        && item.product.isCrossSchool === Boolean(
          item.product.schoolId && item.product.schoolId !== user.schoolId
        )
      )),
      'appointment page cross-school decoration differs from server data'
    );

    await withTimeout(miniProgram.reLaunch('/pages/my-products/index'), 'my products launch');
    const myProductsPage = await waitForPageData(miniProgram, (data) => (
      ['success', 'empty'].includes(data.viewState)
    ));
    assert(
      (myProductsPage.products || []).every((product) => product.schoolId),
      'my products school labels are missing'
    );
    assert(
      Array.isArray(myProducts.list)
      && (myProducts.list || []).every((product) => product.sellerPublicUserId === user.id),
      'my products response is not owner scoped'
    );

    await withTimeout(miniProgram.reLaunch('/pages/home/index'), 'home launch');
    const home = await waitForPageData(miniProgram, (data) => (
      data.isLoading === false
      && data.marketMode === 'schoolScoped'
      && data.marketScope
      && data.marketScope.schoolId === user.schoolId
    ));
    assert(
      (home.products || []).every((product) => product.schoolId === user.schoolId),
      'Phase 18 home contains another school'
    );

    const after = readProductionState(environmentId);
    Object.keys(before.summary).forEach((name) => {
      assert(before.summary[name].count === after.summary[name].count, `${name} count changed`);
      assert(before.summary[name].hash === after.summary[name].hash, `${name} projection changed`);
    });
    assert(consoleErrors === 0 && exceptions === 0, 'developer tools recorded runtime errors');
    return {
      passed: true,
      userId: maskId(user.id),
      schoolId: maskId(user.schoolId),
      schoolVersion: user.schoolVersion,
      historicalRelations: {
        favorites: (favorites.list || []).length,
        crossFavorites: crossFavoriteCount,
        conversations: (conversations.list || []).length,
        crossConversations: crossConversationCount,
        appointments: (appointments.list || []).length,
        crossAppointments: crossAppointmentCount
      },
      sellerScopeVerified,
      sellerHasCrossSchoolPublicSample,
      myProductsOwnerScopeVerified: Array.isArray(myProducts.list),
      phase18HomeStrict: true,
      productionProjectionUnchanged: true,
      consoleErrors,
      exceptions
    };
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }
}

run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`PHASE21_DEVTOOLS_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
