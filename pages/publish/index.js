const AuthStore = require('../../store/auth-store');
const AppStore = require('../../store/app-store');
const AuthGuard = require('../../services/auth-guard');
const NavigationService = require('../../services/navigation-service');
const ProductPublishService = require('../../services/product-publish-service');
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
    images: [],
    maxImages: PRODUCT_PUBLISH_LIMITS.MAX_IMAGES,
    isSubmitting: false,
    submitStage: '',
    outcomeUnknown: false
  },

  onLoad() {
    this.isPageActive = true;
    this.submissionId = ProductPublishService.createSubmissionId();
    this.pendingFileIds = [];
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      this.setData({
        isLoggedIn: state.status === 'authenticated' && Boolean(state.user)
      });
    });
  },

  onShow() {
    if (AuthStore.isLoggedIn()) {
      this.hasPromptedLogin = false;
      return;
    }
    if (!this.hasPromptedLogin) {
      this.hasPromptedLogin = true;
      AuthGuard.requireLogin({
        target: AUTH_TARGETS.PUBLISH
      });
    }
  },

  onUnload() {
    this.isPageActive = false;
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

  onLocationInput(event) {
    if (!this.isFormLocked()) {
      this.setData({ location: event.detail.value });
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
      const result = await new Promise((resolve, reject) => {
        wx.chooseMedia({
          count: remaining,
          mediaType: ['image'],
          sourceType: ['album', 'camera'],
          sizeType: ['compressed'],
          success: resolve,
          fail: reject
        });
      });
      if (!this.isPageActive) {
        return;
      }

      const existingPaths = new Set(
        this.data.images.map((image) => image.tempFilePath)
      );
      const selected = Array.isArray(result.tempFiles) ? result.tempFiles : [];
      let oversizedCount = 0;
      let invalidImageCount = 0;
      const additions = [];
      selected.forEach((file) => {
        const tempFilePath = file && typeof file.tempFilePath === 'string'
          ? file.tempFilePath
          : '';
        const size = Number(file && file.size);
        const fileType = file && typeof file.fileType === 'string'
          ? file.fileType.toLowerCase()
          : 'image';
        if (!tempFilePath || existingPaths.has(tempFilePath)) {
          return;
        }
        if (
          fileType !== 'image'
          || !Number.isFinite(size)
          || size <= 0
        ) {
          invalidImageCount += 1;
          return;
        }
        if (size > PRODUCT_PUBLISH_LIMITS.MAX_IMAGE_SIZE) {
          oversizedCount += 1;
          return;
        }
        existingPaths.add(tempFilePath);
        additions.push({
          tempFilePath,
          size,
          fileType
        });
      });

      if (oversizedCount > 0 || invalidImageCount > 0) {
        wx.showToast({
          title: oversizedCount > 0
            ? '已跳过无效或超过 10MB 的图片'
            : '已跳过无效图片',
          icon: 'none'
        });
      }
      if (additions.length > 0) {
        this.setData({
          images: this.data.images.concat(additions).slice(0, this.data.maxImages)
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
    wx.previewMedia({
      current: index,
      sources: this.data.images.map((image) => ({
        url: image.tempFilePath,
        type: 'image'
      }))
    });
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

  buildDraft() {
    return {
      title: this.data.title,
      description: this.data.description,
      price: this.data.price,
      categoryId: this.data.categoryId,
      condition: this.data.condition,
      location: this.data.location
    };
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
    this.setData({
      title: '',
      description: '',
      descriptionLength: 0,
      price: '',
      categoryId: '',
      condition: '',
      location: '',
      images: [],
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
        this.data.images
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
      submitStage: this.pendingFileIds.length > 0
        ? '正在确认发布结果'
        : '正在上传商品图片'
    });
    this.showSubmissionLoading();

    try {
      const result = await ProductPublishService.publishProduct({
        draft: this.buildDraft(),
        localImages: this.data.images,
        userId: user.id,
        requestId: this.submissionId,
        pendingFileIds: this.pendingFileIds,
        shouldContinue: () => this.isPageActive,
        onProgress: (progress) => {
          if (!this.isPageActive) {
            return;
          }
          this.setData({
            submitStage: progress.stage === 'saving'
              ? '正在保存商品'
              : `正在上传图片 ${progress.completed + 1}/${progress.total}`
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
        this.setData({
          outcomeUnknown: true,
          submitStage: '发布结果待确认，请点击按钮重试'
        });
      } else {
        this.pendingFileIds = [];
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
