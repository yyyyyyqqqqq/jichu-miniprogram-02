const AuthStore = require('../../store/auth-store');
const AppStore = require('../../store/app-store');
const AuthGuard = require('../../services/auth-guard');
const NavigationService = require('../../services/navigation-service');
const ProductPublishService = require('../../services/product-publish-service');
const ProductFormService = require('../../services/product-form-service');
const LocationService = require('../../services/location-service');
const {
  PRODUCT_PUBLISH_LIMITS,
  PRODUCT_CONDITIONS,
  PRODUCT_PUBLISH_CATEGORIES
} = require('../../constants/product-publish');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

Page({
  data: {
    isLoggedIn: false,
    categories: PRODUCT_PUBLISH_CATEGORIES,
    conditions: PRODUCT_CONDITIONS,
    title: '',
    description: '',
    descriptionLength: 0,
    price: '',
    categoryId: '',
    condition: '',
    location: '',
    locationDetail: null,
    images: [],
    video: null,
    maxImages: PRODUCT_PUBLISH_LIMITS.MAX_IMAGES,
    maxVideoSizeMb: PRODUCT_PUBLISH_LIMITS.MAX_VIDEO_SIZE / (1024 * 1024),
    maxVideoDuration: PRODUCT_PUBLISH_LIMITS.MAX_VIDEO_DURATION,
    isSubmitting: false,
    isChoosingLocation: false,
    submitStage: '',
    outcomeUnknown: false
  },

  onLoad() {
    this.isPageActive = true;
    this.submissionId = ProductPublishService.createSubmissionId();
    this.pendingFileIds = [];
    this.pendingVideoFileId = '';
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      this.setData({
        isLoggedIn: AuthStore.isSchoolReady()
      });
    });
  },

  async onShow() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PUBLISH
    });
    if (allowed) {
      this.hasPromptedLogin = false;
      return;
    }
    this.hasPromptedLogin = true;
  },

  onUnload() {
    this.isPageActive = false;
    this.pauseSelectedVideo();
    this.closeSubmissionLoading();
    if (this.successTimer) {
      clearTimeout(this.successTimer);
      this.successTimer = null;
    }
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  },

  onHide() {
    this.pauseSelectedVideo();
  },

  isFormLocked() {
    return this.data.isSubmitting || this.data.outcomeUnknown;
  },

  onTitleInput(event) {
    if (!this.isFormLocked()) {
      this.setData({ title: event.detail.value });
    }
  },

  onDescriptionInput(event) {
    if (this.isFormLocked()) {
      return;
    }
    const description = event.detail.value;
    this.setData({
      description,
      descriptionLength: description.length
    });
  },

  onPriceInput(event) {
    if (!this.isFormLocked()) {
      this.setData({ price: event.detail.value });
    }
  },

  async onChooseLocation() {
    if (this.isFormLocked() || this.data.isChoosingLocation) {
      return;
    }
    this.setData({ isChoosingLocation: true });
    try {
      const result = await LocationService.chooseLocation();
      if (!this.isPageActive || result.cancelled) {
        return;
      }
      this.setData({
        location: result.location.name,
        locationDetail: result.location
      });
    } catch (error) {
      if (this.isPageActive) {
        wx.showToast({
          title: LocationService.getErrorMessage(error),
          icon: 'none'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ isChoosingLocation: false });
      }
    }
  },

  onCategoryTap(event) {
    if (this.isFormLocked()) {
      return;
    }
    const categoryId = event.currentTarget.dataset.id;
    if (categoryId) {
      this.setData({ categoryId });
    }
  },

  onConditionTap(event) {
    if (this.isFormLocked()) {
      return;
    }
    const condition = event.currentTarget.dataset.value;
    if (condition) {
      this.setData({ condition });
    }
  },

  async onChooseImages() {
    if (this.isFormLocked()) {
      return;
    }

    const remaining = this.data.maxImages - this.data.images.length;
    if (remaining <= 0) {
      wx.showToast({
        title: `最多选择 ${this.data.maxImages} 张图片`,
        icon: 'none'
      });
      return;
    }

    try {
      const result = await ProductFormService.chooseImages(
        this.data.images,
        this.data.maxImages
      );
      if (!this.isPageActive) {
        return;
      }

      if (result.oversizedCount > 0 || result.invalidCount > 0) {
        wx.showToast({
          title: result.oversizedCount > 0
            ? '已跳过无效或超过 10MB 的图片'
            : '已跳过无效图片',
          icon: 'none'
        });
      }
      if (result.additions.length > 0) {
        this.setData({
          images: this.data.images
            .concat(result.additions)
            .slice(0, this.data.maxImages)
        });
      }
    } catch (error) {
      const message = error && typeof error.errMsg === 'string'
        ? error.errMsg.toLowerCase()
        : '';
      if (!message.includes('cancel') && this.isPageActive) {
        wx.showToast({
          title: '图片选择失败，请重试',
          icon: 'none'
        });
      }
    }
  },

  onPreviewImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.images[index]) {
      return;
    }
    ProductFormService.previewImages(this.data.images, index);
  },

  onRemoveImage(event) {
    if (this.isFormLocked()) {
      return;
    }
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0) {
      return;
    }
    this.setData({
      images: this.data.images.filter((image, imageIndex) => imageIndex !== index)
    });
  },

  async onChooseVideo() {
    if (this.isFormLocked()) {
      return;
    }
    try {
      const result = await ProductFormService.chooseVideo();
      if (!this.isPageActive) {
        return;
      }
      if (!result.video) {
        const messages = {
          VIDEO_TOO_LARGE: `视频不能超过 ${this.data.maxVideoSizeMb}MB`,
          VIDEO_DURATION_INVALID: `视频时长不能超过 ${this.data.maxVideoDuration} 秒`,
          VIDEO_INVALID: '请选择有效的视频文件'
        };
        wx.showToast({
          title: messages[result.errorCode] || '视频选择失败，请重试',
          icon: 'none'
        });
        return;
      }
      this.pauseSelectedVideo();
      this.setData({ video: result.video });
    } catch (error) {
      const message = error && typeof error.errMsg === 'string'
        ? error.errMsg.toLowerCase()
        : '';
      if (!message.includes('cancel') && this.isPageActive) {
        wx.showToast({
          title: '视频选择失败，请重试',
          icon: 'none'
        });
      }
    }
  },

  onRemoveVideo() {
    if (this.isFormLocked()) {
      return;
    }
    this.pauseSelectedVideo();
    this.setData({ video: null });
  },

  pauseSelectedVideo() {
    if (typeof wx === 'undefined' || typeof wx.createVideoContext !== 'function') {
      return;
    }
    const context = wx.createVideoContext('publish-video-preview', this);
    if (context && typeof context.pause === 'function') {
      context.pause();
    }
  },

  buildDraft() {
    return ProductFormService.buildDraft(this.data);
  },

  showSubmissionLoading() {
    if (this.loadingVisible) {
      return;
    }
    this.loadingVisible = true;
    wx.showLoading({
      title: '正在发布',
      mask: true
    });
  },

  closeSubmissionLoading() {
    if (!this.loadingVisible) {
      return;
    }
    this.loadingVisible = false;
    wx.hideLoading();
  },

  resetForm() {
    this.submissionId = ProductPublishService.createSubmissionId();
    this.pendingFileIds = [];
    this.pendingVideoFileId = '';
    this.setData({
      title: '',
      description: '',
      descriptionLength: 0,
      price: '',
      categoryId: '',
      condition: '',
      location: '',
      locationDetail: null,
      images: [],
      video: null,
      submitStage: '',
      outcomeUnknown: false
    });
  },

  async onSubmit() {
    if (this.data.isSubmitting) {
      return;
    }

    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PUBLISH
    });
    if (!allowed || !this.isPageActive) {
      return;
    }

    try {
      ProductPublishService.validateProductDraft(
        this.buildDraft(),
        this.data.images,
        this.data.video
      );
    } catch (error) {
      wx.showToast({
        title: error && error.message ? error.message : '请检查商品信息',
        icon: 'none'
      });
      return;
    }

    const user = AuthStore.getCurrentUser();
    if (!user || !user.id) {
      AuthStore.logout();
      AuthGuard.requireLogin({
        target: AUTH_TARGETS.PUBLISH
      });
      return;
    }

    let productId = '';
    let requiresLogin = false;
    this.setData({
      isSubmitting: true,
      submitStage: this.pendingFileIds.length > 0 || this.pendingVideoFileId
        ? '正在确认发布结果'
        : '正在上传商品媒体'
    });
    this.showSubmissionLoading();

    try {
      const result = await ProductPublishService.publishProduct({
        draft: this.buildDraft(),
        localImages: this.data.images,
        localVideo: this.data.video,
        userId: user.id,
        requestId: this.submissionId,
        pendingFileIds: this.pendingFileIds,
        pendingVideoFileId: this.pendingVideoFileId,
        shouldContinue: () => this.isPageActive,
        onProgress: (progress) => {
          if (!this.isPageActive) {
            return;
          }
          this.setData({
            submitStage: progress.stage === 'saving'
              ? '正在保存商品'
              : (progress.stage === 'uploadingVideo'
                ? '正在上传商品视频'
                : `正在上传图片 ${progress.completed + 1}/${progress.total}`)
          });
        }
      });
      productId = result.productId;
      AppStore.markProductsChanged();
      if (this.isPageActive) {
        this.resetForm();
      }
    } catch (error) {
      if (!this.isPageActive || error.code === 'OPERATION_CANCELLED') {
        return;
      }

      if (Array.isArray(error.uploadedFileIds) && error.uploadedFileIds.length > 0) {
        this.pendingFileIds = error.uploadedFileIds.slice();
        this.pendingVideoFileId = typeof error.uploadedVideoFileId === 'string'
          ? error.uploadedVideoFileId
          : '';
        this.setData({
          outcomeUnknown: true,
          submitStage: '发布结果待确认，请点击按钮重试'
        });
      } else {
        this.pendingFileIds = [];
        this.pendingVideoFileId = '';
        this.setData({ submitStage: '' });
      }

      if ([
        'AUTH_CONTEXT_MISSING',
        'USER_NOT_FOUND',
        'USER_DISABLED'
      ].includes(error.code)) {
        AuthStore.logout();
        requiresLogin = error.code !== 'USER_DISABLED';
      }

      wx.showToast({
        title: error && error.message
          ? error.message
          : '商品发布失败，请稍后重试',
        icon: 'none',
        duration: 2600
      });
    } finally {
      this.closeSubmissionLoading();
      if (this.isPageActive) {
        this.setData({ isSubmitting: false });
      }
    }

    if (requiresLogin && this.isPageActive) {
      await AuthGuard.requireLogin({
        target: AUTH_TARGETS.PUBLISH
      });
      return;
    }

    if (productId && this.isPageActive) {
      wx.showToast({
        title: '发布成功',
        icon: 'success',
        duration: 1200
      });
      this.successTimer = setTimeout(() => {
        this.successTimer = null;
        this.navigateAfterPublish(productId);
      }, 650);
    }
  },

  async navigateAfterPublish(productId) {
    if (!this.isPageActive) {
      return;
    }
    const detailUrl = `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(productId)}`;
    const openedDetail = await NavigationService.safeRedirectTo(detailUrl);
    if (openedDetail) {
      return;
    }

    const openedHome = await NavigationService.safeSwitchTab(ROUTES.HOME);
    if (!openedHome && this.isPageActive) {
      wx.showToast({
        title: '发布成功，请返回首页查看',
        icon: 'none'
      });
    }
  },

  goLogin() {
    AuthGuard.requireLogin({
      target: AUTH_TARGETS.PUBLISH
    });
  }
});
