const AuthService = require('../../services/auth-service');
const NavigationService = require('../../services/navigation-service');
const { ROUTES } = require('../../constants/routes');

Page({
  data: {
    isLoggedIn: false
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 'profile' });
    }
    this.setData({ isLoggedIn: AuthService.isLoggedIn() });
  },

  goLogin() {
    NavigationService.safeNavigateTo(ROUTES.LOGIN);
  },

  goMyProducts() {
    NavigationService.safeNavigateTo(ROUTES.MY_PRODUCTS);
  },

  goFavorites() {
    NavigationService.safeNavigateTo(ROUTES.FAVORITES);
  },

  showAbout() {
    wx.showModal({
      title: '关于即出',
      content: '即出是面向校园闲置物品信息与线下面交的原生微信小程序。本项目不提供在线支付。',
      showCancel: false
    });
  }
});
