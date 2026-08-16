const fs = require('fs');
const path = require('path');
const {
  runPreflight,
  publicSummary,
  assert
} = require('./environment-preflight');
const {
  queryCollection
} = require('./phase-18-canary-core');

const REQUEST_ID = 'phase24_pair_staging_p2_20260813';
const TITLE = 'Phase24 Pair P2';

function parseArguments(argv) {
  const options = { environmentName: '', confirmTarget: '', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--confirm-target') options.confirmTarget = String(argv[++index] || '').trim();
    else if (value === '--apply') options.apply = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  return options;
}

function mask(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 8)}***${text.slice(-4)}` : '***';
}

function readProducts(environmentId) {
  return queryCollection(environmentId, 'products', {
    projection: {
      _id: 1,
      title: 1,
      description: 1,
      price: 1,
      categoryId: 1,
      condition: 1,
      location: 1,
      locationDetail: 1,
      coverImage: 1,
      status: 1,
      sellerId: 1
    },
    limit: 100
  });
}

function validateTemplate(products) {
  const available = products.filter((item) => item.status === 'available');
  assert(available.length >= 1, 'staging requires one existing available product', 'STAGING_TEMPLATE_PRODUCT_MISSING');
  const sellerIds = [...new Set(available.map((item) => String(item.sellerId || '')).filter(Boolean))];
  assert(sellerIds.length === 1, 'staging available products must use one seller for pair validation', 'STAGING_SELLER_AMBIGUOUS');
  const template = available[0];
  assert(
    String(template.coverImage || '').startsWith('cloud://')
      && template.locationDetail
      && template.categoryId
      && template.condition,
    'staging template product is incomplete',
    'STAGING_TEMPLATE_PRODUCT_INVALID'
  );
  return { available, sellerId: sellerIds[0], template };
}

async function callCloud(miniProgram, name, data) {
  return miniProgram.evaluate(async function invoke(input) {
    const response = await wx.cloud.callFunction({
      name: input.name,
      data: input.data
    });
    return response && response.result;
  }, { name, data });
}

async function run(options) {
  const preflight = runPreflight({
    environmentName: options.environmentName,
    action: options.apply ? 'seed' : 'audit',
    confirmTarget: options.confirmTarget
  });
  assert(preflight.environmentName === 'staging', 'product fixture only supports staging', 'PRODUCTION_WRITE_REJECTED');
  const before = readProducts(preflight.environmentId);
  const state = validateTemplate(before);
  const existingP2 = state.available.find((item) => item.title === TITLE);
  if (!options.apply || existingP2 || state.available.length >= 2) {
    return {
      mode: options.apply ? 'already-ready' : 'dry-run',
      preflight: publicSummary(preflight),
      sellerId: mask(state.sellerId),
      availableProducts: state.available.length,
      wouldCreate: !existingP2 && state.available.length < 2 ? TITLE : null,
      productIds: state.available.map((item) => mask(item._id))
    };
  }

  const automatorPath = String(process.env.PHASE24_AUTOMATOR_MODULE || '').trim();
  const wsEndpoint = String(process.env.PHASE24_AUTOMATOR_WS_ENDPOINT || '').trim();
  assert(automatorPath && fs.existsSync(automatorPath), 'automator module is unavailable', 'AUTOMATOR_MISSING');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(wsEndpoint), 'local automator websocket is required', 'AUTOMATOR_ENDPOINT_INVALID');
  const automator = require(automatorPath);
  let miniProgram;
  try {
    miniProgram = await automator.connect({ wsEndpoint });
    const current = await callCloud(miniProgram, 'authUser', {
      action: 'current',
      data: {}
    });
    const currentUser = current && current.success && current.data
      ? current.data.user
      : null;
    assert(currentUser && currentUser.id === state.sellerId, 'DevTools identity does not own the template product', 'STAGING_SELLER_SESSION_MISMATCH');
    const template = state.template;
    const created = await callCloud(miniProgram, 'createProduct', {
      requestId: REQUEST_ID,
      product: {
        title: TITLE,
        description: 'Phase 24 用户对唯一会话 staging 验证商品 P2',
        price: Number(template.price),
        categoryId: template.categoryId,
        condition: template.condition,
        images: [template.coverImage],
        video: null,
        location: template.location,
        locationDetail: template.locationDetail
      }
    });
    assert(created && created.success === true, `createProduct rejected staging P2: ${created && created.code || 'UNKNOWN'}`, 'STAGING_P2_CREATE_FAILED');
  } finally {
    if (miniProgram) miniProgram.disconnect();
  }

  const after = readProducts(preflight.environmentId);
  const afterState = validateTemplate(after);
  const p2 = afterState.available.find((item) => item.title === TITLE);
  assert(p2 && afterState.available.length >= 2, 'staging P2 readback failed', 'STAGING_P2_READBACK_FAILED');
  return {
    mode: 'created-and-verified',
    preflight: publicSummary(preflight),
    sellerId: mask(afterState.sellerId),
    availableProducts: afterState.available.length,
    createdProductId: mask(p2._id),
    reusedMediaOwnedBySeller: true,
    productionWritten: false
  };
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'PHASE24_PAIR_STAGING_PRODUCT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { REQUEST_ID, TITLE, parseArguments, run };
