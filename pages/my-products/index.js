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

    if (!AuthStore.isLoggedIn()) {
      AuthGuard.requireLogin({
        target: AUTH_TARGETS.MY_PRODUCTS
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
      target: AUTH_TARGETS.MY_PRODUCTS
    });
  }
});
