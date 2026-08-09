const AppStore = require('./store/app-store');
const AuthStore = require('./store/auth-store');
const CloudService = require('./services/cloud-service');

App({
  onLaunch() {
    AppStore.initialize();
    CloudService.ensureCloudReady()
      .then(() => AuthStore.bootstrap())
      .catch(() => {});
  },

  onShow() {
    CloudService.ensureCloudReady()
      .then(() => AuthStore.refreshCurrentUser())
      .catch(() => {});
  },

  globalData: {
    appName: '即出',
    initializedAt: ''
  }
});
