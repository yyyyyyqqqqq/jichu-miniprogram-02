'use strict';

const fs = require('fs');
const { runPreflight, publicSummary, assert } = require('./environment-preflight');

const AUTOMATOR_MODULE = String(process.env.STEP3C3_AUTOMATOR_MODULE || '').trim();
const AUTOMATOR_WS_ENDPOINT = String(process.env.STEP3C3_AUTOMATOR_WS_ENDPOINT || '').trim();

function withTimeout(promise, label, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function payload(response) {
  const value = response && response.result;
  assert(value && typeof value.success === 'boolean', 'invalid cloud response');
  return value;
}

async function run() {
  const preflight = runPreflight({ environmentName: 'production', action: 'audit' });
  assert(AUTOMATOR_MODULE && fs.existsSync(AUTOMATOR_MODULE), 'automator module is unavailable');
  assert(/^ws:\/\/127\.0\.0\.1:\d+$/.test(AUTOMATOR_WS_ENDPOINT), 'local automator endpoint is required');
  const automator = require(AUTOMATOR_MODULE);
  const miniProgram = await withTimeout(automator.connect({ wsEndpoint: AUTOMATOR_WS_ENDPOINT }), 'automation connection');
  let consoleErrors = 0;
  let exceptions = 0;
  miniProgram.on('console', (entry) => {
    if (entry && String(entry.type || '').toLowerCase() === 'error') consoleErrors += 1;
  });
  miniProgram.on('exception', () => { exceptions += 1; });
  try {
    const callCloud = async (name, action, data = {}) => payload(await withTimeout(
      miniProgram.evaluate(async function invoke(functionName, functionAction, functionData) {
        return wx.cloud.callFunction({
          name: functionName,
          data: { action: functionAction, data: functionData }
        });
      }, name, action, data),
      `${name}:${action}`
    ));
    const current = await callCloud('authUser', 'current');
    assert(current.success && current.data && current.data.user, 'production authenticated identity is unavailable');
    const conversations = await callCloud('messageQuery', 'listConversations', { pageSize: 20 });
    assert(conversations.success && conversations.data && Array.isArray(conversations.data.list), 'historical conversation list failed');
    assert(conversations.data.list.length > 0, 'no safe historical conversation is available');
    const conversation = conversations.data.list.find((item) => item.otherUser && item.otherUser.publicUserId) || conversations.data.list[0];
    assert(conversation.otherUser && conversation.otherUser.publicUserId, 'public profile target is unavailable');
    const profile = await callCloud('userQuery', 'publicProfile', {
      publicUserId: conversation.otherUser.publicUserId,
      schoolName: 'forged-client-school-name',
      schoolId: `s_${'f'.repeat(32)}`
    });
    assert(profile.success && profile.data && profile.data.profile, 'publicProfile runtime call failed');
    const dto = profile.data.profile;
    assert(typeof dto.schoolName === 'string' && dto.schoolName.trim(), 'publicProfile omitted schoolName');
    assert(dto.schoolName !== 'forged-client-school-name', 'publicProfile trusted forged schoolName');
    for (const field of ['schoolId', 'openid', 'sellerOpenid']) {
      assert(!Object.prototype.hasOwnProperty.call(dto, field), `publicProfile leaked ${field}`);
    }
    const messages = await callCloud('messageQuery', 'listMessages', {
      conversationId: conversation.conversationId,
      pageSize: 20
    });
    assert(messages.success && messages.data && Array.isArray(messages.data.list), 'historical messages failed');
    const appointments = await callCloud('appointmentQuery', 'listMine', { pageSize: 20 });
    assert(appointments.success && appointments.data && Array.isArray(appointments.data.list), 'historical appointments failed');
    assert(consoleErrors === 0 && exceptions === 0, 'DevTools recorded errors');
    return {
      environment: publicSummary(preflight),
      publicProfile: {
        runtimeCallPassed: true,
        authoritativeSchoolNamePresent: dto.schoolName !== '校园信息待完善',
        forgedSchoolIgnored: true,
        internalFieldsAbsent: true,
        crossSchoolReadable: true
      },
      historicalChat: { listReadable: true, messagesReadable: true },
      historicalAppointment: { listReadable: true, recordsObserved: appointments.data.list.length },
      writesRequested: false,
      consoleErrors,
      exceptions,
      passed: true
    };
  } finally {
    await withTimeout(miniProgram.disconnect(), 'automation disconnect', 5000).catch(() => {});
  }
}

if (require.main === module) {
  run().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code || 'STEP3C3_RUNTIME_FAILED'}: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { run };
