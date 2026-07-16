Component({
  properties: {
    title: {
      type: String,
      value: '暂无内容'
    },
    description: {
      type: String,
      value: ''
    },
    actionText: {
      type: String,
      value: ''
    },
    showAction: {
      type: Boolean,
      value: true
    }
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    }
  }
});
