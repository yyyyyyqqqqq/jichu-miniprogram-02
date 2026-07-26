const AuthGuard = require('../../services/auth-guard');
const MessageService = require('../../services/message-service');
const NavigationService = require('../../services/navigation-service');
const { AUTH_TARGETS } = require('../../constants/routes');

const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const PRODUCT_PAGE_SIZE = 8;
const OWNER_SCOPES = new Set(['self', 'other']);

function createScopeState() {
  return {
    owner: null,
    list: [],
    cursor: null,
    hasMore: false,
    loaded: false,
    error: ''
  };
}

Page({
  data: {
    viewState: 'loading',
    errorMessage: '',
    ownerScope: 'self',
    owner: null,
    productList: [],
    hasMore: false,
    isLoadingProducts: false,
    productError: '',
    isSending: false,
    sendingProductId: ''
  },

  onLoad(options = {}) {
    this.isPageActive = true;
    this.productRequestVersion = 0;
    this.scopeStates = {
      self: createScopeState(),
      other: createScopeState()
    };
    this.pendingProductId = '';
    this.pendingClientMessageId = '';

    const conversationId = typeof options.conversationId === 'string'
      ? options.conversationId.trim()
      : '';
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
      this.setData({
        viewState: 'error',
        errorMessage: '当前链接缺少有效会话 ID'
      });
      return;
    }
    this.conversationId = conversationId;
    this.initializePage();
  },

  onUnload() {
    this.isPageActive = false;
    this.productRequestVersion += 1;
  },

  onReachBottom() {
    this.loadConversationProducts(false);
  },

  async initializePage() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.MESSAGES
    });
    if (!this.isPageActive || !allowed) {
      return;
    }
    this.loadConversationProducts(true);
  },

  applyScopeState(ownerScope) {
    const state = this.scopeStates[ownerScope];
    this.setData({
      ownerScope,
      owner: state.owner,
      productList: state.list,
      hasMore: state.hasMore,
      productError: state.error,
      viewState: state.loaded ? 'success' : 'loading',
      errorMessage: '',
      isLoadingProducts: false
    });
  },

  switchOwnerScope(event) {
    const ownerScope = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.scope
      : '';
    if (
      !OWNER_SCOPES.has(ownerScope)
      || ownerScope === this.data.ownerScope
      || this.data.isSending
    ) {
      return;
    }
    this.productRequestVersion += 1;
    this.applyScopeState(ownerScope);
    if (!this.scopeStates[ownerScope].loaded) {
      this.loadConversationProducts(true);
    }
  },

  async loadConversationProducts(reset = false) {
    const ownerScope = this.data.ownerScope;
    const state = this.scopeStates[ownerScope];
    if (
      !this.conversationId
      || this.data.isLoadingProducts
      || (!reset && (!state.loaded || !state.hasMore))
    ) {
      return;
    }

    const version = this.productRequestVersion + 1;
    this.productRequestVersion = version;
    this.setData({
      isLoadingProducts: true,
      productError: '',
      errorMessage: reset && state.list.length === 0
        ? ''
        : this.data.errorMessage
    });
    try {
      const result = await MessageService.listConversationProducts(
        this.conversationId,
        {
          ownerScope,
          pageSize: PRODUCT_PAGE_SIZE,
          cursor: reset ? null : state.cursor
        }
      );
      if (
        !this.isPageActive
        || ownerScope !== this.data.ownerScope
        || version !== this.productRequestVersion
      ) {
        return;
      }

      const combined = reset
        ? result.list
        : state.list.concat(result.list);
      const uniqueProducts = new Map(
        combined.map((item) => [item.productId, item])
      );
      state.owner = result.owner;
      state.list = [...uniqueProducts.values()];
      state.cursor = result.nextCursor;
      state.hasMore = result.hasMore;
      state.loaded = true;
      state.error = '';
      this.setData({
        viewState: 'success',
        errorMessage: '',
        owner: state.owner,
        productList: state.list,
        hasMore: state.hasMore,
        isLoadingProducts: false,
        productError: ''
      });
    } catch (error) {
      if (
        !this.isPageActive
        || ownerScope !== this.data.ownerScope
        || version !== this.productRequestVersion
      ) {
        return;
      }
      const message = error && error.message
        ? error.message
        : '商品列表加载失败，请稍后重试';
      state.error = message;
      this.setData({
        viewState: state.list.length > 0 ? 'success' : 'error',
        errorMessage: state.list.length > 0 ? '' : message,
        isLoadingProducts: false,
        productError: state.list.length > 0 ? message : ''
      });
    }
  },

  retryProducts() {
    const state = this.scopeStates[this.data.ownerScope];
    this.setData({
      viewState: state.list.length > 0 ? 'success' : 'loading',
      errorMessage: '',
      productError: ''
    });
    this.loadConversationProducts(state.list.length === 0);
  },

  async sendProduct(event) {
    const productId = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.productId
      : '';
    const product = this.data.productList.find(
      (item) => item.productId === productId
    );
    if (!product || this.data.isSending) {
      return;
    }

    if (
      this.pendingProductId !== productId
      || !this.pendingClientMessageId
    ) {
      this.pendingProductId = productId;
      this.pendingClientMessageId = MessageService.createClientMessageId();
    }
    this.setData({
      isSending: true,
      sendingProductId: productId
    });
    try {
      await MessageService.sendProductMessage({
        conversationId: this.conversationId,
        clientMessageId: this.pendingClientMessageId,
        productId
      });
      if (!this.isPageActive) {
        return;
      }
      const returned = await NavigationService.safeNavigateBack();
      if (!returned && this.isPageActive) {
        this.setData({
          isSending: false,
          sendingProductId: ''
        });
        wx.showToast({
          title: '商品已发送，请返回会话查看',
          icon: 'none'
        });
      }
    } catch (error) {
      if (!this.isPageActive) {
        return;
      }
      this.setData({
        isSending: false,
        sendingProductId: ''
      });
      wx.showToast({
        title: error && error.message
          ? error.message
          : '商品消息发送失败，请重试',
        icon: 'none'
      });
    }
  }
});
