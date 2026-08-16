const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const AvatarService = require('../../services/avatar-service');
const NavigationService = require('../../services/navigation-service');
const { ROUTES, AUTH_TARGETS } = require('../../constants/routes');

Page({
  data: {
    nickname: '',
    avatarPreviewUrl: '',
    isSaving: false,
    isUpdatingProfile: false,
    errorMessage: ''
  },

  onLoad() {
    this.isPageActive = true;
    this.formUserId = '';
    this.avatarTempFilePath = '';
    this.pendingAvatarFileId = '';
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const user = state.user;
      const patch = {
        isUpdatingProfile: state.updatingProfile === true,
        errorMessage: state.error ? state.error.message : ''
      };
      if (user && user.id !== this.formUserId) {
        this.formUserId = user.id;
        patch.nickname = user.nickname || '';
        patch.avatarPreviewUrl = user.avatarUrl || '';
      }
      this.setData(patch);
    });
  },

  async onShow() {
    await AuthGuard.requireIdentity({ target: AUTH_TARGETS.PROFILE });
  },

  onUnload() {
    this.isPageActive = false;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  },

  onChooseAvatar(event) {
    const avatarUrl = event
      && event.detail
      && typeof event.detail.avatarUrl === 'string'
      ? event.detail.avatarUrl
      : '';
    if (!avatarUrl || this.data.isSaving) {
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

  validateForm() {
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

  async onSaveTap() {
    if (this.data.isSaving || this.data.isUpdatingProfile) {
      return;
    }
    if (!AuthStore.isLoggedIn() || !AuthStore.getCurrentUser()) {
      await AuthGuard.requireIdentity({ target: AUTH_TARGETS.PROFILE });
      return;
    }

    this.setData({
      isSaving: true,
      errorMessage: ''
    });
    try {
      const profile = this.validateForm();
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
      await AuthStore.updateProfile({ ...profile, avatarUrl });
      this.avatarTempFilePath = '';
      this.pendingAvatarFileId = '';
      wx.showToast({ title: '资料已更新', icon: 'success' });
      const returned = await NavigationService.safeNavigateBack();
      if (!returned) {
        await NavigationService.safeSwitchTab(ROUTES.PROFILE);
      }
    } catch (error) {
      if (this.isPageActive) {
        this.setData({
          errorMessage: error && error.message
            ? error.message
            : '资料保存失败，请稍后重试'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ isSaving: false });
      }
    }
  }
});
