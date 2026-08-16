const CONFIG_COLLECTION = 'systemConfig';
const CONFIG_ID = 'conversation_appointment_maintenance';
const CONFIG_SCHEMA_VERSION = 1;
const ERROR_CODE = 'SERVICE_MAINTENANCE';

function normalizeMaintenanceState(record, readError = null) {
  if (readError) {
    return {
      enabled: true,
      valid: false,
      failClosed: true,
      reason: 'config-read-failed'
    };
  }
  if (
    !record
    || record._id !== CONFIG_ID
    || record.schemaVersion !== CONFIG_SCHEMA_VERSION
    || typeof record.enabled !== 'boolean'
  ) {
    return {
      enabled: true,
      valid: false,
      failClosed: true,
      reason: 'config-missing-or-invalid'
    };
  }
  return {
    enabled: record.enabled,
    valid: true,
    failClosed: false,
    reason: record.enabled ? 'configured-on' : 'configured-off',
    migrationRunId: typeof record.migrationRunId === 'string'
      ? record.migrationRunId
      : ''
  };
}

module.exports = {
  CONFIG_COLLECTION,
  CONFIG_ID,
  CONFIG_SCHEMA_VERSION,
  ERROR_CODE,
  normalizeMaintenanceState
};
