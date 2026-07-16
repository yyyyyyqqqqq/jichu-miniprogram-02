const AppStore = require('./store/app-store');

App({
  onLaunch() {
    AppStore.initialize();
  },

  globalData: {
    appName: '即出',
    initializedAt: ''
  }
});
