const AppStore = require('./store/app-store');
const AuthStore = require('./store/auth-store');
const { CLOUD_CONFIG } = require('./config/cloud');

let cloudInitialized = false;

function initializeCloud() {
  if (cloudInitialized) {
    return true;
  }

  if (
    typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.init !== 'function'
  ) {
    return false;
  }

  try {
    wx.cloud.init({
      env: CLOUD_CONFIG.environmentId,
      traceUser: true
    });
    cloudInitialized = true;
    return true;
  } catch (error) {
    return false;
  }
}

App({
  onLaunch() {
    AppStore.initialize();
    initializeCloud();
    AuthStore.bootstrap().catch(() => {});
  },

  globalData: {
    appName: '即出',
    initializedAt: ''
  }
});
