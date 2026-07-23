const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const MessageService = require('../../services/message-service');
const NavigationService = require('../../services/navigation-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const POLL_INTERVAL_MS = 8000;

Page({
  data: {
    viewState: 'loading',
    conversation: null,
    messages: [],
    inputValue: '',
    inputLength: 0,
    maxLength: MessageService.MESSAGE_MAX_LENGTH,
    sendDisabled: true,
    isSending: false,
    isLoadingEarlier: false,
    hasMore: false,
    historyError: '',
    errorMessage: '',
    scrollIntoView: ''
  },

  onLoad(options) {
    this.isPageActive = true;
    this.isPageVisible = true;
    this.requestVersion = 0;
    this.serverMessages = [];
    this.pendingMessages = [];
    this.nextCursor = null;
    this.pollInFlight = false;

    const conversationId = options && typeof options.conversationId === 'string'
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
    this.initializeConversation();
  },

  onShow() {
    this.isPageVisible = true;
    if (this.data.viewState === 'success') {
      this.startPolling();
      this.refreshLatestMessages();
    }
  },

  onHide() {
    this.isPageVisible = false;
    this.stopPolling();
  },

  onUnload() {
    this.isPageActive = false;
    this.isPageVisible = false;
    this.requestVersion += 1;
    this.stopPolling();
  },

  async initializeConversation() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.MESSAGES
    });
    if (!allowed || !this.isPageActive) {
      return;
    }

    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;
    this.setData({
      viewState: 'loading',
      errorMessage: ''
    });
    try {
      const [conversation, messageResult] = await Promise.all([
        MessageService.getConversation(this.conversationId),
        MessageService.listMessages(this.conversationId, {
          pageSize: 20
        })
      ]);
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
      ) {
        return;
      }

      this.serverMessages = messageResult.list;
      this.nextCursor = messageResult.nextCursor;
      wx.setNavigationBarTitle({
        title: conversation.otherUser.nickname || '聊天'
      });
      this.setData({
        viewState: 'success',
        conversation,
        hasMore: messageResult.hasMore,
        historyError: ''
      });
      this.renderMessages(true);
      this.markRead();
      this.startPolling();
    } catch (error) {
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
      ) {
        return;
      }
      this.setData({
        viewState: 'error',
        errorMessage: error && error.message
          ? error.message
          : '会话暂时无法加载'
      });
    }
  },

  renderMessages(scrollBottom = false) {
    if (!this.isPageActive) {
      return;
    }
    const byId = new Map();
    [...this.serverMessages, ...this.pendingMessages].forEach((message) => {
      byId.set(message.messageId, message);
    });
    const messages = [...byId.values()].sort((left, right) => {
      const leftTime = new Date(left.createdAt).getTime();
      const rightTime = new Date(right.createdAt).getTime();
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return String(left.messageId).localeCompare(String(right.messageId));
    });
    this.setData({
      messages,
      scrollIntoView: scrollBottom ? '' : this.data.scrollIntoView
    }, () => {
      if (scrollBottom && this.isPageActive) {
        this.setData({ scrollIntoView: 'chat-bottom' });
      }
    });
  },

  async loadEarlierMessages() {
    if (
      !this.isPageActive
      || this.data.isLoadingEarlier
      || !this.data.hasMore
      || !this.nextCursor
    ) {
      return;
    }
    this.setData({
      isLoadingEarlier: true,
      historyError: ''
    });
    try {
      const result = await MessageService.listMessages(
        this.conversationId,
        {
          pageSize: 20,
          cursor: this.nextCursor
        }
      );
      if (!this.isPageActive) {
        return;
      }
      const byId = new Map(
        this.serverMessages.map((message) => [message.messageId, message])
      );
      result.list.forEach((message) => {
        byId.set(message.messageId, message);
      });
      this.serverMessages = [...byId.values()];
      this.nextCursor = result.nextCursor;
      this.setData({
        hasMore: result.hasMore,
        isLoadingEarlier: false,
        historyError: ''
      });
      this.renderMessages(false);
    } catch (error) {
      if (this.isPageActive) {
        this.setData({
          isLoadingEarlier: false,
          historyError: error && error.message
            ? error.message
            : '更早消息加载失败'
        });
      }
    }
  },

  retryHistory() {
    this.loadEarlierMessages();
  },

  async refreshLatestMessages() {
    if (
      !this.isPageActive
      || !this.isPageVisible
      || this.pollInFlight
      || !AuthStore.isLoggedIn()
    ) {
      return;
    }
    this.pollInFlight = true;
    try {
      const result = await MessageService.listMessages(
        this.conversationId,
        { pageSize: 20 }
      );
      if (!this.isPageActive || !this.isPageVisible) {
        return;
      }
      const byId = new Map(
        this.serverMessages.map((message) => [message.messageId, message])
      );
      result.list.forEach((message) => {
        byId.set(message.messageId, message);
      });
      this.serverMessages = [...byId.values()];
      this.renderMessages(true);
      this.markRead();
    } catch (error) {
      // 轮询失败保持当前消息，下一轮或手动操作继续重试。
    } finally {
      this.pollInFlight = false;
    }
  },

  startPolling() {
    if (
      this.pollTimer
      || !this.isPageActive
      || !this.isPageVisible
      || this.data.viewState !== 'success'
    ) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.refreshLatestMessages();
    }, POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  markRead() {
    MessageService.markConversationRead(this.conversationId)
      .catch(() => {});
  },

  onInput(event) {
    const value = event && event.detail
      && typeof event.detail.value === 'string'
      ? event.detail.value
      : '';
    this.setData({
      inputValue: value,
      inputLength: value.length,
      sendDisabled: !value.trim()
        || this.data.isSending
        || !this.data.conversation
        || !this.data.conversation.canSend
    });
  },

  sendMessage() {
    const content = this.data.inputValue.trim();
    if (!content) {
      wx.showToast({
        title: '消息内容不能为空',
        icon: 'none'
      });
      return;
    }
    if (content.length > MessageService.MESSAGE_MAX_LENGTH) {
      wx.showToast({
        title: `消息不能超过 ${MessageService.MESSAGE_MAX_LENGTH} 个字`,
        icon: 'none'
      });
      return;
    }
    this.sendPendingMessage({
      messageId: `local_${MessageService.createClientMessageId()}`,
      clientMessageId: MessageService.createClientMessageId(),
      senderPublicUserId: AuthStore.getCurrentUser().id,
      isMine: true,
      type: 'text',
      content,
      createdAt: new Date().toISOString(),
      createdAtText: '刚刚',
      sendStatus: 'sending'
    }, true);
  },

  retryMessage(event) {
    const clientMessageId = event
      && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.clientMessageId
      : '';
    const pending = this.pendingMessages.find(
      (message) => message.clientMessageId === clientMessageId
    );
    if (!pending || pending.sendStatus !== 'failed') {
      return;
    }
    this.sendPendingMessage(pending, false);
  },

  async sendPendingMessage(pending, clearInput) {
    if (
      this.data.isSending
      || !this.data.conversation
      || !this.data.conversation.canSend
    ) {
      return;
    }
    const existingIndex = this.pendingMessages.findIndex(
      (message) => message.clientMessageId === pending.clientMessageId
    );
    const sending = {
      ...pending,
      sendStatus: 'sending'
    };
    if (existingIndex >= 0) {
      this.pendingMessages.splice(existingIndex, 1, sending);
    } else {
      this.pendingMessages.push(sending);
    }
    this.setData({
      isSending: true,
      inputValue: clearInput ? '' : this.data.inputValue,
      inputLength: clearInput ? 0 : this.data.inputLength,
      sendDisabled: true
    });
    this.renderMessages(true);

    try {
      const result = await MessageService.sendTextMessage({
        conversationId: this.conversationId,
        content: sending.content,
        clientMessageId: sending.clientMessageId
      });
      if (!this.isPageActive) {
        return;
      }
      this.pendingMessages = this.pendingMessages.filter(
        (message) => message.clientMessageId !== sending.clientMessageId
      );
      const byId = new Map(
        this.serverMessages.map((message) => [message.messageId, message])
      );
      byId.set(result.message.messageId, result.message);
      this.serverMessages = [...byId.values()];
      this.setData({
        isSending: false,
        sendDisabled: !this.data.inputValue.trim()
          || !this.data.conversation.canSend
      });
      this.renderMessages(true);
      this.refreshLatestMessages();
    } catch (error) {
      if (!this.isPageActive) {
        return;
      }
      const failedIndex = this.pendingMessages.findIndex(
        (message) => message.clientMessageId === sending.clientMessageId
      );
      if (failedIndex >= 0) {
        this.pendingMessages.splice(failedIndex, 1, {
          ...sending,
          sendStatus: 'failed'
        });
      }
      this.setData({
        isSending: false,
        sendDisabled: !this.data.inputValue.trim()
          || !this.data.conversation.canSend
      });
      this.renderMessages(true);
      wx.showToast({
        title: error && error.message
          ? error.message
          : '发送失败，请重试',
        icon: 'none'
      });
    }
  },

  onProductTap() {
    const productId = this.data.conversation
      && this.data.conversation.product
      ? this.data.conversation.product.productId
      : '';
    if (!productId) {
      return;
    }
    NavigationService.safeNavigateTo(
      `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(productId)}`
    );
  },

  retryConversation() {
    this.initializeConversation();
  },

  goMessages() {
    NavigationService.safeSwitchTab(ROUTES.MESSAGES);
  }
});
