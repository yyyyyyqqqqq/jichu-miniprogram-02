function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseCoordinate(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

Page({
  data: {
    state: 'idle',
    location: null,
    errorMessage: ''
  },

  onLoad(options = {}) {
    this.isPageActive = true;
    const latitude = parseCoordinate(options.latitude, -90, 90);
    const longitude = parseCoordinate(options.longitude, -180, 180);
    const name = normalizeString(options.name);
    const address = normalizeString(options.address);
    if (
      name
      && address
      && latitude !== null
      && longitude !== null
      && !(latitude === 0 && longitude === 0)
    ) {
      this.setData({
        state: 'selected',
        location: {
          name,
          address,
          latitude,
          longitude
        }
      });
    }
  },

  onShow() {
    if (!this.hasOpenedChooser) {
      this.hasOpenedChooser = true;
      this.chooseLocation();
    }
  },

  onUnload() {
    this.isPageActive = false;
  },

  chooseLocation() {
    if (this.data.state === 'choosing') {
      return;
    }
    this.setData({
      state: 'choosing',
      errorMessage: ''
    });
    wx.chooseLocation({
      success: (result) => {
        if (!this.isPageActive) {
          return;
        }
        const latitude = parseCoordinate(result.latitude, -90, 90);
        const longitude = parseCoordinate(result.longitude, -180, 180);
        const name = normalizeString(result.name);
        const address = normalizeString(result.address);
        if (
          !name
          || !address
          || latitude === null
          || longitude === null
          || (latitude === 0 && longitude === 0)
        ) {
          this.setData({
            state: 'error',
            errorMessage: '所选地点信息不完整，请重新选择'
          });
          return;
        }
        this.setData({
          state: 'selected',
          location: {
            name,
            address,
            latitude,
            longitude
          },
          errorMessage: ''
        });
      },
      fail: (error) => {
        if (!this.isPageActive) {
          return;
        }
        const message = normalizeString(error && error.errMsg).toLowerCase();
        const cancelled = message.includes('cancel');
        const denied = message.includes('auth deny')
          || message.includes('authorize')
          || message.includes('permission');
        this.setData({
          state: this.data.location ? 'selected' : 'error',
          errorMessage: cancelled
            ? '已取消地图选择，原有地点未发生变化'
            : denied
              ? '需要位置权限才能选择面交地点，请在设置中允许后重试'
              : '地图暂时无法打开，请稍后重试'
        });
      }
    });
  },

  previewLocation() {
    const location = this.data.location;
    if (!location) {
      return;
    }
    wx.openLocation({
      name: location.name,
      address: location.address,
      latitude: location.latitude,
      longitude: location.longitude,
      scale: 16,
      fail() {
        wx.showToast({
          title: '暂时无法打开地图',
          icon: 'none'
        });
      }
    });
  },

  confirmLocation() {
    const location = this.data.location;
    if (!location) {
      wx.showToast({
        title: '请先选择地点',
        icon: 'none'
      });
      return;
    }
    const eventChannel = this.getOpenerEventChannel
      ? this.getOpenerEventChannel()
      : null;
    if (eventChannel && typeof eventChannel.emit === 'function') {
      eventChannel.emit('locationSelected', {
        name: location.name,
        address: location.address,
        latitude: location.latitude,
        longitude: location.longitude
      });
    }
    wx.navigateBack();
  }
});
