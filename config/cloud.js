const CLOUD_CONFIG = {
  environmentId: 'cloud1-d9gpdpv6p2db56d8e',
  authFunctionName: 'authUser',
  authTimeoutMs: 10000,
  productFunctionName: 'productQuery',
  productTimeoutMs: 10000,
  createProductFunctionName: 'createProduct',
  createProductTimeoutMs: 15000,
  productUploadTimeoutMs: 30000,
  userCacheKey: 'auth:user-summary'
};

module.exports = {
  CLOUD_CONFIG
};
