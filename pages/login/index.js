const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const NavigationService = require('../../services/navigation-service');
const { ROUTES } = require('../../constants/routes');

Page({
  data: {
    authStatus: 'idle',
    user: null,
    isLoggingIn: false,
    errorMessage: '',
    target: 'profile',
    productId: '',
    isReturning: false
  },

  onLoad(options) {
    this.isPageActive = true;
    const target = AuthGuard.normalizeTarget(options && options.target);
    const productId = AuthGuard.normalizeProductId(options && options.id);
    this.setData({ target, productId });

    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      this.setData({
        authStatus: state.status,
        user: state.user,
        isLoggingIn: state.loggingIn,
        errorMessage: state.error ? state.error.message : ''
      });
    });
  },

  onUnload() {
    this.isPageActive = false;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
    if (this.returnTimer) {
      clearTimeout(this.returnTimer);
      this.returnTimer = null;
    }
  },

  async onLoginTap() {
    if (this.data.isLoggingIn || this.data.isReturning) {
      return;
    }

    if (AuthStore.isLoggedIn()) {
      this.continueAfterLogin();
      return;
    }

    this.setData({ errorMessage: '' });

    try {
      await AuthStore.login();
      if (!this.isPageActive || this.data.isReturning) {
        return;
      }

      wx.showToast({
        title: '登录成功',
        icon: 'success'
      });
      this.setData({ isReturning: true });
      this.returnTimer = setTimeout(() => {
        this.returnTimer = null;
        this.continueAfterLogin();
      }, 500);
    } catch (error) {
      if (this.isPageActive) {
        this.setData({
          errorMessage: error && error.message
            ? error.message
            : '登录失败，请稍后重试'
        });
      }
    }
  },

  continueAfterLogin() {
    if (this.data.isReturning && !AuthStore.isLoggedIn()) {
      return;
    }

    this.setData({ isReturning: true });
    AuthGuard.navigateAfterLogin({
      target: this.data.target,
      productId: this.data.productId
    });
  },

  async onRetryRestore() {
    if (this.data.isLoggingIn) {
      return;
    }
    await AuthStore.refreshCurrentUser();
  },

  onBackTap() {
    NavigationService.safeNavigateBack().then((success) => {
      if (!success) {
        NavigationService.safeSwitchTab(ROUTES.PROFILE);
      }
    });
  }
});
