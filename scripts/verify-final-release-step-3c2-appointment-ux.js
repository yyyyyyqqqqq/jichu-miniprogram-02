'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const servicePath = path.join(root, 'services', 'appointment-service.js');
const feedbackPath = path.join(root, 'utils', 'appointment-feedback.js');
const createPagePath = path.join(root, 'pages', 'appointment-create', 'index.js');
const chatPagePath = path.join(root, 'pages', 'chat', 'index.js');
const productDetailPath = path.join(root, 'pages', 'product-detail', 'index.js');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function verifySources() {
  const service = read(servicePath);
  const feedback = read(feedbackPath);
  const createPage = read(createPagePath);
  const chatPage = read(chatPagePath);
  const productDetail = read(productDetailPath);

  assert(service.includes('CROSS_SCHOOL_RELATION_FORBIDDEN'),
    'cross-school mapping is missing');
  assert(service.includes("title: '无法发起预约'"),
    'modal title is missing from the mapping layer');
  assert(service.includes('卖家已更换学校，该商品暂不支持发起新的面交预约。'),
    'modal content is missing from the mapping layer');
  assert(service.includes("confirmText: '知道了'")
    && service.includes('showCancel: false'),
  'single confirmation button is not configured');
  assert(createPage.includes('AppointmentFeedback.showCreateFailure(error)'),
    'appointment create failure does not use unified feedback');
  assert(chatPage.includes('AppointmentFeedback.showCrossSchoolCreateForbidden()'),
    'chat appointment entry does not use unified feedback');
  assert(!productDetail.includes('AppointmentService.createAppointment'),
    'product detail unexpectedly bypasses the shared appointment create page');
  assert(feedback.includes('crossSchoolModalVisible'),
    'duplicate modal guard is missing');
  assert(!feedback.includes('navigateTo') && !feedback.includes('redirectTo'),
    'modal feedback changes the current route');
}

function verifyRuntimeFeedback() {
  const AppointmentService = require(servicePath);
  const originalWx = global.wx;
  const modals = [];
  const toasts = [];
  global.wx = {
    showModal(options) {
      modals.push(options);
    },
    showToast(options) {
      toasts.push(options);
    }
  };

  delete require.cache[require.resolve(feedbackPath)];
  const AppointmentFeedback = require(feedbackPath);
  try {
    const crossSchool = new AppointmentService.AppointmentError(
      'CROSS_SCHOOL_RELATION_FORBIDDEN'
    );
    const modal = AppointmentService.getCreateErrorFeedback(crossSchool);
    assert.deepStrictEqual(modal, {
      type: 'modal',
      title: '无法发起预约',
      content: '卖家已更换学校，该商品暂不支持发起新的面交预约。',
      showCancel: false,
      confirmText: '知道了'
    });

    const ordinary = new AppointmentService.AppointmentError(
      'INVALID_PARAMS'
    );
    assert.deepStrictEqual(
      AppointmentService.getCreateErrorFeedback(ordinary),
      {
        type: 'toast',
        title: '预约参数不正确',
        icon: 'none',
        duration: 2600
      },
      'ordinary errors no longer use the existing toast behavior'
    );

    AppointmentFeedback.showCreateFailure(crossSchool);
    AppointmentFeedback.showCreateFailure(crossSchool);
    assert.strictEqual(modals.length, 1,
      'one request can show duplicate cross-school modals');
    assert.strictEqual(toasts.length, 0,
      'cross-school rejection still uses a toast');
    assert.strictEqual(modals[0].showCancel, false,
      'cross-school modal exposes a cancel button');
    assert.strictEqual(modals[0].confirmText, '知道了',
      'cross-school modal confirmation copy changed');

    modals[0].complete();
    AppointmentFeedback.showCrossSchoolCreateForbidden();
    assert.strictEqual(modals.length, 2,
      'modal cannot be shown for a later independent request');
    modals[1].complete();

    AppointmentFeedback.showCreateFailure(ordinary);
    assert.strictEqual(toasts.length, 1,
      'ordinary create failure stopped using toast');
    assert.strictEqual(toasts[0].title, '预约参数不正确');
  } finally {
    delete require.cache[require.resolve(feedbackPath)];
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

verifySources();
verifyRuntimeFeedback();
process.stdout.write(
  'Step 3C-2 appointment UX verification passed: '
  + 'cross-school modal, deduplication, entry consistency and ordinary toast fallback verified.\n'
);
