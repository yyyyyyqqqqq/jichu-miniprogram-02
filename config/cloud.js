const PUBLIC_ENVIRONMENT_ID = 'YOUR_CLOUDBASE_ENV_ID';

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

function normalizeEnvironmentId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const PRIVATE_CLOUD_CONFIG = loadPrivateCloudConfig();
const privateEnvironmentId = normalizeEnvironmentId(
  PRIVATE_CLOUD_CONFIG.environmentId
);
const environmentId = privateEnvironmentId || PUBLIC_ENVIRONMENT_ID;

const CLOUD_CONFIG = {
  environmentId,
  environmentSource: privateEnvironmentId
    ? 'config/cloud.private.js'
    : 'public-placeholder',
  authFunctionName: 'authUser',
  authTimeoutMs: 15000,
  avatarImageValidationTimeoutMs: 5000,
  avatarUploadTimeoutMs: 30000,
  productFunctionName: 'productQuery',
  productTimeoutMs: 15000,
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
  appointmentQueryFunctionName: 'appointmentQuery',
  appointmentQueryTimeoutMs: 15000,
  appointmentActionFunctionName: 'appointmentAction',
  appointmentActionTimeoutMs: 15000,
  productImageValidationTimeoutMs: 5000,
  productUploadTimeoutMs: 30000,
  userCacheKey: 'auth:user-summary'
};

module.exports = {
  CLOUD_CONFIG,
  PUBLIC_ENVIRONMENT_ID
};
