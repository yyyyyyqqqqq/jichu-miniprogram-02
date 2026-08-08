const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUTOMATOR_MODULE = process.env.PHASE18_CHANGE_AUTOMATOR_MODULE;
const DEVTOOLS_CLI = process.env.PHASE18_CHANGE_DEVTOOLS_CLI_PATH;
const RESULT_PATH = process.env.PHASE18_CHANGE_RESULT_PATH;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE18_CHANGE_AUTOMATOR_WS_ENDPOINT;
const DEVTOOLS_CLI_SCRIPT = process.env.PHASE18_CHANGE_DEVTOOLS_CLI_SCRIPT;
const EXPECTED_SCHOOL_A_ID = process.env.PHASE18_CHANGE_EXPECTED_SCHOOL_A_ID;
const EXPECTED_SCHOOL_B_ID = process.env.PHASE18_CHANGE_EXPECTED_SCHOOL_B_ID;

function requireSetting(value, code) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return normalized;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizePayload(response) {
  const payload = response && response.result;
  assert(payload && typeof payload.success === 'boolean', 'invalid cloud response');
  return payload;
}

function maskId(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length > 12
    ? `${text.slice(0, 8)}***${text.slice(-4)}`
    : text ? `${text.slice(0, 3)}***` : '';
}

function progress(step) {
  process.stdout.write(`[phase18-school-change] ${step}\n`);
}

