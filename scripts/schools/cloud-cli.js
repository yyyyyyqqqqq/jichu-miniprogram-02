const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  ROOT
} = require('./core');

const CLI_PACKAGE = '@cloudbase/cli@3.6.3';
const COLLECTION = 'schools';
const MAX_COMMANDS_PER_REQUEST = 1;
const QUERY_PAGE_SIZE = 1000;

function loadEnvironmentId() {
  const privateConfigPath = path.join(ROOT, 'config', 'cloud.private.js');
  let privateConfig;
  try {
    privateConfig = require(privateConfigPath);
  } catch (error) {
    const wrapped = new Error('private cloud environment configuration is unavailable');
    wrapped.code = 'TARGET_ENV_UNCONFIRMED';
    throw wrapped;
  }
  const environmentId = typeof privateConfig.environmentId === 'string'
    ? privateConfig.environmentId.trim()
    : '';
  if (!environmentId || environmentId === 'YOUR_CLOUDBASE_ENV_ID') {
    const error = new Error('target cloud environment is not explicitly configured');
    error.code = 'TARGET_ENV_UNCONFIRMED';
    throw error;
  }
  return environmentId;
}

function parseJsonOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (error) {
      // Continue looking for the final JSON line.
    }
  }
  const start = String(stdout || '').indexOf('{');
  const end = String(stdout || '').lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(String(stdout).slice(start, end + 1));
  }
  throw new Error('CloudBase CLI did not return JSON');
}

function runCloudBase(args, options = {}) {
  const explicitCliBin = typeof process.env.SCHOOL_CLOUDBASE_CLI_BIN === 'string'
    ? process.env.SCHOOL_CLOUDBASE_CLI_BIN.trim()
    : '';
  const windowsNpxCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npx-cli.js'
  );
  const useExplicitCli = explicitCliBin && fs.existsSync(explicitCliBin);
  const useNodeNpxCli = !useExplicitCli
    && process.platform === 'win32'
    && fs.existsSync(windowsNpxCli);
  const executable = useExplicitCli || useNodeNpxCli ? process.execPath : 'npx';
  const prefix = useExplicitCli
    ? [explicitCliBin]
    : useNodeNpxCli
      ? [windowsNpxCli]
      : [];
  const result = spawnSync(executable, [
    ...prefix,
    ...(useExplicitCli ? [] : ['-y', '-p', CLI_PACKAGE, 'cloudbase']),
    ...args
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs || 120000,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim();
    const error = new Error(details || 'CloudBase CLI failed');
    error.code = 'CLOUD_CLI_FAILED';
    error.status = result.status;
    throw error;
  }
  return options.json === false ? result.stdout : parseJsonOutput(result.stdout);
}

function maskEnvironmentId(environmentId) {
  if (environmentId.length <= 8) {
    return `${environmentId.slice(0, 2)}***`;
  }
  return `${environmentId.slice(0, 6)}***${environmentId.slice(-4)}`;
}

function runNoSql(environmentId, commands) {
  return runCloudBase([
    'db',
    'nosql',
    'execute',
    '--env-id',
    environmentId,
    '--json',
    '--command',
    JSON.stringify(commands)
  ], { timeoutMs: 180000 });
}

function buildFindCommand(skip, limit = QUERY_PAGE_SIZE) {
  return {
    TableName: COLLECTION,
    CommandType: 'QUERY',
    Command: JSON.stringify({
      find: COLLECTION,
      filter: {},
      projection: {
        _id: 1,
        officialCode: 1,
        name: 1,
        nameNormalized: 1,
        province: 1,
        city: 1,
        educationLevel: 1,
        authority: 1,
        officialStatus: 1,
        platformStatus: 1,
        dataSource: 1,
        sourceYear: 1,
        sourceVersion: 1,
        sourceRow: 1,
        note: 1,
        remark: 1,
        platformStatusPrevious: 1,
        platformStatusReason: 1,
        platformStatusOperationId: 1,
        platformStatusToolVersion: 1,
        platformStatusUpdatedAt: 1,
        activatedAt: 1,
        createdAt: 1,
        updatedAt: 1,
        lastSeenAt: 1
      },
      sort: { _id: 1 },
      skip,
      limit
    })
  };
}

