const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const NavigationService = require('../../services/navigation-service');
const SchoolService = require('../../services/school-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

const SEARCH_DEBOUNCE_MS = 350;
const SCHOOL_PAGE_SIZE = 20;
const MAX_RETAINED_SCHOOLS = 100;
const PROVINCE_OPTIONS = Object.freeze([
  '全部地区',
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区',
  '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省',
  '浙江省', '安徽省', '福建省', '江西省', '山东省',
  '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区',
  '海南省', '重庆市', '四川省', '贵州省', '云南省',
  '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区',
  '新疆维吾尔自治区'
]);

function mergeSchoolPage(current, incoming) {
  const byId = new Map();
  [...current, ...incoming].forEach((school) => {
    if (school && school.id) {
      byId.set(school.id, school);
    }
  });
  const all = [...byId.values()];
  const discarded = Math.max(0, all.length - MAX_RETAINED_SCHOOLS);
  return {
    items: discarded ? all.slice(discarded) : all,
    discarded
  };
}

function formatDateTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildCooldownPresentation(user) {
  const value = user && typeof user === 'object' ? user : {};
  const canChangeSchool = value.canChangeSchool !== false;
  const nextSchoolChangeAllowedAt = typeof value.nextSchoolChangeAllowedAt === 'string'
    ? value.nextSchoolChangeAllowedAt
    : '';
  const nextAllowedText = formatDateTime(nextSchoolChangeAllowedAt);
  return {
    canChangeSchool,
    schoolChangedAt: typeof value.schoolChangedAt === 'string'
      ? value.schoolChangedAt
      : '',
    nextSchoolChangeAllowedAt,
    schoolChangeRemainingMs: Number(value.schoolChangeRemainingMs) > 0
      ? Math.floor(Number(value.schoolChangeRemainingMs))
      : 0,
    cooldownText: canChangeSchool
      ? '当前可以修改学校；成功后 7 天内不能再次修改。'
      : nextAllowedText
        ? `学校修改后 7 天内不可再次修改，可于 ${nextAllowedText} 后重试。`
        : '学校修改后 7 天内不可再次修改。'
  };
}

Page({
  data: {
    mode: 'select',
    isChangeMode: false,
    pageTitle: '选择你的学校',
    pageSubtitle: '选择学校后，你将进入对应的校园二手市场。',
    target: AUTH_TARGETS.HOME,
    productId: '',
    currentSchoolId: '',
    currentSchoolName: '',
    schoolUnavailable: false,
    canChangeSchool: true,
    schoolChangedAt: '',
    nextSchoolChangeAllowedAt: '',
    schoolChangeRemainingMs: 0,
    cooldownText: '',
    keyword: '',
    provinceOptions: PROVINCE_OPTIONS,
    provinceIndex: 0,
    province: '',
    schools: [],
    viewState: 'loading',
    isSearching: false,
    isSubmitting: false,
    selectedSchoolId: '',
    errorMessage: '',
    nextCursor: '',
    hasMore: false,
    isLoadingMore: false,
    loadMoreError: '',
    discardedCount: 0,
    isConfirming: false,
    isReturning: false
  },

  onLoad(options) {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.seenCursors = new Set();
    this.hasLoadedSchools = false;
    this.isChangeMode = Boolean(options && options.mode === 'change');
    this.target = AuthGuard.normalizeTarget(options && options.target);
    this.productId = AuthGuard.normalizeProductId(options && options.id);
    this.conversationId = AuthGuard.normalizeConversationId(
      options && options.conversationId
    );
    this.appointmentId = AuthGuard.normalizeAppointmentId(
      options && options.appointmentId
    );
    this.publicUserId = AuthGuard.normalizePublicUserId(
      options && options.userId
    );
    this.setData({
      mode: this.isChangeMode ? 'change' : 'select',
      isChangeMode: this.isChangeMode,
      pageTitle: this.isChangeMode ? '修改学校' : '选择你的学校',
      pageSubtitle: this.isChangeMode
        ? '从开放学校中选择新的校园市场。'
        : '选择学校后，你将进入对应的校园二手市场。',
      target: this.target,
      productId: this.productId,
      conversationId: this.conversationId,
      appointmentId: this.appointmentId,
      publicUserId: this.publicUserId
    });
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const user = state.user;
      this.setData({
        currentSchoolId: user && user.schoolId ? user.schoolId : '',
        currentSchoolName: user && user.schoolName ? user.schoolName : '',
        schoolUnavailable: Boolean(user && user.schoolUnavailable),
        ...buildCooldownPresentation(user),
        isSubmitting: Boolean(
          state.selectingSchool
          || state.updatingSchool
          || this.data.isSubmitting
        )
      });
    });
  },

  async onShow() {
    if (this.isChangeMode) {
      const refreshedState = await AuthStore.refreshCurrentUser();
      if (!this.isPageActive) {
        return;
      }
      if (refreshedState.status === 'error') {
        this.hasLoadedSchools = false;
        this.setData({
          schools: [],
          viewState: 'error',
          errorMessage: refreshedState.error && refreshedState.error.message
            ? refreshedState.error.message
            : '无法读取服务端学校修改状态，请稍后重试'
        });
        return;
      }
    }
    const allowed = await this.ensureSelectionAccess();
    if (
      allowed
      && this.isPageActive
      && !this.hasLoadedSchools
      && !this.data.isSubmitting
    ) {
      this.hasLoadedSchools = true;
      this.loadSchools('', { reset: true });
    }
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.returnTimer) {
      clearTimeout(this.returnTimer);
      this.returnTimer = null;
    }
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  },

  async ensureSelectionAccess() {
    if (this.accessPromise) {
      return this.accessPromise;
    }
    const operation = (async () => {
      const state = AuthStore.getState();
      if (state.status === 'idle' || state.restoring) {
        await AuthStore.bootstrap();
      }
      if (!this.isPageActive) {
        return false;
      }
      const user = AuthStore.getCurrentUser();
      if (!AuthStore.isLoggedIn() || !user) {
        await NavigationService.safeRedirectTo(AuthGuard.buildLoginUrl({
          target: this.target,
          productId: this.productId,
          conversationId: this.conversationId,
          appointmentId: this.appointmentId,
          publicUserId: this.publicUserId
        }));
        return false;
      }
      if (!this.isChangeMode && AuthStore.isSchoolReady()) {
        await AuthGuard.navigateAfterSchoolSelection({
          target: this.target,
          productId: this.productId,
          conversationId: this.conversationId,
          appointmentId: this.appointmentId,
          publicUserId: this.publicUserId
        });
        return false;
      }
      return true;
    })();
    this.accessPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.accessPromise === operation) {
        this.accessPromise = null;
      }
    }
  },

  normalizeKeyword(value) {
    return typeof value === 'string'
      ? value.normalize('NFKC').replace(/\s+/g, ' ').trim()
      : '';
  },

  onKeywordInput(event) {
    if (this.data.isSubmitting || this.data.isReturning) {
      return;
    }
    const keyword = event && event.detail
      ? String(event.detail.value || '')
      : '';
    this.setData({
      keyword,
      errorMessage: ''
    });
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      if (this.isPageActive && !this.data.isSubmitting) {
        this.loadSchools(keyword, { reset: true });
      }
    }, SEARCH_DEBOUNCE_MS);
  },

  onSearchConfirm(event) {
    if (this.data.isSubmitting || this.data.isReturning) {
      return;
    }
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    const keyword = event && event.detail
      ? String(event.detail.value || '')
      : this.data.keyword;
    this.setData({ keyword });
    this.loadSchools(keyword, { reset: true });
  },

  onClearSearch() {
    if (this.data.isSubmitting || this.data.isReturning) {
      return;
    }
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.setData({ keyword: '' });
    this.loadSchools('', { reset: true });
  },

  onProvinceChange(event) {
    if (this.data.isSubmitting || this.data.isReturning) {
      return;
    }
    const provinceIndex = Number(event && event.detail && event.detail.value);
    const safeIndex = Number.isInteger(provinceIndex)
      && provinceIndex >= 0
      && provinceIndex < PROVINCE_OPTIONS.length
      ? provinceIndex
      : 0;
    this.setData({
      provinceIndex: safeIndex,
      province: safeIndex === 0 ? '' : PROVINCE_OPTIONS[safeIndex]
    });
    this.loadSchools(this.data.keyword, { reset: true });
  },

  async loadSchools(rawKeyword, options = {}) {
    if (!this.isPageActive || this.data.isSubmitting) {
      return false;
    }
    const reset = options.reset !== false;
    if (!reset && (this.data.isLoadingMore || !this.data.hasMore || !this.data.nextCursor)) {
      return false;
    }
    const keyword = this.normalizeKeyword(rawKeyword);
    const province = this.data.province || '';
    const cursor = reset ? '' : this.data.nextCursor;
    const scopeKey = JSON.stringify({ keyword, province });
    const requestVersion = reset ? this.requestVersion + 1 : this.requestVersion;
    if (reset) {
      this.requestVersion = requestVersion;
      this.currentSchoolScope = scopeKey;
      this.seenCursors = new Set();
      this.setData({
        viewState: 'loading',
        isSearching: Boolean(keyword),
        schools: [],
        nextCursor: '',
        hasMore: false,
        isLoadingMore: false,
        loadMoreError: '',
        discardedCount: 0,
        errorMessage: ''
      });
    } else {
      if (this.currentSchoolScope !== scopeKey || this.seenCursors.has(cursor)) {
        return false;
      }
      this.seenCursors.add(cursor);
      this.setData({ isLoadingMore: true, loadMoreError: '' });
    }
    try {
      const result = keyword
        ? await SchoolService.searchSchools({
          keyword,
          province,
          pageSize: SCHOOL_PAGE_SIZE,
          cursor
        })
        : await SchoolService.listSchools({
          province,
          pageSize: SCHOOL_PAGE_SIZE,
          cursor
        });
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
        || this.currentSchoolScope !== scopeKey
      ) {
        return false;
      }
      const pageItems = result.items.filter((school) => (
        school
        && school.selectable === true
        && school.platformStatus === 'active'
      ));
      const merged = mergeSchoolPage(reset ? [] : this.data.schools, pageItems);
      const nextCursor = result.hasMore ? result.nextCursor : '';
      if (result.hasMore && (!nextCursor || nextCursor === cursor)) {
        throw new Error('学校分页游标异常，请重新加载');
      }
      this.setData({
        schools: merged.items,
        viewState: merged.items.length > 0 ? 'success' : 'empty',
        isSearching: Boolean(keyword),
        nextCursor,
        hasMore: result.hasMore,
        isLoadingMore: false,
        loadMoreError: '',
        discardedCount: reset
          ? merged.discarded
          : this.data.discardedCount + merged.discarded,
        errorMessage: ''
      });
      return true;
    } catch (error) {
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
        || this.currentSchoolScope !== scopeKey
      ) {
        return false;
      }
      if (!reset) {
        this.seenCursors.delete(cursor);
        this.setData({
          isLoadingMore: false,
          loadMoreError: error && error.message
            ? error.message
            : '下一页加载失败，请重试'
        });
        return false;
      }
      this.setData({
        schools: [],
        viewState: 'error',
        isSearching: Boolean(keyword),
        nextCursor: '',
        hasMore: false,
        isLoadingMore: false,
        errorMessage: error && error.message
          ? error.message
          : '学校列表加载失败，请稍后重试'
      });
      return false;
    }
  },

  onRetry() {
    this.loadSchools(this.data.keyword, { reset: true });
  },

  onLoadMore() {
    this.loadSchools(this.data.keyword, { reset: false });
  },

  onReachBottom() {
    this.onLoadMore();
  },

  onEmptyAction() {
    if (this.data.isSearching) {
      this.onClearSearch();
      return;
    }
    this.onRetry();
  },

  onSchoolTap(event) {
    if (
      this.data.isSubmitting
      || this.data.isConfirming
      || this.data.isReturning
    ) {
      return;
    }
    if (this.isChangeMode && !this.data.canChangeSchool) {
      wx.showToast({
        title: '学校修改仍在 7 天冷却期',
        icon: 'none'
      });
      return;
    }
    const schoolId = event
      && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.id
      : '';
    const school = this.data.schools.find((item) => item.id === schoolId);
    if (!school || !school.selectable) {
      wx.showToast({
        title: '该学校暂不可选择',
        icon: 'none'
      });
      return;
    }
    if (
      this.isChangeMode
      && this.data.currentSchoolId
      && school.id === this.data.currentSchoolId
    ) {
      wx.showToast({
        title: '这已经是当前学校',
        icon: 'none'
      });
      return;
    }
    this.setData({ isConfirming: true });
    const currentSchoolName = this.data.currentSchoolName || '未绑定';
    wx.showModal({
      title: this.isChangeMode ? '确认修改学校？' : `确认选择“${school.name}”吗？`,
      content: this.isChangeMode
        ? `当前学校：${currentSchoolName}\n新学校：${school.name}\n\n修改后，你将进入新学校的校园市场，且 7 天内不能再次修改。此前发布的商品仍保留在原学校，不会自动迁移。`
        : '选择后，你将进入对应的校园市场。学校名称由云端权威数据确认。',
      confirmText: this.isChangeMode ? '确认修改' : '确认选择',
      confirmColor: '#16a36a',
      success: (result) => {
        if (result.confirm && this.isPageActive) {
          this.submitSchool(school);
        }
      },
      complete: () => {
        if (this.isPageActive) {
          this.setData({ isConfirming: false });
        }
      }
    });
  },

  async submitSchool(school) {
    if (
      !school
      || !school.id
      || this.data.isSubmitting
      || this.data.isReturning
    ) {
      return;
    }
    this.requestVersion += 1;
    this.setData({
      isSubmitting: true,
      selectedSchoolId: school.id,
      errorMessage: ''
    });
    try {
      if (this.isChangeMode) {
        await AuthStore.updateSchool(school.id);
      } else {
        await AuthStore.selectSchool(school.id);
      }
      const user = AuthStore.getCurrentUser();
      if (
        !this.isPageActive
        || !user
        || user.schoolRequired
        || user.schoolUnavailable
        || user.schoolId !== school.id
      ) {
        throw new Error('学校状态同步失败，请重新尝试');
      }
      this.setData({
        isReturning: true,
        isSubmitting: false
      });
      wx.showToast({
        title: this.isChangeMode ? '学校已修改' : '学校选择成功',
        icon: 'success'
      });
      this.returnTimer = setTimeout(async () => {
        this.returnTimer = null;
        if (this.isChangeMode) {
          const navigated = await NavigationService.safeNavigateBack();
          if (this.isPageActive && !navigated) {
            NavigationService.safeSwitchTab(ROUTES.PROFILE);
          }
          return;
        }
        const navigated = await AuthGuard.navigateAfterSchoolSelection({
          target: this.target,
          productId: this.productId,
          conversationId: this.conversationId,
          appointmentId: this.appointmentId,
          publicUserId: this.publicUserId
        });
        if (this.isPageActive && !navigated) {
          NavigationService.safeSwitchTab(ROUTES.HOME);
        }
      }, 350);
    } catch (error) {
      if (this.isPageActive) {
        const cooldownPatch = error
          && error.code === 'SCHOOL_CHANGE_COOLDOWN'
          ? buildCooldownPresentation({
            ...(error.details || {}),
            canChangeSchool: false
          })
          : {};
        this.setData({
          isSubmitting: false,
          selectedSchoolId: '',
          errorMessage: error && error.message
            ? error.message
            : '学校选择失败，请稍后重试',
          ...cooldownPatch
        });
      }
    }
  },

  onLogoutTap() {
    if (
      this.data.isSubmitting
      || this.data.isConfirming
      || this.data.isReturning
    ) {
      return;
    }
    wx.showModal({
      title: '退出当前登录？',
      content: '退出后需重新登录才能进入校园市场，重新登录后仍需完成学校选择。',
      confirmText: '退出登录',
      confirmColor: '#d95745',
      success: (result) => {
        if (!result.confirm || !this.isPageActive) {
          return;
        }
        AuthStore.logout();
        NavigationService.safeSwitchTab(ROUTES.HOME);
      }
    });
  }
});
