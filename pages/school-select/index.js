const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const NavigationService = require('../../services/navigation-service');
const SchoolService = require('../../services/school-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

const SEARCH_DEBOUNCE_MS = 350;

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
    keyword: '',
    schools: [],
    viewState: 'loading',
    isSearching: false,
    isSubmitting: false,
    selectedSchoolId: '',
    errorMessage: '',
    isConfirming: false,
    isReturning: false
  },

  onLoad(options) {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.hasLoadedSchools = false;
    this.isChangeMode = Boolean(options && options.mode === 'change');
    this.target = AuthGuard.normalizeTarget(options && options.target);
    this.productId = AuthGuard.normalizeProductId(options && options.id);
    this.setData({
      mode: this.isChangeMode ? 'change' : 'select',
      isChangeMode: this.isChangeMode,
      pageTitle: this.isChangeMode ? '修改学校' : '选择你的学校',
      pageSubtitle: this.isChangeMode
        ? '从开放学校中选择新的校园市场。'
        : '选择学校后，你将进入对应的校园二手市场。',
      target: this.target,
      productId: this.productId
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
        isSubmitting: Boolean(
          state.selectingSchool
          || state.updatingSchool
          || this.data.isSubmitting
        )
      });
    });
  },

  async onShow() {
    const allowed = await this.ensureSelectionAccess();
    if (
      allowed
      && this.isPageActive
      && !this.hasLoadedSchools
      && !this.data.isSubmitting
    ) {
      this.hasLoadedSchools = true;
      this.loadSchools('');
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
      if (!AuthStore.isLoggedIn() || !user || !user.profileCompleted) {
        await NavigationService.safeRedirectTo(AuthGuard.buildLoginUrl({
          target: this.target,
          productId: this.productId
        }));
        return false;
      }
      if (!this.isChangeMode && AuthStore.isSchoolReady()) {
        await AuthGuard.navigateAfterSchoolSelection({
          target: this.target,
          productId: this.productId
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
        this.loadSchools(keyword);
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
    this.loadSchools(keyword);
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
    this.loadSchools('');
  },

  async loadSchools(rawKeyword) {
    if (!this.isPageActive || this.data.isSubmitting) {
      return false;
    }
    const keyword = this.normalizeKeyword(rawKeyword);
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;
    this.setData({
      viewState: 'loading',
      isSearching: Boolean(keyword),
      schools: [],
      errorMessage: ''
    });
    try {
      const result = keyword
        ? await SchoolService.searchSchools({
          keyword,
          pageSize: 20
        })
        : await SchoolService.listSchools({
          pageSize: 20
        });
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return false;
      }
      const schools = result.items.filter((school) => (
        school
        && school.selectable === true
        && school.platformStatus === 'active'
      ));
      this.setData({
        schools,
        viewState: schools.length > 0 ? 'success' : 'empty',
        isSearching: Boolean(keyword),
        errorMessage: ''
      });
      return true;
    } catch (error) {
      if (!this.isPageActive || requestVersion !== this.requestVersion) {
        return false;
      }
      this.setData({
        schools: [],
        viewState: 'error',
        isSearching: Boolean(keyword),
        errorMessage: error && error.message
          ? error.message
          : '学校列表加载失败，请稍后重试'
      });
      return false;
    }
  },

  onRetry() {
    this.loadSchools(this.data.keyword);
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
        ? `当前学校：${currentSchoolName}\n新学校：${school.name}\n\n修改后，你将进入新学校的校园市场。此前发布的商品仍保留在原学校，不会自动迁移。`
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
          productId: this.productId
        });
        if (this.isPageActive && !navigated) {
          NavigationService.safeSwitchTab(ROUTES.HOME);
        }
      }, 350);
    } catch (error) {
      if (this.isPageActive) {
        this.setData({
          isSubmitting: false,
          selectedSchoolId: '',
          errorMessage: error && error.message
            ? error.message
            : '学校选择失败，请稍后重试'
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
      content: '退出后可以继续匿名浏览，重新登录后仍需完成学校选择。',
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
