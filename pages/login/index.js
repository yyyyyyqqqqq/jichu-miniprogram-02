const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const AvatarService = require('../../services/avatar-service');
const NavigationService = require('../../services/navigation-service');
const { ROUTES } = require('../../constants/routes');

Page({
  data: {
    authStatus: 'idle',
    user: null,
    nickname: '',
    campus: '',
    avatarPreviewUrl: '',
    isEditing: false,
    showProfileForm: true,
    isLoggingIn: false,
    isUpdatingProfile: false,
    isSubmitting: false,
    errorMessage: '',
    target: 'profile',
    productId: '',
    isReturning: false
  },

  onLoad(options) {
    this.isPageActive = true;
    this.formUserId = '';
    this.avatarTempFilePath = '';
    this.pendingAvatarFileId = '';
    const target = AuthGuard.normalizeTarget(options && options.target);
    const productId = AuthGuard.normalizeProductId(options && options.id);
    const isEditing = Boolean(options && options.mode === 'edit');
    this.setData({
      target,
      productId,
      isEditing
    });

    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const user = state.user;
      const shouldHydrate = user && user.id !== this.formUserId;
      const patch = {
        authStatus: state.status,
        user,
        isLoggingIn: state.loggingIn,
        isUpdatingProfile: state.updatingProfile,
        showProfileForm: state.status !== 'authenticated'
          || isEditing
          || Boolean(user && !user.profileCompleted),
        errorMessage: state.error ? state.error.message : ''
      };
      if (shouldHydrate) {
        this.formUserId = user.id;
        patch.nickname = user.nickname || '';
        patch.campus = user.campus || '';
        patch.avatarPreviewUrl = user.avatarUrl || '';
      }
      this.setData(patch);
    });
  },

  onUnload() {
    this.isPageActive = false;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
    if (this.returnTimer) {
      clearTimeout(this.returnTimer);
      this.returnTimer = null;
    }
  },

  onChooseAvatar(event) {
    const avatarUrl = event
      && event.detail
      && typeof event.detail.avatarUrl === 'string'
      ? event.detail.avatarUrl
      : '';
    if (!avatarUrl || this.data.isSubmitting) {
      return;
    }
    this.avatarTempFilePath = avatarUrl;
    this.pendingAvatarFileId = '';
    this.setData({
      avatarPreviewUrl: avatarUrl,
      errorMessage: ''
    });
  },

  onNicknameInput(event) {
    this.setData({
      nickname: event && event.detail ? event.detail.value : '',
      errorMessage: ''
    });
  },

  onCampusInput(event) {
    this.setData({
      campus: event && event.detail ? event.detail.value : '',
      errorMessage: ''
    });
  },

  validateForm() {
    const nickname = typeof this.data.nickname === 'string'
      ? this.data.nickname.trim().replace(/\s+/g, ' ')
      : '';
    const campus = typeof this.data.campus === 'string'
      ? this.data.campus.trim().replace(/\s+/g, ' ')
      : '';
    if (!nickname || nickname.length > 20) {
      throw new Error('昵称应为 1～20 个字符');
    }
    if (campus.length > 40) {
      throw new Error('校园信息不能超过 40 个字符');
    }
    if (
      !this.avatarTempFilePath
      && !this.pendingAvatarFileId
      && !String(this.data.avatarPreviewUrl || '').startsWith('cloud://')
    ) {
      throw new Error('请选择头像');
    }
    return {
      nickname,
      campus
    };
  },

  async onLoginTap() {
    if (
      this.data.isSubmitting
      || this.data.isLoggingIn
      || this.data.isUpdatingProfile
      || this.data.isReturning
    ) {
      return;
    }

    this.setData({
      errorMessage: '',
      isSubmitting: true
    });

    try {
      const profile = this.validateForm();
      let user = AuthStore.getCurrentUser();
      if (!AuthStore.isLoggedIn() || !user) {
        await AuthStore.login(profile);
        user = AuthStore.getCurrentUser();
      }
      if (!user || !user.id) {
        throw new Error('登录状态校验失败，请重试');
      }

      let avatarUrl = this.pendingAvatarFileId;
      if (!avatarUrl && this.avatarTempFilePath) {
        avatarUrl = await AvatarService.uploadAvatar({
          tempFilePath: this.avatarTempFilePath,
          userId: user.id
        });
        this.pendingAvatarFileId = avatarUrl;
      }
      if (!avatarUrl) {
        avatarUrl = String(this.data.avatarPreviewUrl || '');
      }

      await AuthStore.updateProfile({
        ...profile,
        avatarUrl
      });
      if (!this.isPageActive || this.data.isReturning) {
        return;
      }

      this.avatarTempFilePath = '';
      this.pendingAvatarFileId = '';
      wx.showToast({
        title: this.data.isEditing ? '资料已更新' : '登录成功',
        icon: 'success'
      });
      this.setData({ isReturning: true });
      this.returnTimer = setTimeout(() => {
        this.returnTimer = null;
        this.continueAfterLogin();
      }, 500);
    } catch (error) {
      if (this.isPageActive) {
        this.setData({
          errorMessage: error && error.message
            ? error.message
            : '登录失败，请稍后重试'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ isSubmitting: false });
      }
    }
  },

  async continueAfterLogin() {
    const user = AuthStore.getCurrentUser();
    if (!AuthStore.isLoggedIn() || !user || !user.profileCompleted) {
      this.setData({
        isReturning: false,
        showProfileForm: true,
        errorMessage: '请先选择头像并填写昵称'
      });
      return;
    }

    this.setData({ isReturning: true });
    const navigated = await AuthGuard.navigateAfterLogin({
      target: this.data.target,
      productId: this.data.productId
    });
    if (!this.isPageActive || navigated) {
      return;
    }

    this.setData({ isReturning: false });
    wx.showToast({
      title: '页面跳转失败，请重试',
      icon: 'none'
    });
  },

  async onRetryRestore() {
    if (this.data.isSubmitting || this.data.isLoggingIn) {
      return;
    }
    await AuthStore.refreshCurrentUser();
  },

  onBackTap() {
    NavigationService.safeNavigateBack().then((success) => {
      if (!success) {
        NavigationService.safeSwitchTab(ROUTES.PROFILE);
      }
    });
  }
});
