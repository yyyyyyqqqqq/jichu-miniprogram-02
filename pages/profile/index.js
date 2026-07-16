const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const NavigationService = require('../../services/navigation-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

Page({
  data: {
    authStatus: 'idle',
    user: null,
    isLoggedIn: false,
    isRestoring: false,
    errorMessage: ''
  },

  onLoad() {
    this.isPageActive = true;
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      this.setData({
        authStatus: state.status,
        user: state.user,
        isLoggedIn: state.status === 'authenticated' && Boolean(state.user),
        isRestoring: state.restoring,
        errorMessage: state.error ? state.error.message : ''
      });
    });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 'profile' });
    }
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

  async retryAuth() {
    await AuthStore.refreshCurrentUser();
  },

  clearLocalState() {
    AuthStore.logout();
  },

  logout() {
    wx.showModal({
      title: '退出当前登录？',
      content: '退出后仍可浏览商品，发布和联系卖家时需要重新登录。',
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
