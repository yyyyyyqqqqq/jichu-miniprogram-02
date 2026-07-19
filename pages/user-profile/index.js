const PublicUserService = require('../../services/public-user-service');
const NavigationService = require('../../services/navigation-service');
const { ROUTES } = require('../../constants/routes');

const PAGE_SIZE = 6;

Page({
  data: {
    publicUserId: '',
    profile: null,
    products: [],
    viewState: 'loading',
    errorMessage: '',
    page: 1,
    hasMore: false,
    isLoadingMore: false,
    loadMoreError: ''
  },

  onLoad(options) {
    this.isPageActive = true;
    this.requestVersion = 0;
    const publicUserId = PublicUserService.normalizePublicUserId(
      options && options.userId
    );
    if (!publicUserId) {
      this.setData({
        viewState: 'error',
        errorMessage: '用户主页链接无效'
      });
      return;
    }
    this.setData({ publicUserId });
    this.loadPage();
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
  },

  async loadPage() {
    if (!this.isPageActive || !this.data.publicUserId) {
      return;
    }
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;
    this.setData({
      viewState: 'loading',
      profile: null,
      products: [],
      errorMessage: '',
      page: 1,
      hasMore: false,
      isLoadingMore: false,
      loadMoreError: ''
    });
    try {
      const [profile, productResult] = await Promise.all([
        PublicUserService.getPublicProfile(this.data.publicUserId),
        PublicUserService.getPublicProducts(this.data.publicUserId, {
          page: 1,
          pageSize: PAGE_SIZE
        })
      ]);
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }
      this.setData({
        profile: {
          ...profile,
          joinDateText: this.formatJoinDate(profile.joinDate)
        },
        products: productResult.list,
        page: productResult.page,
        hasMore: productResult.hasMore,
        viewState: 'success'
      });
    } catch (error) {
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }
      this.setData({
        viewState: 'error',
        errorMessage: error && error.message
          ? error.message
          : '用户主页加载失败，请稍后重试'
      });
    }
  },

  formatJoinDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '加入时间未知';
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月加入`;
  },

  async loadMore() {
    if (
      !this.isPageActive
      || this.data.viewState !== 'success'
      || this.data.isLoadingMore
      || !this.data.hasMore
    ) {
      return;
    }
    const requestVersion = this.requestVersion;
    this.setData({ isLoadingMore: true, loadMoreError: '' });
    try {
      const result = await PublicUserService.getPublicProducts(
        this.data.publicUserId,
        {
          page: this.data.page + 1,
          pageSize: PAGE_SIZE
        }
      );
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }
      const ids = new Set(this.data.products.map((item) => item.id));
      this.setData({
        products: this.data.products.concat(
          result.list.filter((item) => !ids.has(item.id))
        ),
        page: result.page,
        hasMore: result.hasMore,
        isLoadingMore: false
      });
    } catch (error) {
      if (this.isPageActive && requestVersion === this.requestVersion) {
        this.setData({
          isLoadingMore: false,
          loadMoreError: error && error.message
            ? error.message
            : '加载更多失败，请重试'
        });
      }
    }
  },

  onReachBottom() {
    this.loadMore();
  },

  onLoadMoreRetry() {
    this.loadMore();
  },

  async onPullDownRefresh() {
    try {
      await this.loadPage();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  onRetry() {
    this.loadPage();
  },

  onProductTap(event) {
    const productId = event.currentTarget.dataset.id;
    NavigationService.safeNavigateTo(
      `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(productId)}`
    );
  }
});
