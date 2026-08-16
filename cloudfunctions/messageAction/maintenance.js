const CONFIG_COLLECTION = 'systemConfig';
const CONFIG_ID = 'conversation_appointment_maintenance';
const CONFIG_SCHEMA_VERSION = 1;
const ERROR_CODE = 'SERVICE_MAINTENANCE';

function extractRecord(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.data && !Array.isArray(result.data)) return result.data;
  return Array.isArray(result.data) && result.data.length > 0
    ? result.data[0]
    : null;
}

function normalizeState(record, readFailed = false) {
  if (
    readFailed
    || !record
    || record._id !== CONFIG_ID
    || record.schemaVersion !== CONFIG_SCHEMA_VERSION
    || typeof record.enabled !== 'boolean'
  ) {
    return { enabled: true, valid: false, failClosed: true };
  }
  return { enabled: record.enabled, valid: true, failClosed: false };
}

async function readState(db) {
  try {
    const result = await db.collection(CONFIG_COLLECTION).doc(CONFIG_ID).get();
    return normalizeState(extractRecord(result));
  } catch (error) {
    return normalizeState(null, true);
  }
}

async function assertWritable(db, businessError) {
  const state = await readState(db);
  if (state.enabled) {
    businessError(ERROR_CODE, '服务维护中，请稍后再试');
  }
  return state;
}

module.exports = {
  CONFIG_COLLECTION,
  CONFIG_ID,
  CONFIG_SCHEMA_VERSION,
  ERROR_CODE,
  normalizeState,
  readState,
  assertWritable
};
