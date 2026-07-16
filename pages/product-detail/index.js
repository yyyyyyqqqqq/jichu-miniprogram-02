const ProductService = require('../../services/product-service');
const NavigationService = require('../../services/navigation-service');
const AuthGuard = require('../../services/auth-guard');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

Page({
  data: {
    product: null,
    productId: '',
    viewState: 'loading',
    showErrorState: false,
    canRetry: false,
    errorTitle: '',
    errorDescription: '',
    errorActionText: ''
  },

  onLoad(options) {
    this.isPageActive = true;
    this.requestVersion = 0;

    const id = this.normalizeProductId(options && options.id);
    if (!id) {
      this.showInvalidParameter();
      return;
    }

    this.productId = id;
    this.setData({ productId: id });
    this.loadProduct();
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
  },

  normalizeProductId(value) {
    if (value === null || value === undefined) {
      return '';
    }

    const id = String(value).trim();
    return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : '';
  },

  showInvalidParameter() {
    this.setData({
      product: null,
      viewState: 'invalid',
      showErrorState: true,
      canRetry: false,
      errorTitle: '商品参数不完整',
      errorDescription: '当前链接缺少有效商品 ID，请返回首页重新选择商品',
      errorActionText: '返回首页'
    });
  },

  async loadProduct() {
    if (!this.isPageActive || !this.productId) {
      return;
    }

    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;

    this.setData({
      product: null,
      viewState: 'loading',
      showErrorState: false,
      canRetry: false
    });

    try {
      const product = await ProductService.getProductById(this.productId);
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }

      if (!product) {
        this.setData({
          product: null,
          viewState: 'notFound',
          showErrorState: true,
          canRetry: true,
          errorTitle: '商品不存在或已下架',
          errorDescription: '当前商品不可公开查看，或分享链接已经失效',
          errorActionText: '重新加载'
        });
        return;
      }

      this.setData({
        product,
        viewState: 'success',
        showErrorState: false,
        canRetry: false
      });
    } catch (error) {
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }

      this.setData({
        product: null,
        viewState: 'error',
        showErrorState: true,
        canRetry: true,
        errorTitle: '商品详情加载失败',
        errorDescription: error && error.message
          ? error.message
          : '商品服务暂不可用，请稍后重试',
        errorActionText: '重新加载'
      });
    }
  },

  onErrorAction() {
    if (this.data.canRetry) {
      this.loadProduct();
      return;
    }
    this.goHome();
  },

  goHome() {
    NavigationService.safeSwitchTab(ROUTES.HOME);
  },

  async onFavoriteTap() {
    if (this.data.product && this.data.product.isSold) {
      return;
    }

    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PRODUCT_DETAIL,
      productId: this.data.productId
    });
    if (!allowed) {
      return;
    }

    wx.showToast({
      title: '收藏功能将在后续阶段开放',
      icon: 'none'
    });
  },

  async onContactTap() {
    const { product } = this.data;
    if (!product) {
      return;
    }

    if (product.isSold) {
      wx.showToast({
        title: '商品已完成面交',
        icon: 'none'
      });
      return;
    }

    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PRODUCT_DETAIL,
      productId: this.data.productId
    });
    if (!allowed) {
      return;
    }

    wx.showToast({
      title: product.isReserved
        ? '商品已预订，聊天功能将在后续开放'
        : '聊天功能将在后续阶段开放',
      icon: 'none'
    });
  },

  onSellerTap() {
    const { product } = this.data;
    if (!product || !product.seller || !product.seller.id) {
      return;
    }

    NavigationService.safeNavigateTo(
      `${ROUTES.USER_PROFILE}?id=${encodeURIComponent(product.seller.id)}`
    );
  },

  onShareAppMessage() {
    const { product } = this.data;
    if (!product || !product.id) {
      return {
        title: '闲置面交——校园闲置物品平台',
        path: ROUTES.HOME
      };
    }

    return {
      title: product.title,
      path: `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(product.id)}`
    };
  }
});
