Component({
  properties: {
    product: {
      type: Object,
      value: null
    }
  },

  methods: {
    onTap() {
      const { product } = this.properties;
      if (!product || !product.id) {
        return;
      }
      this.triggerEvent('select', { id: product.id });
    }
  }
});
