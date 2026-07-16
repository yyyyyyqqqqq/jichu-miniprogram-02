const ProductService = require('../../services/product-service');
const NavigationService = require('../../services/navigation-service');
const { CATEGORIES } = require('../../constants/categories');
const {
  PRODUCT_SORT,
  PRODUCT_SORT_OPTIONS
} = require('../../constants/product');
const { ROUTES } = require('../../constants/routes');

Page({
  data: {
    categories: CATEGORIES,
    sortOptions: PRODUCT_SORT_OPTIONS,
    selectedCategoryId: 'all',
    selectedSortBy: PRODUCT_SORT.DEFAULT,
    keyword: '',
    products: [],
    viewState: 'initial',
    isLoading: false,
    isQuerying: false,
    isLoadingMore: false,
    isRefreshing: false,
    loadMoreError: false,
    errorMessage: '',
    emptyTitle: '',
    emptyDescription: '',
    emptyActionText: '',
    querySummary: '正在准备商品',
    page: 1,
    pageSize: 6,
    total: 0,
    hasMore: false
  },

  onLoad() {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.loadProducts({ mode: 'initial' });
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
    if (
      !this.isPageActive
      || this.data.isRefreshing
      || this.data.isLoading
      || this.data.isLoadingMore
    ) {
      wx.stopPullDownRefresh();
      return;
    }

    try {
      await this.loadProducts({ mode: 'refresh' });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  onReachBottom() {
    if (
      !this.isPageActive
      || this.data.viewState !== 'success'
      || !this.data.hasMore
      || this.data.isLoading
      || this.data.isQuerying
      || this.data.isRefreshing
      || this.data.isLoadingMore
      || this.data.loadMoreError
    ) {
      return;
    }

    this.loadProducts({ mode: 'loadMore' });
  },

  async loadProducts({ mode }) {
    if (!this.isPageActive) {
      return false;
    }

    const isLoadMore = mode === 'loadMore';
    const nextPage = isLoadMore ? this.data.page + 1 : 1;
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;

    if (mode === 'initial') {
      this.setData({
        viewState: 'loading',
        isLoading: true,
        errorMessage: '',
        loadMoreError: false
      });
    } else if (mode === 'query') {
      this.setData({
        products: [],
        viewState: 'loading',
        page: 1,
        total: 0,
        hasMore: false,
        isLoading: true,
        isQuerying: true,
        errorMessage: '',
        loadMoreError: false
      });
    } else if (mode === 'refresh') {
      this.setData({
        isRefreshing: true,
        loadMoreError: false
      });
    } else {
      this.setData({
        isLoadingMore: true,
        loadMoreError: false
      });
    }

    try {
      const result = await ProductService.getProducts({
        categoryId: this.data.selectedCategoryId,
        keyword: this.data.keyword,
        sortBy: this.data.selectedSortBy,
        page: nextPage,
        pageSize: this.data.pageSize
      });

      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return false;
      }

      const products = isLoadMore
        ? this.mergeProducts(this.data.products, result.list)
        : result.list;
      const emptyState = this.buildEmptyState();

      this.setData({
        products,
        viewState: products.length > 0 ? 'success' : 'empty',
        page: result.page,
        total: result.total,
        hasMore: result.hasMore,
        errorMessage: '',
        emptyTitle: emptyState.title,
        emptyDescription: emptyState.description,
        emptyActionText: emptyState.actionText,
        querySummary: this.buildQuerySummary(result.total)
      });

      return true;
    } catch (error) {
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return false;
      }

      if (mode === 'loadMore') {
        this.setData({ loadMoreError: true });
      } else if (mode === 'refresh' && this.data.products.length > 0) {
        wx.showToast({
          title: '刷新失败，已保留当前商品',
          icon: 'none'
        });
      } else {
        this.setData({
          viewState: 'error',
          errorMessage: error && error.message
            ? error.message
            : '商品服务暂不可用，请稍后重试'
        });
      }

      return false;
    } finally {
      if (this.isPageActive && requestVersion === this.requestVersion) {
        this.setData({
          isLoading: false,
          isQuerying: false,
          isLoadingMore: false,
          isRefreshing: false
        });
      }
    }
  },

  mergeProducts(currentProducts, nextProducts) {
    const list = [];
    const seenIds = new Set();

    currentProducts.concat(nextProducts).forEach((product) => {
      if (!product || !product.id || seenIds.has(product.id)) {
        return;
      }
      seenIds.add(product.id);
      list.push(product);
    });

    return list;
  },

  buildQuerySummary(total) {
    const category = this.data.categories.find((item) => (
      item.id === this.data.selectedCategoryId
    ));
    const sort = this.data.sortOptions.find((item) => (
      item.value === this.data.selectedSortBy
    ));
    const keyword = this.data.keyword.trim().replace(/\s+/g, ' ');
    const parts = [
      keyword ? `“${keyword}”` : '',
      category ? category.name : '推荐',
      sort ? sort.label : '综合'
    ].filter(Boolean);

    return `${parts.join(' · ')} · 共 ${total} 件`;
  },

  buildEmptyState() {
    const keyword = this.data.keyword.trim().replace(/\s+/g, ' ');
    const category = this.data.categories.find((item) => (
      item.id === this.data.selectedCategoryId
    ));

    if (keyword) {
      return {
        title: `没有找到与“${keyword}”相关的商品`,
        description: '可以清除关键词，或尝试更宽泛的搜索内容',
        actionText: '清除搜索'
      };
    }

    if (this.data.selectedCategoryId !== 'all') {
      return {
        title: `${category ? category.name : '当前'}分类暂时没有商品`,
        description: '换个分类看看其他校园闲置',
        actionText: '查看全部商品'
      };
    }

    return {
      title: '暂时没有可浏览的商品',
      description: '稍后刷新页面再看看',
      actionText: '重新加载'
    };
  },

  scheduleSearch() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }

    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      if (this.isPageActive) {
        this.loadProducts({ mode: 'query' });
      }
    }, 300);
  },

  cancelSearchTimer() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  },

  onKeywordInput(event) {
    this.requestVersion += 1;
    this.setData({
      keyword: event.detail.value,
      products: [],
      viewState: 'loading',
      page: 1,
      total: 0,
      hasMore: false,
      loadMoreError: false
    });
    this.scheduleSearch();
  },

  onSearchConfirm(event) {
    this.cancelSearchTimer();
    this.requestVersion += 1;
    this.setData({ keyword: event.detail.value }, () => {
      this.loadProducts({ mode: 'query' });
    });
  },

  onSearchClear() {
    this.cancelSearchTimer();
    this.requestVersion += 1;
    this.setData({ keyword: '' }, () => {
      this.loadProducts({ mode: 'query' });
    });
  },

  onCategoryChange(event) {
    this.cancelSearchTimer();
    this.requestVersion += 1;
    this.setData({ selectedCategoryId: event.detail.id }, () => {
      this.loadProducts({ mode: 'query' });
      wx.pageScrollTo({
        scrollTop: 0,
        duration: 180
      });
    });
  },

  onSortChange(event) {
    const { sortBy } = event.currentTarget.dataset;
    if (!sortBy || sortBy === this.data.selectedSortBy) {
      return;
    }

    this.cancelSearchTimer();
    this.requestVersion += 1;
    this.setData({ selectedSortBy: sortBy }, () => {
      this.loadProducts({ mode: 'query' });
    });
  },

  onProductSelect(event) {
    const { id } = event.detail;
    NavigationService.safeNavigateTo(
      `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(id)}`
    );
  },

  onRetry() {
    this.loadProducts({ mode: 'query' });
  },

  onLoadMoreRetry() {
    if (!this.data.isLoadingMore && this.data.hasMore) {
      this.loadProducts({ mode: 'loadMore' });
    }
  },

  onEmptyAction() {
    if (this.data.keyword.trim()) {
      this.onSearchClear();
      return;
    }

    if (
      this.data.selectedCategoryId !== 'all'
      || this.data.selectedSortBy !== PRODUCT_SORT.DEFAULT
    ) {
      this.requestVersion += 1;
      this.setData({
        selectedCategoryId: 'all',
        selectedSortBy: PRODUCT_SORT.DEFAULT
      }, () => {
        this.loadProducts({ mode: 'query' });
      });
      return;
    }

    this.loadProducts({ mode: 'query' });
  },

  onShareAppMessage() {
    return {
      title: '闲置面交——校园闲置物品平台',
      path: ROUTES.HOME
    };
  }
});
