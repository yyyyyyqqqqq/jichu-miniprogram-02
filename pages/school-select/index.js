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
    target: AUTH_TARGETS.HOME,
    productId: '',
    currentSchoolName: '',
    schoolUnavailable: false,
    keyword: '',
    schools: [],
    viewState: 'loading',
    isSearching: false,
    isSubmitting: false,
    selectedSchoolId: '',
    errorMessage: '',
    isReturning: false
  },

  onLoad(options) {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.hasLoadedSchools = false;
    this.target = AuthGuard.normalizeTarget(options && options.target);
    this.productId = AuthGuard.normalizeProductId(options && options.id);
    this.setData({
      target: this.target,
      productId: this.productId
    });
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const user = state.user;
      this.setData({
        currentSchoolName: user && user.schoolName ? user.schoolName : '',
        schoolUnavailable: Boolean(user && user.schoolUnavailable),
        isSubmitting: state.selectingSchool || this.data.isSubmitting
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
      if (AuthStore.isSchoolReady()) {
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
    if (this.data.isSubmitting || this.data.isReturning) {
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
    wx.showModal({
      title: `确认选择“${school.name}”吗？`,
      content: '学校确认后，当前阶段暂不支持自行切换。',
      confirmText: '确认选择',
      confirmColor: '#16a36a',
      success: (result) => {
        if (result.confirm && this.isPageActive) {
          this.submitSchool(school);
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
      await AuthStore.selectSchool(school.id);
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
        title: '学校选择成功',
        icon: 'success'
      });
      this.returnTimer = setTimeout(async () => {
        this.returnTimer = null;
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
    if (this.data.isSubmitting || this.data.isReturning) {
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
