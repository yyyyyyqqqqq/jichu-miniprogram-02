const LocationService = require('../../services/location-service');

Page({
  data: {
    state: 'idle',
    location: null,
    errorMessage: ''
  },

  onLoad(options = {}) {
    this.isPageActive = true;
    const location = LocationService.normalizeLocation(options);
    if (location) {
      this.setData({
        state: 'selected',
        location
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

  async chooseLocation() {
    if (this.data.state === 'choosing') {
      return;
    }
    this.setData({
      state: 'choosing',
      errorMessage: ''
    });
    try {
      const result = await LocationService.chooseLocation();
      if (!this.isPageActive) {
        return;
      }
      if (result.cancelled) {
        this.setData({
          state: this.data.location ? 'selected' : 'error',
          errorMessage: '已取消地图选择，原有地点未发生变化'
        });
        return;
      }
      this.setData({
        state: 'selected',
        location: result.location,
        errorMessage: ''
      });
    } catch (error) {
      if (!this.isPageActive) {
        return;
      }
      this.setData({
        state: this.data.location ? 'selected' : 'error',
        errorMessage: error && error.code === 'LOCATION_PERMISSION_DENIED'
          ? '需要位置权限才能选择面交地点，请在设置中允许后重试'
          : LocationService.getErrorMessage(error)
      });
    }
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
