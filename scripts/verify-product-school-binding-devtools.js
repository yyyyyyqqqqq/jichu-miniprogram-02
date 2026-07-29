const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const AUTOMATOR_MODULE = process.env.PHASE17_AUTOMATOR_MODULE;
const DEVTOOLS_CLI = process.env.PHASE17_DEVTOOLS_CLI_PATH;
const AUTOMATOR_WS_ENDPOINT = process.env.PHASE17_AUTOMATOR_WS_ENDPOINT;
const RESULT_PATH = process.env.PHASE17_RESULT_PATH;
const FAKE_SCHOOL_ID = `s_${'f'.repeat(32)}`;

function requireSetting(value, code) {
  if (!value || !String(value).trim()) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return String(value).trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizePayload(response) {
  const payload = response && response.result;
  if (!payload || typeof payload !== 'object') {
    throw new Error('cloud function returned an invalid response');
  }
  return payload;
}

function buildProductInput(editable) {
  return {
    title: editable.title,
    description: editable.description,
    price: editable.price,
    categoryId: editable.categoryId,
    categoryName: '客户端不能决定分类名称',
    condition: editable.condition,
    location: editable.location,
    locationDetail: editable.locationDetail,
    images: editable.images,
    video: editable.video || null
  };
}

function maskId(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= 12) {
    return text ? `${text.slice(0, 3)}***` : '';
  }
  return `${text.slice(0, 8)}***${text.slice(-4)}`;
}

