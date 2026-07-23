const CLOUD_CONFIG = {
  environmentId: 'cloud1-d9gpdpv6p2db56d8e',
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
  productImageValidationTimeoutMs: 5000,
  productUploadTimeoutMs: 30000,
  userCacheKey: 'auth:user-summary'
};

module.exports = {
  CLOUD_CONFIG
};
