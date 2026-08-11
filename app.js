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
    // 前台恢复时立即把 AuthStore 切入刷新流程，让页面 onShow 的守卫
    // 能等待同一个 current 请求，避免地图等原生界面返回时误判为未登录。
    AuthStore.refreshCurrentUser().catch(() => {});
  },

  globalData: {
    appName: '即出',
    initializedAt: ''
  }
});
