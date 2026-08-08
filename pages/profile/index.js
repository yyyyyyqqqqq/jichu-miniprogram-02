const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const NavigationService = require('../../services/navigation-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

function getSchoolPresentation(user) {
  const schoolName = user && typeof user.schoolName === 'string'
    ? user.schoolName.trim()
    : '';
  const legacyCampus = user && typeof user.campus === 'string'
    ? user.campus.trim()
    : '';
  return {
    displaySchoolName: schoolName || legacyCampus || '校园信息待完善',
    hasBoundSchool: Boolean(schoolName)
  };
}

Page({
  data: {
    authStatus: 'idle',
    user: null,
    isLoggedIn: false,
    isRestoring: false,
    errorMessage: '',
    displaySchoolName: '校园信息待完善',
    hasBoundSchool: false
  },

  onLoad() {
    this.isPageActive = true;
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      this.applyAuthState(state);
    });
  },

  applyAuthState(state) {
    if (!this.isPageActive) {
      return;
    }
    const schoolPresentation = getSchoolPresentation(state.user);
    this.setData({
      authStatus: state.status,
      user: state.user,
      isLoggedIn: state.status === 'authenticated'
        && Boolean(state.user)
        && state.user.profileCompleted === true,
      isRestoring: state.restoring,
      errorMessage: state.error ? state.error.message : '',
      ...schoolPresentation
    });
  },

  async onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 'profile' });
    }
    await AuthGuard.requireMarketAccess({
      target: AUTH_TARGETS.PROFILE
    });
    this.applyAuthState(AuthStore.getState());
  },

  onUnload() {
    this.isPageActive = false;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  },

  goLogin() {
    AuthGuard.requireLogin({
      target: AUTH_TARGETS.PROFILE
    });
  },

  editProfile() {
    if (!AuthStore.isLoggedIn()) {
      this.goLogin();
      return;
    }
    NavigationService.safeNavigateTo(
      `${ROUTES.LOGIN}?target=${AUTH_TARGETS.PROFILE}&mode=edit`
    );
  },

  async changeSchool() {
    if (!AuthStore.isLoggedIn()) {
      this.goLogin();
      return;
    }
    const user = AuthStore.getCurrentUser();
    if (!user || !user.schoolId || user.schoolUnavailable) {
      await AuthGuard.requireMarketAccess({
        target: AUTH_TARGETS.PROFILE
      });
      return;
    }
    await AuthGuard.openSchoolChange({
      target: AUTH_TARGETS.PROFILE
    });
  },

  async goMyProducts() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.MY_PRODUCTS
    });
    if (allowed) {
      NavigationService.safeNavigateTo(ROUTES.MY_PRODUCTS);
    }
  },

  async goFavorites() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.FAVORITES
    });
    if (allowed) {
      NavigationService.safeNavigateTo(ROUTES.FAVORITES);
    }
  },

  async goMessages() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.MESSAGES
    });
    if (allowed) {
      NavigationService.safeSwitchTab(ROUTES.MESSAGES);
    }
  },

  async goAppointments() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PROFILE
    });
    if (allowed) {
      NavigationService.safeNavigateTo(ROUTES.APPOINTMENTS);
    }
  },

  async retryAuth() {
    await AuthStore.refreshCurrentUser();
  },

  clearLocalState() {
    AuthStore.logout();
  },

  logout() {
    wx.showModal({
      title: '退出当前登录？',
      content: '退出后首页将保持匿名且不再加载校园商品，重新登录后可恢复当前学校市场。',
      confirmText: '退出登录',
      confirmColor: '#d95745',
      success(result) {
        if (result.confirm) {
          AuthStore.logout();
          wx.showToast({
            title: '已退出登录',
            icon: 'none'
          });
        }
      }
    });
  },

  showAbout() {
    wx.showModal({
      title: '关于即出',
      content: '即出是面向校园闲置物品信息与线下面交的原生微信小程序。本项目不提供在线支付。',
      showCancel: false
    });
  }
});
