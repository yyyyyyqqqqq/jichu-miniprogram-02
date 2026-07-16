const ProductService = require('../../services/product-service');
const NavigationService = require('../../services/navigation-service');
const { CATEGORIES } = require('../../constants/categories');
const { ROUTES } = require('../../constants/routes');

Page({
  data: {
    categories: CATEGORIES,
    selectedCategoryId: 'all',
    keyword: '',
    products: [],
    loading: true,
    loadingMore: false,
    errorMessage: '',
    page: 1,
    pageSize: 4,
    total: 0,
    hasMore: false
  },

  onLoad() {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.loadProducts({ reset: true });
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 'home' });
    }
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  },

  async onPullDownRefresh() {
    try {
      await this.loadProducts({ reset: true });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) {
      return;
    }
    this.loadProducts({ reset: false });
  },

  async loadProducts({ reset }) {
    const nextPage = reset ? 1 : this.data.page + 1;
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;

    this.setData({
      loading: reset,
      loadingMore: !reset,
      errorMessage: reset ? '' : this.data.errorMessage
    });

    try {
      const result = await ProductService.getProducts({
        categoryId: this.data.selectedCategoryId,
        keyword: this.data.keyword,
        page: nextPage,
        pageSize: this.data.pageSize
      });

      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }

      this.setData({
        products: reset ? result.list : this.data.products.concat(result.list),
        page: result.page,
        total: result.total,
        hasMore: result.hasMore,
        errorMessage: ''
      });
    } catch (error) {
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }

      if (reset) {
        this.setData({
          errorMessage: '商品加载失败，请稍后重试'
        });
      } else {
        wx.showToast({
          title: '加载更多失败，请重试',
          icon: 'none'
        });
      }
    } finally {
      if (this.isPageActive && requestVersion === this.requestVersion) {
        this.setData({
          loading: false,
          loadingMore: false
        });
      }
    }
  },

  scheduleSearch() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      if (this.isPageActive) {
        this.loadProducts({ reset: true });
      }
    }, 280);
  },

  onKeywordInput(event) {
    this.setData({ keyword: event.detail.value });
    this.scheduleSearch();
  },

  onSearchConfirm(event) {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.setData({ keyword: event.detail.value }, () => {
      this.loadProducts({ reset: true });
    });
  },

  onSearchClear() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.setData({ keyword: '' }, () => {
      this.loadProducts({ reset: true });
    });
  },

  onCategoryChange(event) {
    this.setData({ selectedCategoryId: event.detail.id }, () => {
      this.loadProducts({ reset: true });
    });
  },

  onProductSelect(event) {
    const { id } = event.detail;
    NavigationService.safeNavigateTo(
      `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(id)}`
    );
  },

  onRetry() {
    this.loadProducts({ reset: true });
  }
});
