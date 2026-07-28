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

function buildLoginUrl(options = {}) {
  const target = normalizeTarget(options.target);
  const parts = [`target=${encodeURIComponent(target)}`];

  if (
    target === AUTH_TARGETS.PRODUCT_DETAIL
    || target === AUTH_TARGETS.PRODUCT_EDIT
  ) {
    const productId = normalizeProductId(options.productId);
    if (productId) {
      parts.push(`id=${encodeURIComponent(productId)}`);
    }
  }

  return `${ROUTES.LOGIN}?${parts.join('&')}`;
}

function buildSchoolSelectUrl(options = {}) {
  const target = normalizeTarget(options.target);
  const parts = [`target=${encodeURIComponent(target)}`];
  if (
    target === AUTH_TARGETS.PRODUCT_DETAIL
    || target === AUTH_TARGETS.PRODUCT_EDIT
  ) {
    const productId = normalizeProductId(options.productId);
    if (productId) {
      parts.push(`id=${encodeURIComponent(productId)}`);
    }
  }
  return `${ROUTES.SCHOOL_SELECT}?${parts.join('&')}`;
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

async function requireLogin(options = {}) {
  await restoreIfNeeded();
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
  const currentUser = AuthStore.getCurrentUser();
  if (state.status !== 'authenticated' || !currentUser) {
    return true;
  }
  if (currentUser.profileCompleted !== true) {
    if (NavigationService.getCurrentRoute() !== ROUTES.LOGIN) {
      await NavigationService.safeNavigateTo(buildLoginUrl(options));
    }
    return false;
  }
  if (AuthStore.isSchoolReady()) {
    return true;
  }
  await openSchoolSelection(options);
  return false;
}

function buildTargetUrl(target, productId) {
  const config = AUTH_TARGET_CONFIG[target]
    || AUTH_TARGET_CONFIG[AUTH_TARGETS.PROFILE];

  if (
    target === AUTH_TARGETS.PRODUCT_DETAIL
    || target === AUTH_TARGETS.PRODUCT_EDIT
  ) {
    const id = normalizeProductId(productId);
    return id
      ? `${config.route}?id=${encodeURIComponent(id)}`
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

  const url = buildTargetUrl(target, options.productId);
  if (url === ROUTES.HOME) {
    return NavigationService.safeSwitchTab(ROUTES.HOME);
  }
  if (config.method === 'switchTab') {
    return NavigationService.safeSwitchTab(url);
  }
  return NavigationService.safeRedirectTo(url);
}

async function navigateAfterLogin(options = {}) {
  if (!AuthStore.isSchoolReady()) {
    return openSchoolSelection(options);
  }
  return navigateToTarget(options);
}

async function navigateAfterSchoolSelection(options = {}) {
  if (!AuthStore.isSchoolReady()) {
    return false;
  }
  return navigateToTarget(options);
}

module.exports = {
  normalizeTarget,
  normalizeProductId,
  buildLoginUrl,
  buildSchoolSelectUrl,
  requireLogin,
  requireMarketAccess,
  navigateAfterLogin,
  navigateAfterSchoolSelection
};
