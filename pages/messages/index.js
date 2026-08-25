const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const MessageService = require('../../services/message-service');
const NavigationService = require('../../services/navigation-service');
const SchoolRelation = require('../../utils/school-relation');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

function showCopyableAttemptDiagnostic(error) {
  const content = MessageService.formatAttemptDiagnostic(
    error && error.diagnostic
  );
  if (!content) {
    return;
  }
  wx.showModal({
    title: '删除诊断（测试环境）',
    content,
    confirmText: '复制',
    cancelText: '关闭',
    success(result) {
      if (result.confirm) {
        wx.setClipboardData({ data: content });
      }
    }
  });
}

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
    this.observedSchoolScopeKey = SchoolRelation.getSchoolScopeKey(
      AuthStore.getCurrentUser()
    );
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (this.isPageActive) {
        const isLoggedIn = AuthStore.isSchoolReady();
        const nextSchoolScopeKey = SchoolRelation.getSchoolScopeKey(state.user);
        const schoolChanged = nextSchoolScopeKey !== this.observedSchoolScopeKey;
        if (schoolChanged) {
          this.observedSchoolScopeKey = nextSchoolScopeKey;
          this.requestVersion += 1;
          if (isLoggedIn && this.isPageVisible) {
            this.nextCursor = null;
            this.setData({ isRefreshing: false, isLoadingMore: false });
            this.loadConversations({ reset: true });
          }
        }
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

    if (!AuthStore.isSchoolReady()) {
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
      || !AuthStore.isSchoolReady()
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
      const currentUser = AuthStore.getCurrentUser();
      result.list.forEach((item) => {
        const decorated = SchoolRelation.decorateConversation(item, currentUser);
        byId.set(decorated.conversationId, decorated);
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
    if (!AuthStore.isSchoolReady()) {
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
    if (
      this.suppressedConversationId === conversationId
      && Date.now() < this.suppressConversationTapUntil
    ) {
      return;
    }
    NavigationService.safeNavigateTo(
      `${ROUTES.CHAT}?conversationId=${encodeURIComponent(conversationId)}`
    );
  },

  onConversationLongPress(event) {
    const conversationId = event
      && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.conversationId
      : '';
    if (!conversationId) {
      return;
    }
    const conversation = this.data.conversations.find(
      (item) => item.conversationId === conversationId
    );
    if (!conversation) {
      return;
    }
    this.suppressedConversationId = conversationId;
    this.suppressConversationTapUntil = Date.now() + 800;
    wx.showActionSheet({
      itemList: ['从消息列表删除'],
      success: (result) => {
        if (result.tapIndex === 0) {
          this.confirmHideConversation(conversation);
        }
      }
    });
  },

  confirmHideConversation(conversation) {
    const conversationId = conversation.conversationId;
    wx.showModal({
      title: '删除会话',
      content: '仅从你的消息列表删除。对方仍可看到会话，新消息到达后会重新出现。',
      confirmText: '删除',
      confirmColor: '#d84b32',
      success: async (result) => {
        if (!result.confirm) {
          return;
        }
        try {
          const hidden = await MessageService.hideConversation(conversationId, {
            expectedLastMessageId: conversation.lastMessageId,
            expectedLastMessageAt: conversation.lastMessageAt
          });
          if (hidden.superseded) {
            wx.showToast({ title: '收到新消息，未删除会话', icon: 'none' });
            this.loadConversations({ reset: true });
            return;
          }
          const conversations = this.data.conversations.filter(
            (item) => item.conversationId !== conversationId
          );
          this.setData({
            conversations,
            viewState: conversations.length > 0 ? 'success' : 'empty'
          });
          wx.showToast({ title: '已从列表删除', icon: 'success' });
        } catch (error) {
          wx.showToast({
            title: error && error.message
              ? `${error.message}${error.traceId ? `（${error.traceId}）` : ''}`
              : '删除失败，请重试',
            icon: 'none'
          });
          showCopyableAttemptDiagnostic(error);
        }
      }
    });
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
