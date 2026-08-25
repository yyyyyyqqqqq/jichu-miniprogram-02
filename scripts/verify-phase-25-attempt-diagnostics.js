const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const actionPath = path.join(root, 'cloudfunctions/messageAction/index.js');
const queryPath = path.join(root, 'cloudfunctions/messageQuery/index.js');
const servicePath = path.join(root, 'services/message-service.js');
const cloudServicePath = path.join(root, 'services/cloud-service.js');
const cloudConfigPath = path.join(root, 'config/cloud.js');
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

delete require.cache[require.resolve(servicePath)];
const MessageService = require(servicePath);
const CloudService = require(cloudServicePath);
const { CLOUD_CONFIG } = require(cloudConfigPath);

let assertionCount = 0;

function assert(condition, message) {
  assertionCount += 1;
  if (!condition) {
    throw new Error(message);
  }
}

function codedError(code, message = 'redacted failure') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createCommitDatabase(commitFailures) {
  let attempt = 0;
  return {
    async startTransaction() {
      const failure = commitFailures[attempt];
      attempt += 1;
      return {
        async commit() {
          if (failure) {
            throw failure;
          }
        },
        async rollback() {}
      };
    }
  };
}

async function runWithCollector(database, callback = async () => 'ok') {
  const collector = actionTest.createAttemptDiagnosticCollector(
    'tr_diagnostics1',
    'sendMessage',
    true
  );
  let result;
  let error;
  try {
    result = await actionTest.runTransaction(callback, {
      database,
      onEvent: collector.onEvent
    });
  } catch (caught) {
    error = caught;
  }
  return {
    result,
    error,
    diagnostic: collector.toDiagnostic()
  };
}

async function verifyConflictRetrySuccess() {
  const result = await runWithCollector(createCommitDatabase([
    codedError('DATABASE_TRANSACTION_CONFLICT'),
    null
  ]));
  assert(result.result === 'ok', 'conflict retry did not succeed');
  assert(result.diagnostic.attemptCount === 2, 'retry attempt count is not two');
  assert(
    result.diagnostic.attempts[0].commitOutcome === 'conflict'
      && result.diagnostic.attempts[0].retryable === true,
    'first conflict attempt was not recorded'
  );
  assert(
    result.diagnostic.attempts[1].commitOutcome === 'committed',
    'second committed attempt was not recorded'
  );
}

async function verifyConflictExhaustion() {
  const result = await runWithCollector(createCommitDatabase([
    codedError('DATABASE_TRANSACTION_CONFLICT'),
    codedError('DATABASE_TRANSACTION_CONFLICT'),
    codedError('DATABASE_TRANSACTION_CONFLICT')
  ]));
  assert(Boolean(result.error), 'three conflicts did not fail');
  assert(result.diagnostic.attemptCount === 3, 'three conflicts were not recorded');
  assert(
    result.diagnostic.attempts.every((attempt) => (
      attempt.safeCode === 'DATABASE_TRANSACTION_CONFLICT'
      && attempt.retryable === true
      && attempt.commitOutcome === 'conflict'
    )),
    'conflict exhaustion diagnostic is incomplete'
  );
}

async function verifyNonConflictFailure() {
  const result = await runWithCollector(
    createCommitDatabase([]),
    async () => {
      throw codedError(
        'DATABASE_REQUEST_FAILED',
        'OPENID_secret c_aaaaaaaa message-body cloud://file 31.2,121.4'
      );
    }
  );
  assert(Boolean(result.error), 'non-conflict database failure did not fail');
  const attempt = result.diagnostic.attempts[0];
  assert(attempt.safeCode === 'DATABASE_ERROR', 'database error was not whitelisted');
  assert(attempt.retryable === false, 'database error was marked retryable');
  assert(attempt.commitOutcome === 'rolled_back', 'rollback was not recorded');
}

async function verifyUnknownCommitOutcome() {
  const result = await runWithCollector(createCommitDatabase([
    codedError('NETWORK_ERROR')
  ]));
  const attempt = result.diagnostic.attempts[0];
  assert(attempt.safeCode === 'NETWORK_ERROR', 'network code was not whitelisted');
  assert(attempt.commitStarted === true, 'commit start was not recorded');
  assert(
    attempt.commitOutcome === 'outcome_unknown',
    'ambiguous commit was assigned a guessed outcome'
  );
}

