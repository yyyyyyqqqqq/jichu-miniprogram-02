const path = require('path');
const {
  ROOT,
  FIXTURE_PREFIX,
  PRIVATE_BOOTSTRAP_PATH,
  PRIVATE_CANARY_PATH,
  normalizeText,
  maskId,
  assert,
  loadBootstrapPrivate,
  mongoDate,
  queryCollection,
  writePrivateJson,
  buildFixtureSpecs,
  publicSummary,
  loadEnvironmentId,
  maskEnvironmentId,
  runNoSql
} = require('./phase-18-canary-core');

function parseArguments(argv) {
  const options = {
    confirmTarget: '',
    privateInput: PRIVATE_BOOTSTRAP_PATH,
    output: PRIVATE_CANARY_PATH,
    apply: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--confirm-target') {
      options.confirmTarget = normalizeText(argv[++index]);
    } else if (value === '--private-input') {
      options.privateInput = path.resolve(ROOT, normalizeText(argv[++index]));
    } else if (value === '--output') {
      options.output = path.resolve(ROOT, normalizeText(argv[++index]));
    } else if (value === '--apply-fixtures') {
      options.apply = true;
    } else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

function readAudit(environmentId, privateData) {
  const users = queryCollection(environmentId, 'users', {
    filter: { _id: privateData.userId },
    projection: {
      _id: 1,
      openid: 1,
      status: 1,
      profileCompleted: 1,
      nickname: 1,
      avatarUrl: 1,
      schoolId: 1,
      schoolName: 1,
      schoolVersion: 1
    }
  });
  const schools = queryCollection(environmentId, 'schools', {
    filter: {
      _id: { $in: [privateData.schoolA.id, privateData.schoolB.id] }
    },
    projection: {
      _id: 1,
      name: 1,
      officialStatus: 1,
      platformStatus: 1
    }
  });
  const products = queryCollection(environmentId, 'products', {
    filter: {},
    projection: {
      _id: 1,
      title: 1,
      sellerId: 1,
      status: 1,
      schoolId: 1,
      schoolName: 1,
      categoryId: 1,
      price: 1,
      favoriteCount: 1,
      viewCount: 1,
      createdAt: 1
    },
    limit: 1000
  });
  const user = users[0];
  assert(users.length === 1, 'controlled user was not found exactly once');
  assert(user.status === 'active', 'controlled user is not active');
  assert(user.profileCompleted === true, 'controlled user profile is incomplete');
  assert(normalizeText(user.openid), 'controlled user has no trusted identity');
  assert(normalizeText(user.nickname), 'controlled user nickname is missing');
  assert(normalizeText(user.avatarUrl), 'controlled user avatar is missing');
  assert(
    [privateData.schoolA.id, privateData.schoolB.id].includes(user.schoolId),
    'controlled user is outside the two approved schools'
  );
  assert(schools.length === 2, 'approved schools were not found exactly once');
  schools.forEach((school) => {
    assert(school.platformStatus === 'active', 'approved school is not active');
    assert(school.officialStatus === 'valid', 'approved school is not official-valid');
    assert(normalizeText(school.name), 'approved school name is missing');
  });
  const conflicting = products.filter((product) => (
    normalizeText(product.title).startsWith(FIXTURE_PREFIX)
    && product.sellerId !== privateData.userId
  ));
  assert(conflicting.length === 0, 'fixture prefix is already used by another seller');
  return { user, schools, products };
}

function summarizeExisting(audit, specs, privateData) {
  return specs.map((spec) => {
    const matches = audit.products.filter((product) => (
      product.title === spec.title
      && product.sellerId === privateData.userId
    ));
    assert(matches.length <= 1, `duplicate fixture title: ${spec.key}`);
    return {
      key: spec.key,
      exists: matches.length === 1,
      id: matches[0] ? maskId(matches[0]._id) : '',
      currentStatus: matches[0] ? matches[0].status : '',
      currentSchool: matches[0] ? maskId(matches[0].schoolId || '') : ''
    };
  });
}

function withTimeout(promise, label, timeoutMs = 30000) {
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

function normalizeCloudPayload(response) {
  const payload = response && response.result;
  assert(payload && typeof payload.success === 'boolean', 'invalid cloud response');
  return payload;
}

function buildProductInput(source, spec) {
  return {
    title: spec.title,
    description: `${FIXTURE_PREFIX}真实云端隔离、分页、排序与游标验证专用。`,
    price: spec.price,
    categoryId: spec.categoryId,
    condition: source.condition,
    location: source.location,
    locationDetail: source.locationDetail,
    images: source.images,
    video: source.video || null,
    schoolId: `s_${'f'.repeat(32)}`,
    schoolName: '客户端伪造学校'
  };
}

async function applyFixtures(environmentId, privateData, specs, audit, outputPath) {
  const automatorModule = normalizeText(process.env.PHASE18_CANARY_AUTOMATOR_MODULE);
  const endpoint = normalizeText(process.env.PHASE18_CANARY_AUTOMATOR_WS_ENDPOINT);
  assert(automatorModule, 'PHASE18_CANARY_AUTOMATOR_MODULE is required for apply');
  assert(endpoint, 'PHASE18_CANARY_AUTOMATOR_WS_ENDPOINT is required for apply');
  const automator = require(automatorModule);
  let miniProgram;
  try {
    miniProgram = await withTimeout(
      automator.connect({ wsEndpoint: endpoint }),
      'developer tools connection'
    );
    const callCloud = async (name, data) => normalizeCloudPayload(
      await withTimeout(miniProgram.evaluate(
        async function callCloudFunction(functionName, functionData) {
          return wx.cloud.callFunction({ name: functionName, data: functionData });
        },
        name,
        data
      ), `${name} cloud call`, 45000)
    );
    const current = async () => {
      const result = await callCloud('authUser', { action: 'current', data: {} });
      assert(result.success === true, 'authUser/current failed');
      return result.data.user;
    };
    const switchSchool = async (school) => {
      const before = await current();
      if (before.schoolId === school.id) {
        return before;
      }
      const changed = await callCloud('authUser', {
        action: 'updateSchool',
        data: { schoolId: school.id }
      });
      assert(changed.success === true, `failed to switch to school ${school.name}`);
      assert(changed.data.user.schoolId === school.id, 'school switch returned wrong scope');
      return changed.data.user;
    };
    const identity = await current();
    assert(identity.id === privateData.userId, 'developer tools identity is not controlled user');
    assert(identity.status === 'active' && identity.profileCompleted === true, 'controlled identity is unavailable');

    const editable = await callCloud('manageProduct', {
      action: 'getEditableProduct',
      productId: privateData.productBId
    });
    assert(editable.success === true, 'fixture media source is unavailable');
    const source = editable.data && editable.data.product;
    assert(source && Array.isArray(source.images) && source.images.length > 0, 'fixture media source has no images');
    assert(source.locationDetail, 'fixture location source is missing');

    const created = [];
    const createAtSchool = async (schoolKey, school) => {
      await switchSchool(school);
      for (const spec of specs.filter((item) => item.school === schoolKey)) {
        const result = await callCloud('createProduct', {
          requestId: spec.requestId,
          product: buildProductInput(source, spec)
        });
        assert(result.success === true, `createProduct failed for ${spec.key}`);
        assert(result.data.schoolId === school.id, `server school binding failed for ${spec.key}`);
        created.push({ ...spec, productId: result.data.productId, reused: result.data.reused === true });
      }
    };

    await createAtSchool('B', privateData.schoolB);
    await createAtSchool('A', privateData.schoolA);
    const finalUser = await switchSchool(privateData.schoolB);

    const uniqueIds = new Set(created.map((item) => item.productId));
    assert(created.length === specs.length, 'not all fixture products were created');
    assert(uniqueIds.size === specs.length, 'fixture product IDs are not unique');

    const operationId = 'phase18-school-scoped-canary-fixtures-v1';
    const updates = created.map((item) => {
      const set = {
        title: item.title,
        description: `${FIXTURE_PREFIX}真实云端隔离、分页、排序与游标验证专用。`,
        status: item.status,
        categoryId: item.categoryId,
        categoryName: item.categoryId === 'books' ? '书籍教材' : '数码产品',
        price: item.price,
        favoriteCount: item.favoriteCount,
        viewCount: item.viewCount,
        createdAt: mongoDate(item.createdAt),
        version: 2,
        phase18CanaryFixture: {
          operationId,
          key: item.key,
          school: item.removeSchool ? 'none' : item.school,
          purpose: 'school-scoped-market-validation'
        }
      };
      if (item.status === 'reserved') {
        set.reservedAt = mongoDate(item.createdAt);
      }
      if (item.status === 'offline') {
        set.offlineAt = mongoDate(item.createdAt);
      }
      return {
        q: {
          _id: item.productId,
          sellerId: privateData.userId,
          title: item.title
        },
        u: {
          $set: set,
          $currentDate: { updatedAt: true },
          ...(item.removeSchool ? {
            $unset: { schoolId: '', schoolName: '' }
          } : {})
        },
        multi: false,
        upsert: false
      };
    });
    for (let offset = 0; offset < updates.length; offset += 4) {
      runNoSql(environmentId, [{
        TableName: 'products',
        CommandType: 'UPDATE',
        Command: JSON.stringify({
          update: 'products',
          updates: updates.slice(offset, offset + 4),
          ordered: true
        })
      }]);
    }

    const readback = queryCollection(environmentId, 'products', {
      filter: { _id: { $in: created.map((item) => item.productId) } },
      projection: {
        _id: 1,
        title: 1,
        sellerId: 1,
        status: 1,
        schoolId: 1,
        schoolName: 1,
        categoryId: 1,
        price: 1,
        favoriteCount: 1,
        viewCount: 1,
        createdAt: 1
      },
      limit: 100
    });
    assert(readback.length === specs.length, 'fixture readback count mismatch');
    const byId = new Map(readback.map((item) => [item._id, item]));
    created.forEach((item) => {
      const record = byId.get(item.productId);
      const expectedSchool = item.school === 'A' ? privateData.schoolA : privateData.schoolB;
      assert(record && record.sellerId === privateData.userId, `fixture owner mismatch: ${item.key}`);
      assert(record.title === item.title, `fixture title mismatch: ${item.key}`);
      assert(record.status === item.status, `fixture status mismatch: ${item.key}`);
      assert(record.categoryId === item.categoryId, `fixture category mismatch: ${item.key}`);
      assert(Number(record.price) === item.price, `fixture price mismatch: ${item.key}`);
      assert(Number(record.favoriteCount) === item.favoriteCount, `fixture favorite count mismatch: ${item.key}`);
      assert(Number(record.viewCount) === item.viewCount, `fixture view count mismatch: ${item.key}`);
      if (item.removeSchool) {
        assert(!normalizeText(record.schoolId), 'no-school fixture still has schoolId');
      } else {
        assert(record.schoolId === expectedSchool.id, `fixture school mismatch: ${item.key}`);
        assert(record.schoolName === expectedSchool.name, `fixture school name mismatch: ${item.key}`);
      }
    });

    const privateResult = {
      schemaVersion: 1,
      preparedAt: new Date().toISOString(),
      target: `cloud:${maskEnvironmentId(environmentId)}`,
      operationId,
      userId: privateData.userId,
      finalUserSchoolId: finalUser.schoolId,
      finalUserSchoolName: finalUser.schoolName,
      finalSchoolVersion: finalUser.schoolVersion,
      schoolA: privateData.schoolA,
      schoolB: privateData.schoolB,
      originalProductAId: privateData.productAId,
      originalProductBId: privateData.productBId,
      fixtures: created.map((item) => ({
        key: item.key,
        productId: item.productId,
        title: item.title,
        school: item.removeSchool ? 'none' : item.school,
        schoolId: item.removeSchool
          ? ''
          : item.school === 'A' ? privateData.schoolA.id : privateData.schoolB.id,
        status: item.status,
        categoryId: item.categoryId,
        price: item.price,
        favoriteCount: item.favoriteCount,
        viewCount: item.viewCount,
        createdAt: item.createdAt,
        reused: item.reused
      })),
      configurationBefore: {
        schoolScopedMarketEnabled: false,
        strictForAll: false,
        allowlistCount: 0,
        hmacSecretPresent: true,
        hmacSecretLengthQualified: true
      }
    };
    writePrivateJson(outputPath, privateResult);
    return {
      mode: 'apply',
      target: privateResult.target,
      userId: maskId(privateData.userId),
      finalSchoolId: maskId(finalUser.schoolId),
      finalSchoolVersion: finalUser.schoolVersion,
      createdOrReused: created.length,
      reused: created.filter((item) => item.reused).length,
      schoolA: created.filter((item) => item.school === 'A').length,
      schoolB: created.filter((item) => item.school === 'B' && !item.removeSchool).length,
      noSchool: created.filter((item) => item.removeSchool).length,
      privateOutput: path.relative(ROOT, outputPath).replace(/\\/g, '/')
    };
  } finally {
    if (miniProgram) {
      miniProgram.disconnect();
    }
  }
}

async function run(options) {
  const environmentId = loadEnvironmentId();
  const targetMasked = maskEnvironmentId(environmentId);
  assert(options.confirmTarget === targetMasked, 'explicit masked target confirmation is required');
  const privateData = loadBootstrapPrivate(options.privateInput);
  const specs = buildFixtureSpecs();
  const audit = readAudit(environmentId, privateData);
  const existing = summarizeExisting(audit, specs, privateData);
  if (!options.apply) {
    return {
      mode: 'dry-run',
      target: `cloud:${targetMasked}`,
      databaseWrites: false,
      cloudFunctionCalls: false,
      userId: maskId(privateData.userId),
      currentSchoolId: maskId(audit.user.schoolId),
      currentSchoolVersion: audit.user.schoolVersion,
      plan: publicSummary(specs),
      existing
    };
  }
  return applyFixtures(environmentId, privateData, specs, audit, options.output);
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'PHASE18_FIXTURE_PREPARATION_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  readAudit,
  summarizeExisting,
  buildProductInput,
  run
};
