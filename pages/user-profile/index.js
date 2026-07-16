Page({
  data: {
    sellerId: ''
  },

  onLoad(options) {
    const sellerId = options && options.id
      ? String(options.id).trim()
      : '';
    this.setData({ sellerId });
  }
});