function sampleDiagnostic() {
  return {
    traceId: 'tr_diagnostics1',
    action: 'sendMessage',
    attemptCount: 1,
    attempts: [{
      attempt: 1,
      safeCode: 'DATABASE_ERROR',
      retryable: false,
      transactionCreated: true,
      commitStarted: false,
      commitOutcome: 'rolled_back',
      lastCompletedStage: 'existing_message_check',
      failedStage: 'message_write'
    }],
    reconciliation: {
      attempted: false,
      outcome: 'not_applicable'
    }
  };
}

async function verifyStageDiagnostics() {
  const collector = actionTest.createAttemptDiagnosticCollector(
    'tr_diagnostics1',
    'sendTextMessage',
    true
  );
  const database = createCommitDatabase([]);
  let error;
  try {
    await actionTest.runTransaction(async () => {
      actionTest.beginAttemptStage(
        { attemptDiagnostic: collector },
        'canonical_resolve'
      );
      actionTest.completeAttemptStage(
        { attemptDiagnostic: collector },
        'canonical_resolve'
      );
      actionTest.beginAttemptStage(
        { attemptDiagnostic: collector },
        'existing_message_check'
      );
      actionTest.completeAttemptStage(
        { attemptDiagnostic: collector },
        'existing_message_check'
      );
      actionTest.beginAttemptStage(
        { attemptDiagnostic: collector },
        'message_write'
      );
      const wrappedDatabaseError = new Error('raw message must not escape');
      wrappedDatabaseError.errCode = -502001;
      throw wrappedDatabaseError;
    }, {
      database,
      onEvent: collector.onEvent
    });
  } catch (caught) {
    error = caught;
  }
  assert(Boolean(error), 'injected stage failure did not fail');
  const attempt = collector.toDiagnostic().attempts[0];
  assert(
    attempt.lastCompletedStage === 'existing_message_check',
    'last completed stage was not retained'
  );
  assert(attempt.failedStage === 'message_write', 'failed stage was not retained');
  assert(
    attempt.safeCode === 'DATABASE_ERROR',
    'documented SDK database errCode was not safely categorized'
  );
  assert(
    actionTest.getWhitelistedDiagnosticCode({ errCode: -501002 })
      === 'CLOUD_TIMEOUT',
    'documented SDK timeout errCode was not safely categorized'
  );
  assert(
    actionTest.getWhitelistedDiagnosticCode({ errCode: -501001 })
      === 'INTERNAL_ERROR',
    'documented SDK system errCode was not safely categorized'
  );
  assert(
    actionTest.safeAttemptStages.has('context_product_read')
      && actionTest.safeAttemptStages.has('conversation_update_prepare')
      && actionTest.safeAttemptStages.has('conversation_update_write')
      && !actionTest.safeAttemptStages.has('raw_stage_name'),
    'attempt stage whitelist is incomplete or open-ended'
  );
  const normalized = MessageService.normalizeAttemptDiagnostic(sampleDiagnostic());
  assert(
    normalized.attempts[0].failedStage === 'message_write',
    'client stripped a valid stage'
  );
  const invalid = sampleDiagnostic();
  invalid.attempts[0].failedStage = 'raw_stage_name';
  assert(
    MessageService.normalizeAttemptDiagnostic(invalid) === undefined,
    'client accepted a non-whitelisted stage'
  );
  const hideCollector = actionTest.createAttemptDiagnosticCollector(
    'tr_diagnostics1',
    'hideConversation',
    true
  );
  hideCollector.onEvent('attempt_start', { attempt: 1 });
  hideCollector.onEvent('transaction_created', { attempt: 1 });
  hideCollector.onEvent('attempt_end', {
    attempt: 1,
    safeCode: 'DATABASE_ERROR',
    retryable: false
  });
  const hideAttempt = hideCollector.toDiagnostic().attempts[0];
  assert(
    !Object.prototype.hasOwnProperty.call(hideAttempt, 'failedStage'),
    'send-only stage diagnostic leaked a misleading hide stage'
  );
}

