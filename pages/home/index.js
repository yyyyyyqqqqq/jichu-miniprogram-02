const ProductService = require('../../services/product-service');
const AuthGuard = require('../../services/auth-guard');
const AuthStore = require('../../store/auth-store');
const NavigationService = require('../../services/navigation-service');
const AppStore = require('../../store/app-store');
const { CATEGORIES } = require('../../constants/categories');
const {
  PRODUCT_SORT,
  PRODUCT_SORT_OPTIONS
} = require('../../constants/product');
const { ROUTES, AUTH_TARGETS } = require('../../constants/routes');

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
    hasMore: false,
    marketMode: '',
    marketScope: {
      schoolId: '',
      schoolName: ''
    },
    nextCursor: '',
    queryScopeKey: '',
    guideType: '',
    guideTitle: '',
    guideDescription: '',
    guideActionText: ''
  },

  onLoad() {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.hasLoadedMarket = false;
    this.authScopeKey = this.buildAuthScopeKey(AuthStore.getState());
    this.observedProductsVersion = AppStore.getProductsVersion();
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      this.handleAuthStateChange(state);
    });
  },

  async onShow() {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 'home' });
    }

    const allowed = await AuthGuard.requireMarketAccess({
      target: AUTH_TARGETS.HOME
    });
    if (!this.isPageActive) {
      return;
    }
    if (!allowed) {
      this.requestVersion += 1;
      this.hasLoadedMarket = false;
      this.authScopeKey = this.buildAuthScopeKey(AuthStore.getState());
      this.showMarketGuide(this.getLocalGuideType());
      return;
    }
    const nextAuthScopeKey = this.buildAuthScopeKey(AuthStore.getState());
    if (nextAuthScopeKey !== this.authScopeKey) {
      this.authScopeKey = nextAuthScopeKey;
      this.requestVersion += 1;
      this.hasLoadedMarket = false;
      this.resetMarketWindow({
        marketMode: '',
        marketScope: {
          schoolId: '',
          schoolName: ''
        }
      });
    }
    if (!this.hasLoadedMarket) {
      this.hasLoadedMarket = true;
      await this.loadProducts({ mode: 'initial' });
      return;
    }

    const productsVersion = AppStore.getProductsVersion();
    if (
      this.isPageActive
      && productsVersion !== this.observedProductsVersion
    ) {
      this.observedProductsVersion = productsVersion;
      this.cancelSearchTimer();
      this.loadProducts({ mode: 'query' });
    }
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
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

  buildAuthScopeKey(authState) {
    const state = authState && typeof authState === 'object' ? authState : {};
    const user = state.user && typeof state.user === 'object' ? state.user : {};
    return [
      state.status || '',
      user.id || '',
      user.profileCompleted === true ? 'profileReady' : 'profileRequired',
      user.schoolId || '',
      user.schoolVersion || 0,
      user.schoolRequired === false ? 'schoolSelected' : 'schoolRequired',
      user.schoolUnavailable === true ? 'schoolUnavailable' : 'schoolAvailable'
    ].join('|');
  },

  handleAuthStateChange(authState) {
    if (!this.isPageActive) {
      return;
    }
    const nextAuthScopeKey = this.buildAuthScopeKey(authState);
    if (nextAuthScopeKey === this.authScopeKey) {
      return;
    }
    this.authScopeKey = nextAuthScopeKey;
    this.requestVersion += 1;
    this.hasLoadedMarket = false;
    this.cancelSearchTimer();

    if (authState.status === AuthStore.AUTH_STATUS.ANONYMOUS) {
      this.showMarketGuide('login');
      return;
    }
    if (authState.status === AuthStore.AUTH_STATUS.AUTHENTICATED) {
      if (!authState.user || authState.user.profileCompleted !== true) {
        this.showMarketGuide('profile');
        return;
      }
      if (authState.user.schoolUnavailable === true) {
        this.showMarketGuide('schoolUnavailable');
        return;
      }
      if (!AuthStore.isSchoolReady()) {
        this.showMarketGuide('schoolRequired');
        return;
      }
      this.resetMarketWindow({
        viewState: 'initial',
        marketMode: '',
        marketScope: {
          schoolId: '',
          schoolName: ''
        },
        querySummary: '正在准备商品'
      });
    }
  },

  buildQueryScopeKey(options = {}) {
    return [
      options.marketMode || '',
      options.schoolId || '',
      options.categoryId || 'all',
      String(options.keyword || '').trim().replace(/\s+/g, ' ').toLowerCase(),
      options.sortBy || PRODUCT_SORT.DEFAULT
    ].join('|');
  },

  captureRequestScope() {
    return {
      marketMode: this.data.marketMode,
      schoolId: this.data.marketScope.schoolId,
      categoryId: this.data.selectedCategoryId,
      keyword: this.data.keyword,
      sortBy: this.data.selectedSortBy,
      queryScopeKey: this.data.queryScopeKey
    };
  },

  isRequestScopeCurrent(scope) {
    return Boolean(
      scope
      && scope.categoryId === this.data.selectedCategoryId
      && scope.keyword === this.data.keyword
      && scope.sortBy === this.data.selectedSortBy
    );
  },

  resetMarketWindow(extra = {}) {
    this.setData(Object.assign({
      products: [],
      page: 1,
      total: 0,
      hasMore: false,
      nextCursor: '',
      queryScopeKey: '',
      loadMoreError: false,
      errorMessage: '',
      emptyTitle: '',
      emptyDescription: '',
      emptyActionText: '',
      guideType: '',
      guideTitle: '',
      guideDescription: '',
      guideActionText: ''
    }, extra));
  },

  getLocalGuideType() {
    const state = AuthStore.getState();
    const user = state.user;
    if (state.status !== AuthStore.AUTH_STATUS.AUTHENTICATED || !user) {
      return 'login';
    }
    if (user.profileCompleted !== true) {
      return 'profile';
    }
    if (user.schoolUnavailable === true) {
      return 'schoolUnavailable';
    }
    return 'schoolRequired';
  },

  showMarketGuide(type) {
    const guides = {
      login: {
        title: '登录后查看你的校园二手市场',
        description: '登录并选择学校后，只浏览本校发布的闲置商品',
        actionText: '去登录'
      },
      profile: {
        title: '请先完善个人资料',
        description: '完成头像和昵称后，再选择学校进入校园市场',
        actionText: '完善资料'
      },
      schoolUnavailable: {
        title: '当前学校暂不可用',
        description: '请重新选择已开放的学校，校园市场不会回退到全市场',
        actionText: '重新选校'
      },
      schoolRequired: {
        title: '选择学校后进入市场',
        description: '校园商品按学校隔离，历史无学校商品不会进入本校市场',
        actionText: '选择学校'
      }
    };
    const guide = guides[type] || guides.schoolRequired;
    this.resetMarketWindow({
      viewState: 'guide',
      isLoading: false,
      isQuerying: false,
      isLoadingMore: false,
      isRefreshing: false,
      querySummary: guide.title,
      marketMode: '',
      marketScope: {
        schoolId: '',
        schoolName: ''
      },
      guideType: type,
      guideTitle: guide.title,
      guideDescription: guide.description,
      guideActionText: guide.actionText
    });
  },

  getGuideTypeForError(error) {
    const code = error && error.code;
    if (code === 'AUTH_REQUIRED' || code === 'USER_NOT_FOUND') {
      return 'login';
    }
    if (code === 'PROFILE_INCOMPLETE') {
      return 'profile';
    }
    if (
      code === 'SCHOOL_UNAVAILABLE'
      || code === 'SCHOOL_INVALID'
      || code === 'SCHOOL_CONTEXT_MISMATCH'
      || code === 'USER_INACTIVE'
    ) {
      return 'schoolUnavailable';
    }
    if (code === 'SCHOOL_REQUIRED') {
      return 'schoolRequired';
    }
    return '';
  },

  async loadProducts({ mode }) {
    if (!this.isPageActive) {
      return false;
    }

    const isLoadMore = mode === 'loadMore';
    const nextPage = isLoadMore ? this.data.page + 1 : 1;
    const nextCursor = isLoadMore ? this.data.nextCursor : '';
    const requestScope = this.captureRequestScope();
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
        nextCursor: '',
        queryScopeKey: '',
        isLoading: true,
        isQuerying: true,
        errorMessage: '',
        loadMoreError: false
      });
    } else if (mode === 'refresh') {
      this.setData({
        isRefreshing: true,
        loadMoreError: false,
        page: 1,
        nextCursor: '',
        queryScopeKey: ''
      });
    } else {
      this.setData({
        isLoadingMore: true,
        loadMoreError: false
      });
    }

    try {
      const result = await ProductService.getProducts({
        categoryId: requestScope.categoryId,
        keyword: requestScope.keyword,
        sortBy: requestScope.sortBy,
        page: nextPage,
        cursor: nextCursor,
        marketMode: requestScope.marketMode,
        pageSize: this.data.pageSize
      });

      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
        || !this.isRequestScopeCurrent(requestScope)
      ) {
        return false;
      }

      const responseSchoolId = result.scope.schoolId;
      if (
        isLoadMore
        && (
          result.marketMode !== requestScope.marketMode
          || responseSchoolId !== requestScope.schoolId
          || requestScope.queryScopeKey !== this.data.queryScopeKey
        )
      ) {
        this.requestVersion += 1;
        this.hasLoadedMarket = true;
        this.resetMarketWindow({
          viewState: 'loading',
          marketMode: result.marketMode,
          marketScope: result.scope,
          querySummary: '市场范围已变化，正在重新加载'
        });
        return this.loadProducts({ mode: 'query' });
      }

      const products = isLoadMore
        ? this.mergeProducts(this.data.products, result.list)
        : result.list;
      const emptyState = this.buildEmptyState();
      const queryScopeKey = this.buildQueryScopeKey({
        marketMode: result.marketMode,
        schoolId: responseSchoolId,
        categoryId: requestScope.categoryId,
        keyword: requestScope.keyword,
        sortBy: requestScope.sortBy
      });

      this.setData({
        products,
        viewState: products.length > 0 ? 'success' : 'empty',
        page: result.marketMode === ProductService.MARKET_MODE.SCHOOL_SCOPED
          ? null
          : result.page || 1,
        total: result.total,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        marketMode: result.marketMode,
        marketScope: result.scope,
        queryScopeKey,
        errorMessage: '',
        emptyTitle: emptyState.title,
        emptyDescription: emptyState.description,
        emptyActionText: emptyState.actionText,
        querySummary: this.buildQuerySummary({
          ...result,
          list: products
        })
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
        const guideType = this.getGuideTypeForError(error);
        if (guideType) {
          this.showMarketGuide(guideType);
        } else {
          this.setData({
            viewState: 'error',
            errorMessage: error && error.message
              ? error.message
              : '商品服务暂不可用，请稍后重试'
          });
        }
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

  buildQuerySummary(result) {
    const category = this.data.categories.find((item) => (
      item.id === this.data.selectedCategoryId
    ));
    const sort = this.data.sortOptions.find((item) => (
      item.value === this.data.selectedSortBy
    ));
    const keyword = this.data.keyword.trim().replace(/\s+/g, ' ');
    const parts = [
      result.marketMode === ProductService.MARKET_MODE.SCHOOL_SCOPED
        ? result.scope.schoolName
        : '',
      keyword ? `“${keyword}”` : '',
      category ? category.name : '推荐',
      sort ? sort.label : '综合'
    ].filter(Boolean);
    const countText = typeof result.total === 'number'
      ? `共 ${result.total} 件`
      : `已加载 ${result.list.length} 件`;
    return `${parts.join(' · ')} · ${countText}`;
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
      nextCursor: '',
      queryScopeKey: '',
      loadMoreError: false
    });
    this.scheduleSearch();
  },

  onSearchConfirm(event) {
    this.cancelSearchTimer();
    this.requestVersion += 1;
    this.setData({
      keyword: event.detail.value,
      page: 1,
      nextCursor: '',
      queryScopeKey: ''
    }, () => {
      this.loadProducts({ mode: 'query' });
    });
  },

  onSearchClear() {
    this.cancelSearchTimer();
    this.requestVersion += 1;
    this.setData({
      keyword: '',
      page: 1,
      nextCursor: '',
      queryScopeKey: ''
    }, () => {
      this.loadProducts({ mode: 'query' });
    });
  },

  onCategoryChange(event) {
    this.cancelSearchTimer();
    this.requestVersion += 1;
    this.setData({
      selectedCategoryId: event.detail.id,
      page: 1,
      nextCursor: '',
      queryScopeKey: ''
    }, () => {
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
    this.setData({
      selectedSortBy: sortBy,
      page: 1,
      nextCursor: '',
      queryScopeKey: ''
    }, () => {
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

  async onMarketGuideAction() {
    let allowed = false;
    if (this.data.guideType === 'schoolUnavailable') {
      try {
        await AuthStore.refreshCurrentUser();
      } catch (error) {
        return;
      }
    }
    allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.HOME
    });
    if (allowed && this.isPageActive) {
      this.authScopeKey = this.buildAuthScopeKey(AuthStore.getState());
      this.hasLoadedMarket = true;
      this.loadProducts({ mode: 'query' });
    }
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
        selectedSortBy: PRODUCT_SORT.DEFAULT,
        page: 1,
        nextCursor: '',
        queryScopeKey: ''
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
