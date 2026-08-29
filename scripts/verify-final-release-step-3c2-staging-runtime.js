'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  USER_ID_PATTERN,
  assert
} = require('./phase-18-canary-core');
const {
  loadDualAccountPrivate
} = require('./phase-18-dual-account-core');

const AUTOMATOR_MODULE = String(
  process.env.STEP3C2_AUTOMATOR_MODULE || ''
).trim();
const AUTOMATOR_WS_ENDPOINT = String(
  process.env.STEP3C2_AUTOMATOR_WS_ENDPOINT || ''
).trim();

function withTimeout(promise, label, timeoutMs = 60000) {
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

async function waitForProfile(miniProgram) {
  const started = Date.now();
  while (Date.now() - started < 45000) {
    const data = await withTimeout(
      miniProgram.evaluate(function readCurrentPageData() {
        const pages = getCurrentPages();
        const page = pages[pages.length - 1];
        return page && page.data || null;
      }),
      'public profile page data probe',
      5000
    );
    if (data && ['success', 'error'].includes(data.viewState)) {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('public profile page did not settle');
}

async function run() {
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(AUTOMATOR_WS_ENDPOINT), 'local automator endpoint is required');
  const automator = require(AUTOMATOR_MODULE);
  const dual = loadDualAccountPrivate();
  const screenshotPath = path.join(ROOT, 'tmp', 'step-3c2-staging-public-profile.png');
  let miniProgram;
  const stage = (label) => process.stderr.write(`[RUNTIME] ${label}\n`);
  try {
    stage('connect');
    miniProgram = await withTimeout(
      automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }),
      'automation connection'
    );
    const callCloud = async (name, action, data = {}) => payload(
      await withTimeout(miniProgram.evaluate(
        async function invoke(functionName, functionAction, functionData) {
          return wx.cloud.callFunction({
            name: functionName,
            data: { action: functionAction, data: functionData }
          });
        },
        name,
        action,
        data
      ), `${name}:${action}`)
    );

    stage('read current identity');
    const current = await callCloud('authUser', 'current');
    assert(current.success === true && current.data && current.data.user, 'current staging identity is unavailable');
    const viewer = current.data.user;
    assert(USER_ID_PATTERN.test(String(viewer.id || '')), 'current staging user id is invalid');
    const candidates = [dual.accountA, dual.accountB];
    const target = candidates.find((account) => account.userId !== viewer.id);
    assert(target, 'a distinct staging profile target is unavailable');

    stage('call publicProfile');
    const profile = await callCloud('userQuery', 'publicProfile', {
      publicUserId: target.userId,
      schoolName: 'forged-client-school-name'
    });
    assert(profile.success === true && profile.data && profile.data.profile, 'publicProfile runtime call failed');
    const dto = profile.data.profile;
    assert(typeof dto.schoolName === 'string' && dto.schoolName.trim(), 'publicProfile omitted schoolName');
    assert(dto.schoolName !== '校园信息待完善', 'valid target school resolved to fallback');
    assert(dto.schoolName !== 'forged-client-school-name', 'publicProfile trusted forged schoolName');
    for (const field of ['schoolId', 'openid', 'sellerOpenid']) {
      assert(!Object.prototype.hasOwnProperty.call(dto, field), `publicProfile leaked ${field}`);
    }

    stage('call publicProducts');
    const products = await callCloud('userQuery', 'publicProducts', {
      publicUserId: target.userId,
      page: 1,
      pageSize: 6
    });
    assert(products.success === true && products.data, 'publicProducts runtime call failed');
    assert(
      products.data.scope
      && profile.data.scope
      && products.data.scope.schoolId === profile.data.scope.schoolId,
      'profile and products viewer scope differ'
    );

    stage('launch public profile page');
    await withTimeout(
      miniProgram.reLaunch(
        `/pages/user-profile/index?userId=${encodeURIComponent(target.userId)}`
      ),
      'public profile page launch'
    );
    stage('wait for public profile page');
    const pageData = await waitForProfile(miniProgram);
    assert(pageData.viewState === 'success' && pageData.profile, 'public profile page failed');
    assert(pageData.profile.schoolName === dto.schoolName, 'service/page dropped schoolName');
    let screenshotCaptured = false;
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    stage('capture public profile screenshot');
    try {
      await withTimeout(
        miniProgram.screenshot({ path: screenshotPath }),
        'public profile screenshot',
        10000
      );
      screenshotCaptured = fs.existsSync(screenshotPath);
    } catch (_) {
      // Screenshot capture is optional because older DevTools automation
      // endpoints can omit App.captureScreenshot support.
    }

    stage('inspect rendered school name');
    let elementTextProbePassed = false;
    try {
      const page = await withTimeout(miniProgram.currentPage(), 'current page', 5000);
      const campus = await withTimeout(page.$('.public-campus'), 'school element query', 5000);
      if (campus) {
        const rendered = String(
          await withTimeout(campus.text(), 'school element text', 5000)
        ).trim();
        elementTextProbePassed = rendered === dto.schoolName;
      }
    } catch (_) {
      // Some remote-debug versions do not implement element queries. The
      // screenshot and settled page data remain available for manual evidence.
    }
    const wxml = fs.readFileSync(
      path.join(ROOT, 'pages', 'user-profile', 'index.wxml'),
      'utf8'
    );
    assert(
      /class="public-campus"[^>]*>\{\{profile\.schoolName \|\| profile\.campus\}\}/.test(wxml),
      'public profile WXML school binding changed'
    );

    return {
      environment: 'staging',
      publicProfile: {
        runtimeCallPassed: true,
        schoolNamePresent: true,
        forgedFieldIgnored: true,
        internalFieldsAbsent: true,
        viewerScopePreserved: true
      },
      pageServiceWxml: {
        pageSuccess: true,
        servicePreservedSchoolName: true,
        screenshotCaptured,
        wxmlBindingPresent: true,
        elementTextProbePassed,
        fallbackInPageData: false
      }
    };
  } finally {
    if (miniProgram) {
      stage('disconnect');
      await withTimeout(miniProgram.disconnect(), 'automation disconnect', 5000).catch(() => {});
    }
  }
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`STEP_3C2_STAGING_RUNTIME_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run };
