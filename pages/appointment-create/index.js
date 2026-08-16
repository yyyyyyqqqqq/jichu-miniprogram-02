const AuthGuard = require('../../services/auth-guard');
const MessageService = require('../../services/message-service');
const AppointmentService = require('../../services/appointment-service');
const NavigationService = require('../../services/navigation-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

function toDateValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeValue(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    viewState: 'loading',
    conversation: null,
    date: '',
    time: '',
    minDate: '',
    maxDate: '',
    location: null,
    legacyLocationName: '',
    note: '',
    noteLength: 0,
    noteMaxLength: AppointmentService.APPOINTMENT_LIMITS.NOTE_MAX_LENGTH,
    isSubmitting: false,
    errorMessage: ''
  },

  onLoad(options = {}) {
    this.isPageActive = true;
    this.createKey = AppointmentService.createIdempotencyKey('create');
    const conversationId = typeof options.conversationId === 'string'
      ? options.conversationId.trim()
      : '';
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
      this.setData({
        viewState: 'error',
        errorMessage: '当前链接缺少有效会话 ID'
      });
      return;
    }
    this.conversationId = conversationId;
    const productId = typeof options.productId === 'string'
      ? options.productId.trim()
      : '';
    this.productId = PRODUCT_ID_PATTERN.test(productId) ? productId : '';

    const now = new Date();
    const initial = new Date(now.getTime() + 60 * 60 * 1000);
    initial.setMinutes(Math.ceil(initial.getMinutes() / 5) * 5, 0, 0);
    const maximum = new Date(
      now.getTime()
      + AppointmentService.APPOINTMENT_LIMITS.MAX_FUTURE_DAYS
        * 24 * 60 * 60 * 1000
    );
    this.setData({
      date: toDateValue(initial),
      time: toTimeValue(initial),
      minDate: toDateValue(now),
      maxDate: toDateValue(maximum)
    });
    this.initialize();
  },

  onUnload() {
    this.isPageActive = false;
  },

  async initialize() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.APPOINTMENT_CREATE,
      conversationId: this.conversationId,
      productId: this.productId
    });
    if (!allowed || !this.isPageActive) {
      return;
    }
    this.setData({
      viewState: 'loading',
      errorMessage: ''
    });
    try {
      const conversation = await MessageService.getConversation(
        this.conversationId
      );
      if (!this.isPageActive) {
        return;
      }
      this.conversationId = conversation.conversationId;
      const currentProductId = conversation.product.productId;
      if (this.productId && this.productId !== currentProductId) {
        this.setData({
          viewState: 'error',
          errorMessage: '商品上下文已变化，请返回聊天页重新发起预约'
        });
        return;
      }
      this.productId = currentProductId;
      const activeAppointment = await AppointmentService
        .getActiveByConversation(this.conversationId, this.productId);
      if (!this.isPageActive) {
        return;
      }
      if (activeAppointment) {
        await NavigationService.safeRedirectTo(
          `${ROUTES.APPOINTMENT_DETAIL}?appointmentId=${encodeURIComponent(activeAppointment.appointmentId)}`
        );
        return;
      }
      if (
        !conversation.canSend
        || conversation.product.status !== 'available'
      ) {
        this.setData({
          viewState: 'error',
          errorMessage: '当前商品不能创建面交预约'
        });
        return;
      }
      this.setData({
        viewState: 'success',
        conversation,
        legacyLocationName: conversation.product.locationName || ''
      });
    } catch (error) {
      if (this.isPageActive) {
        this.setData({
          viewState: 'error',
          errorMessage: error && error.message
            ? error.message
            : '预约页面暂时无法加载'
        });
      }
    }
  },

  onDateChange(event) {
    if (!this.data.isSubmitting) {
      this.setData({ date: event.detail.value });
    }
  },

  onTimeChange(event) {
    if (!this.data.isSubmitting) {
      this.setData({ time: event.detail.value });
    }
  },

  onNoteInput(event) {
    if (this.data.isSubmitting) {
      return;
    }
    const note = event.detail.value;
    this.setData({
      note,
      noteLength: note.length
    });
  },

  chooseLocation() {
    if (this.data.isSubmitting) {
      return;
    }
    const location = this.data.location;
    const params = location
      ? `?name=${encodeURIComponent(location.name)}&address=${encodeURIComponent(location.address)}&latitude=${encodeURIComponent(location.latitude)}&longitude=${encodeURIComponent(location.longitude)}`
      : '';
    wx.navigateTo({
      url: `${ROUTES.LOCATION_PICKER}${params}`,
      events: {
        locationSelected: (selected) => {
          if (this.isPageActive && selected) {
            this.setData({ location: selected });
          }
        }
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
      scale: 16
    });
  },

  buildScheduledAt() {
    return new Date(`${this.data.date}T${this.data.time}:00`).toISOString();
  },

  async submit() {
    if (this.data.isSubmitting) {
      return;
    }
    if (!this.data.location) {
      wx.showToast({
        title: '请先在地图中选择地点',
        icon: 'none'
      });
      return;
    }
    let scheduledAt;
    try {
      scheduledAt = this.buildScheduledAt();
      AppointmentService.validateScheduledAt(scheduledAt);
      AppointmentService.validateLocation(this.data.location);
    } catch (error) {
      wx.showToast({
        title: error && error.message ? error.message : '请检查预约信息',
        icon: 'none'
      });
      return;
    }

    this.setData({ isSubmitting: true });
    wx.showLoading({
      title: '正在发起预约',
      mask: true
    });
    try {
      const result = await AppointmentService.createAppointment({
        conversationId: this.conversationId,
        productId: this.productId,
        scheduledAt,
        location: this.data.location,
        note: this.data.note,
        idempotencyKey: this.createKey
      });
      if (!this.isPageActive) {
        return;
      }
      wx.showToast({
        title: result.reused ? '预约已存在' : '预约已发起',
        icon: 'success'
      });
      await NavigationService.safeRedirectTo(
        `${ROUTES.APPOINTMENT_DETAIL}?appointmentId=${encodeURIComponent(result.appointmentId)}`
      );
    } catch (error) {
      if (!this.isPageActive) {
        return;
      }
      wx.showToast({
        title: error && error.message ? error.message : '预约发起失败',
        icon: 'none',
        duration: 2600
      });
    } finally {
      wx.hideLoading();
      if (this.isPageActive) {
        this.setData({ isSubmitting: false });
      }
    }
  },

  retryLoad() {
    this.initialize();
  }
});
