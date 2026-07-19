const AuthStore = require('../../store/auth-store');
const AppStore = require('../../store/app-store');
const AuthGuard = require('../../services/auth-guard');
const FavoriteService = require('../../services/favorite-service');
const NavigationService = require('../../services/navigation-service');
const { ROUTES, AUTH_TARGETS } = require('../../constants/routes');

const PAGE_SIZE = 6;

Page({
  data: {
    isLoggedIn: false,
    isRestoring: false,
    viewState: 'loading',
    favorites: [],
    total: 0,
    page: 1,
    hasMore: false,
    isLoadingMore: false,
    loadMoreError: '',
    errorMessage: '',
    removingProductId: ''
  },

  onLoad() {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.lastFavoritesVersion = AppStore.getFavoritesVersion();
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const isLoggedIn = state.status === 'authenticated' && Boolean(state.user);
      const wasLoggedIn = this.data.isLoggedIn;
      this.setData({
        isLoggedIn,
        isRestoring: state.restoring
      });
      if (isLoggedIn && !wasLoggedIn) {
        this.loadFavorites({ reset: true });
      }
    });
    if (!AuthStore.isLoggedIn()) {
      AuthGuard.requireLogin({ target: AUTH_TARGETS.FAVORITES });
    }
  },

  onShow() {
    if (!AuthStore.isLoggedIn()) {
      return;
    }
    const version = AppStore.getFavoritesVersion();
    if (
      version !== this.lastFavoritesVersion
      && !this.data.isLoadingMore
      && !this.data.removingProductId
    ) {
      this.lastFavoritesVersion = version;
      this.loadFavorites({ reset: true });
    }
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  },

  async loadFavorites(options = {}) {
    if (!this.isPageActive || !AuthStore.isLoggedIn()) {
      return;
    }
    const reset = options.reset === true;
    if (!reset && (this.data.isLoadingMore || !this.data.hasMore)) {
      return;
    }
    const page = reset ? 1 : this.data.page + 1;
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;
    if (reset) {
      this.setData({
        viewState: 'loading',
        favorites: [],
        total: 0,
        page: 1,
        hasMore: false,
        errorMessage: '',
        loadMoreError: ''
      });
    } else {
      this.setData({ isLoadingMore: true, loadMoreError: '' });
    }

    try {
      const result = await FavoriteService.listMyFavorites({
        page,
        pageSize: PAGE_SIZE
      });
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }
      const existing = reset ? [] : this.data.favorites;
      const ids = new Set(existing.map((item) => item.id));
      const favorites = existing.concat(
        result.list.filter((item) => !ids.has(item.id))
      );
      this.lastFavoritesVersion = AppStore.getFavoritesVersion();
      this.setData({
        favorites,
        total: result.total,
        page: result.page,
        hasMore: result.hasMore,
        viewState: favorites.length > 0 ? 'success' : 'empty',
        errorMessage: '',
        isLoadingMore: false,
        loadMoreError: ''
      });
    } catch (error) {
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }
      const message = error && error.message
        ? error.message
        : '收藏列表加载失败，请稍后重试';
      this.setData(reset ? {
        viewState: 'error',
        errorMessage: message,
        isLoadingMore: false
      } : {
        isLoadingMore: false,
        loadMoreError: message
      });
    }
  },

  onRetry() {
    this.loadFavorites({ reset: true });
  },

  onLoadMoreRetry() {
    this.loadFavorites();
  },

  onReachBottom() {
    this.loadFavorites();
  },

  async onPullDownRefresh() {
    try {
      await this.loadFavorites({ reset: true });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  onProductTap(event) {
    const productId = event.currentTarget.dataset.id;
    const status = event.currentTarget.dataset.status;
    if (status === 'offline') {
      wx.showToast({
        title: '商品已下架，暂不可查看详情',
        icon: 'none'
      });
      return;
    }
    NavigationService.safeNavigateTo(
      `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(productId)}`
    );
  },

  async onRemoveFavorite(event) {
    const productId = event.currentTarget.dataset.id;
    if (
      !productId
      || this.data.removingProductId
    ) {
      return;
    }
    this.setData({
      removingProductId: productId
    });
    try {
      await FavoriteService.removeFavorite(productId);
      if (!this.isPageActive) {
        return;
      }
      const favorites = this.data.favorites.filter((item) => item.id !== productId);
      AppStore.markFavoritesChanged();
      this.lastFavoritesVersion = AppStore.getFavoritesVersion();
      this.setData({
        favorites,
        total: Math.max(0, this.data.total - 1),
        viewState: favorites.length > 0 ? 'success' : 'empty'
      });
      wx.showToast({ title: '已取消收藏', icon: 'none' });
    } catch (error) {
      if (this.isPageActive) {
        wx.showToast({
          title: error && error.message ? error.message : '取消收藏失败，请重试',
          icon: 'none'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({
          removingProductId: ''
        });
      }
    }
  },

  goLogin() {
    AuthGuard.requireLogin({ target: AUTH_TARGETS.FAVORITES });
  }
});
