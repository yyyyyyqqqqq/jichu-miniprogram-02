const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const AppointmentService = require('../../services/appointment-service');
const NavigationService = require('../../services/navigation-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

const FILTERS = [
  {
    value: AppointmentService.APPOINTMENT_LIST_FILTER.PENDING,
    label: '待处理'
  },
  {
    value: AppointmentService.APPOINTMENT_LIST_FILTER.ACCEPTED,
    label: '进行中'
  },
  {
    value: AppointmentService.APPOINTMENT_LIST_FILTER.ENDED,
    label: '已结束'
  }
];

Page({
  data: {
    filters: FILTERS,
    activeFilter: FILTERS[0].value,
    viewState: 'loading',
    appointments: [],
    hasMore: false,
    isRefreshing: false,
    isLoadingMore: false,
    loadMoreError: '',
    errorMessage: ''
  },

  onLoad() {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.nextCursor = null;
  },

  async onShow() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PROFILE
    });
    if (allowed && this.isPageActive) {
      this.loadAppointments({ reset: true });
    }
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
  },

  selectFilter(event) {
    const filter = event.currentTarget.dataset.filter;
    if (
      !FILTERS.some((item) => item.value === filter)
      || filter === this.data.activeFilter
    ) {
      return;
    }
    this.nextCursor = null;
    this.setData({
      activeFilter: filter,
      appointments: [],
      hasMore: false,
      viewState: 'loading'
    });
    this.loadAppointments({ reset: true });
  },

  async loadAppointments(options = {}) {
    if (
      !this.isPageActive
      || !AuthStore.isSchoolReady()
      || this.data.isLoadingMore
      || (this.data.isRefreshing && options.reset)
    ) {
      return;
    }
    const reset = options.reset === true;
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;
    if (reset) {
      this.nextCursor = null;
      this.setData({
        viewState: this.data.appointments.length > 0 ? 'success' : 'loading',
        isRefreshing: this.data.appointments.length > 0,
        loadMoreError: '',
        errorMessage: ''
      });
    } else {
      this.setData({
        isLoadingMore: true,
        loadMoreError: ''
      });
    }

    try {
      const result = await AppointmentService.listMine({
        filter: this.data.activeFilter,
        pageSize: 10,
        cursor: reset ? null : this.nextCursor
      });
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
      ) {
        return;
      }
      const base = reset ? [] : this.data.appointments;
      const byId = new Map(
        base.map((item) => [item.appointmentId, item])
      );
      result.list.forEach((item) => {
        byId.set(item.appointmentId, item);
      });
      const appointments = [...byId.values()];
      this.nextCursor = result.nextCursor;
      this.setData({
        appointments,
        viewState: appointments.length > 0 ? 'success' : 'empty',
        hasMore: result.hasMore,
        isRefreshing: false,
        isLoadingMore: false,
        loadMoreError: '',
        errorMessage: ''
      });
    } catch (error) {
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
      ) {
        return;
      }
      const message = error && error.message
        ? error.message
        : '预约列表暂时无法加载';
      this.setData({
        viewState: this.data.appointments.length > 0 ? 'success' : 'error',
        isRefreshing: false,
        isLoadingMore: false,
        loadMoreError: reset ? '' : message,
        errorMessage: reset ? message : ''
      });
    } finally {
      if (options.pullDown && typeof wx.stopPullDownRefresh === 'function') {
        wx.stopPullDownRefresh();
      }
    }
  },

  onPullDownRefresh() {
    this.loadAppointments({
      reset: true,
      pullDown: true
    });
  },

  onReachBottom() {
    if (
      this.data.viewState === 'success'
      && this.data.hasMore
      && !this.data.isLoadingMore
    ) {
      this.loadAppointments({ reset: false });
    }
  },

  openAppointment(event) {
    const appointmentId = event.currentTarget.dataset.appointmentId;
    if (appointmentId) {
      NavigationService.safeNavigateTo(
        `${ROUTES.APPOINTMENT_DETAIL}?appointmentId=${encodeURIComponent(appointmentId)}`
      );
    }
  },

  retryLoad() {
    this.loadAppointments({ reset: true });
  },

  retryLoadMore() {
    this.loadAppointments({ reset: false });
  },

  goMessages() {
    NavigationService.safeSwitchTab(ROUTES.MESSAGES);
  }
});
