const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const MyProductsService = require('../../services/my-products-service');
const ProductEditService = require('../../services/product-edit-service');
const NavigationService = require('../../services/navigation-service');
const AppStore = require('../../store/app-store');
const { PRODUCT_STATUS } = require('../../constants/product');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

const STATUS_TABS = [
  {
    value: PRODUCT_STATUS.AVAILABLE,
    label: '在售'
  },
  {
    value: PRODUCT_STATUS.OFFLINE,
    label: '已下架'
  },
  {
    value: PRODUCT_STATUS.SOLD,
    label: '已售出'
  }
];

const ACTION_META = {
  takeOffline: {
    title: '确认下架商品？',
    content: '下架后商品将从公开列表隐藏，可在“已下架”中重新上架。',
    confirmText: '确认下架',
    successText: '商品已下架'
  },
  relist: {
    title: '确认重新上架？',
    content: '重新上架后商品会再次出现在公开列表中。',
    confirmText: '重新上架',
    successText: '商品已重新上架'
  },
  markSold: {
    title: '确认标记为已售？',
    content: '标记后不能在本阶段直接恢复为在售，请确认已经完成线下面交。',
    confirmText: '标记已售',
    successText: '商品已标记为已售'
  },
  softDelete: {
    title: '确认删除商品？',
    content: '删除后商品将不再展示，此操作暂不支持恢复。',
    confirmText: '确认删除',
    successText: '商品已删除'
  }
};

