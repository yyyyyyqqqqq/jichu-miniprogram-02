'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const checks = [];
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, callback) {
  try {
    await callback();
    checks.push(name);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

function loadSubject() {
  const originalLoad = Module._load;
  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'dynamic',
        init() {},
        database() { return {}; },
        getWXContext() { return {}; }
      };
    }
    if (request === 'nodemailer') return { createTransport() { throw new Error('unexpected live mail'); } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const target = path.join(ROOT, 'cloudfunctions', 'feedbackAction', 'index.js');
    delete require.cache[require.resolve(target)];
    return require(target).__test;
  } finally {
    Module._load = originalLoad;
  }
}

function createDatabase(initialRecords = [], options = {}) {
  const records = new Map(initialRecords.map((record) => [record._id, { ...record }]));
  const userRecords = new Map(
    (options.users || []).map((record) => [record._id, { ...record }])
  );
  function collection(name = 'feedbacks') {
    const selectedRecords = name === 'users' ? userRecords : records;
    return {
      doc(id) {
        return {
          async get() {
            if (!selectedRecords.has(id)) {
              const error = new Error('document does not exist');
              error.code = 'DATABASE_DOCUMENT_NOT_EXIST';
              throw error;
            }
            return { data: { ...selectedRecords.get(id) } };
          },
          async set({ data }) {
            selectedRecords.set(id, { _id: id, ...data });
          },
          async update({ data }) {
            if (options.failUpdate) throw Object.assign(new Error('update failed'), { code: 'DATABASE_ERROR' });
            selectedRecords.set(id, { ...selectedRecords.get(id), ...data });
          }
        };
      },
      where(filter) {
        const query = {
          orderBy() { return query; },
          limit(value) {
            query.maximum = value;
            return query;
          },
          async get() {
            const data = [...selectedRecords.values()]
              .filter((record) => (
                filter._id
                  ? record._id === filter._id
                  : filter.openid
                    ? record.openid === filter.openid
                    : record.userOpenid === filter.userOpenid
              ))
              .filter((record) => (
                !filter.createdAt || new Date(record.createdAt) >= filter.createdAt.$gte
              ))
              .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
              .slice(0, query.maximum || 100);
            return { data };
          }
        };
        return query;
      }
    };
  }
  return {
    records,
    userRecords,
    collection,
    async runTransaction(callback) {
      if (options.failTransaction) throw Object.assign(new Error('database unavailable'), { code: 'DATABASE_ERROR' });
      return callback({ collection });
    }
  };
}

function createHarness(subject, options = {}) {
  const database = options.database || createDatabase(options.records || [], options);
  const openId = options.openId === undefined ? 'trusted-openid' : options.openId;
  const appId = options.appId === undefined ? 'trusted-appid' : options.appId;
  if (
    options.seedUser !== false
    && openId
    && appId
    && database.userRecords
  ) {
    const userId = subject.createUserId(appId, openId);
    database.userRecords.set(userId, {
      _id: userId,
      openid: options.userOpenId === undefined ? openId : options.userOpenId,
      status: options.userStatus || 'active'
    });
  }
  const sent = [];
  const logs = [];
  const mailer = {
    createTransport(configuration) {
      sent.push({ configuration, message: null });
      return {
        async sendMail(message) {
          sent[sent.length - 1].message = message;
          if (options.mailError) throw options.mailError;
          return { accepted: [message.to] };
        },
        close() {}
      };
    }
  };
  const environment = options.environment || {
    FEEDBACK_ENVIRONMENT: 'staging',
    FEEDBACK_MAIL_HOST: 'smtp.qq.com',
    FEEDBACK_MAIL_PORT: '465',
    FEEDBACK_MAIL_USER: 'sender@qq.com',
    FEEDBACK_MAIL_SECRET: 'new-authorization-code'
  };
  const now = options.now || new Date('2026-08-30T08:00:00.000Z');
  const handler = subject.createHandler({
    database,
    command: { gte: (value) => ({ $gte: value }) },
    getContext: () => ({ OPENID: openId, APPID: appId }),
    mailer,
    environment,
    now: () => new Date(now),
    randomBytes: () => Buffer.from('00112233445566778899aabbccddeeff0011', 'hex'),
    logger: { error(message, data) { logs.push({ message, data }); } }
  });
  return { handler, database, sent, logs };
}

function request(content = 'A useful suggestion', requestId = 'feedback_request_001') {
  return { action: 'submit', content, requestId };
}

