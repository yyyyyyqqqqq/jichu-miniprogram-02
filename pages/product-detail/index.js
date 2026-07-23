const ProductService = require('../../services/product-service');
const NavigationService = require('../../services/navigation-service');
const AuthGuard = require('../../services/auth-guard');
const AuthStore = require('../../store/auth-store');
const AppStore = require('../../store/app-store');
const FavoriteService = require('../../services/favorite-service');
const MessageService = require('../../services/message-service');
const { formatCount } = require('../../utils/format');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

function isDevelopmentEnvironment() {
  if (
    typeof wx === 'undefined'
    || typeof wx.getAccountInfoSync !== 'function'
  ) {
    return false;
  }
  try {
    const account = wx.getAccountInfoSync();
    return Boolean(
      account
      && account.miniProgram
      && account.miniProgram.envVersion === 'develop'
    );
  } catch (error) {
    return false;
  }
}

Page({
  data: {
    product: null,
    productId: '',
    viewState: 'loading',
    showErrorState: false,
    canRetry: false,
    errorTitle: '',
    errorDescription: '',
    errorActionText: '',
    isFavorited: false,
    canFavorite: false,
    isOwnProduct: false,
    isFavoriteLoading: false,
    isContactLoading: false
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

  onShow() {
    if (this.data.viewState === 'success' && this.data.product) {
      this.refreshFavoriteStatus();
    }
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
      this.refreshFavoriteStatus();
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
    const { product } = this.data;
    if (!product || this.data.isFavoriteLoading || this.data.isOwnProduct) {
      return;
    }

    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PRODUCT_DETAIL,
      productId: this.data.productId
    });
    if (!allowed) {
      return;
    }

    if (!this.data.isFavorited && !this.data.canFavorite) {
      wx.showToast({
        title: '当前商品暂不可收藏',
        icon: 'none'
      });
      return;
    }

    this.setData({ isFavoriteLoading: true });
    try {
      const result = this.data.isFavorited
        ? await FavoriteService.removeFavorite(this.data.productId)
        : await FavoriteService.addFavorite(this.data.productId);
      if (!this.isPageActive) {
        return;
      }
      this.applyFavoriteState(result);
      AppStore.markFavoritesChanged();
      wx.showToast({
        title: result.isFavorited ? '已收藏' : '已取消收藏',
        icon: 'none'
      });
    } catch (error) {
      if (this.isPageActive) {
        wx.showToast({
          title: error && error.message ? error.message : '收藏操作失败，请重试',
          icon: 'none'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ isFavoriteLoading: false });
      }
    }
  },

  async refreshFavoriteStatus() {
    const { product } = this.data;
    if (!product) {
      return;
    }

    const currentUser = AuthStore.getCurrentUser();
    const isOwnProduct = Boolean(
      currentUser
      && product.seller
      && product.seller.id
      && currentUser.id === product.seller.id
    );
    if (!AuthStore.isLoggedIn()) {
      this.setData({
        isFavorited: false,
        isOwnProduct: false,
        canFavorite: product.status === 'available'
      });
      return;
    }
    if (isOwnProduct) {
      this.setData({
        isFavorited: false,
        isOwnProduct: true,
        canFavorite: false
      });
      return;
    }

    const requestVersion = this.requestVersion;
    try {
      const result = await FavoriteService.getFavoriteStatus(this.data.productId);
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
        || !this.data.product
      ) {
        return;
      }
      this.applyFavoriteState(result);
    } catch (error) {
      if (this.isPageActive && requestVersion === this.requestVersion) {
        this.setData({
          isFavorited: false,
          canFavorite: product.status === 'available',
          isOwnProduct: false
        });
      }
    }
  },

  applyFavoriteState(result) {
    const favoriteCount = Number(result.favoriteCount);
    const safeCount = Number.isFinite(favoriteCount) && favoriteCount >= 0
      ? Math.floor(favoriteCount)
      : 0;
    this.setData({
      isFavorited: result.isFavorited === true,
      canFavorite: result.canFavorite === true,
      isOwnProduct: result.isOwnProduct === true,
      'product.favoriteCount': safeCount,
      'product.favoriteCountText': formatCount(safeCount)
    });
  },

  async onContactTap() {
    const { product } = this.data;
    if (!product || this.data.isContactLoading) {
      return;
    }
    const productId = typeof product.id === 'string'
      ? product.id.trim()
      : '';
    if (isDevelopmentEnvironment()) {
      console.info('[product-detail] contact seller', {
        productId,
        hasProduct: Boolean(product),
        productStatus: product.status || ''
      });
    }
    if (!productId || productId !== this.data.productId) {
      wx.showToast({
        title: '商品数据已失效，请重新加载',
        icon: 'none'
      });
      return;
    }

    if (this.data.isOwnProduct) {
      wx.showToast({
        title: '不能给自己发送私信',
        icon: 'none'
      });
      return;
    }

    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PRODUCT_DETAIL,
      productId
    });
    if (!allowed) {
      return;
    }

    this.setData({ isContactLoading: true });
    try {
      const result = await MessageService.createOrGetConversation(
        productId
      );
      if (!this.isPageActive) {
        return;
      }
      await NavigationService.safeNavigateTo(
        `${ROUTES.CHAT}?conversationId=${encodeURIComponent(result.conversationId)}`
      );
    } catch (error) {
      if (this.isPageActive) {
        if (isDevelopmentEnvironment()) {
          console.info('[product-detail] contact seller failed', {
            code: error && error.code ? error.code : 'UNKNOWN_ERROR',
            message: error && error.message
              ? error.message
              : '暂时无法联系卖家',
            productId
          });
        }
        wx.showToast({
          title: error && error.message
            ? error.message
            : '暂时无法联系卖家',
          icon: 'none'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ isContactLoading: false });
      }
    }
  },

  onSellerTap() {
    const { product } = this.data;
    if (!product || !product.seller || !product.seller.id) {
      return;
    }

    NavigationService.safeNavigateTo(
      `${ROUTES.USER_PROFILE}?userId=${encodeURIComponent(product.seller.id)}`
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
