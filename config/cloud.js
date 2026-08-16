const PUBLIC_ENVIRONMENT_ID = 'YOUR_CLOUDBASE_ENV_ID';
const PUBLIC_ENVIRONMENT_NAME = 'YOUR_ENVIRONMENT_NAME';
const {
  validateEnvironmentConfiguration
} = require('./environment');

function isDirectPrivateConfigMissing(error) {
  return Boolean(
    error
    && error.code === 'MODULE_NOT_FOUND'
    && /cloud\.private/.test(error.message || '')
  );
}

function loadPrivateCloudConfig() {
  try {
    return require('./cloud.private');
  } catch (error) {
    if (!isDirectPrivateConfigMissing(error)) {
      throw error;
    }
    return {};
  }
}

function loadPrivateCloudTargets() {
  try {
    return require('./cloud.targets.private');
  } catch (error) {
    if (
      error
      && error.code === 'MODULE_NOT_FOUND'
      && /cloud\.targets\.private/.test(error.message || '')
    ) {
      return {};
    }
    throw error;
  }
}

function normalizeEnvironmentId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const PRIVATE_CLOUD_CONFIG = loadPrivateCloudConfig();
const PRIVATE_CLOUD_TARGETS = loadPrivateCloudTargets();
const privateEnvironmentId = normalizeEnvironmentId(
  PRIVATE_CLOUD_CONFIG.environmentId
);
const privateEnvironmentName = normalizeEnvironmentId(
  PRIVATE_CLOUD_CONFIG.environmentName
);
const environmentId = privateEnvironmentId || PUBLIC_ENVIRONMENT_ID;
const environmentName = privateEnvironmentName || PUBLIC_ENVIRONMENT_NAME;
const environmentValidation = validateEnvironmentConfiguration(
  PRIVATE_CLOUD_CONFIG,
  PRIVATE_CLOUD_TARGETS
);

const CLOUD_CONFIG = {
  environmentId,
  environmentName,
  environmentSource: privateEnvironmentId && privateEnvironmentName
    ? 'config/cloud.private.js'
    : 'public-placeholder',
  environmentValidationError: environmentValidation.valid
    ? ''
    : environmentValidation.code,
  authFunctionName: 'authUser',
  authTimeoutMs: 15000,
  avatarImageValidationTimeoutMs: 5000,
  avatarUploadTimeoutMs: 30000,
  productFunctionName: 'productQuery',
  productTimeoutMs: 15000,
  productViewFunctionName: 'productViewAction',
  productViewTimeoutMs: 15000,
  createProductFunctionName: 'createProduct',
  createProductTimeoutMs: 15000,
  manageProductFunctionName: 'manageProduct',
  manageProductTimeoutMs: 15000,
  favoriteProductFunctionName: 'favoriteProduct',
  favoriteProductTimeoutMs: 15000,
  userQueryFunctionName: 'userQuery',
  userQueryTimeoutMs: 15000,
  messageQueryFunctionName: 'messageQuery',
  messageQueryTimeoutMs: 15000,
  messageActionFunctionName: 'messageAction',
  messageActionTimeoutMs: 15000,
  chatMediaValidationTimeoutMs: 5000,
  chatMediaUploadTimeoutMs: 60000,
  appointmentQueryFunctionName: 'appointmentQuery',
  appointmentQueryTimeoutMs: 15000,
  appointmentActionFunctionName: 'appointmentAction',
  appointmentActionTimeoutMs: 15000,
  schoolQueryFunctionName: 'schoolQuery',
  schoolQueryTimeoutMs: 15000,
  productImageValidationTimeoutMs: 5000,
  productUploadTimeoutMs: 30000,
  productVideoUploadTimeoutMs: 120000,
  userCacheKey: 'auth:user-summary',
  explicitLogoutKey: 'auth:explicit-logout',
  loginTransactionKey: 'auth:login-transaction'
};

module.exports = {
  CLOUD_CONFIG,
  PUBLIC_ENVIRONMENT_ID,
  PUBLIC_ENVIRONMENT_NAME
};