async function run() {
  const automatorPath = requireSetting(
    AUTOMATOR_MODULE,
    'PHASE17_AUTOMATOR_MODULE_REQUIRED'
  );
  const cliPath = requireSetting(
    DEVTOOLS_CLI,
    'PHASE17_DEVTOOLS_CLI_PATH_REQUIRED'
  );
  const resultPath = requireSetting(
    RESULT_PATH,
    'PHASE17_RESULT_PATH_REQUIRED'
  );
  const automator = require(automatorPath);
  let miniProgram;
  let testProductId = '';
  let testVersion = 0;
  let sourceHistoryChecked = false;
  let consoleErrorCount = 0;
  let exceptionCount = 0;

  try {
    miniProgram = AUTOMATOR_WS_ENDPOINT
      ? await automator.connect({
        wsEndpoint: AUTOMATOR_WS_ENDPOINT
      })
      : await automator.launch({
        cliPath,
        projectPath: PROJECT_ROOT,
        trustProject: true,
        timeout: 90000
      });
    miniProgram.on('console', (entry) => {
      if (
        entry
        && typeof entry.type === 'string'
        && entry.type.toLowerCase() === 'error'
      ) {
        consoleErrorCount += 1;
      }
    });
    miniProgram.on('exception', () => {
      exceptionCount += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 5000));
    const callCloud = async (name, data) => miniProgram.evaluate(
      async function callCloudFunction(functionName, functionData) {
        return wx.cloud.callFunction({
          name: functionName,
          data: functionData
        });
      },
      name,
      data
    );

    const current = normalizePayload(await callCloud('authUser', {
      action: 'current',
      data: {}
    }));
    assert(current.success === true, 'real identity current user is unavailable');
    const user = current.data && current.data.user;
    assert(user && user.id, 'real identity user summary is missing');
    assert(user.profileCompleted === true, 'real identity profile is incomplete');
    assert(
      user.schoolRequired === false
        && user.schoolUnavailable !== true
        && user.schoolId
        && user.schoolName,
      'real identity does not have an active school'
    );

    const directReadDenied = await miniProgram.evaluate(
      async function verifyDirectProductsReadDenied() {
        try {
          await wx.cloud.database().collection('products').limit(1).get();
          return false;
        } catch (error) {
          return true;
        }
      }
    );
    assert(
      directReadDenied === true,
      'client direct products read is not denied'
    );

    const mine = normalizePayload(await callCloud('productQuery', {
      action: 'myProducts',
      data: {
        status: ['available', 'offline'],
        page: 1,
        pageSize: 20
      }
    }));
    assert(mine.success === true, 'real identity myProducts query failed');
    const candidates = mine.data && Array.isArray(mine.data.list)
      ? mine.data.list
      : [];
    let source = null;
    let sourceEditable = null;
    for (const candidate of candidates) {
      const editableResponse = normalizePayload(await callCloud(
        'manageProduct',
        {
          action: 'getEditableProduct',
          productId: candidate._id
        }
      ));
      if (
        editableResponse.success
        && editableResponse.data
        && editableResponse.data.product
        && editableResponse.data.product.locationDetail
      ) {
        source = candidate;
        sourceEditable = editableResponse.data;
        if (!candidate.schoolId && !candidate.schoolName) {
          break;
        }
      }
    }
    assert(
      source && sourceEditable,
      'no editable real product with structured location is available'
    );

    if (!source.schoolId && !source.schoolName) {
      const historyInput = buildProductInput(sourceEditable.product);
      const historyMutation = `phase17_history_${Date.now()}`;
      const historyEdit = normalizePayload(await callCloud('manageProduct', {
        action: 'updateProduct',
        productId: source._id,
        expectedVersion: sourceEditable.version,
        mutationId: historyMutation,
        product: historyInput
      }));
      assert(historyEdit.success === true, 'legacy no-op edit failed');
      const historyAfter = normalizePayload(await callCloud('productQuery', {
        action: 'myProducts',
        data: {
          status: source.status,
          page: 1,
          pageSize: 20
        }
      }));
      const historyRecord = historyAfter.data.list.find(
        (item) => item._id === source._id
      );
      assert(
        historyRecord
          && historyRecord.schoolId === ''
          && historyRecord.schoolName === '',
        'legacy no-op edit backfilled a school'
      );
      sourceHistoryChecked = true;
    }

    const requestId = `phase17_online_${Date.now()}`;
    const productInput = Object.assign(
      {},
      buildProductInput(sourceEditable.product),
      {
        title: '阶段17学校绑定验证商品',
        description: '阶段17受控真实学校绑定、编辑与状态验证商品。',
        schoolId: FAKE_SCHOOL_ID,
        schoolName: '客户端伪造大学',
        sellerId: 'u_spoofed',
        sellerName: '伪造卖家',
        status: 'sold'
      }
    );
    const created = normalizePayload(await callCloud('createProduct', {
      requestId,
      product: productInput
    }));
    assert(created.success === true, 'real product creation failed');
    testProductId = created.data.productId;
    assert(
      created.data.schoolId === user.schoolId
        && created.data.schoolName === user.schoolName
        && created.data.schoolId !== FAKE_SCHOOL_ID,
      'real product response does not use the authoritative school'
    );

    const detail = normalizePayload(await callCloud('productQuery', {
      action: 'detail',
      data: {
        productId: testProductId
      }
    }));
    assert(detail.success === true, 'real product detail query failed');
    assert(
      detail.data.product.schoolId === user.schoolId
        && detail.data.product.schoolName === user.schoolName,
      'real product query does not return the stored school summary'
    );
    assert(
      detail.data.product.sellerPublicUserId === user.id,
      'real product seller identity was overridden'
    );

    const editable = normalizePayload(await callCloud('manageProduct', {
      action: 'getEditableProduct',
      productId: testProductId
    }));
    assert(editable.success === true, 'new real product is not editable');
    testVersion = editable.data.version;
    const editInput = Object.assign(
      {},
      buildProductInput(editable.data.product),
      {
        title: '阶段17学校绑定验证商品（已编辑）'
      }
    );
    const forgedEdit = normalizePayload(await callCloud('manageProduct', {
      action: 'updateProduct',
      productId: testProductId,
      expectedVersion: testVersion,
      mutationId: `phase17_forged_${Date.now()}`,
      product: Object.assign({}, editInput, {
        schoolId: FAKE_SCHOOL_ID,
        schoolName: '伪造编辑大学'
      })
    }));
    assert(
      forgedEdit.success === false
        && forgedEdit.code === 'INVALID_PRODUCT_FIELD',
      'real product edit accepts forged school fields'
    );

    const validEdit = normalizePayload(await callCloud('manageProduct', {
      action: 'updateProduct',
      productId: testProductId,
      expectedVersion: testVersion,
      mutationId: `phase17_edit_${Date.now()}`,
      product: editInput
    }));
    assert(validEdit.success === true, 'real product ordinary edit failed');
    testVersion = validEdit.data.version;
    const afterEdit = normalizePayload(await callCloud('productQuery', {
      action: 'detail',
      data: {
        productId: testProductId
      }
    }));
    assert(
      afterEdit.data.product.schoolId === user.schoolId
        && afterEdit.data.product.schoolName === user.schoolName,
      'real product ordinary edit changes the school'
    );

    const offline = normalizePayload(await callCloud('manageProduct', {
      action: 'takeOffline',
      productId: testProductId
    }));
    assert(offline.success === true, 'real product takeOffline failed');
    testVersion = offline.data.version;
    const relisted = normalizePayload(await callCloud('manageProduct', {
      action: 'relist',
      productId: testProductId
    }));
    assert(relisted.success === true, 'real product relist failed');
    testVersion = relisted.data.version;
    const afterState = normalizePayload(await callCloud('productQuery', {
      action: 'detail',
      data: {
        productId: testProductId
      }
    }));
    assert(
      afterState.data.product.schoolId === user.schoolId
        && afterState.data.product.schoolName === user.schoolName,
      'real product status transitions change the school'
    );

    const deleted = normalizePayload(await callCloud('manageProduct', {
      action: 'softDelete',
      productId: testProductId,
      expectedVersion: testVersion,
      mutationId: `phase17_delete_${Date.now()}`
    }));
    assert(deleted.success === true, 'real test product cleanup failed');
    testVersion = deleted.data.version;

    const privateResult = {
      productId: testProductId,
      schoolId: user.schoolId,
      schoolName: user.schoolName,
      sellerId: user.id,
      finalVersion: testVersion,
      finalStatus: 'deleted',
      directReadDenied,
      sourceHistoryChecked,
      consoleErrorCount,
      exceptionCount
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(privateResult, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    console.log(JSON.stringify({
      productId: maskId(testProductId),
      schoolId: maskId(user.schoolId),
      schoolNameMatches: true,
      sellerIdMatches: true,
      editPreservedSchool: true,
      statePreservedSchool: true,
      finalStatus: 'deleted',
      directReadDenied,
      sourceHistoryChecked,
      consoleErrorCount,
      exceptionCount
    }, null, 2));
  } catch (error) {
    if (miniProgram && testProductId && testVersion) {
      try {
        await miniProgram.evaluate(
          async function cleanupFailedTestProduct(productId, version) {
            return wx.cloud.callFunction({
              name: 'manageProduct',
              data: {
                action: 'softDelete',
                productId,
                expectedVersion: version,
                mutationId: `phase17_cleanup_${Date.now()}`
              }
            });
          },
          testProductId,
          testVersion
        );
      } catch (cleanupError) {
        // The caller will inspect the test product if cleanup cannot be proven.
      }
    }
    throw error;
  } finally {
    if (miniProgram) {
      miniProgram.disconnect();
    }
  }
}

run().catch((error) => {
  console.error(
    `Phase 17 developer-tools verification failed: ${error.message}`
  );
  process.exitCode = 1;
});
