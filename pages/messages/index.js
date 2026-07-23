const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const MessageService = require('../../services/message-service');
const NavigationService = require('../../services/navigation-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

Page({
  data: {
    isLoggedIn: false,
    viewState: 'loading',
    conversations: [],
    hasMore: false,
    isRefreshing: false,
    isLoadingMore: false,
    loadMoreError: '',
    errorMessage: ''
  },

  onLoad() {
    this.isPageActive = true;
    this.isPageVisible = false;
    this.requestVersion = 0;
    this.nextCursor = null;
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (this.isPageActive) {
        const isLoggedIn = state.status === 'authenticated'
          && Boolean(state.user)
          && state.user.profileCompleted === true;
        this.setData({
          isLoggedIn
        });
      }
    });
  },

  async onShow() {
    this.isPageVisible = true;
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 'messages' });
    }

    if (!AuthStore.isLoggedIn()) {
      this.setData({
        viewState: 'login',
        conversations: [],
        hasMore: false,
        errorMessage: ''
      });
      if (!this.hasPromptedLogin) {
        this.hasPromptedLogin = true;
        await AuthGuard.requireLogin({
          target: AUTH_TARGETS.MESSAGES
        });
      }
      return;
    }

    this.hasPromptedLogin = false;
    this.loadConversations({ reset: true });
  },

  onHide() {
    this.isPageVisible = false;
  },

  onUnload() {
    this.isPageActive = false;
    this.isPageVisible = false;
    this.requestVersion += 1;
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
  },

  async loadConversations(options = {}) {
    if (
      !this.isPageActive
      || !AuthStore.isLoggedIn()
      || this.data.isLoadingMore
      || (this.data.isRefreshing && options.reset)
    ) {
      return;
    }

    const reset = options.reset === true;
    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;
    if (reset) {
      this.nextCursor = null;
      this.setData({
        viewState: this.data.conversations.length > 0 ? 'success' : 'loading',
        isRefreshing: this.data.conversations.length > 0,
        loadMoreError: '',
        errorMessage: ''
      });
    } else {
      this.setData({
        isLoadingMore: true,
        loadMoreError: ''
      });
    }

    try {
      const result = await MessageService.listConversations({
        pageSize: 10,
        cursor: reset ? null : this.nextCursor
      });
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
      ) {
        return;
      }

      const base = reset ? [] : this.data.conversations;
      const byId = new Map(
        base.map((item) => [item.conversationId, item])
      );
      result.list.forEach((item) => {
        byId.set(item.conversationId, item);
      });
      const conversations = [...byId.values()];
      this.nextCursor = result.nextCursor;
      this.setData({
        conversations,
        viewState: conversations.length > 0 ? 'success' : 'empty',
        hasMore: result.hasMore,
        isRefreshing: false,
        isLoadingMore: false,
        loadMoreError: '',
        errorMessage: ''
      });
    } catch (error) {
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
      ) {
        return;
      }
      const message = error && error.message
        ? error.message
        : '消息暂时无法加载';
      this.setData({
        viewState: this.data.conversations.length > 0 ? 'success' : 'error',
        isRefreshing: false,
        isLoadingMore: false,
        loadMoreError: reset ? '' : message,
        errorMessage: reset ? message : ''
      });
    } finally {
      if (options.pullDown && typeof wx.stopPullDownRefresh === 'function') {
        wx.stopPullDownRefresh();
      }
    }
  },

  onPullDownRefresh() {
    if (!AuthStore.isLoggedIn()) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadConversations({
      reset: true,
      pullDown: true
    });
  },

  onReachBottom() {
    if (
      this.data.viewState === 'success'
      && this.data.hasMore
      && !this.data.isLoadingMore
    ) {
      this.loadConversations({ reset: false });
    }
  },

  retryLoad() {
    this.loadConversations({ reset: true });
  },

  retryLoadMore() {
    this.loadConversations({ reset: false });
  },

  openConversation(event) {
    const conversationId = event
      && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.conversationId
      : '';
    if (!conversationId) {
      return;
    }
    NavigationService.safeNavigateTo(
      `${ROUTES.CHAT}?conversationId=${encodeURIComponent(conversationId)}`
    );
  },

  goHome() {
    NavigationService.safeSwitchTab(ROUTES.HOME);
  },

  goLogin() {
    AuthGuard.requireLogin({
        target: AUTH_TARGETS.MESSAGES
      });
  }
});
