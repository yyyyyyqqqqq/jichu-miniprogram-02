const AuthGuard = require('../../services/auth-guard');
const AuthStore = require('../../store/auth-store');
const AppointmentService = require('../../services/appointment-service');
const NavigationService = require('../../services/navigation-service');
const AppStore = require('../../store/app-store');
const SchoolRelation = require('../../utils/school-relation');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

const APPOINTMENT_ID_PATTERN = /^a_[a-f0-9]{64}$/;

Page({
  data: {
    viewState: 'loading',
    appointment: null,
    isActing: false,
    errorMessage: ''
  },

  onLoad(options = {}) {
    this.isPageActive = true;
    this.hasLoaded = false;
    this.requestVersion = 0;
    this.observedSchoolScopeKey = SchoolRelation.getSchoolScopeKey(
      AuthStore.getCurrentUser()
    );
    this.actionKeys = {};
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const nextSchoolScopeKey = SchoolRelation.getSchoolScopeKey(state.user);
      if (nextSchoolScopeKey !== this.observedSchoolScopeKey) {
        this.observedSchoolScopeKey = nextSchoolScopeKey;
        this.requestVersion += 1;
        if (this.appointmentId && AuthStore.isSchoolReady()) {
          this.loadAppointment({ keepContent: true });
        }
      }
    });
    const appointmentId = typeof options.appointmentId === 'string'
      ? options.appointmentId.trim()
      : '';
    if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
      this.setData({
        viewState: 'error',
        errorMessage: '当前链接缺少有效预约 ID'
      });
      return;
    }
    this.appointmentId = appointmentId;
    this.loadAppointment();
  },

  onShow() {
    if (this.hasLoaded && this.appointmentId) {
      this.loadAppointment({ keepContent: true });
    }
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  },

  async loadAppointment(options = {}) {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.APPOINTMENT_DETAIL,
      appointmentId: this.appointmentId
    });
    if (!allowed || !this.isPageActive) {
      return;
    }
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;
    if (!options.keepContent || !this.data.appointment) {
      this.setData({
        viewState: 'loading',
        errorMessage: ''
      });
    }
    try {
      const appointment = await AppointmentService.getAppointment(
        this.appointmentId
      );
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return;
      }
      this.hasLoaded = true;
      this.setData({
        viewState: 'success',
        appointment: SchoolRelation.decorateAppointment(
          appointment,
          AuthStore.getCurrentUser()
        ),
        errorMessage: ''
      });
    } catch (error) {
      if (this.isPageActive && requestVersion === this.requestVersion) {
        this.setData({
          viewState: this.data.appointment ? 'success' : 'error',
          errorMessage: error && error.message
            ? error.message
            : '预约详情暂时无法加载'
        });
      }
    }
  },

  getActionKey(action) {
    if (!this.actionKeys[action]) {
      this.actionKeys[action] = AppointmentService.createIdempotencyKey(
        action
      );
    }
    return this.actionKeys[action];
  },

  showConfirm(options) {
    return new Promise((resolve) => {
      wx.showModal({
        title: options.title,
        content: options.content,
        confirmText: options.confirmText || '确认',
        confirmColor: options.confirmColor || '#16a36a',
        success(result) {
          resolve(result.confirm === true);
        },
        fail() {
          resolve(false);
        }
      });
    });
  },

  async accept() {
    await this.runAction('accept', {
      title: '接受面交预约？',
      content: '接受后商品将显示为“已预定”，双方按预约时间和地点线下面交。',
      service: AppointmentService.acceptAppointment
    });
  },

  async reject() {
    await this.runAction('reject', {
      title: '拒绝面交预约？',
      content: '拒绝后本次预约将结束，如需继续可重新发起。',
      confirmText: '拒绝',
      confirmColor: '#d95745',
      service: AppointmentService.rejectAppointment
    });
  },

  async cancel() {
    await this.runAction('cancel', {
      title: '取消面交预约？',
      content: '取消后本次预约将结束，如需继续可重新发起。',
      confirmText: '取消预约',
      confirmColor: '#d95745',
      service: AppointmentService.cancelAppointment
    });
  },

  async complete() {
    await this.runAction('complete', {
      title: '确认已完成面交？',
      content: '确认后，该预约将完成，商品将标记为已出，且不能撤销。',
      confirmText: '确认完成',
      service: AppointmentService.completeAppointment,
      marksProductsChanged: true
    });
  },

  async runAction(action, options) {
    if (this.data.isActing || !this.data.appointment) {
      return;
    }
    const confirmed = await this.showConfirm(options);
    if (!confirmed || !this.isPageActive) {
      return;
    }
    this.setData({ isActing: true });
    wx.showLoading({
      title: '正在处理',
      mask: true
    });
    try {
      const result = await options.service(
        this.appointmentId,
        this.getActionKey(action)
      );
      if (!this.isPageActive) {
        return;
      }
      if (options.marksProductsChanged || result.productChanged) {
        AppStore.markProductsChanged();
      }
      if (
        action === 'complete'
        && result.cleanup
        && result.cleanup.cleanupPending
        && result.productId
      ) {
        await AppointmentService.retryProductSoldCleanup(result.productId)
          .catch(() => {});
      }
      wx.showToast({
        title: result.reused ? '状态已更新' : '操作成功',
        icon: 'success'
      });
      await this.loadAppointment({ keepContent: true });
    } catch (error) {
      if (this.isPageActive) {
        wx.showToast({
          title: error && error.message ? error.message : '操作失败',
          icon: 'none',
          duration: 2600
        });
      }
    } finally {
      wx.hideLoading();
      if (this.isPageActive) {
        this.setData({ isActing: false });
      }
    }
  },

  openLocation() {
    const location = this.data.appointment
      && this.data.appointment.location;
    if (
      !location
      || !Number.isFinite(location.latitude)
      || !Number.isFinite(location.longitude)
    ) {
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

  openChat() {
    const conversationId = this.data.appointment
      && this.data.appointment.conversationId;
    if (conversationId) {
      NavigationService.safeNavigateTo(
        `${ROUTES.CHAT}?conversationId=${encodeURIComponent(conversationId)}`
      );
    }
  },

  openProduct() {
    const productId = this.data.appointment
      && this.data.appointment.product
      && this.data.appointment.product.productId;
    if (productId) {
      NavigationService.safeNavigateTo(
        `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(productId)}`
      );
    }
  },

  retryLoad() {
    this.loadAppointment();
  }
});
