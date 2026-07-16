const ROUTES = {
  HOME: '/pages/home/index',
  PRODUCT_DETAIL: '/pages/product-detail/index',
  PUBLISH: '/pages/publish/index',
  MESSAGES: '/pages/messages/index',
  PROFILE: '/pages/profile/index',
  LOGIN: '/pages/login/index',
  FAVORITES: '/pages/favorites/index',
  MY_PRODUCTS: '/pages/my-products/index',
  CHAT: '/pages/chat/index',
  USER_PROFILE: '/pages/user-profile/index',
  LOCATION_PICKER: '/pages/location-picker/index'
};

const AUTH_TARGETS = {
  PROFILE: 'profile',
  PUBLISH: 'publish',
  MESSAGES: 'messages',
  FAVORITES: 'favorites',
  MY_PRODUCTS: 'my-products',
  PRODUCT_DETAIL: 'product-detail'
};

const AUTH_TARGET_CONFIG = {
  [AUTH_TARGETS.PROFILE]: {
    route: ROUTES.PROFILE,
    method: 'switchTab'
  },
  [AUTH_TARGETS.PUBLISH]: {
    route: ROUTES.PUBLISH,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.MESSAGES]: {
    route: ROUTES.MESSAGES,
    method: 'switchTab'
  },
  [AUTH_TARGETS.FAVORITES]: {
    route: ROUTES.FAVORITES,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.MY_PRODUCTS]: {
    route: ROUTES.MY_PRODUCTS,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.PRODUCT_DETAIL]: {
    route: ROUTES.PRODUCT_DETAIL,
    method: 'redirectTo'
  }
};

module.exports = {
  ROUTES,
  AUTH_TARGETS,
  AUTH_TARGET_CONFIG
};
