const ROUTES = {
  HOME: '/pages/home/index',
  PRODUCT_DETAIL: '/pages/product-detail/index',
  PRODUCT_EDIT: '/pages/product-edit/index',
  PUBLISH: '/pages/publish/index',
  MESSAGES: '/pages/messages/index',
  PROFILE: '/pages/profile/index',
  PROFILE_EDIT: '/pages/profile-edit/index',
  FEEDBACK: '/pages/feedback/index',
  LOGIN: '/pages/login/index',
  SCHOOL_SELECT: '/pages/school-select/index',
  FAVORITES: '/pages/favorites/index',
  MY_PRODUCTS: '/pages/my-products/index',
  CHAT: '/pages/chat/index',
  CHAT_PRODUCT_PICKER: '/pages/chat-product-picker/index',
  MESSAGE_FORWARD: '/pages/message-forward/index',
  USER_PROFILE: '/pages/user-profile/index',
  LOCATION_PICKER: '/pages/location-picker/index',
  APPOINTMENT_CREATE: '/pages/appointment-create/index',
  APPOINTMENT_DETAIL: '/pages/appointment-detail/index',
  APPOINTMENTS: '/pages/appointments/index'
};

const AUTH_TARGETS = {
  HOME: 'home',
  PROFILE: 'profile',
  FEEDBACK: 'feedback',
  PUBLISH: 'publish',
  MESSAGES: 'messages',
  FAVORITES: 'favorites',
  MY_PRODUCTS: 'my-products',
  PRODUCT_DETAIL: 'product-detail',
  PRODUCT_EDIT: 'product-edit',
  CHAT: 'chat',
  CHAT_PRODUCT_PICKER: 'chat-product-picker',
  USER_PROFILE: 'user-profile',
  APPOINTMENT_CREATE: 'appointment-create',
  APPOINTMENT_DETAIL: 'appointment-detail',
  APPOINTMENTS: 'appointments'
};

const AUTH_TARGET_CONFIG = {
  [AUTH_TARGETS.HOME]: {
    route: ROUTES.HOME,
    method: 'switchTab'
  },
  [AUTH_TARGETS.PROFILE]: {
    route: ROUTES.PROFILE,
    method: 'switchTab'
  },
  [AUTH_TARGETS.FEEDBACK]: {
    route: ROUTES.FEEDBACK,
    method: 'redirectTo'
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
  },
  [AUTH_TARGETS.PRODUCT_EDIT]: {
    route: ROUTES.PRODUCT_EDIT,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.CHAT]: {
    route: ROUTES.CHAT,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.CHAT_PRODUCT_PICKER]: {
    route: ROUTES.CHAT_PRODUCT_PICKER,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.USER_PROFILE]: {
    route: ROUTES.USER_PROFILE,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.APPOINTMENT_CREATE]: {
    route: ROUTES.APPOINTMENT_CREATE,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.APPOINTMENT_DETAIL]: {
    route: ROUTES.APPOINTMENT_DETAIL,
    method: 'redirectTo'
  },
  [AUTH_TARGETS.APPOINTMENTS]: {
    route: ROUTES.APPOINTMENTS,
    method: 'redirectTo'
  }
};

module.exports = {
  ROUTES,
  AUTH_TARGETS,
  AUTH_TARGET_CONFIG
};
