const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const { AUTH_TARGETS } = require('../../constants/routes');

Page({
  data: {
    isLoggedIn: false
  },

  onLoad() {
    this.isPageActive = true;
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (this.isPageActive) {
        this.setData({
          isLoggedIn: state.status === 'authenticated' && Boolean(state.user)
        });
      }
    });
  },

  onShow() {
    if (!AuthStore.isLoggedIn() && !this.hasPromptedLogin) {
      this.hasPromptedLogin = true;
      AuthGuard.requireLogin({
        target: AUTH_TARGETS.PUBLISH
      });
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
      target: AUTH_TARGETS.PUBLISH
    });
  },

  showNotice() {
    wx.showToast({
      title: '商品发布将在下一阶段开放',
      icon: 'none'
    });
  }
});
