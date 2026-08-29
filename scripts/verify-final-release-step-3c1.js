'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const SCHOOL_A = `s_${'a'.repeat(32)}`;
const SCHOOL_B = `s_${'b'.repeat(32)}`;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function activeUser(openid, schoolId) {
  return { openid, schoolId, status: 'active' };
}

function activeSchool(schoolId, overrides = {}) {
  return {
    _id: schoolId,
    name: schoolId === SCHOOL_A ? '学校 A' : '学校 B',
    platformStatus: 'active',
    officialStatus: 'valid',
    ...overrides
  };
}

function verifyCurrentSchoolBoundary() {
  const appointmentPath = path.join(
    root,
    'cloudfunctions/appointmentAction/current-school-boundary.js'
  );
  const messagePath = path.join(
    root,
    'cloudfunctions/messageAction/current-school-boundary.js'
  );
  const appointmentBoundary = require(appointmentPath);
  const messageBoundary = require(messagePath);
  assert.strictEqual(
    read('cloudfunctions/appointmentAction/current-school-boundary.js'),
    read('cloudfunctions/messageAction/current-school-boundary.js'),
    'appointment and conversation boundary helpers drifted'
  );

  const buyerOpenid = 'step3c1-buyer';
  const sellerOpenid = 'step3c1-seller';
  const base = {
    buyer: activeUser(buyerOpenid, SCHOOL_A),
    buyerOpenid,
    seller: activeUser(sellerOpenid, SCHOOL_A),
    sellerOpenid,
    product: { schoolId: SCHOOL_A },
    school: activeSchool(SCHOOL_A)
  };
  const allowed = (input) => appointmentBoundary
    .canCreateCurrentSchoolRelation(input);

  assert.strictEqual(allowed(base), true, 'case 1: same-school relation rejected');
  assert.strictEqual(allowed({
    ...base,
    seller: activeUser(sellerOpenid, SCHOOL_B)
  }), false, 'case 2: seller school drift was accepted');
  assert.strictEqual(allowed({
    ...base,
    buyer: activeUser(buyerOpenid, SCHOOL_B)
  }), false, 'case 3: buyer school drift was accepted');
  assert.strictEqual(allowed({
    ...base,
    product: { schoolId: SCHOOL_B }
  }), false, 'case 4: product school mismatch was accepted');
  assert.strictEqual(allowed({
    ...base,
    school: activeSchool(SCHOOL_A, { platformStatus: 'inactive' })
  }), false, 'case 5: inactive school was accepted');
  assert.strictEqual(allowed({
    ...base,
    school: activeSchool(SCHOOL_A, { officialStatus: 'invalid' })
  }), false, 'case 6: invalid official school was accepted');
  assert.strictEqual(allowed({ ...base, school: null }), false,
    'case 7: missing school was accepted');
  assert.strictEqual(allowed({
    ...base,
    seller: activeUser(sellerOpenid, SCHOOL_B),
    schoolId: SCHOOL_A,
    schoolName: '学校 A'
  }), false, 'case 8: forged client school fields bypassed the boundary');
  assert.strictEqual(
    messageBoundary.canCreateCurrentSchoolRelation({
      ...base,
      seller: activeUser(sellerOpenid, SCHOOL_B)
    }),
    false,
    'case 9: new conversation boundary accepted stale seller school'
  );

  const appointmentSource = read('cloudfunctions/appointmentAction/index.js');
  const transitionSource = appointmentSource.slice(
    appointmentSource.indexOf('async function transitionAppointment'),
    appointmentSource.indexOf('async function completeAppointment')
  );
  assert(!/assertCanCreateSchoolRelation/.test(transitionSource),
    'case 10: historical appointment transitions were newly school-gated');

  const messageSource = read('cloudfunctions/messageAction/index.js');
  const createSource = messageSource.slice(
    messageSource.indexOf('async function createOrGetConversation'),
    messageSource.indexOf('async function sendMessage')
  );
  assert(
    createSource.indexOf('assertCanCreateSchoolRelation')
      < createSource.indexOf('if (duplicate)'),
    'case 9: stale product can update an existing pair before the boundary guard'
  );
  assert(!/assertCanCreateSchoolRelation/.test(read('cloudfunctions/messageQuery/index.js')),
    'case 8: historical conversation reads were newly school-gated');

  const sellerReturned = {
    ...base,
    seller: activeUser(sellerOpenid, SCHOOL_A)
  };
  assert.strictEqual(allowed(sellerReturned), true,
    'case 12: seller returning to the product school did not restore creation');

  assert(/transaction\.collection\('schools'\)/.test(appointmentSource),
    'appointment transaction does not re-read authoritative school state');
  assert(/transaction\.collection\('schools'\)/.test(messageSource),
    'conversation transaction does not read authoritative school state');
}

function matches(record, condition) {
  return Object.entries(condition || {}).every(([key, expected]) => {
    if (expected && Array.isArray(expected.$in)) {
      return expected.$in.includes(record[key]);
    }
    return record[key] === expected;
  });
}

