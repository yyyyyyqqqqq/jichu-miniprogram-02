Component({
  properties: {
    categories: {
      type: Array,
      value: []
    },
    selectedId: {
      type: String,
      value: 'all'
    }
  },

  methods: {
    onSelect(event) {
      const { id } = event.currentTarget.dataset;
      if (!id || id === this.properties.selectedId) {
        return;
      }
      this.triggerEvent('change', { id });
    }
  }
});