function verifyConversationUpdateStageSplit() {
  const source = fs.readFileSync(actionPath, 'utf8');
  const prepareBegin = source.indexOf(
    "beginAttemptStage(trace, 'conversation_update_prepare')"
  );
  const updateDataStart = source.indexOf('const updateData = {', prepareBegin);
  const prepareComplete = source.indexOf(
    "completeAttemptStage(trace, 'conversation_update_prepare')",
    updateDataStart
  );
  const writeBegin = source.indexOf(
    "beginAttemptStage(trace, 'conversation_update_write')",
    prepareComplete
  );
  const documentUpdate = source.indexOf(
    'await conversationDocument.update({',
    writeBegin
  );
  const writeComplete = source.indexOf(
    "completeAttemptStage(trace, 'conversation_update_write')",
    documentUpdate
  );
  assert(
    prepareBegin < updateDataStart
      && updateDataStart < prepareComplete
      && prepareComplete < writeBegin
      && writeBegin < documentUpdate
      && documentUpdate < writeComplete,
    'conversation update prepare/write stage order is incorrect'
  );
  const prepareSource = source.slice(updateDataStart, prepareComplete);
  assert(
    (prepareSource.match(/db\.serverDate\(\)/g) || []).length === 2,
    'conversation update prepare changed its server-date payload'
  );
  assert(
    !/db\.command|\.inc\(|\.push\(|\.remove\(/.test(prepareSource),
    'conversation update prepare introduced a dynamic database command'
  );
  const collector = actionTest.createAttemptDiagnosticCollector(
    'tr_diagnostics1',
    'sendTextMessage',
    true
  );
  collector.onEvent('attempt_start', { attempt: 1 });
  collector.onEvent('transaction_created', { attempt: 1 });
  actionTest.beginAttemptStage(
    { attemptDiagnostic: collector },
    'message_write'
  );
  actionTest.completeAttemptStage(
    { attemptDiagnostic: collector },
    'message_write'
  );
  actionTest.beginAttemptStage(
    { attemptDiagnostic: collector },
    'conversation_update_prepare'
  );
  actionTest.completeAttemptStage(
    { attemptDiagnostic: collector },
    'conversation_update_prepare'
  );
  actionTest.beginAttemptStage(
    { attemptDiagnostic: collector },
    'conversation_update_write'
  );
  collector.onEvent('transaction_error', {
    attempt: 1,
    safeCode: 'INTERNAL_ERROR',
    retryable: false
  });
  collector.onEvent('attempt_end', {
    attempt: 1,
    safeCode: 'INTERNAL_ERROR',
    retryable: false
  });
  const attempt = collector.toDiagnostic().attempts[0];
  assert(
    attempt.lastCompletedStage === 'conversation_update_prepare',
    'write failure did not retain completed prepare stage'
  );
  assert(
    attempt.failedStage === 'conversation_update_write',
    'write failure did not identify document.update stage'
  );
  assert(
    attempt.safeCode === 'INTERNAL_ERROR' && attempt.retryable === false,
    'stage split changed INTERNAL_ERROR retry classification'
  );
}

function verifyReconciliationOutcomes() {
  for (const outcome of ['found', 'not_found', 'query_failed']) {
    const diagnostic = MessageService.withReconciliationOutcome(
      sampleDiagnostic(),
      outcome
    );
    assert(diagnostic.reconciliation.attempted === true, `${outcome} was not attempted`);
    assert(diagnostic.reconciliation.outcome === outcome, `${outcome} was not retained`);
  }
}

async function verifyReconciliationPipeline() {
  const originalCallFunction = CloudService.callFunction;
  const conversationId = `c_${'a'.repeat(64)}`;
  const traceId = 'tr_diagnostics1';
  const safeMessage = {
    messageId: `m_${'b'.repeat(64)}`,
    senderPublicUserId: `u_${'c'.repeat(32)}`,
    isMine: true,
    type: 'text',
    content: 'reconciled',
    createdAt: '2026-08-21T14:00:00.000Z'
  };
  const actionFailure = {
    success: false,
    code: 'DATABASE_ERROR',
    message: '消息数据暂不可用，请稍后重试',
    data: null,
    traceId,
    diagnostic: sampleDiagnostic()
  };
  const runScenario = async (outcome) => {
    CloudService.callFunction = async (options) => {
      if (options.data.action !== 'getMessageDeliveryStatus') {
        return { result: actionFailure };
      }
      if (outcome === 'query_failed') {
        throw codedError('NETWORK_ERROR');
      }
      return {
        result: {
          success: true,
          code: 'OK',
          message: '',
          data: outcome === 'found'
            ? { found: true, message: safeMessage }
            : { found: false }
        }
      };
    };
    try {
      const response = await MessageService.sendTextMessage({
        conversationId,
        clientMessageId: `client_${outcome}`,
        content: 'probe',
        traceId
      });
      return { response };
    } catch (error) {
      return { error };
    }
  };
  try {
    const found = await runScenario('found');
    assert(
      found.response && found.response.reconciled === true,
      'found reconciliation did not preserve success decision'
    );
    const notFound = await runScenario('not_found');
    assert(Boolean(notFound.error), 'not_found reconciliation swallowed failure');
    assert(
      notFound.error.diagnostic.reconciliation.outcome === 'not_found',
      'not_found pipeline outcome was not attached'
    );
    const queryFailed = await runScenario('query_failed');
    assert(Boolean(queryFailed.error), 'query_failed reconciliation swallowed failure');
    assert(
      queryFailed.error.diagnostic.reconciliation.outcome === 'query_failed',
      'query_failed pipeline outcome was not attached'
    );
  } finally {
    CloudService.callFunction = originalCallFunction;
  }
}

function verifyEnvironmentGates() {
  const originalRole = process.env.JICHU_ENVIRONMENT_ROLE;
  const originalName = CLOUD_CONFIG.environmentName;
  const originalValidation = CLOUD_CONFIG.environmentValidationError;
  try {
    process.env.JICHU_ENVIRONMENT_ROLE = 'staging';
    const collector = actionTest.createAttemptDiagnosticCollector(
      'tr_diagnostics1',
      'sendMessage'
    );
    collector.onEvent('attempt_start', { attempt: 1 });
    collector.onEvent('attempt_end', {
      attempt: 1,
      safeCode: 'DATABASE_ERROR',
      retryable: false
    });
    const stagingResponse = actionTest.appendAttemptDiagnostic(
      { success: false },
      { attemptDiagnostic: collector }
    );
    assert(Boolean(stagingResponse.diagnostic), 'staging failure omitted diagnostic');

    process.env.JICHU_ENVIRONMENT_ROLE = 'production';
    const productionCollector = actionTest.createAttemptDiagnosticCollector(
      'tr_diagnostics1',
      'sendMessage'
    );
    const productionResponse = actionTest.appendAttemptDiagnostic(
      { success: false },
      { attemptDiagnostic: productionCollector }
    );
    assert(
      !Object.prototype.hasOwnProperty.call(productionResponse, 'diagnostic'),
      'production failure returned diagnostic'
    );
    assert(
      !Object.prototype.hasOwnProperty.call(
        queryTest.appendReconciliationDiagnostic(
          { success: false },
          'tr_diagnostics1',
          'query_failed'
        ),
        'diagnostic'
      ),
      'production reconciliation returned diagnostic'
    );

    for (const role of [undefined, 'unknown']) {
      if (role === undefined) {
        delete process.env.JICHU_ENVIRONMENT_ROLE;
      } else {
        process.env.JICHU_ENVIRONMENT_ROLE = role;
      }
      assert(
        actionTest.isAttemptDiagnosticEnabled() === false,
        `${role || 'unset'} action role enabled diagnostic`
      );
      assert(
        queryTest.isAttemptDiagnosticEnabled() === false,
        `${role || 'unset'} query role enabled diagnostic`
      );
      assert(
        !Object.prototype.hasOwnProperty.call(
          actionTest.appendAttemptDiagnostic(
            { success: false },
            { attemptDiagnostic: productionCollector }
          ),
          'diagnostic'
        ),
        `${role || 'unset'} action response returned diagnostic`
      );
    }

    process.env.JICHU_ENVIRONMENT_ROLE = 'development';
    assert(
      Boolean(queryTest.appendReconciliationDiagnostic(
        { success: false },
        'tr_diagnostics1',
        'query_failed'
      ).diagnostic),
      'development reconciliation omitted diagnostic'
    );

    CLOUD_CONFIG.environmentName = 'production';
    CLOUD_CONFIG.environmentValidationError = '';
    assert(
      MessageService.normalizeAttemptDiagnostic(sampleDiagnostic()) === undefined,
      'production client accepted diagnostic'
    );
    assert(
      MessageService.formatAttemptDiagnostic(sampleDiagnostic()) === '',
      'production client could render diagnostic viewer content'
    );
    CLOUD_CONFIG.environmentName = 'unknown';
    assert(
      MessageService.normalizeAttemptDiagnostic(sampleDiagnostic()) === undefined,
      'unknown client role accepted diagnostic'
    );
    CLOUD_CONFIG.environmentName = 'staging';
    assert(
      Boolean(MessageService.normalizeAttemptDiagnostic(sampleDiagnostic())),
      'staging client rejected safe diagnostic'
    );
  } finally {
    if (originalRole === undefined) {
      delete process.env.JICHU_ENVIRONMENT_ROLE;
    } else {
      process.env.JICHU_ENVIRONMENT_ROLE = originalRole;
    }
    CLOUD_CONFIG.environmentName = originalName;
    CLOUD_CONFIG.environmentValidationError = originalValidation;
  }
}

async function verifySensitiveScan() {
  const result = await runWithCollector(
    createCommitDatabase([]),
    async () => {
      const error = codedError(
        'DATABASE_REQUEST_FAILED',
        'OPENID_sensitive c_deadbeef m_deadbeef msg_secret cloud://secret '
          + 'nickname avatar address latitude longitude content fileID'
      );
      error.stack = 'STACK_SECRET';
      error.raw = { content: 'RAW_SECRET' };
      throw error;
    }
  );
  const serialized = JSON.stringify(result.diagnostic);
  for (const forbidden of [
    'OPENID_sensitive',
    'c_deadbeef',
    'm_deadbeef',
    'msg_secret',
    'cloud://secret',
    'nickname',
    'avatar',
    'address',
    'latitude',
    'longitude',
    'content',
    'fileID',
    'STACK_SECRET',
    'RAW_SECRET'
  ]) {
    assert(!serialized.includes(forbidden), `diagnostic leaked ${forbidden}`);
  }
}

async function main() {
  const originalName = CLOUD_CONFIG.environmentName;
  const originalValidation = CLOUD_CONFIG.environmentValidationError;
  try {
    // Diagnostic DTO behavior is intentionally a staging-only contract. Keep
    // these unit scenarios independent from the developer's active target;
    // verifyEnvironmentGates still exercises production/unknown fail-closed.
    CLOUD_CONFIG.environmentName = 'staging';
    CLOUD_CONFIG.environmentValidationError = '';
    await verifyConflictRetrySuccess();
    await verifyConflictExhaustion();
    await verifyNonConflictFailure();
    await verifyUnknownCommitOutcome();
    await verifyStageDiagnostics();
    verifyConversationUpdateStageSplit();
    verifyReconciliationOutcomes();
    await verifyReconciliationPipeline();
    verifyEnvironmentGates();
    await verifySensitiveScan();
  } finally {
    CLOUD_CONFIG.environmentName = originalName;
    CLOUD_CONFIG.environmentValidationError = originalValidation;
  }
  console.log(
    `PASS attempt diagnostics: retries, commit outcomes, reconciliation, environment gates and redaction (${assertionCount} assertions)`
  );
}

main().catch((error) => {
  console.error(`FAIL attempt diagnostics: ${error.message}`);
  process.exitCode = 1;
});
