const AuthStore = require('../store/auth-store');
const NavigationService = require('./navigation-service');
const {
  ROUTES,
  AUTH_TARGETS,
  AUTH_TARGET_CONFIG
} = require('../constants/routes');

const VALID_TARGETS = new Set(Object.values(AUTH_TARGETS));

function normalizeTarget(value) {
  return VALID_TARGETS.has(value) ? value : AUTH_TARGETS.PROFILE;
}

function normalizeProductId(value) {
  const id = value === null || value === undefined
    ? ''
    : String(value).trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : '';
}

function normalizeConversationId(value) {
  const id = value === null || value === undefined ? '' : String(value).trim();
  return /^c_[a-f0-9]{64}$/.test(id) ? id : '';
}

function normalizeAppointmentId(value) {
  const id = value === null || value === undefined ? '' : String(value).trim();
  return /^a_[a-f0-9]{64}$/.test(id) ? id : '';
}

function normalizePublicUserId(value) {
  const id = value === null || value === undefined ? '' : String(value).trim();
  return /^u_[a-f0-9]{32}$/.test(id) ? id : '';
}

function normalizeAuthContext(options = {}) {
  const target = normalizeTarget(options.target);
  return {
    target,
    productId: normalizeProductId(options.productId),
    conversationId: normalizeConversationId(options.conversationId),
    appointmentId: normalizeAppointmentId(options.appointmentId),
    publicUserId: normalizePublicUserId(options.publicUserId)
  };
}

function appendTargetParameter(parts, target, options = {}) {
  if (
    target === AUTH_TARGETS.PRODUCT_DETAIL
    || target === AUTH_TARGETS.PRODUCT_EDIT
  ) {
    const productId = normalizeProductId(options.productId);
    if (productId) parts.push(`id=${encodeURIComponent(productId)}`);
  }
  if (
    target === AUTH_TARGETS.CHAT
    || target === AUTH_TARGETS.CHAT_PRODUCT_PICKER
    || target === AUTH_TARGETS.APPOINTMENT_CREATE
  ) {
    const conversationId = normalizeConversationId(options.conversationId);
    if (conversationId) parts.push(`conversationId=${encodeURIComponent(conversationId)}`);
  }
  if (target === AUTH_TARGETS.APPOINTMENT_CREATE) {
    const productId = normalizeProductId(options.productId);
    if (productId) parts.push(`productId=${encodeURIComponent(productId)}`);
  }
  if (target === AUTH_TARGETS.APPOINTMENT_DETAIL) {
    const appointmentId = normalizeAppointmentId(options.appointmentId);
    if (appointmentId) parts.push(`appointmentId=${encodeURIComponent(appointmentId)}`);
  }
  if (target === AUTH_TARGETS.USER_PROFILE) {
    const publicUserId = normalizePublicUserId(options.publicUserId);
    if (publicUserId) parts.push(`userId=${encodeURIComponent(publicUserId)}`);
  }
}

function buildLoginUrl(options = {}) {
  const target = normalizeTarget(options.target);
  const parts = [`target=${encodeURIComponent(target)}`];
  appendTargetParameter(parts, target, options);

  return `${ROUTES.LOGIN}?${parts.join('&')}`;
}

function buildSchoolSelectUrl(options = {}) {
  const target = normalizeTarget(options.target);
  const parts = [`target=${encodeURIComponent(target)}`];
  if (options.mode === 'change') {
    parts.push('mode=change');
  }
  appendTargetParameter(parts, target, options);
  return `${ROUTES.SCHOOL_SELECT}?${parts.join('&')}`;
}

async function openSchoolChange(options = {}) {
  await restoreIfNeeded();
  const currentUser = AuthStore.getCurrentUser();
  if (!AuthStore.isLoggedIn() || !currentUser) {
    return false;
  }
  if (NavigationService.getCurrentRoute() === ROUTES.SCHOOL_SELECT) {
    return false;
  }
  return NavigationService.safeNavigateTo(buildSchoolSelectUrl({
    ...options,
    mode: 'change'
  }));
}

async function restoreIfNeeded() {
  const state = AuthStore.getState();
  if (state.status === 'idle' || state.restoring) {
    await AuthStore.bootstrap();
  }
  return AuthStore.getState();
}

async function openSchoolSelection(options = {}) {
  if (NavigationService.getCurrentRoute() === ROUTES.SCHOOL_SELECT) {
    return false;
  }
  const url = buildSchoolSelectUrl(options);
  const redirected = await NavigationService.safeRedirectTo(url);
  return redirected || NavigationService.safeNavigateTo(url);
}

async function requireIdentity(options = {}) {
  await restoreIfNeeded();
  if (AuthStore.isProfileConfirmationRequired()) {
    if (NavigationService.getCurrentRoute() !== ROUTES.LOGIN) {
      const context = AuthStore.getLoginContext() || normalizeAuthContext(options);
      await NavigationService.safeNavigateTo(buildLoginUrl(context));
    }
    return false;
  }
  if (AuthStore.isLoggedIn() && AuthStore.getCurrentUser()) {
    return true;
  }
  if (NavigationService.getCurrentRoute() === ROUTES.LOGIN) {
    return false;
  }
  await NavigationService.safeNavigateTo(buildLoginUrl(options));
  return false;
}

