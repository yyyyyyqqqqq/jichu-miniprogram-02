const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const AvatarService = require('../../services/avatar-service');
const NavigationService = require('../../services/navigation-service');
const { ROUTES } = require('../../constants/routes');

Page({
  data: {
    authStatus: 'idle',
    loginStage: AuthStore.LOGIN_STAGE.NONE,
    isAuthenticated: false,
    isRestoring: false,
    isLoggingIn: false,
    isUpdatingProfile: false,
    isSubmitting: false,
    isReturning: false,
    isProfileStep: false,
    nickname: '',
    avatarPreviewUrl: '',
    errorMessage: '',
    target: 'profile',
    productId: '',
    conversationId: '',
    appointmentId: '',
    publicUserId: ''
  },

  onLoad(options = {}) {
    this.isPageActive = true;
    this.avatarTempFilePath = '';
    this.pendingAvatarFileId = '';
    this.profileSeedUserId = '';
    const urlContext = AuthGuard.normalizeAuthContext({
      target: options.target,
      productId: options.id,
      conversationId: options.conversationId,
      appointmentId: options.appointmentId,
      publicUserId: options.userId
    });
    this.loginContext = AuthStore.getLoginContext() || urlContext;
    this.setData(this.loginContext);
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const isProfileStep = state.loginStage
        === AuthStore.LOGIN_STAGE.PROFILE_CONFIRM_REQUIRED;
      const patch = {
        authStatus: state.status,
        loginStage: state.loginStage,
        isAuthenticated: state.status === AuthStore.AUTH_STATUS.AUTHENTICATED
          && Boolean(state.user),
        isRestoring: state.restoring === true,
        isLoggingIn: state.loggingIn === true,
        isUpdatingProfile: state.updatingProfile === true,
        isProfileStep,
        errorMessage: state.error ? state.error.message : ''
      };
      if (state.loginContext) {
        this.loginContext = AuthGuard.normalizeAuthContext(state.loginContext);
        Object.assign(patch, this.loginContext);
      }
      if (isProfileStep && state.user && state.user.id !== this.profileSeedUserId) {
        this.profileSeedUserId = state.user.id;
        patch.nickname = state.user.nickname || '';
        patch.avatarPreviewUrl = state.user.avatarUrl || '';
        this.avatarTempFilePath = '';
        this.pendingAvatarFileId = '';
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
  },

  async onLoginTap() {
    if (
      this.data.isSubmitting
      || this.data.isLoggingIn
      || this.data.isRestoring
      || this.data.isReturning
    ) {
      return;
    }
    this.setData({ errorMessage: '', isSubmitting: true });
    try {
      await AuthStore.loginIdentity(this.loginContext);
      if (
        !AuthStore.isLoggedIn()
        || !AuthStore.getCurrentUser()
        || !AuthStore.isProfileConfirmationRequired()
      ) {
        throw new Error('微信身份登录失败，请重试');
      }
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

  onChooseAvatar(event) {
    const avatarUrl = event
      && event.detail
      && typeof event.detail.avatarUrl === 'string'
      ? event.detail.avatarUrl
      : '';
    if (!avatarUrl || this.data.isSubmitting || this.data.isUpdatingProfile) {
      return;
    }
    this.avatarTempFilePath = avatarUrl;
    this.pendingAvatarFileId = '';
    this.setData({ avatarPreviewUrl: avatarUrl, errorMessage: '' });
  },

  onNicknameInput(event) {
    this.setData({
      nickname: event && event.detail ? event.detail.value : '',
      errorMessage: ''
    });
  },

  validateProfile() {
    const nickname = typeof this.data.nickname === 'string'
      ? this.data.nickname.trim().replace(/\s+/g, ' ')
      : '';
    if (!nickname || nickname.length > 20) {
      throw new Error('昵称应为 1～20 个字符');
    }
    if (
      !this.avatarTempFilePath
      && !this.pendingAvatarFileId
      && !String(this.data.avatarPreviewUrl || '').startsWith('cloud://')
    ) {
      throw new Error('请选择头像');
    }
    return { nickname };
  },

  async onConfirmProfileTap() {
    if (
      this.data.isSubmitting
      || this.data.isUpdatingProfile
      || this.data.isReturning
    ) {
      return;
    }
    if (!AuthStore.isProfileConfirmationRequired()) {
      this.setData({ errorMessage: '当前登录流程已失效，请重新登录' });
      return;
    }
    this.setData({ errorMessage: '', isSubmitting: true });
    try {
      const profile = this.validateProfile();
      const user = AuthStore.getCurrentUser();
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
      await AuthStore.confirmLoginProfile({ ...profile, avatarUrl });
      this.avatarTempFilePath = '';
      this.pendingAvatarFileId = '';
      wx.showToast({ title: '资料已确认', icon: 'success' });
      await this.continueAfterProfile();
    } catch (error) {
      if (this.isPageActive) {
        this.setData({
          isReturning: false,
          errorMessage: error && error.message
            ? error.message
            : '资料确认失败，请稍后重试'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ isSubmitting: false });
      }
    }
  },

  async continueAfterProfile() {
    if (!AuthStore.isLoggedIn() || !AuthStore.getCurrentUser()) {
      this.setData({ isReturning: false, errorMessage: '请重新完成微信登录' });
      return false;
    }
    this.setData({ isReturning: true });
    const context = AuthStore.getLoginContext() || this.loginContext;
    const navigated = await AuthGuard.navigateAfterLogin(context);
    if (!this.isPageActive || navigated) {
      return navigated;
    }
    this.setData({ isReturning: false });
    wx.showToast({ title: '页面跳转失败，请重试', icon: 'none' });
    return false;
  },

  async onRetryRestore() {
    if (this.data.isSubmitting || this.data.isLoggingIn) {
      return;
    }
    await AuthStore.refreshCurrentUser();
  },

  onBackTap() {
    if (AuthStore.isExplicitLoginInProgress()) {
      AuthStore.logout();
    }
    NavigationService.safeNavigateBack().then((success) => {
      if (!success) {
        NavigationService.safeSwitchTab(ROUTES.PROFILE);
      }
    });
  }
});