function extractCommandResults(response) {
  const root = response && (response.data || response.Response || response);
  const candidates = [
    root && root.Data,
    root && root.Result,
    root && root.Results,
    root && root.results,
    root && root.CommandResults,
    root && root.Items
  ].find(Array.isArray);
  return candidates || [];
}

function extractDocuments(result) {
  if (!result) {
    return [];
  }
  const value = typeof result === 'string' ? (() => {
    try {
      return JSON.parse(result);
    } catch (error) {
      return null;
    }
  })() : result;
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(decodeExtendedJson);
  }
  const cursor = value.cursor || value.Cursor || value.result && value.result.cursor;
  const batch = cursor && (cursor.firstBatch || cursor.nextBatch);
  if (Array.isArray(batch)) {
    return batch.map(decodeExtendedJson);
  }
  for (const key of ['documents', 'Documents', 'data', 'Data', 'items', 'Items']) {
    if (Array.isArray(value[key])) {
      return value[key].map(decodeExtendedJson);
    }
  }
  return [];
}

function decodeExtendedJson(value) {
  if (Array.isArray(value)) {
    return value.map(decodeExtendedJson);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Object.prototype.hasOwnProperty.call(value, '$numberInt')) {
    return Number(value.$numberInt);
  }
  if (Object.prototype.hasOwnProperty.call(value, '$numberLong')) {
    const number = Number(value.$numberLong);
    return Number.isSafeInteger(number) ? number : String(value.$numberLong);
  }
  if (Object.prototype.hasOwnProperty.call(value, '$numberDouble')) {
    return Number(value.$numberDouble);
  }
  if (Object.prototype.hasOwnProperty.call(value, '$date')) {
    const raw = decodeExtendedJson(value.$date);
    const date = new Date(Number(raw));
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decodeExtendedJson(item)])
  );
}

function readAllSchools(environmentId, maximum = 10000) {
  const records = [];
  for (let offset = 0; offset < maximum; offset += QUERY_PAGE_SIZE * MAX_COMMANDS_PER_REQUEST) {
    const commands = [];
    for (let index = 0; index < MAX_COMMANDS_PER_REQUEST; index += 1) {
      commands.push(buildFindCommand(offset + index * QUERY_PAGE_SIZE));
    }
    const response = runNoSql(environmentId, commands);
    const results = extractCommandResults(response);
    if (results.length === 0) {
      const direct = extractDocuments(response);
      if (direct.length === 0) {
        break;
      }
      records.push(...direct);
      if (direct.length < QUERY_PAGE_SIZE) {
        break;
      }
      continue;
    }
    let batchCount = 0;
    results.forEach((result) => {
      const documents = extractDocuments(result);
      batchCount += documents.length;
      records.push(...documents);
    });
    if (batchCount < QUERY_PAGE_SIZE * MAX_COMMANDS_PER_REQUEST) {
      break;
    }
  }
  if (records.length >= maximum) {
    const error = new Error(`schools query reached safety limit ${maximum}`);
    error.code = 'IMPORT_READ_LIMIT';
    throw error;
  }
  return records;
}

function buildInsertDocuments(records) {
  return records.map((record) => ({
    ...record,
    platformStatus: 'pending'
  }));
}

function buildOfficialUpdate(record) {
  return {
    name: record.name,
    nameNormalized: record.nameNormalized,
    province: record.province,
    city: record.city,
    educationLevel: record.educationLevel,
    authority: record.authority,
    officialStatus: record.officialStatus,
    dataSource: record.dataSource,
    sourceYear: record.sourceYear,
    sourceVersion: record.sourceVersion,
    sourceRow: record.sourceRow,
    remark: record.remark
  };
}

