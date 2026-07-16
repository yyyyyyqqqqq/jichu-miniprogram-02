Component({
  properties: {
    value: {
      type: String,
      value: ''
    },
    placeholder: {
      type: String,
      value: '搜索商品、描述或标签'
    }
  },

  methods: {
    onInput(event) {
      this.triggerEvent('input', { value: event.detail.value });
    },

    onConfirm(event) {
      this.triggerEvent('search', { value: event.detail.value });
    },

    onClear() {
      this.triggerEvent('clear');
    }
  }
});