function withTimeout(promise, label, timeoutMs = 20000) {
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

function buildProductInput(editable, title, description) {
  return {
    title,
    description,
    price: editable.price,
    categoryId: editable.categoryId,
    condition: editable.condition,
    location: editable.location,
    locationDetail: editable.locationDetail,
    images: editable.images,
    video: editable.video || null,
    schoolId: `s_${'f'.repeat(32)}`,
    schoolName: '客户端伪造学校'
  };
}

async function waitForPath(miniProgram, expected, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const page = await withTimeout(miniProgram.currentPage(), 'current page');
    if (page && String(page.path || '').endsWith(expected)) {
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`page did not reach ${expected}`);
}

async function readCurrentPage(miniProgram) {
  return withTimeout(miniProgram.evaluate(function readPageState() {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    return page
      ? {
        route: page.route || '',
        data: page.data || {}
      }
      : null;
  }), 'read current page state');
}

async function invokeCurrentPageMethod(miniProgram, methodName, args = []) {
  return withTimeout(miniProgram.evaluate(
    function invokePageMethod(name, methodArgs) {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (!page || typeof page[name] !== 'function') {
        return false;
      }
      page[name].apply(page, methodArgs);
      return true;
    },
    methodName,
    args
  ), `invoke page method ${methodName}`);
}

async function invokeCurrentPageMethodAwaited(miniProgram, methodName, args = []) {
  return withTimeout(miniProgram.evaluate(
    async function invokePageMethodAndWait(name, methodArgs) {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (!page || typeof page[name] !== 'function') {
        return false;
      }
      await page[name].apply(page, methodArgs);
      return true;
    },
    methodName,
    args
  ), `invoke and await page method ${methodName}`);
}

async function waitForPageData(miniProgram, predicate, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await readCurrentPage(miniProgram);
    if (current && predicate(current.data)) {
      return current.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('page state wait timed out');
}

async function run() {
  const expectedSchoolAId = requireSetting(
    EXPECTED_SCHOOL_A_ID,
    'PHASE18_CHANGE_EXPECTED_SCHOOL_A_ID_REQUIRED'
  );
  const expectedSchoolBId = requireSetting(
    EXPECTED_SCHOOL_B_ID,
    'PHASE18_CHANGE_EXPECTED_SCHOOL_B_ID_REQUIRED'
  );
  assert(expectedSchoolAId !== expectedSchoolBId, 'expected schools must differ');
  const automator = require(requireSetting(
    AUTOMATOR_MODULE,
    'PHASE18_CHANGE_AUTOMATOR_MODULE_REQUIRED'
  ));
  const cliPath = requireSetting(
    DEVTOOLS_CLI,
    'PHASE18_CHANGE_DEVTOOLS_CLI_PATH_REQUIRED'
  );
  const resultPath = requireSetting(
    RESULT_PATH,
    'PHASE18_CHANGE_RESULT_PATH_REQUIRED'
  );
  let miniProgram;
  let consoleErrorCount = 0;
  let exceptionCount = 0;
  let productAId = '';
  let productBId = '';

  try {
    miniProgram = AUTOMATOR_WS_ENDPOINT
      ? await withTimeout(automator.connect({
        wsEndpoint: AUTOMATOR_WS_ENDPOINT
      }), 'connect automation')
      : await withTimeout(automator.launch({
        cliPath,
        args: DEVTOOLS_CLI_SCRIPT ? [DEVTOOLS_CLI_SCRIPT] : [],
        projectPath: ROOT,
        trustProject: true,
        timeout: 90000
      }), 'launch automation', 100000);
    miniProgram.on('console', (entry) => {
      if (entry && String(entry.type || '').toLowerCase() === 'error') {
        consoleErrorCount += 1;
      }
    });
    miniProgram.on('exception', () => {
      exceptionCount += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    progress('automation connected');

    const callCloud = async (name, data) => withTimeout(miniProgram.evaluate(
      async function callCloudFunction(functionName, functionData) {
        return wx.cloud.callFunction({
          name: functionName,
          data: functionData
        });
      },
      name,
      data
    ), `${name} cloud call`, 30000);
    const current = async () => normalizePayload(await callCloud('authUser', {
      action: 'current',
      data: {}
    }));

    const before = await current();
    const userA = before.data && before.data.user;
    assert(userA && userA.profileCompleted === true, 'real user profile is incomplete');
    assert(
      userA.schoolRequired === false
        && userA.schoolUnavailable !== true
        && userA.schoolId
        && userA.schoolName,
      'real user does not have an active current school'
    );
    assert(
      userA.schoolId === expectedSchoolAId,
      'real user is not at the explicitly confirmed school A checkpoint'
    );
    progress('current user and school A verified');

    const schoolsResult = normalizePayload(await callCloud('schoolQuery', {
      action: 'list',
      pageSize: 20,
      cursor: ''
    }));
    assert(schoolsResult.success === true, 'active school list failed');
    const activeSchools = schoolsResult.data && schoolsResult.data.items;
    const schoolB = Array.isArray(activeSchools)
      ? activeSchools.find((school) => school.id === expectedSchoolBId)
      : null;
    assert(schoolB && schoolB.id && schoolB.name, 'second active school is unavailable');
    progress('second active school resolved');

    const invalidDirect = normalizePayload(await callCloud('authUser', {
      action: 'updateSchool',
      data: {
        schoolId: `s_${'9'.repeat(32)}`,
        schoolName: '直接调用伪造名称',
        userId: `u_${'9'.repeat(32)}`,
        openid: 'forged-openid'
      }
    }));
    assert(
      invalidDirect.success === false && invalidDirect.code === 'SCHOOL_NOT_FOUND',
      'invalid direct school change was not rejected'
    );
    const afterInvalid = await current();
    assert(afterInvalid.data.user.schoolId === userA.schoolId, 'invalid request changed real user');
    progress('invalid direct update rejected');

    const directUserWriteDenied = await withTimeout(miniProgram.evaluate(
      async function verifyDirectUserWriteDenied(userId) {
        try {
          await wx.cloud.database().collection('users').doc(userId).update({
            data: { schoolName: '客户端直接伪造' }
          });
          return false;
        } catch (error) {
          return true;
        }
      },
      userA.id
    ), 'direct users write denial', 30000);
    assert(directUserWriteDenied === true, 'client direct users update is not denied');
    progress('direct users write denied');

    const mineBefore = normalizePayload(await callCloud('productQuery', {
      action: 'myProducts',
      data: {
        status: ['available', 'offline'],
        page: 1,
        pageSize: 20
      }
    }));
    assert(mineBefore.success === true, 'myProducts before school change failed');
    let editableSource = null;
    for (const item of mineBefore.data.list) {
      const editable = normalizePayload(await callCloud('manageProduct', {
        action: 'getEditableProduct',
        productId: item._id
      }));
      if (
        editable.success
        && editable.data
        && editable.data.product
        && editable.data.product.locationDetail
        && Array.isArray(editable.data.product.images)
        && editable.data.product.images.length > 0
      ) {
        editableSource = editable.data.product;
        break;
      }
    }
    assert(editableSource, 'no owned product media is available for controlled test products');
    const existingA = mineBefore.data.list.find((item) => (
      item.title === '阶段18换校验证-A校测试商品'
      && item.schoolId === userA.schoolId
    ));
    if (existingA) {
      productAId = existingA._id;
      progress('existing school A test product reused');
    } else {
      const createdA = normalizePayload(await callCloud('createProduct', {
        requestId: `phase18_change_a_${Date.now()}`,
        product: buildProductInput(
          editableSource,
          '阶段18换校验证-A校测试商品',
          '阶段18第四轮跨校隔离准备：换校前发布的A校测试商品。'
        )
      }));
      assert(createdA.success === true, 'school A test product creation failed');
      productAId = createdA.data.productId;
      assert(createdA.data.schoolId === userA.schoolId, 'school A test product has wrong school');
      progress('school A test product created');
    }

    await withTimeout(miniProgram.switchTab('/pages/profile/index'), 'open profile');
    await waitForPath(miniProgram, 'pages/profile/index');
    const profileBefore = await waitForPageData(
      miniProgram,
      (data) => data.isLoggedIn === true && data.displaySchoolName === userA.schoolName
    );
    assert(profileBefore.hasBoundSchool === true, 'profile does not show current school');
    progress('profile school change entry opened');
    assert(
      await invokeCurrentPageMethodAwaited(miniProgram, 'changeSchool'),
      'profile school change method is missing'
    );

    let schoolPage = await waitForPath(miniProgram, 'pages/school-select/index');
    let schoolPageData = await waitForPageData(
      miniProgram,
      (data) => data.isChangeMode === true && data.viewState === 'success'
    );
    assert(schoolPageData.currentSchoolId === userA.schoolId, 'change page current school is stale');
    const listedSchoolIds = schoolPageData.schools.map((school) => school.id);
    assert(
      listedSchoolIds.includes(userA.schoolId) && listedSchoolIds.includes(schoolB.id),
      'school change list does not contain both active schools'
    );
    progress('school change list loaded');

    await invokeCurrentPageMethod(miniProgram, 'onSchoolTap', [{
      currentTarget: { dataset: { id: userA.schoolId } }
    }]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const unchangedAfterTap = await current();
    assert(unchangedAfterTap.data.user.schoolId === userA.schoolId, 'tapping current school submitted a change');
    progress('current-school tap caused no write');

    await invokeCurrentPageMethod(miniProgram, 'onSchoolTap', [{
      currentTarget: { dataset: { id: schoolB.id } }
    }]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await withTimeout(miniProgram.native().cancelModal(), 'cancel confirmation');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterCancel = await current();
    assert(afterCancel.data.user.schoolId === userA.schoolId, 'cancelled confirmation changed school');
    progress('confirmation cancellation caused no write');

    schoolPageData = await waitForPageData(
      miniProgram,
      (data) => data.isChangeMode === true && data.viewState === 'success'
    );
    assert(
      schoolPageData.schools.some((school) => school.id === schoolB.id),
      'target school disappeared before confirmation'
    );
    await invokeCurrentPageMethod(miniProgram, 'onSchoolTap', [{
      currentTarget: { dataset: { id: schoolB.id } }
    }]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await withTimeout(miniProgram.native().confirmModal(), 'confirm school change');
    progress('school B confirmation submitted');

    await waitForPath(miniProgram, 'pages/profile/index', 20000);
    const profileAfter = await waitForPageData(
      miniProgram,
      (data) => data.displaySchoolName === schoolB.name
    );
    assert(profileAfter.user.schoolId === schoolB.id, 'profile did not refresh to school B');
    const afterChange = await current();
    const userB = afterChange.data.user;
    assert(userB.schoolId === schoolB.id, 'server user record did not change to school B');
    assert(userB.schoolName === schoolB.name, 'server user name is not authoritative school B name');
    assert(userB.schoolVersion > userA.schoolVersion, 'school version did not increase');
    progress('profile and server user refreshed to school B');

    const repeated = normalizePayload(await callCloud('authUser', {
      action: 'updateSchool',
      data: { schoolId: schoolB.id }
    }));
    assert(repeated.success === false && repeated.code === 'SCHOOL_UNCHANGED', 'same-school request is not rejected');
    progress('same-school direct retry rejected');

    await withTimeout(miniProgram.reLaunch('/pages/profile/index'), 'relaunch profile');
    await waitForPath(miniProgram, 'pages/profile/index');
    const restarted = await waitForPageData(
      miniProgram,
      (data) => data.displaySchoolName === schoolB.name && data.isRestoring === false,
      20000
    );
    assert(restarted.user.schoolId === schoolB.id, 'relaunch restored the old school');
    progress('relaunch restored school B');

    await withTimeout(miniProgram.switchTab('/pages/home/index'), 'open home');
    const homeData = await waitForPageData(
      miniProgram,
      (data) => ['success', 'empty'].includes(data.viewState) && data.isLoading === false,
      20000
    );
    assert(homeData.marketMode === 'legacy', 'school change unexpectedly enabled strict market');
    assert(!homeData.guideType, 'home remained in a stale school guide state');
    assert(homeData.queryScopeKey.startsWith('legacy|'), 'home did not rebuild legacy query scope');
    progress('home reloaded in legacy mode');

    const createdB = normalizePayload(await callCloud('createProduct', {
      requestId: `phase18_change_b_${Date.now()}`,
      product: buildProductInput(
        editableSource,
        '阶段18换校验证-B校测试商品',
        '阶段18第四轮跨校隔离准备：换校后发布的B校测试商品。'
      )
    }));
    assert(createdB.success === true, 'school B test product creation failed');
    productBId = createdB.data.productId;
    assert(createdB.data.schoolId === schoolB.id, 'school B test product has wrong school');
    progress('school B test product created');

    const detailA = normalizePayload(await callCloud('productQuery', {
      action: 'detail',
      data: { productId: productAId }
    }));
    const detailB = normalizePayload(await callCloud('productQuery', {
      action: 'detail',
      data: { productId: productBId }
    }));
    assert(detailA.success === true && detailA.data.product.schoolId === userA.schoolId, 'historical A product school changed');
    assert(detailB.success === true && detailB.data.product.schoolId === schoolB.id, 'new B product school is incorrect');

    const mineAfter = normalizePayload(await callCloud('productQuery', {
      action: 'myProducts',
      data: {
        status: 'available',
        page: 1,
        pageSize: 20
      }
    }));
    const mineById = new Map(mineAfter.data.list.map((item) => [item._id, item]));
    assert(mineById.has(productAId) && mineById.has(productBId), 'myProducts does not show both school test products');
    assert(mineById.get(productAId).schoolId === userA.schoolId, 'myProducts changed A product school');
    assert(mineById.get(productBId).schoolId === schoolB.id, 'myProducts changed B product school');
    progress('historical ownership and cross-school myProducts verified');

    const result = {
      completedAt: new Date().toISOString(),
      userId: userB.id,
      schoolA: { id: userA.schoolId, name: userA.schoolName },
      schoolB: { id: schoolB.id, name: schoolB.name },
      productAId,
      productBId,
      directUserWriteDenied,
      invalidDirectRejected: true,
      currentSchoolTapNoWrite: true,
      cancelledConfirmationNoWrite: true,
      restartRecoveredSchoolB: true,
      homeMarketMode: homeData.marketMode,
      myProductsContainsBoth: true,
      consoleErrorCount,
      exceptionCount
    };
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    process.stdout.write(`${JSON.stringify({
      userId: maskId(userB.id),
      schoolAId: maskId(userA.schoolId),
      schoolBId: maskId(schoolB.id),
      productAId: maskId(productAId),
      productBId: maskId(productBId),
      schoolChanged: true,
      restartRecoveredSchoolB: true,
      homeMarketMode: homeData.marketMode,
      historicalProductPreserved: true,
      myProductsContainsBoth: true,
      directUserWriteDenied,
      consoleErrorCount,
      exceptionCount
    }, null, 2)}\n`);
    assert(consoleErrorCount === 0, 'developer tools recorded console errors');
    assert(exceptionCount === 0, 'developer tools recorded runtime exceptions');
  } finally {
    if (miniProgram) {
      miniProgram.disconnect();
    }
  }
}

run().catch((error) => {
  process.stderr.write(`Phase 18 school change developer-tools verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