function createQuery(records, condition) {
  let offset = 0;
  let limit = Number.MAX_SAFE_INTEGER;
  const query = {
    orderBy() {
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
      return { total: [...records.values()].filter((item) => matches(item, condition)).length };
    },
    async get() {
      return {
        data: [...records.values()]
          .filter((item) => matches(item, condition))
          .slice(offset, offset + limit)
          .map((item) => ({ ...item }))
      };
    }
  };
  return query;
}

async function verifyPublicProfileSchoolDisplay() {
  const crypto = require('crypto');
  const functionPath = path.join(root, 'cloudfunctions/userQuery/index.js');
  const originalLoad = Module._load;
  const appId = 'step3c1-app';
  const viewerOpenid = 'step3c1-viewer';
  const viewerId = `u_${crypto.createHash('sha256')
    .update(`${appId}:${viewerOpenid}`).digest('hex').slice(0, 32)}`;
  const sellerId = `u_${'c'.repeat(32)}`;
  const users = new Map([
    [viewerId, {
      _id: viewerId,
      openid: viewerOpenid,
      status: 'active',
      schoolId: SCHOOL_A,
      schoolVersion: 2
    }],
    [sellerId, {
      _id: sellerId,
      openid: 'step3c1-seller',
      status: 'active',
      schoolId: SCHOOL_B,
      campus: '伪造旧校园',
      nickname: '公开卖家',
      createdAt: new Date('2026-07-01T00:00:00.000Z')
    }]
  ]);
  const schools = new Map([
    [SCHOOL_A, activeSchool(SCHOOL_A)],
    [SCHOOL_B, activeSchool(SCHOOL_B)]
  ]);
  const products = new Map([
    ['product-a', {
      _id: 'product-a',
      title: 'A 校商品',
      sellerOpenid: 'step3c1-seller',
      sellerId,
      schoolId: SCHOOL_A,
      status: 'available',
      createdAt: new Date()
    }],
    ['product-b', {
      _id: 'product-b',
      title: 'B 校商品',
      sellerOpenid: 'step3c1-seller',
      sellerId,
      schoolId: SCHOOL_B,
      status: 'available',
      createdAt: new Date()
    }]
  ]);
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
    DYNAMIC_CURRENT_ENV: 'verification',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { APPID: appId, OPENID: viewerOpenid };
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
    const request = (extra = {}) => userQuery.main({
      action: 'publicProfile',
      data: {
        publicUserId: sellerId,
        schoolName: '客户端伪造学校',
        schoolId: SCHOOL_A,
        ...extra
      }
    });

    let response = await request();
    assert.strictEqual(response.success, true, 'profile case 1 failed to load');
    assert.strictEqual(response.data.profile.schoolName, '学校 B',
      'profile case 1 did not show target authoritative school');
    assert.strictEqual(response.data.profile.campus, '学校 B',
      'profile case 1 legacy display field did not mirror authoritative school');
    assert.strictEqual(response.data.profile.activeProductCount, 1,
      'profile case 8 broke viewer-school product scope');
    assert.strictEqual(response.data.scope.schoolId, SCHOOL_A,
      'profile case 8 trusted forged viewer school scope');
    assert(!['openid', 'schoolId', 'role', 'status'].some(
      (field) => Object.prototype.hasOwnProperty.call(response.data.profile, field)
    ), 'profile case 7 leaked an internal field');
    assert.notStrictEqual(response.data.profile.schoolName, '客户端伪造学校',
      'profile case 6 trusted client schoolName');

    users.set(sellerId, { ...users.get(sellerId), schoolId: '' });
    response = await request();
    assert.strictEqual(response.data.profile.schoolName, '校园信息待完善',
      'profile case 2 missing school did not fall back');

    users.set(sellerId, { ...users.get(sellerId), schoolId: `s_${'d'.repeat(32)}` });
    response = await request();
    assert.strictEqual(response.data.profile.schoolName, '校园信息待完善',
      'profile case 3 unknown school did not fall back');

    users.set(sellerId, { ...users.get(sellerId), schoolId: SCHOOL_B });
    schools.set(SCHOOL_B, activeSchool(SCHOOL_B, { platformStatus: 'inactive' }));
    response = await request();
    assert.strictEqual(response.data.profile.schoolName, '校园信息待完善',
      'profile case 4 inactive school did not fall back');

    schools.set(SCHOOL_B, activeSchool(SCHOOL_B, { officialStatus: 'invalid' }));
    response = await request();
    assert.strictEqual(response.data.profile.schoolName, '校园信息待完善',
      'profile case 5 invalid official school did not fall back');

    schools.set(SCHOOL_B, activeSchool(SCHOOL_B));
    response = await request();
    assert.strictEqual(response.data.profile.schoolName, '学校 B',
      'profile case 8 cross-school profile read was blocked');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function main() {
  verifyCurrentSchoolBoundary();
  await verifyPublicProfileSchoolDisplay();
  console.log(
    'Final Release Step 3C-1 verification succeeded: '
    + '12 current-school boundary cases and 8 public-profile cases passed.'
  );
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
