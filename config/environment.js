const ENVIRONMENT_NAMES = Object.freeze(['production', 'staging']);
const ENVIRONMENT_ID_PLACEHOLDERS = Object.freeze([
  'YOUR_CLOUDBASE_ENV_ID',
  'YOUR_PRODUCTION_ENV_ID',
  'YOUR_STAGING_ENV_ID'
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlaceholderEnvironmentId(value) {
  const normalized = normalizeText(value);
  return !normalized || ENVIRONMENT_ID_PLACEHOLDERS.includes(normalized);
}

function validateEnvironmentConfiguration(activeConfig, targetsConfig) {
  const environmentName = normalizeText(activeConfig && activeConfig.environmentName);
  const environmentId = normalizeText(activeConfig && activeConfig.environmentId);
  const productionId = normalizeText(targetsConfig && targetsConfig.production);
  const stagingId = normalizeText(targetsConfig && targetsConfig.staging);

  if (!ENVIRONMENT_NAMES.includes(environmentName)) {
    return { valid: false, code: 'ENVIRONMENT_ROLE_UNCONFIRMED' };
  }
  if (
    isPlaceholderEnvironmentId(environmentId)
    || isPlaceholderEnvironmentId(productionId)
    || isPlaceholderEnvironmentId(stagingId)
  ) {
    return { valid: false, code: 'ENVIRONMENT_ID_UNCONFIRMED' };
  }
  if (productionId === stagingId) {
    return { valid: false, code: 'ENVIRONMENT_TARGETS_NOT_DISTINCT' };
  }
  if (targetsConfig[environmentName] !== environmentId) {
    return { valid: false, code: 'ENVIRONMENT_ROLE_ID_MISMATCH' };
  }
  return {
    valid: true,
    code: '',
    environmentName,
    environmentId,
    productionId,
    stagingId
  };
}

module.exports = {
  ENVIRONMENT_NAMES,
  ENVIRONMENT_ID_PLACEHOLDERS,
  normalizeText,
  isPlaceholderEnvironmentId,
  validateEnvironmentConfiguration
};
