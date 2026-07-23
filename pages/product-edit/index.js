const AuthStore = require('../../store/auth-store');
const AppStore = require('../../store/app-store');
const AuthGuard = require('../../services/auth-guard');
const NavigationService = require('../../services/navigation-service');
const ProductEditService = require('../../services/product-edit-service');
const ProductFormService = require('../../services/product-form-service');
const ProductPublishService = require('../../services/product-publish-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

Page({
  data: {
    productId: '',
    isLoggedIn: false,
    isRestoring: false,
    viewState: 'loading',
    errorMessage: '',
    categories: ProductFormService.PRODUCT_PUBLISH_CATEGORIES,
    conditions: ProductFormService.PRODUCT_CONDITIONS,
    title: '',
    description: '',
    descriptionLength: 0,
    price: '',
    categoryId: '',
    condition: '',
    location: '',
    images: [],
    maxImages: ProductFormService.PRODUCT_PUBLISH_LIMITS.MAX_IMAGES,
    productStatus: '',
    version: 0,
    isSubmitting: false,
    submitStage: '',
    outcomeUnknown: false
  },

  onLoad(options) {
    this.isPageActive = true;
    this.requestVersion = 0;
    this.loadStarted = false;
    this.loginGuardPromise = null;
    this.submitPromise = null;
    this.pendingFileIds = [];
    this.mutationId = ProductEditService.createMutationId();
    this.initialSnapshot = '';
    this.unloadAlertEnabled = false;

    const productId = this.normalizeProductId(options && options.id);
    if (!productId) {
      this.setData({
        viewState: 'error',
        errorMessage: '当前链接缺少有效商品 ID'
      });
      return;
    }
    this.productId = productId;
    this.setData({ productId });

    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const isLoggedIn = state.status === 'authenticated'
        && Boolean(state.user)
        && state.user.profileCompleted === true;
      this.setData({
        isLoggedIn,
        isRestoring: state.restoring
      });
      if (isLoggedIn && !this.loadStarted) {
        this.loadStarted = true;
        this.loadEditableProduct();
      } else if (
        !isLoggedIn
        && state.initialized
        && !state.restoring
      ) {
        this.ensureLogin();
      }
    });

    if (!AuthStore.isLoggedIn()) {
      this.ensureLogin();
    }
  },

  onShow() {
    if (
      this.isPageActive
      && this.productId
      && AuthStore.isLoggedIn()
      && !this.loadStarted
    ) {
      this.loadStarted = true;
      this.loadEditableProduct();
    }
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
    this.closeLoading();
    this.disableUnloadAlert();
    if (this.successTimer) {
      clearTimeout(this.successTimer);
      this.successTimer = null;
    }
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  },

  normalizeProductId(value) {
    const productId = value === null || value === undefined
      ? ''
      : String(value).trim();
    return /^[a-zA-Z0-9_-]{1,64}$/.test(productId) ? productId : '';
  },

  async ensureLogin() {
    if (!this.productId || this.loginGuardPromise) {
      return this.loginGuardPromise;
    }
    const operation = AuthGuard.requireLogin({
      target: AUTH_TARGETS.PRODUCT_EDIT,
      productId: this.productId
    });
    this.loginGuardPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.loginGuardPromise === operation) {
        this.loginGuardPromise = null;
      }
    }
  },

  async loadEditableProduct() {
    if (!this.isPageActive || !this.productId || !AuthStore.isLoggedIn()) {
      return false;
    }
    const version = this.requestVersion + 1;
    this.requestVersion = version;
    this.setData({
      viewState: 'loading',
      errorMessage: ''
    });

    try {
      const result = await ProductEditService.getEditableProduct(this.productId);
      if (!this.isPageActive || version !== this.requestVersion) {
        return false;
      }
      const product = result.product;
      const images = ProductFormService.createExistingImages(product.images);
      this.pendingFileIds = [];
      this.mutationId = ProductEditService.createMutationId();
      this.setData({
        title: product.title,
        description: product.description,
        descriptionLength: product.description.length,
        price: String(product.price),
        categoryId: product.categoryId,
        condition: product.condition,
        location: product.location,
        images,
        productStatus: product.status,
        version: result.version,
        viewState: 'success',
        outcomeUnknown: false,
        submitStage: ''
      }, () => {
        this.initialSnapshot = ProductFormService.createFormSnapshot(this.data);
        this.syncUnloadAlert();
      });
      return true;
    } catch (error) {
      if (!this.isPageActive || version !== this.requestVersion) {
        return false;
      }
      if (error && error.code === 'UNAUTHORIZED') {
        AuthStore.logout();
        this.loadStarted = false;
        this.ensureLogin();
        return false;
      }
      this.setData({
        viewState: 'error',
        errorMessage: error && error.message
          ? error.message
          : '商品编辑数据加载失败，请稍后重试'
      });
      return false;
    }
  },

  isFormLocked() {
    return this.data.isSubmitting || this.data.outcomeUnknown;
  },

  updateForm(patch) {
    if (this.isFormLocked()) {
      return;
    }
    this.setData(patch, () => {
      this.syncUnloadAlert();
    });
  },

  onTitleInput(event) {
    this.updateForm({ title: event.detail.value });
  },

  onDescriptionInput(event) {
    const description = event.detail.value;
    this.updateForm({
      description,
      descriptionLength: description.length
    });
  },

  onPriceInput(event) {
    this.updateForm({ price: event.detail.value });
  },

  onLocationInput(event) {
    this.updateForm({ location: event.detail.value });
  },

  onCategoryTap(event) {
    const categoryId = event.currentTarget.dataset.id;
    if (categoryId) {
      this.updateForm({ categoryId });
    }
  },

  onConditionTap(event) {
    const condition = event.currentTarget.dataset.value;
    if (condition) {
      this.updateForm({ condition });
    }
  },

  async onChooseImages() {
    if (this.isFormLocked()) {
      return;
    }
    if (this.data.images.length >= this.data.maxImages) {
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
      if (result.invalidCount > 0 || result.oversizedCount > 0) {
        wx.showToast({
          title: result.oversizedCount > 0
            ? '已跳过无效或超过 10MB 的图片'
            : '已跳过无效图片',
          icon: 'none'
        });
      }
      if (result.additions.length > 0) {
        this.updateForm({
          images: this.data.images.concat(result.additions)
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
    ProductFormService.previewImages(
      this.data.images,
      Number(event.currentTarget.dataset.index)
    );
  },

  onRemoveImage(event) {
    if (this.isFormLocked()) {
      return;
    }
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0) {
      return;
    }
    if (this.data.images.length <= 1) {
      wx.showToast({
        title: '商品至少保留一张图片',
        icon: 'none'
      });
      return;
    }
    this.updateForm({
      images: this.data.images.filter((image, imageIndex) => imageIndex !== index)
    });
  },

  hasUnsavedChanges() {
    return this.data.viewState === 'success'
      && Boolean(this.initialSnapshot)
      && ProductFormService.createFormSnapshot(this.data) !== this.initialSnapshot;
  },

  syncUnloadAlert() {
    const shouldEnable = this.hasUnsavedChanges() && !this.data.isSubmitting;
    if (
      shouldEnable
      && !this.unloadAlertEnabled
      && typeof wx.enableAlertBeforeUnload === 'function'
    ) {
      wx.enableAlertBeforeUnload({
        message: '商品信息尚未保存，确定离开吗？',
        success: () => {
          this.unloadAlertEnabled = true;
        }
      });
    } else if (!shouldEnable) {
      this.disableUnloadAlert();
    }
  },

  disableUnloadAlert() {
    if (
      this.unloadAlertEnabled
      && typeof wx.disableAlertBeforeUnload === 'function'
    ) {
      wx.disableAlertBeforeUnload();
    }
    this.unloadAlertEnabled = false;
  },

  showLoading(title) {
    if (this.loadingVisible) {
      return;
    }
    this.loadingVisible = true;
    wx.showLoading({
      title,
      mask: true
    });
  },

  closeLoading() {
    if (!this.loadingVisible) {
      return;
    }
    this.loadingVisible = false;
    wx.hideLoading();
  },

  async onSubmit() {
    if (
      this.data.isSubmitting
      || this.submitPromise
      || this.data.viewState !== 'success'
    ) {
      return;
    }
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.PRODUCT_EDIT,
      productId: this.productId
    });
    if (!allowed || !this.isPageActive) {
      return;
    }

    const split = ProductFormService.splitImages(this.data.images);
    try {
      ProductPublishService.validateProductFields(
        ProductFormService.buildDraft(this.data)
      );
      ProductPublishService.validateLocalImages(
        split.localImages,
        { allowEmpty: true }
      );
      if (this.data.images.length < 1 || this.data.images.length > this.data.maxImages) {
        throw new ProductEditService.ProductEditError(
          'INVALID_IMAGE_LIST',
          '请保留至少一张且最多六张有效商品图片'
        );
      }
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
      this.ensureLogin();
      return;
    }

    this.setData({
      isSubmitting: true,
      submitStage: this.pendingFileIds.length > 0
        ? '正在确认编辑结果'
        : (split.localImages.length > 0 ? '正在上传新图片' : '正在保存商品')
    });
    this.disableUnloadAlert();
    this.showLoading('正在保存');

    const operation = ProductEditService.updateProduct({
      productId: this.productId,
      expectedVersion: this.data.version,
      mutationId: this.mutationId,
      draft: ProductFormService.buildDraft(this.data),
      existingFileIDs: split.existingFileIDs,
      localImages: split.localImages,
      pendingFileIds: this.pendingFileIds,
      userId: user.id,
      shouldContinue: () => this.isPageActive,
      onProgress: (progress) => {
        if (this.isPageActive) {
          this.setData({
            submitStage: `正在上传图片 ${progress.completed + 1}/${progress.total}`
          });
        }
      }
    });
    this.submitPromise = operation;

    try {
      const result = await operation;
      if (!this.isPageActive) {
        return;
      }
      this.pendingFileIds = [];
      this.initialSnapshot = ProductFormService.createFormSnapshot(this.data);
      this.setData({
        version: result.version,
        outcomeUnknown: false,
        submitStage: ''
      });
      AppStore.markProductsChanged();
      wx.showToast({
        title: result.cleanupPending
          ? '商品已更新，部分旧图片正在清理'
          : '商品已更新',
        icon: result.cleanupPending ? 'none' : 'success',
        duration: 1800
      });
      this.successTimer = setTimeout(() => {
        this.successTimer = null;
        this.returnToMyProducts();
      }, 700);
    } catch (error) {
      if (!this.isPageActive || error.code === 'OPERATION_CANCELLED') {
        return;
      }
      if (error.outcomeUnknown && error.uploadedFileIds.length > 0) {
        this.pendingFileIds = error.uploadedFileIds.slice();
        this.setData({
          outcomeUnknown: true,
          submitStage: '编辑结果待确认，请保持表单不变并重试'
        });
      } else {
        this.pendingFileIds = [];
        this.setData({ submitStage: '' });
      }
      if (error.code === 'UNAUTHORIZED') {
        AuthStore.logout();
        this.ensureLogin();
      }
      wx.showToast({
        title: error && error.message
          ? error.message
          : '商品更新失败，请稍后重试',
        icon: 'none',
        duration: 2800
      });
    } finally {
      this.closeLoading();
      if (this.submitPromise === operation) {
        this.submitPromise = null;
      }
      if (this.isPageActive) {
        this.setData({ isSubmitting: false }, () => {
          this.syncUnloadAlert();
        });
      }
    }
  },

  returnToMyProducts() {
    if (!this.isPageActive) {
      return;
    }
    this.disableUnloadAlert();
    const pages = getCurrentPages();
    if (pages.length > 1 && `/${pages[pages.length - 2].route}` === ROUTES.MY_PRODUCTS) {
      NavigationService.safeNavigateBack();
      return;
    }
    NavigationService.safeRedirectTo(ROUTES.MY_PRODUCTS);
  },

  onRetry() {
    this.loadStarted = true;
    this.loadEditableProduct();
  }
});