async function run() {
  const subject = loadSubject();

  await check('content trims both edges', () => {
    assert(subject.normalizeContent('  hello \n') === 'hello', 'content was not trimmed');
  });
  await check('blank content is rejected', () => {
    let code = '';
    try { subject.normalizeContent('  \n '); } catch (error) { code = error.businessCode; }
    assert(code === 'INVALID_CONTENT', 'blank content was accepted');
  });
  await check('exact 1000-character content is accepted', () => {
    assert(subject.normalizeContent('a'.repeat(1000)).length === 1000, '1000 characters failed');
  });
  await check('1001-character content is rejected', () => {
    let code = '';
    try { subject.normalizeContent('a'.repeat(1001)); } catch (error) { code = error.businessCode; }
    assert(code === 'INVALID_CONTENT', 'oversize content was accepted');
  });
  await check('missing mail user is detected', () => {
    const result = subject.readMailConfiguration({ FEEDBACK_MAIL_HOST: 'smtp.qq.com', FEEDBACK_MAIL_PORT: '465', FEEDBACK_MAIL_SECRET: 'x' });
    assert(!result.ok && result.code === 'MAIL_CONFIG_MISSING', 'missing user was not detected');
  });
  await check('missing mail secret is detected', () => {
    const result = subject.readMailConfiguration({ FEEDBACK_MAIL_HOST: 'smtp.qq.com', FEEDBACK_MAIL_PORT: '465', FEEDBACK_MAIL_USER: 'x' });
    assert(!result.ok && result.code === 'MAIL_CONFIG_MISSING', 'missing secret was not detected');
  });
  await check('non-QQ SMTP host is rejected', () => {
    const result = subject.readMailConfiguration({ FEEDBACK_MAIL_HOST: 'example.com', FEEDBACK_MAIL_PORT: '465', FEEDBACK_MAIL_USER: 'x', FEEDBACK_MAIL_SECRET: 'y' });
    assert(!result.ok && result.code === 'MAIL_CONFIG_INVALID', 'invalid host was accepted');
  });
  await check('non-TLS QQ SMTP port is rejected', () => {
    const result = subject.readMailConfiguration({ FEEDBACK_MAIL_HOST: 'smtp.qq.com', FEEDBACK_MAIL_PORT: '587', FEEDBACK_MAIL_USER: 'x', FEEDBACK_MAIL_SECRET: 'y' });
    assert(!result.ok && result.code === 'MAIL_CONFIG_INVALID', 'invalid port was accepted');
  });
  await check('valid QQ SMTP configuration is accepted', () => {
    const result = subject.readMailConfiguration({ FEEDBACK_MAIL_HOST: 'smtp.qq.com', FEEDBACK_MAIL_PORT: '465', FEEDBACK_MAIL_USER: 'x', FEEDBACK_MAIL_SECRET: 'y' });
    assert(result.ok && result.port === 465, 'valid mail configuration failed');
  });
  await check('unknown environment defaults to staging marker', () => {
    assert(subject.normalizeEnvironmentName('unexpected') === 'staging', 'unsafe environment default');
  });
  await check('production subject has no staging prefix', () => {
    const mail = subject.buildMail({ _id: 'fb_1', content: 'hello', createdAt: new Date('2026-08-30T00:00:00Z') }, 'production', 'sender@qq.com');
    assert(mail.subject === '即出 - 新用户反馈', 'production subject drifted');
  });
  await check('staging subject is visibly marked', () => {
    const mail = subject.buildMail({ _id: 'fb_1', content: 'hello', createdAt: new Date('2026-08-30T00:00:00Z') }, 'staging', 'sender@qq.com');
    assert(mail.subject === '[STAGING] 即出 - 测试反馈', 'staging subject drifted');
  });
  await check('mail body omits trusted identity', () => {
    const mail = subject.buildMail({ _id: 'fb_1', content: 'hello', createdAt: new Date('2026-08-30T00:00:00Z'), userOpenid: 'private-openid' }, 'staging', 'sender@qq.com');
    assert(mail.text.includes('fb_1') && mail.text.includes('hello') && !mail.text.includes('private-openid'), 'mail privacy boundary drifted');
  });
  await check('SMTP authentication errors are normalized', () => {
    assert(subject.classifyMailFailure({ code: 'EAUTH' }) === 'SMTP_AUTH_FAILED', 'EAUTH classification drifted');
  });
  await check('SMTP connection errors are normalized', () => {
    assert(subject.classifyMailFailure({ code: 'ETIMEDOUT' }) === 'SMTP_CONNECTION_FAILED', 'timeout classification drifted');
  });
  await check('unknown mail errors are generic', () => {
    assert(subject.classifyMailFailure(new Error('secret detail')) === 'MAIL_SEND_FAILED', 'generic mail classification drifted');
  });

  await check('wrong action is rejected', async () => {
    const result = await createHarness(subject).handler({ action: 'list', content: 'hello' });
    assert(!result.success && result.code === 'INVALID_ACTION', 'wrong action was accepted');
  });
  await check('missing trusted identity is rejected', async () => {
    const result = await createHarness(subject, { openId: '' }).handler(request());
    assert(!result.success && result.code === 'UNAUTHORIZED', 'anonymous request was accepted');
  });
  await check('disabled authoritative user is rejected before persistence or mail', async () => {
    const harness = createHarness(subject, { userStatus: 'disabled' });
    const result = await harness.handler({
      ...request(),
      OPENID: 'forged-openid',
      status: 'active'
    });
    const payload = JSON.stringify(result);
    assert(!result.success && result.code === 'USER_DISABLED', 'disabled user was accepted');
    assert(harness.database.records.size === 0, 'disabled request persisted feedback');
    assert(harness.sent.length === 0, 'disabled request attempted to send mail');
    assert(
      !payload.includes('trusted-openid')
      && !payload.includes('trusted-appid')
      && !Object.prototype.hasOwnProperty.call(result, 'stack'),
      'disabled response leaked identity or stack data'
    );
  });
  await check('invalid request id is rejected', async () => {
    const result = await createHarness(subject).handler(request('hello', 'bad!'));
    assert(!result.success && result.code === 'INVALID_REQUEST_ID', 'bad request id was accepted');
  });
  await check('forged client identity is ignored', async () => {
    const harness = createHarness(subject);
    const result = await harness.handler({ ...request(), OPENID: 'forged', openid: 'forged', userOpenid: 'forged' });
    const stored = harness.database.records.get(result.data.feedbackId);
    assert(stored.userOpenid === 'trusted-openid', 'client identity influenced storage');
  });
  await check('missing SMTP config preserves accepted feedback', async () => {
    const harness = createHarness(subject, { environment: { FEEDBACK_ENVIRONMENT: 'staging', FEEDBACK_MAIL_HOST: 'smtp.qq.com', FEEDBACK_MAIL_PORT: '465' } });
    const result = await harness.handler(request());
    const stored = harness.database.records.get(result.data.feedbackId);
    assert(result.success && result.data.accepted && !result.data.notificationDelivered, 'feedback was not accepted');
    assert(stored.status === 'submitted' && stored.mailStatus === 'failed' && stored.mailLastErrorCode === 'MAIL_CONFIG_MISSING', 'missing config state drifted');
    assert(harness.sent.length === 0, 'mail transport was used without credentials');
  });
  await check('successful SMTP marks feedback sent', async () => {
    const harness = createHarness(subject);
    const result = await harness.handler(request());
    const stored = harness.database.records.get(result.data.feedbackId);
    assert(result.data.notificationDelivered && stored.mailStatus === 'sent', 'sent state was not persisted');
  });
  await check('SMTP uses QQ 465 with TLS', async () => {
    const harness = createHarness(subject);
    await harness.handler(request());
    const configuration = harness.sent[0].configuration;
    assert(configuration.host === 'smtp.qq.com' && configuration.port === 465 && configuration.secure === true, 'SMTP transport is unsafe');
  });
  await check('recipient is fixed server-side', async () => {
    const harness = createHarness(subject);
    await harness.handler({ ...request(), recipient: 'attacker@example.com' });
    assert(harness.sent[0].message.to === subject.RECIPIENT, 'client changed recipient');
  });
  await check('SMTP failure preserves feedback with generic code', async () => {
    const harness = createHarness(subject, { mailError: Object.assign(new Error('private server detail'), { code: 'EAUTH' }) });
    const result = await harness.handler(request());
    const stored = harness.database.records.get(result.data.feedbackId);
    assert(result.success && stored.mailStatus === 'failed' && stored.mailLastErrorCode === 'SMTP_AUTH_FAILED', 'mail failure damaged persistence');
  });
  await check('60-second rate limit rejects recent submission', async () => {
    const harness = createHarness(subject, { records: [{ _id: 'old', userOpenid: 'trusted-openid', createdAt: new Date('2026-08-30T07:59:30Z') }] });
    const result = await harness.handler(request());
    assert(!result.success && result.code === 'RATE_LIMITED', 'one-minute limit was bypassed');
  });
  await check('submission at exactly 60 seconds is allowed', async () => {
    const harness = createHarness(subject, { records: [{ _id: 'old', userOpenid: 'trusted-openid', createdAt: new Date('2026-08-30T07:59:00Z') }] });
    const result = await harness.handler(request());
    assert(result.success, 'exact one-minute boundary was rejected');
  });
  await check('24-hour limit rejects eleventh submission', async () => {
    const records = Array.from({ length: 10 }, (_, index) => ({ _id: `old_${index}`, userOpenid: 'trusted-openid', createdAt: new Date(`2026-08-30T0${index % 8}:00:00Z`) }));
    const result = await createHarness(subject, { records }).handler(request());
    assert(!result.success && result.code === 'RATE_LIMITED', 'daily limit was bypassed');
  });
  await check('other users do not consume rate allowance', async () => {
    const records = Array.from({ length: 10 }, (_, index) => ({ _id: `other_${index}`, userOpenid: 'other-openid', createdAt: new Date('2026-08-30T07:59:30Z') }));
    const result = await createHarness(subject, { records }).handler(request());
    assert(result.success, 'another user affected rate limit');
  });
  await check('idempotent retry does not resend mail', async () => {
    const harness = createHarness(subject);
    const first = await harness.handler(request('first content'));
    const second = await harness.handler(request('changed content'));
    const stored = harness.database.records.get(first.data.feedbackId);
    assert(second.success && second.data.reused && harness.sent.length === 1 && stored.content === 'first content', 'idempotent retry drifted');
  });
  await check('database failure returns generic error', async () => {
    const database = createDatabase([], { failTransaction: true });
    const result = await createHarness(subject, { database }).handler(request());
    assert(!result.success && result.code === 'DATABASE_ERROR' && result.data === null
      && result.message === '反馈暂时无法保存，请稍后再试', 'database failure envelope drifted');
  });
  await check('mail status update failure does not lose acceptance', async () => {
    const database = createDatabase([], { failUpdate: true });
    const harness = createHarness(subject, { database });
    const result = await harness.handler(request());
    assert(result.success && result.data.accepted && result.data.notificationDelivered, 'post-send update failure lost acceptance');
  });
  await check('stored feedback contains no SMTP credential', async () => {
    const harness = createHarness(subject);
    const result = await harness.handler(request());
    const serialized = JSON.stringify(harness.database.records.get(result.data.feedbackId));
    assert(!serialized.includes('authorization-code') && !serialized.includes('sender@qq.com'), 'credential leaked into feedback record');
  });
  await check('generic logs omit content identity secret and stack', async () => {
    const harness = createHarness(subject, { mailError: Object.assign(new Error('stack/private content'), { code: 'EAUTH' }) });
    await harness.handler(request('highly-private-feedback'));
    const serialized = JSON.stringify(harness.logs);
    assert(!serialized.includes('highly-private-feedback') && !serialized.includes('trusted-openid') && !serialized.includes('authorization-code') && !serialized.includes('stack/private'), 'private detail leaked to logs');
  });
  await check('request without client id receives server id', async () => {
    const harness = createHarness(subject);
    const result = await harness.handler({ action: 'submit', content: 'hello' });
    assert(result.success && /^fb_[a-f0-9]{64}$/.test(result.data.feedbackId), 'server request id path failed');
  });

  await check('feedback page is registered and login guarded', () => {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
    const page = fs.readFileSync(path.join(ROOT, 'pages', 'feedback', 'index.js'), 'utf8');
    assert(app.pages.includes('pages/feedback/index') && /requireIdentity/.test(page), 'page registration or guard missing');
  });
  await check('feedback UI exposes count loading success and error states', () => {
    const markup = fs.readFileSync(path.join(ROOT, 'pages', 'feedback', 'index.wxml'), 'utf8');
    assert(/contentLength/.test(markup) && /loading/.test(markup) && /errorMessage/.test(markup) && /successMessage/.test(markup), 'UI state coverage missing');
  });
  await check('client sends only action content and request id', () => {
    const service = fs.readFileSync(path.join(ROOT, 'services', 'feedback-service.js'), 'utf8');
    assert(/data:\s*\{ action: 'submit', content: normalized, requestId \}/.test(service), 'client request boundary drifted');
    assert(!/recipient\s*:/.test(service) && !/userOpenid\s*:/.test(service), 'client controls private mail or identity fields');
  });

  if (failures.length) {
    failures.forEach((failure) => process.stderr.write(`FAIL ${failure}\n`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ passed: true, checksPassed: checks.length, checks }, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`FEEDBACK_VERIFY_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