function buildPlatformStatusUpdateCommand(changes, operation) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 2) {
    const error = new Error('platform status update requires one or two explicit schools');
    error.code = 'STATUS_BATCH_LIMIT';
    throw error;
  }
  return {
    TableName: COLLECTION,
    CommandType: 'UPDATE',
    Command: JSON.stringify({
      update: COLLECTION,
      updates: changes.map((change) => ({
        q: {
          _id: change.schoolId,
          officialCode: change.officialCode,
          officialStatus: change.officialStatus,
          platformStatus: change.fromStatus
        },
        u: {
          $set: {
            platformStatus: operation.status,
            platformStatusPrevious: change.fromStatus,
            platformStatusReason: operation.reason,
            platformStatusOperationId: operation.operationId,
            platformStatusToolVersion: operation.toolVersion
          },
          $currentDate: {
            updatedAt: true,
            platformStatusUpdatedAt: true,
            ...(operation.status === 'active' ? { activatedAt: true } : {})
          }
        },
        multi: false,
        upsert: false
      })),
      ordered: true
    })
  };
}

function applyPlatformStatusOperation(environmentId, changes, operation) {
  const command = buildPlatformStatusUpdateCommand(changes, operation);
  return runWithRetry(() => runNoSql(environmentId, [command]));
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function runWithRetry(callback, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return callback();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function applyChanges(environmentId, additions, updates, options = {}) {
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || 20, 50));
  const maxWrites = Math.max(1, Math.min(Number(options.maxWrites) || 5000, 10000));
  if (additions.length + updates.length > maxWrites) {
    const error = new Error(`planned writes exceed safety limit ${maxWrites}`);
    error.code = 'IMPORT_WRITE_LIMIT';
    throw error;
  }
  const summary = {
    inserted: 0,
    updated: 0,
    failed: 0,
    failures: []
  };
  for (const records of chunk(additions, batchSize)) {
    const command = {
      TableName: COLLECTION,
      CommandType: 'INSERT',
      Command: JSON.stringify({
        insert: COLLECTION,
        documents: buildInsertDocuments(records),
        ordered: true
      })
    };
    try {
      const timestampCommand = {
        TableName: COLLECTION,
        CommandType: 'UPDATE',
        Command: JSON.stringify({
          update: COLLECTION,
          updates: [{
            q: {
              _id: {
                $in: records.map((record) => record._id)
              }
            },
            u: {
              $currentDate: {
                createdAt: true,
                updatedAt: true,
                lastSeenAt: true
              }
            },
            multi: true,
            upsert: false
          }],
          ordered: true
        })
      };
      runWithRetry(() => runNoSql(environmentId, [command, timestampCommand]));
      summary.inserted += records.length;
    } catch (error) {
      summary.failed += records.length;
      summary.failures.push({
        operation: 'insert',
        ids: records.map((record) => record._id),
        code: error.code || 'CLOUD_CLI_FAILED'
      });
      break;
    }
  }
  if (summary.failed === 0) {
    for (const records of chunk(updates, batchSize)) {
      const command = {
        TableName: COLLECTION,
        CommandType: 'UPDATE',
        Command: JSON.stringify({
          update: COLLECTION,
          updates: records.map((item) => ({
            q: {
              _id: item.desired._id,
              officialCode: item.desired.officialCode
            },
            u: {
              $set: buildOfficialUpdate(item.desired),
              $currentDate: {
                updatedAt: true,
                lastSeenAt: true
              }
            },
            multi: false,
            upsert: false
          })),
          ordered: true
        })
      };
      try {
        runWithRetry(() => runNoSql(environmentId, [command]));
        summary.updated += records.length;
      } catch (error) {
        summary.failed += records.length;
        summary.failures.push({
          operation: 'update',
          ids: records.map((record) => record.desired._id),
          code: error.code || 'CLOUD_CLI_FAILED'
        });
        break;
      }
    }
  }
  return summary;
}

module.exports = {
  CLI_PACKAGE,
  COLLECTION,
  loadEnvironmentId,
  maskEnvironmentId,
  runCloudBase,
  runNoSql,
  readAllSchools,
  buildInsertDocuments,
  buildOfficialUpdate,
  buildPlatformStatusUpdateCommand,
  applyPlatformStatusOperation,
  applyChanges,
  parseJsonOutput,
  extractCommandResults,
  extractDocuments,
  decodeExtendedJson
};
