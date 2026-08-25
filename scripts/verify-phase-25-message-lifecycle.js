const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checks = [];
let assertionCount = 0;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  assertionCount += 1;
  if (!condition) {
    throw new Error(message);
  }
}

function check(name, callback) {
  const before = assertionCount;
  callback();
  checks.push({
    name,
    assertions: assertionCount - before
  });
}

const action = read('cloudfunctions/messageAction/index.js');
const query = read('cloudfunctions/messageQuery/index.js');
const appointment = read('cloudfunctions/appointmentAction/index.js');
const service = read('services/message-service.js');
const messagesPage = read('pages/messages/index.js');
const chatPage = read('pages/chat/index.js');
const chatTemplate = read('pages/chat/index.wxml');
const forwardPage = read('pages/message-forward/index.js');
const projectVerification = read('scripts/verify-project.js');
const raceVerification = read('scripts/verify-phase-25-hide-send-race.js');

check('lifecycle actions are server-authorized and alias-aware', () => {
  for (const name of [
    'hideConversation',
    'deleteMessageForMe',
    'recallMessage',
    'forwardMessage'
  ]) {
    assert(action.includes(`'${name}'`), `missing action ${name}`);
  }
  assert(
    (action.match(/resolveConversation\(/g) || []).length >= 6,
    'lifecycle actions do not resolve canonical conversations'
  );
  assert(
    !/collection\(['"]messages['"]\)[\s\S]{0,120}\.remove\(/.test(action),
    'message lifecycle physically deletes a message document'
  );
});

check('recall uses server time and strips original payload from projections', () => {
  assert(/Date\.now\(\)\s*-\s*createdAt\s*>\s*RECALL_WINDOW_MS/.test(action), 'recall window is not server-enforced');
  assert(/record\.recalled\s*===\s*true/.test(action), 'action safe projection lacks recall branch');
  assert(/record\.recalled\s*===\s*true/.test(query), 'query safe projection lacks recall branch');
  assert(/type:\s*['"]recalled['"]/.test(query), 'query does not emit neutral recalled type');
  assert(/Math\.max\(\s*0,/.test(action), 'recall unread decrement is not clamped');
});

check('delete-for-me and conversation hide are participant scoped', () => {
  assert(/deletedForParticipant\$\{slot\}At/.test(action), 'delete marker is not participant scoped');
  assert(/participant\$\{slot\}HiddenAt/.test(action), 'conversation hide marker is not participant scoped');
  assert(/isMessageDeletedFor\(record, slot\)/.test(query), 'message query does not filter by participant slot');
  assert(/isConversationHiddenFor\(record, slot\)/.test(query), 'conversation query does not filter by participant slot');
  assert(/participantAHiddenAt:\s*null/.test(action), 'new chat activity does not resurface hidden conversations');
  assert(/participantAHiddenAt:\s*null/.test(appointment), 'appointment activity does not resurface hidden conversations');
});

check('hide/send races use bounded exact-conflict retry and activity snapshots', () => {
  assert(/TRANSACTION_MAX_ATTEMPTS\s*=\s*3/.test(action), 'transaction retry bound is not three');
  assert(/DATABASE_TRANSACTION_CONFLICT/.test(action), 'explicit transaction conflict classification is missing');
  assert(/database\.startTransaction\(\)/.test(action), 'application-controlled transaction boundary is missing');
  assert(/attempt\s*>=\s*maximum\s*\|\|\s*!retryable/.test(action), 'non-conflict failures may be retried');
  assert(/conversationMatchesActivitySnapshot/.test(action), 'hide does not bind to an activity snapshot');
  assert(/participantAHiddenActivityId:\s*['"]['"]/.test(action), 'send does not clear hidden activity ids');
  assert(/HiddenActivityAt/.test(query), 'query does not project activity-bound hide state');
  assert(/expectedLastMessageId/.test(service) && /expectedLastMessageAt/.test(service), 'client service does not send the visible activity snapshot');
  assert(/hidden\.superseded/.test(messagesPage), 'messages page removes a conversation after a stale hide');
  assert(/iteration\s*<\s*120/.test(raceVerification), 'race verification does not repeat 120 times');
  for (const caseName of [
    'caseHideReadSendCommitHideCommit',
    'caseSendReadHideCommitSendCommit',
    'caseExplicitConflictRetry',
    'caseUnknownResultSameId'
  ]) {
    assert(raceVerification.includes(caseName), `missing controlled race ${caseName}`);
  }
});

check('second-round stale confirm, SDK wrapping, reconciliation and tracing are covered', () => {
  for (const caseName of [
    'caseStaleUiSnapshotDelayedConfirm',
    'caseConfirmAndSendCommitOverlap',
    'caseConflictExhaustion',
    'caseWxSdkWrapperBypass',
    'caseReadOnlyRefreshDoesNotCompete'
  ]) {
    assert(raceVerification.includes(caseName), `missing controlled race ${caseName}`);
  }
  assert(/transaction\._transaction/.test(action), 'lossy SDK commit wrapper is not bypassed');
  assert(/getMessageDeliveryStatus/.test(query), 'deterministic delivery reconciliation query is missing');
  assert(/sendActionWithReconciliation/.test(service), 'client does not perform bounded delivery reconciliation');
  assert(/createSafeTraceId/.test(action) && /logSafeTrace/.test(action), 'safe transaction tracing is missing');
  assert(
    /confirmHideConversation\(conversation\)/.test(messagesPage)
      && /expectedLastMessageId:\s*conversation\.lastMessageId/.test(messagesPage),
    'confirm dialog does not preserve the long-press activity snapshot'
  );
  assert(!/markConversationRead\(/.test(messagesPage), 'messages list refresh unexpectedly writes read state');
  assert(/requestVersion/.test(messagesPage) && /isRefreshing/.test(messagesPage), 'messages list refresh lacks overlap guards');
});

check('forward derives a new server message from an existing safe source', () => {
  assert(/currentSourceMessage\.recalled\s*===\s*true/.test(action), 'forward transaction does not revalidate recall state');
  assert(/messageData\.forwarded\s*=\s*true/.test(action), 'forwarded marker is missing');
  assert(/cloud\.downloadFile/.test(action) && /cloud\.uploadFile/.test(action), 'media forward is not a server-side copy');
  assert(/sourceConversationId/.test(forwardPage) && /targetConversationId/.test(forwardPage), 'forward picker is not wired to source and target conversations');
  assert(/createClientMessageId\(\)/.test(forwardPage), 'forward picker does not create a new idempotency key');
});

check('long-press UX exposes only supported lifecycle operations', () => {
  const deleteDialogStart = chatPage.indexOf('  confirmDeleteMessage(message) {');
  const recallActionStart = chatPage.indexOf('  async recallMessage(message) {');
  const retryConversationStart = chatPage.indexOf('  retryConversation() {');
  const deleteDialog = chatPage.slice(deleteDialogStart, recallActionStart);
  const recallAction = chatPage.slice(recallActionStart, retryConversationStart);
  assert(/bindlongpress="onConversationLongPress"/.test(read('pages/messages/index.wxml')), 'conversation long-press is missing');
  assert(/bindlongpress="onMessageLongPress"/.test(chatTemplate), 'message long-press is missing');
  assert(/canRecallMessage/.test(chatPage), 'client recall affordance ignores the two-minute window');
  assert(deleteDialogStart >= 0 && recallActionStart > deleteDialogStart, 'delete confirmation implementation is missing');
  assert(retryConversationStart > recallActionStart, 'direct recall implementation is missing');
  assert(/label:\s*['"]删除['"],\s*action:\s*['"]delete['"]/.test(chatPage), 'delete menu copy is not simplified');
  assert(/title:\s*['"]确认删除？['"]/.test(deleteDialog), 'delete confirmation title is not simplified');
  assert(!/\bcontent\s*:/.test(deleteDialog), 'delete confirmation still contains explanatory body copy');
  assert(/if\s*\(!result\.confirm\)\s*\{\s*return;/.test(deleteDialog), 'canceling delete does not stop before mutation');
  assert(!/仅从我这里删除|仅从你这里删除/.test(chatPage), 'legacy delete-for-me copy remains user-visible');
  assert(!/wx\.showModal\(/.test(recallAction), 'recall still opens a second confirmation modal');
  assert(/this\.recallMessage\(message\)/.test(chatPage), 'recall action is not dispatched directly');
  assert(/messageLifecycleActionsInFlight/.test(chatPage), 'message lifecycle actions lack duplicate-request protection');
  assert(/MessageService\.recallMessage\(/.test(recallAction), 'direct recall no longer uses the existing service boundary');
  assert(/新消息到达后会重新出现/.test(messagesPage), 'conversation hide copy omits resurface behavior');
});

check('runtime regression covers lifecycle privacy and idempotency', () => {
  for (const phrase of [
    'recall did not preserve payload',
    'delete-for-me filtering',
    'conversation hide scope',
    'forward did not create a new trusted/idempotent message'
  ]) {
    assert(projectVerification.includes(phrase), `missing runtime assertion: ${phrase}`);
  }
});

checks.forEach((item) => console.log(`PASS ${item.name} (${item.assertions} assertions)`));
console.log(
  `\nPhase 25 lifecycle verification succeeded: ${checks.length} focused gates, ${assertionCount} assertions passed.`
);