async function requireLogin(options = {}) {
  await restoreIfNeeded();
  if (AuthStore.isProfileConfirmationRequired()) {
    if (NavigationService.getCurrentRoute() !== ROUTES.LOGIN) {
      const context = AuthStore.getLoginContext() || normalizeAuthContext(options);
      await NavigationService.safeNavigateTo(buildLoginUrl(context));
    }
    return false;
  }
  const currentUser = AuthStore.getCurrentUser();
  if (AuthStore.isLoggedIn() && currentUser) {
    if (AuthStore.isSchoolReady()) {
      return true;
    }
    await openSchoolSelection(options);
    return false;
  }

  if (NavigationService.getCurrentRoute() === ROUTES.LOGIN) {
    return false;
  }

  await NavigationService.safeNavigateTo(buildLoginUrl(options));
  return false;
}

async function requireMarketAccess(options = {}) {
  const state = await restoreIfNeeded();
  if (AuthStore.isProfileConfirmationRequired()) {
    if (NavigationService.getCurrentRoute() !== ROUTES.LOGIN) {
      const context = AuthStore.getLoginContext() || normalizeAuthContext(options);
      await NavigationService.safeNavigateTo(buildLoginUrl(context));
    }
    return false;
  }
  if (
    state.loginStage === AuthStore.LOGIN_STAGE.SCHOOL_SELECTION_REQUIRED
    && AuthStore.isLoggedIn()
  ) {
    await openSchoolSelection(AuthStore.getLoginContext() || options);
    return false;
  }
  const currentUser = AuthStore.getCurrentUser();
  if (state.status !== 'authenticated' || !currentUser) {
    return false;
  }
  if (AuthStore.isSchoolReady()) {
    return true;
  }
  return false;
}

function buildTargetUrl(target, options = {}) {
  const config = AUTH_TARGET_CONFIG[target]
    || AUTH_TARGET_CONFIG[AUTH_TARGETS.PROFILE];

  if (
    target === AUTH_TARGETS.PRODUCT_DETAIL
    || target === AUTH_TARGETS.PRODUCT_EDIT
  ) {
    const id = normalizeProductId(options.productId);
    return id
      ? `${config.route}?id=${encodeURIComponent(id)}`
      : ROUTES.HOME;
  }

  if (target === AUTH_TARGETS.CHAT || target === AUTH_TARGETS.CHAT_PRODUCT_PICKER) {
    const conversationId = normalizeConversationId(options.conversationId);
    return conversationId
      ? `${config.route}?conversationId=${encodeURIComponent(conversationId)}`
      : ROUTES.MESSAGES;
  }
  if (target === AUTH_TARGETS.APPOINTMENT_CREATE) {
    const conversationId = normalizeConversationId(options.conversationId);
    const productId = normalizeProductId(options.productId);
    return conversationId && productId
      ? `${config.route}?conversationId=${encodeURIComponent(conversationId)}&productId=${encodeURIComponent(productId)}`
      : ROUTES.MESSAGES;
  }
  if (target === AUTH_TARGETS.APPOINTMENT_DETAIL) {
    const appointmentId = normalizeAppointmentId(options.appointmentId);
    return appointmentId
      ? `${config.route}?appointmentId=${encodeURIComponent(appointmentId)}`
      : ROUTES.APPOINTMENTS;
  }
  if (target === AUTH_TARGETS.USER_PROFILE) {
    const publicUserId = normalizePublicUserId(options.publicUserId);
    return publicUserId
      ? `${config.route}?userId=${encodeURIComponent(publicUserId)}`
      : ROUTES.HOME;
  }

  return config.route;
}

function hasPreviousRoute(route) {
  const pages = getCurrentPages();
  if (pages.length < 2) {
    return false;
  }
  const previousPage = pages[pages.length - 2];
  return previousPage && `/${previousPage.route}` === route;
}

async function navigateToTarget(options = {}) {
  const target = normalizeTarget(options.target);
  const config = AUTH_TARGET_CONFIG[target]
    || AUTH_TARGET_CONFIG[AUTH_TARGETS.PROFILE];

  if (
    target === AUTH_TARGETS.PRODUCT_DETAIL
    && hasPreviousRoute(ROUTES.PRODUCT_DETAIL)
  ) {
    return NavigationService.safeNavigateBack();
  }
  if (
    target === AUTH_TARGETS.MY_PRODUCTS
    && hasPreviousRoute(ROUTES.MY_PRODUCTS)
  ) {
    return NavigationService.safeNavigateBack();
  }
  if (
    target === AUTH_TARGETS.PRODUCT_EDIT
    && hasPreviousRoute(ROUTES.PRODUCT_EDIT)
  ) {
    return NavigationService.safeNavigateBack();
  }

  const url = buildTargetUrl(target, options);
  if (url === ROUTES.HOME) {
    return NavigationService.safeSwitchTab(ROUTES.HOME);
  }
  if (config.method === 'switchTab') {
    return NavigationService.safeSwitchTab(url);
  }
  return NavigationService.safeRedirectTo(url);
}

async function navigateAfterLogin(options = {}) {
  if (AuthStore.isProfileConfirmationRequired()) {
    return false;
  }
  if (!AuthStore.isSchoolReady()) {
    return openSchoolSelection(options);
  }
  const navigated = await navigateToTarget(options);
  if (navigated) {
    AuthStore.completeExplicitLogin();
  }
  return navigated;
}

async function navigateAfterSchoolSelection(options = {}) {
  if (!AuthStore.isSchoolReady()) {
    return false;
  }
  const navigated = await navigateToTarget(options);
  if (navigated) {
    AuthStore.completeExplicitLogin();
  }
  return navigated;
}

module.exports = {
  normalizeTarget,
  normalizeProductId,
  normalizeConversationId,
  normalizeAppointmentId,
  normalizePublicUserId,
  normalizeAuthContext,
  buildLoginUrl,
  buildSchoolSelectUrl,
  openSchoolChange,
  requireIdentity,
  requireLogin,
  requireMarketAccess,
  navigateAfterLogin,
  navigateAfterSchoolSelection
};