Page({
  data: {
    statusTabs: STATUS_TABS,
    selectedStatus: PRODUCT_STATUS.AVAILABLE,
    products: [],
    authStatus: 'idle',
    isLoggedIn: false,
    isRestoring: false,
    viewState: 'initial',
    isLoading: false,
    isRefreshing: false,
    isLoadingMore: false,
    loadMoreError: false,
    errorMessage: '',
    page: 1,
    pageSize: 6,
    total: 0,
    hasMore: false,
    isManaging: false,
    managingProductId: '',
    managingAction: ''
  },

  onLoad() {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.initialLoadStarted = false;
    this.loginGuardPromise = null;
    this.actionPromise = null;
    this.observedProductsVersion = AppStore.getProductsVersion();

    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }

      const isLoggedIn = state.status === 'authenticated'
        && Boolean(state.user)
        && state.user.profileCompleted === true;
      this.setData({
        authStatus: state.status,
        isLoggedIn,
        isRestoring: state.restoring
      });

      if (isLoggedIn && !this.initialLoadStarted) {
        this.initialLoadStarted = true;
        this.loadProducts({ mode: 'initial' });
      } else if (
        !isLoggedIn
        && state.initialized
        && !state.restoring
      ) {
        this.ensureLogin();
      }
    });

    if (!AuthStore.isLoggedIn()) {
      this.ensureLogin();
    }
  },

  onShow() {
    const productsVersion = AppStore.getProductsVersion();
    if (
      this.isPageActive
      && AuthStore.isLoggedIn()
      && this.initialLoadStarted
      && productsVersion !== this.observedProductsVersion
    ) {
      this.observedProductsVersion = productsVersion;
      this.loadProducts({ mode: 'query' });
      return;
    }
    if (
      this.isPageActive
      && AuthStore.isLoggedIn()
      && !this.initialLoadStarted
    ) {
      this.initialLoadStarted = true;
      this.loadProducts({ mode: 'initial' });
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

  async ensureLogin() {
    if (this.loginGuardPromise) {
      return this.loginGuardPromise;
    }

    const operation = AuthGuard.requireLogin({
      target: AUTH_TARGETS.MY_PRODUCTS
    });
    this.loginGuardPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.loginGuardPromise === operation) {
        this.loginGuardPromise = null;
      }
    }
  },

  async onPullDownRefresh() {
    if (
      !this.data.isLoggedIn
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
      !this.data.isLoggedIn
      || this.data.viewState !== 'success'
      || !this.data.hasMore
      || this.data.isLoading
      || this.data.isRefreshing
      || this.data.isLoadingMore
      || this.data.loadMoreError
    ) {
      return;
    }
    this.loadProducts({ mode: 'loadMore' });
  },

  async loadProducts({ mode }) {
    if (!this.isPageActive || !AuthStore.isLoggedIn()) {
      return false;
    }

    const isLoadMore = mode === 'loadMore';
    const nextPage = isLoadMore ? this.data.page + 1 : 1;
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;

    if (mode === 'initial' || mode === 'query') {
      this.setData({
        products: mode === 'query' ? [] : this.data.products,
        viewState: 'loading',
        isLoading: true,
        page: 1,
        total: 0,
        hasMore: false,
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
      const result = await MyProductsService.getMyProducts({
        status: this.data.selectedStatus,
        page: nextPage,
        pageSize: this.data.pageSize
      });
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return false;
      }

      const products = isLoadMore
        ? this.mergeProducts(this.data.products, result.list)
        : result.list;
      this.setData({
        products,
        viewState: products.length > 0 ? 'success' : 'empty',
        page: result.page,
        total: result.total,
        hasMore: result.hasMore,
        errorMessage: '',
        loadMoreError: false
      });
      return true;
    } catch (error) {
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return false;
      }

      if (error && error.code === 'UNAUTHORIZED') {
        AuthStore.logout();
        this.ensureLogin();
      } else if (mode === 'loadMore') {
        this.setData({ loadMoreError: true });
      } else if (mode === 'refresh' && this.data.products.length > 0) {
        wx.showToast({
          title: '刷新失败，已保留当前列表',
          icon: 'none'
        });
      } else {
        this.setData({
          viewState: 'error',
          errorMessage: error && error.message
            ? error.message
            : '商品管理服务暂不可用，请稍后重试'
        });
      }
      return false;
    } finally {
      if (this.isPageActive && requestVersion === this.requestVersion) {
        this.setData({
          isLoading: false,
          isRefreshing: false,
          isLoadingMore: false
        });
      }
    }
  },

  mergeProducts(currentProducts, nextProducts) {
    const products = [];
    const seenIds = new Set();
    currentProducts.concat(nextProducts).forEach((product) => {
      if (!product || !product.id || seenIds.has(product.id)) {
        return;
      }
      seenIds.add(product.id);
      products.push(product);
    });
    return products;
  },

  onStatusChange(event) {
    const { status } = event.currentTarget.dataset;
    if (
      !STATUS_TABS.some((tab) => tab.value === status)
      || status === this.data.selectedStatus
      || this.data.isManaging
    ) {
      return;
    }

    this.requestVersion += 1;
    this.setData({
      selectedStatus: status,
      products: [],
      page: 1,
      total: 0,
      hasMore: false,
      loadMoreError: false
    }, () => {
      this.loadProducts({ mode: 'query' });
    });
  },

  confirmAction(meta) {
    return new Promise((resolve) => {
      wx.showModal({
        title: meta.title,
        content: meta.content,
        confirmText: meta.confirmText,
        confirmColor: '#16a36a',
        success(result) {
          resolve(result.confirm === true);
        },
        fail() {
          resolve(false);
        }
      });
    });
  },

  async onManageTap(event) {
    const { action, id, version } = event.currentTarget.dataset;
    const meta = ACTION_META[action];
    if (
      !meta
      || !id
      || this.data.isManaging
      || this.actionPromise
    ) {
      return;
    }

    const confirmed = await this.confirmAction(meta);
    if (!confirmed || !this.isPageActive) {
      return;
    }

    this.setData({
      isManaging: true,
      managingProductId: id,
      managingAction: action
    });

    const operation = action === 'softDelete'
      ? MyProductsService.softDelete(
        id,
        version,
        ProductEditService.createMutationId()
      )
      : MyProductsService.manageProduct(action, id);
    this.actionPromise = operation;
    try {
      const result = await operation;
      if (!this.isPageActive) {
        return;
      }

      const products = this.data.products.filter((product) => product.id !== id);
      this.setData({
        products,
        total: Math.max(0, this.data.total - 1),
        viewState: products.length > 0 ? 'success' : 'empty'
      });
      this.observedProductsVersion = AppStore.markProductsChanged();
      wx.showToast({
        title: result && result.cleanupPending
          ? '商品已删除，部分图片待清理'
          : meta.successText,
        icon: result && result.cleanupPending ? 'none' : 'success'
      });
    } catch (error) {
      if (!this.isPageActive) {
        return;
      }
      if (error && error.code === 'UNAUTHORIZED') {
        AuthStore.logout();
        this.ensureLogin();
      } else {
        wx.showToast({
          title: error && error.message
            ? error.message
            : '操作失败，请稍后重试',
          icon: 'none'
        });
      }
    } finally {
      if (this.actionPromise === operation) {
        this.actionPromise = null;
      }
      if (this.isPageActive) {
        this.setData({
          isManaging: false,
          managingProductId: '',
          managingAction: ''
        });
      }
    }
  },

  onProductTap(event) {
    const { id, status } = event.currentTarget.dataset;
    if (!id) {
      return;
    }
    if (status === PRODUCT_STATUS.OFFLINE) {
      wx.showToast({
        title: '已下架商品暂不提供公开详情',
        icon: 'none'
      });
      return;
    }
    NavigationService.safeNavigateTo(
      `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(id)}`
    );
  },

  onEditTap(event) {
    const { id, status } = event.currentTarget.dataset;
    if (
      !id
      || ![PRODUCT_STATUS.AVAILABLE, PRODUCT_STATUS.OFFLINE].includes(status)
      || this.data.isManaging
    ) {
      return;
    }
    NavigationService.safeNavigateTo(
      `${ROUTES.PRODUCT_EDIT}?id=${encodeURIComponent(id)}`
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

  goLogin() {
    this.ensureLogin();
  }
});
