const ProductService = require('../../services/product-service');

Page({
  data: {
    product: null,
    loading: true,
    errorMessage: ''
  },

  onLoad(options) {
    this.isPageActive = true;
    this.loadProduct(options && options.id);
  },

  onUnload() {
    this.isPageActive = false;
  },

  async loadProduct(id) {
    this.setData({
      loading: true,
      errorMessage: ''
    });

    try {
      const product = await ProductService.getProductById(id);
      if (!this.isPageActive) {
        return;
      }

      if (!product) {
        this.setData({
          product: null,
          errorMessage: '商品不存在或已下架'
        });
        return;
      }

      this.setData({ product });
    } catch (error) {
      if (this.isPageActive) {
        this.setData({
          product: null,
          errorMessage: '商品详情加载失败'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ loading: false });
      }
    }
  },

  showLaterNotice() {
    wx.showToast({
      title: '后续阶段开放',
      icon: 'none'
    });
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/home/index' });
      }
    });
  }
});
