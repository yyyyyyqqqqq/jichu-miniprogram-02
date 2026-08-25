const crypto = require('crypto');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const actionPath = path.join(root, 'cloudfunctions/messageAction/index.js');
const queryPath = path.join(root, 'cloudfunctions/messageQuery/index.js');
const originalLoad = Module._load;
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'verification',
  init() {},
  database() {
    return {
      command: {},
      collection() {
        return {};
      }
    };
  },
  getWXContext() {
    return {};
  }
};

Module._load = function loadWithCloudMock(request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return cloudMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[require.resolve(actionPath)];
delete require.cache[require.resolve(queryPath)];
const actionTest = require(actionPath).__test;
const queryTest = require(queryPath).__test;
Module._load = originalLoad;

let assertionCount = 0;

function assert(condition, message) {
  assertionCount += 1;
  if (!condition) {
    throw new Error(message);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cloneDate(value) {
  return value instanceof Date ? new Date(value.getTime()) : value;
}

function cloneState(source) {
  return {
    conversation: Object.fromEntries(
      Object.entries(source.conversation).map(([key, value]) => [
        key,
        cloneDate(value)
      ])
    ),
    messages: new Map(
      [...source.messages.entries()].map(([key, value]) => [
        key,
        Object.fromEntries(
          Object.entries(value).map(([field, fieldValue]) => [
            field,
            cloneDate(fieldValue)
          ])
        )
      ])
    )
  };
}

function transactionConflict() {
  const error = new Error('database transaction conflict');
  error.code = 'DATABASE_TRANSACTION_CONFLICT';
  return error;
}

function createOccDatabase(initialState, options = {}) {
  let shared = cloneState(initialState);
  let version = 0;
  let forcedConflicts = Number(options.forcedConflicts || 0);
  let ambiguousCommits = Number(options.ambiguousCommits || 0);
  let attempts = 0;

  return {
    snapshot() {
      return cloneState(shared);
    },
    attempts() {
      return attempts;
    },
    async startTransaction() {
      attempts += 1;
      const baseVersion = version;
      const local = cloneState(shared);
      let dirty = false;
      return {
        readConversation() {
          return local.conversation;
        },
        hasMessage(messageId) {
          return local.messages.has(messageId);
        },
        writeMessage(messageId, message) {
          local.messages.set(messageId, { ...message });
          dirty = true;
        },
        updateConversation(update) {
          local.conversation = {
            ...local.conversation,
            ...update
          };
          dirty = true;
        },
        async commit() {
          if (forcedConflicts > 0) {
            forcedConflicts -= 1;
            throw transactionConflict();
          }
          if (dirty && baseVersion !== version) {
            throw transactionConflict();
          }
          if (dirty) {
            shared = cloneState(local);
            version += 1;
          }
          if (ambiguousCommits > 0) {
            ambiguousCommits -= 1;
            const error = new Error('commit response unavailable');
            error.code = 'NETWORK_ERROR';
            throw error;
          }
        },
        async rollback() {}
      };
    }
  };
}

function createInitialState() {
  return {
    conversation: {
      lastMessageId: `m_${'a'.repeat(64)}`,
      lastMessageAt: new Date('2026-08-21T12:00:00.000Z'),
      participantAUnreadCount: 0,
      participantAHiddenAt: null,
      participantAHiddenActivityId: '',
      participantAHiddenActivityAt: null
    },
    messages: new Map()
  };
}

function createMessageId(clientMessageId) {
  return `m_${crypto.createHash('sha256').update(clientMessageId).digest('hex')}`;
}

async function send(database, clientMessageId, hooks = {}) {
  const messageId = createMessageId(clientMessageId);
  let firstRead = true;
  return actionTest.runTransaction(async (transaction) => {
    const conversation = transaction.readConversation();
    if (transaction.hasMessage(messageId)) {
      return { messageId, reused: true };
    }
    if (firstRead && hooks.afterFirstRead) {
      firstRead = false;
      await hooks.afterFirstRead();
    }
    const createdAt = new Date(conversation.lastMessageAt.getTime() + 1000);
    transaction.writeMessage(messageId, { messageId, createdAt });
    transaction.updateConversation({
      lastMessageId: messageId,
      lastMessageAt: createdAt,
      participantAUnreadCount: conversation.participantAUnreadCount + 1,
      participantAHiddenAt: null,
      participantAHiddenActivityId: '',
      participantAHiddenActivityAt: null
    });
    return { messageId, reused: false };
  }, { database });
}

async function hide(database, expectedActivity, hooks = {}) {
  let firstRead = true;
  return actionTest.runTransaction(async (transaction) => {
    const conversation = transaction.readConversation();
    if (firstRead && hooks.afterFirstRead) {
      firstRead = false;
      await hooks.afterFirstRead();
    }
    if (!actionTest.conversationMatchesActivitySnapshot(
      conversation,
      expectedActivity
    )) {
      return { superseded: true };
    }
    transaction.updateConversation({
      participantAHiddenAt: new Date('2026-08-21T12:00:05.000Z'),
      participantAHiddenActivityId: expectedActivity.lastMessageId,
      participantAHiddenActivityAt: expectedActivity.lastMessageAt,
      participantAUnreadCount: 0
    });
    return { superseded: false };
  }, { database });
}

function assertFinalState(database, messageId, label) {
  const state = database.snapshot();
  assert(state.messages.size === 1, `${label}: canonical message count is not one`);
  assert(state.messages.has(messageId), `${label}: deterministic message is missing`);
  assert(
    state.conversation.lastMessageId === messageId,
    `${label}: latest message id is stale`
  );
  assert(
    state.conversation.participantAUnreadCount === 1,
    `${label}: recipient unread count is not one`
  );
  assert(
    !queryTest.isConversationHiddenFor(state.conversation, 'A'),
    `${label}: recipient conversation remained hidden`
  );
}

async function caseHideReadSendCommitHideCommit(suffix) {
  const database = createOccDatabase(createInitialState());
  const expected = actionTest.getConversationActivitySnapshot(
    database.snapshot().conversation
  );
  const hideRead = deferred();
  const releaseHide = deferred();
  const hidden = hide(database, expected, {
    async afterFirstRead() {
      hideRead.resolve();
      await releaseHide.promise;
    }
  });
  await hideRead.promise;
  const clientId = `case_a_${suffix}`;
  const sent = await send(database, clientId);
  releaseHide.resolve();
  const hideResult = await hidden;
  assert(sent.reused === false, 'case A: send unexpectedly reused a message');
  assert(hideResult.superseded === true, 'case A: stale hide was not superseded');
  assertFinalState(database, createMessageId(clientId), 'case A');
}

async function caseSendReadHideCommitSendCommit(suffix) {
  const database = createOccDatabase(createInitialState());
  const expected = actionTest.getConversationActivitySnapshot(
    database.snapshot().conversation
  );
  const sendRead = deferred();
  const releaseSend = deferred();
  const clientId = `case_b_${suffix}`;
  const sending = send(database, clientId, {
    async afterFirstRead() {
      sendRead.resolve();
      await releaseSend.promise;
    }
  });
  await sendRead.promise;
  const hideResult = await hide(database, expected);
  releaseSend.resolve();
  const sent = await sending;
  assert(hideResult.superseded === false, 'case B: current hide was rejected');
  assert(sent.reused === false, 'case B: send unexpectedly reused a message');
  assertFinalState(database, createMessageId(clientId), 'case B');
}

async function caseExplicitConflictRetry() {
  const database = createOccDatabase(createInitialState(), {
    forcedConflicts: 1
  });
  const clientId = 'case_c_conflict_retry';
  const sent = await send(database, clientId);
  assert(sent.reused === false, 'case C: retry did not return send success');
  assert(database.attempts() === 2, 'case C: conflict did not retry exactly once');
  assertFinalState(database, createMessageId(clientId), 'case C');
}

async function caseStaleUiSnapshotDelayedConfirm() {
  const database = createOccDatabase(createInitialState());
  const frozenAtLongPress = actionTest.getConversationActivitySnapshot(
    database.snapshot().conversation
  );
  const clientId = 'case_e_delayed_confirm';
  const sent = await send(database, clientId);
  const hidden = await hide(database, frozenAtLongPress);
  assert(sent.reused === false, 'case E: send did not succeed');
  assert(hidden.superseded === true, 'case E: delayed stale confirm was not superseded');
  assertFinalState(database, createMessageId(clientId), 'case E');
}

async function caseConfirmAndSendCommitOverlap() {
  await caseHideReadSendCommitHideCommit('case_f_overlap');
}

async function caseConflictExhaustion() {
  const database = createOccDatabase(createInitialState(), {
    forcedConflicts: 3
  });
  let finalError = null;
  try {
    await send(database, 'case_conflict_exhaustion');
  } catch (error) {
    finalError = error;
  }
  assert(
    finalError && finalError.code === 'DATABASE_TRANSACTION_CONFLICT',
    'conflict exhaustion lost the original safe error code'
  );
  assert(database.attempts() === 3, 'conflict exhaustion did not stop at three attempts');
  assert(
    database.snapshot().messages.size === 0,
    'conflict exhaustion left a partial message write'
  );
}

async function caseWxSdkWrapperBypass() {
  let rawCommitCalls = 0;
  let wrappedCommitCalls = 0;
  let transactionCreations = 0;
  const database = {
    async startTransaction() {
      transactionCreations += 1;
      const shouldConflict = transactionCreations === 1;
      const raw = {
        async commit() {
          rawCommitCalls += 1;
          if (shouldConflict) {
            throw transactionConflict();
          }
        },
        async rollback() {}
      };
      return {
        _transaction: raw,
        async commit() {
          wrappedCommitCalls += 1;
          const error = new Error('transaction.commit:fail undefined . ');
          error.errCode = -1;
          throw error;
        },
        async rollback() {}
      };
    }
  };
  const result = await actionTest.runTransaction(async () => 'success', {
    database
  });
  assert(result === 'success', 'raw conflict retry did not succeed');
  assert(transactionCreations === 2, 'raw conflict did not create a fresh transaction');
  assert(rawCommitCalls === 2, 'raw commit was not used for every attempt');
  assert(wrappedCommitCalls === 0, 'lossy wx SDK commit wrapper was still used');
}

async function caseReadOnlyRefreshDoesNotCompete() {
  const database = createOccDatabase(createInitialState());
  const beforeAttempts = database.attempts();
  const refreshed = database.snapshot();
  const clientId = 'case_refresh_send';
  await send(database, clientId);
  assert(
    refreshed.conversation.lastMessageId === `m_${'a'.repeat(64)}`,
    'read-only refresh did not return its own snapshot'
  );
  assert(
    database.attempts() === beforeAttempts + 1,
    'read-only list refresh participated in transaction writes'
  );
  assertFinalState(database, createMessageId(clientId), 'refresh/send');
}

async function caseUnknownResultSameId() {
  const database = createOccDatabase(createInitialState(), {
    ambiguousCommits: 1
  });
  const clientId = 'case_d_unknown_result';
  let failed = false;
  try {
    await send(database, clientId);
  } catch (error) {
    failed = error && error.code === 'NETWORK_ERROR';
  }
  assert(failed, 'case D: ambiguous first result was not surfaced');
  const repeated = await send(database, clientId);
  assert(repeated.reused === true, 'case D: same client id was not reused');
  assertFinalState(database, createMessageId(clientId), 'case D');
}

async function verifyRetryBoundary() {
  let attempts = 0;
  const database = {
    async startTransaction() {
      attempts += 1;
      return {
        async commit() {
          throw new Error('collection temporarily unavailable');
        },
        async rollback() {}
      };
    }
  };
  let failed = false;
  try {
    await actionTest.runTransaction(async () => 'never', { database });
  } catch (error) {
    failed = error.message === 'collection temporarily unavailable';
  }
  assert(failed, 'non-conflict error was not preserved');
  assert(attempts === 1, 'non-conflict error was retried');
  assert(
    actionTest.transactionMaxAttempts === 3,
    'transaction retry bound is not three attempts'
  );
}

async function main() {
  await caseHideReadSendCommitHideCommit('controlled');
  await caseSendReadHideCommitSendCommit('controlled');
  await caseExplicitConflictRetry();
  await caseStaleUiSnapshotDelayedConfirm();
  await caseConfirmAndSendCommitOverlap();
  await caseConflictExhaustion();
  await caseWxSdkWrapperBypass();
  await caseUnknownResultSameId();
  await caseReadOnlyRefreshDoesNotCompete();
  await verifyRetryBoundary();
  for (let iteration = 0; iteration < 120; iteration += 1) {
    if (iteration % 2 === 0) {
      await caseHideReadSendCommitHideCommit(`repeat_${iteration}`);
    } else {
      await caseSendReadHideCommitSendCommit(`repeat_${iteration}`);
    }
  }
  console.log(
    `PASS hide/send race: cases A-F, exhaustion/result-unknown/refresh, plus 120 repeated interleavings (${assertionCount} assertions)`
  );
}

main().catch((error) => {
  console.error(`FAIL hide/send race: ${error.message}`);
  process.exitCode = 1;
});
