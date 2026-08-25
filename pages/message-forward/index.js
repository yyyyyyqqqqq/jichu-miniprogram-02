const AuthGuard = require('../../services/auth-guard');
const MessageService = require('../../services/message-service');
const NavigationService = require('../../services/navigation-service');
const SchoolRelation = require('../../utils/school-relation');
const AuthStore = require('../../store/auth-store');
const { AUTH_TARGETS } = require('../../constants/routes');

const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^m_[a-f0-9]{64}$/;

Page({
  data: {
    viewState: 'loading',
    conversations: [],
    hasMore: false,
    isLoadingMore: false,
    isForwarding: false,
    forwardingConversationId: '',
    errorMessage: ''
  },

  onLoad(options = {}) {
    this.isPageActive = true;
    this.nextCursor = null;
    this.requestVersion = 0;
    this.sourceConversationId = typeof options.sourceConversationId === 'string'
      ? options.sourceConversationId.trim()
      : '';
    this.sourceMessageId = typeof options.sourceMessageId === 'string'
      ? options.sourceMessageId.trim()
      : '';
    if (
      !CONVERSATION_ID_PATTERN.test(this.sourceConversationId)
      || !MESSAGE_ID_PATTERN.test(this.sourceMessageId)
    ) {
      this.setData({
        viewState: 'error',
        errorMessage: '当前链接缺少有效的原消息信息'
      });
      return;
    }
    this.initializePage();
  },

  onUnload() {
    this.isPageActive = false;
    this.requestVersion += 1;
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.isLoadingMore) {
      this.loadConversations(false);
    }
  },

  async initializePage() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.CHAT,
      conversationId: this.sourceConversationId
    });
    if (allowed && this.isPageActive) {
      this.loadConversations(true);
    }
  },

  async loadConversations(reset) {
    if (this.data.isLoadingMore || this.data.isForwarding) {
      return;
    }
    const version = this.requestVersion + 1;
    this.requestVersion = version;
    this.setData({
      viewState: reset ? 'loading' : this.data.viewState,
      isLoadingMore: !reset,
      errorMessage: ''
    });
    try {
      const result = await MessageService.listConversations({
        pageSize: 20,
        cursor: reset ? null : this.nextCursor
      });
      if (!this.isPageActive || version !== this.requestVersion) {
        return;
      }
      const currentUser = AuthStore.getCurrentUser();
      const incoming = result.list
        .filter((item) => item.conversationId !== this.sourceConversationId)
        .map((item) => SchoolRelation.decorateConversation(item, currentUser));
      const combined = reset ? incoming : this.data.conversations.concat(incoming);
      const unique = new Map(
        combined.map((item) => [item.conversationId, item])
      );
      const conversations = [...unique.values()];
      this.nextCursor = result.nextCursor;
      this.setData({
        conversations,
        hasMore: result.hasMore,
        isLoadingMore: false,
        viewState: conversations.length > 0 ? 'success' : 'empty'
      });
    } catch (error) {
      if (!this.isPageActive || version !== this.requestVersion) {
        return;
      }
      this.setData({
        isLoadingMore: false,
        viewState: this.data.conversations.length > 0 ? 'success' : 'error',
        errorMessage: error && error.message
          ? error.message
          : '会话列表加载失败，请重试'
      });
    }
  },

  retryLoad() {
    this.loadConversations(true);
  },

  async selectConversation(event) {
    const targetConversationId = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.conversationId
      : '';
    if (
      this.data.isForwarding
      || !CONVERSATION_ID_PATTERN.test(targetConversationId)
    ) {
      return;
    }
    this.setData({
      isForwarding: true,
      forwardingConversationId: targetConversationId
    });
    try {
      await MessageService.forwardMessage({
        sourceConversationId: this.sourceConversationId,
        sourceMessageId: this.sourceMessageId,
        targetConversationId,
        clientMessageId: MessageService.createClientMessageId()
      });
      if (!this.isPageActive) {
        return;
      }
      wx.showToast({ title: '已转发', icon: 'success' });
      const returned = await NavigationService.safeNavigateBack();
      if (!returned && this.isPageActive) {
        this.setData({ isForwarding: false, forwardingConversationId: '' });
      }
    } catch (error) {
      if (!this.isPageActive) {
        return;
      }
      this.setData({ isForwarding: false, forwardingConversationId: '' });
      wx.showToast({
        title: error && error.message ? error.message : '转发失败，请重试',
        icon: 'none'
      });
    }
  }
});
