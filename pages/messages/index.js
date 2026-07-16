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
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 'messages' });
    }

    if (!AuthStore.isLoggedIn() && !this.hasPromptedLogin) {
      this.hasPromptedLogin = true;
      AuthGuard.requireLogin({
        target: AUTH_TARGETS.MESSAGES
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
      target: AUTH_TARGETS.MESSAGES
    });
  }
});
