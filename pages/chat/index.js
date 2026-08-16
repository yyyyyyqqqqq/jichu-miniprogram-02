const AuthStore = require('../../store/auth-store');
const AuthGuard = require('../../services/auth-guard');
const MessageService = require('../../services/message-service');
const ChatMediaService = require('../../services/chat-media-service');
const AppointmentService = require('../../services/appointment-service');
const ProductService = require('../../services/product-service');
const SchoolRelation = require('../../utils/school-relation');
const NavigationService = require('../../services/navigation-service');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../../constants/routes');

const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const POLL_INTERVAL_MS = 8000;
const VOICE_CANCEL_THRESHOLD_PX = 80;
const RECORDING_MAX_DURATION_MS = 60000;
const VOICE_PLAYBACK_READY_TIMEOUT_MS = 10000;

function isDevelopmentEnvironment() {
  if (
    typeof wx === 'undefined'
    || typeof wx.getAccountInfoSync !== 'function'
  ) {
    return false;
  }
  try {
    const account = wx.getAccountInfoSync();
    return Boolean(
      account
      && account.miniProgram
      && account.miniProgram.envVersion === 'develop'
    );
  } catch (error) {
    return false;
  }
}

function getDevicePlatform() {
  if (typeof wx === 'undefined') {
    return 'unknown';
  }
  try {
    const device = typeof wx.getDeviceInfo === 'function'
      ? wx.getDeviceInfo()
      : (typeof wx.getSystemInfoSync === 'function'
        ? wx.getSystemInfoSync()
        : null);
    const platform = device && typeof device.platform === 'string'
      ? device.platform.toLowerCase()
      : '';
    return ['ios', 'android', 'devtools'].includes(platform)
      ? platform
      : 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

function getSafeMessageKey(messageId) {
  const normalized = typeof messageId === 'string'
    ? messageId.replace(/[^a-zA-Z0-9_-]/g, '')
    : '';
  return normalized ? normalized.slice(-8) : 'unknown';
}

function sanitizeAudioErrorMessage(error) {
  const message = error && (error.errMsg || error.message)
    ? String(error.errMsg || error.message)
    : '';
  return message
    .replace(/\b(?:cloud|https?|wxfile|file):\/\/\S+/gi, '[redacted-source]')
    .replace(/\bc_[a-f0-9]{64}\b/gi, '[redacted-conversation]')
    .replace(/\bu_[a-f0-9]{32}\b/gi, '[redacted-user]')
    .slice(0, 120);
}

function logVoicePlayback(eventName, details = {}, error = null) {
  if (!isDevelopmentEnvironment()) {
    return;
  }
  console.info('[chat-audio]', {
    event: eventName,
    platform: getDevicePlatform(),
    messageKey: getSafeMessageKey(details.messageId),
    sourceType: details.sourceType || 'unknown',
    tempUrlResolved: Boolean(details.tempUrlResolved),
    errCode: error && (error.errCode || error.code)
      ? String(error.errCode || error.code)
      : '',
    errMsg: sanitizeAudioErrorMessage(error)
  });
}

Page({
  data: {
    viewState: 'loading',
    conversation: null,
    activeAppointment: null,
    appointmentError: '',
    appointmentErrorCode: '',
    messageErrorCode: '',
    isLoadingAppointment: false,
    messages: [],
    inputValue: '',
    hasInputContent: false,
    inputMode: 'text',
    isExtensionPanelOpen: false,
    isPreparingRecording: false,
    isRecording: false,
    isCancellingVoice: false,
    recordingDuration: 0,
    playingVoiceMessageId: '',
    isUploadingMedia: false,
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
    this.observedSchoolScopeKey = SchoolRelation.getSchoolScopeKey(
      AuthStore.getCurrentUser()
    );
    this.pendingSchoolRefresh = false;
    this.serverMessages = [];
    this.pendingMessages = [];
    this.nextCursor = null;
    this.pollInFlight = false;
    this.voicePressActive = false;
    this.voiceStartY = 0;
    this.recordStopAction = 'cancel';
    this.recordingStartedAt = 0;
    this.recorderStartRequested = false;
    this.initializeRecorder();
    this.initializeAudioPlayer();
    this.unsubscribeAuth = AuthStore.subscribe((state) => {
      if (!this.isPageActive) {
        return;
      }
      const nextSchoolScopeKey = SchoolRelation.getSchoolScopeKey(state.user);
      if (nextSchoolScopeKey === this.observedSchoolScopeKey) {
        return;
      }
      this.observedSchoolScopeKey = nextSchoolScopeKey;
      this.pendingSchoolRefresh = true;
      this.requestVersion += 1;
      if (
        AuthStore.isSchoolReady()
        && this.isPageVisible
        && this.conversationId
      ) {
        this.pendingSchoolRefresh = false;
        this.initializeConversation();
      }
    });

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
    this.bindRecorderListeners();
    if (this.data.viewState === 'success') {
      this.startPolling();
      this.refreshLatestMessages();
    }
    if (this.pendingSchoolRefresh && this.conversationId) {
      this.pendingSchoolRefresh = false;
      this.initializeConversation();
    }
  },

  onHide() {
    this.isPageVisible = false;
    this.stopPolling();
    this.closeBottomPanels();
    this.cancelActiveRecording();
    this.unbindRecorderListeners();
    this.stopVoicePlayback();
  },

  onUnload() {
    this.isPageVisible = false;
    this.requestVersion += 1;
    this.stopPolling();
    this.closeBottomPanels();
    this.cancelActiveRecording();
    this.unbindRecorderListeners();
    this.destroyAudioPlayer();
    this.releaseRecorderState();
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
      this.unsubscribeAuth = null;
    }
    this.isPageActive = false;
  },

  async initializeConversation() {
    const allowed = await AuthGuard.requireLogin({
      target: AUTH_TARGETS.CHAT,
      conversationId: this.conversationId
    });
    if (!allowed || !this.isPageActive) {
      return;
    }

    const requestVersion = this.requestVersion + 1;
    this.requestVersion = requestVersion;
    this.setData({
      viewState: 'loading',
      errorMessage: '',
      messageErrorCode: ''
    });
    try {
      const conversation = await MessageService.getConversation(
        this.conversationId
      );
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
      ) {
        return;
      }
      this.conversationId = conversation.conversationId;
      const productId = conversation.product.productId;
      const appointmentRequest = AppointmentService
        .getActiveByConversation(this.conversationId, productId)
        .then((appointment) => ({
          success: true,
          appointment
        }))
        .catch(() => ({
          success: false,
          appointment: null
        }));
      const [messageResult, appointmentResult] = await Promise.all([
        MessageService.listMessages(this.conversationId, {
          pageSize: 20
        }),
        appointmentRequest
      ]);
      if (
        !this.isPageActive
        || requestVersion !== this.requestVersion
      ) {
        return;
      }

      const currentUser = AuthStore.getCurrentUser();
      const decoratedConversation = SchoolRelation.decorateConversation(
        conversation,
        currentUser
      );
      const decoratedAppointment = appointmentResult.appointment
        ? SchoolRelation.decorateAppointment(
            appointmentResult.appointment,
            currentUser
          )
        : null;
      this.serverMessages = messageResult.list;
      this.nextCursor = messageResult.nextCursor;
      wx.setNavigationBarTitle({
        title: conversation.otherUser.nickname || '聊天'
      });
      this.setData({
        viewState: 'success',
        conversation: decoratedConversation,
        activeAppointment: decoratedAppointment,
        appointmentError: appointmentResult.success
          ? ''
          : '预约功能暂不可用',
        appointmentErrorCode: appointmentResult.success
          ? ''
          : 'APPOINTMENT_SERVICE_ERROR',
        messageErrorCode: '',
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
        messageErrorCode: 'MESSAGE_SERVICE_ERROR',
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
      || !AuthStore.isSchoolReady()
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
      this.refreshActiveAppointment();
    } catch (error) {
      // 轮询失败保持当前消息，下一轮或手动操作继续重试。
    } finally {
      this.pollInFlight = false;
    }
  },

  async refreshActiveAppointment() {
    if (
      !this.isPageActive
      || !this.isPageVisible
      || this.data.isLoadingAppointment
    ) {
      return;
    }
    this.setData({ isLoadingAppointment: true });
    try {
      const appointment = await AppointmentService
        .getActiveByConversation(
          this.conversationId,
          this.data.conversation
            && this.data.conversation.product
            && this.data.conversation.product.productId
        );
      if (this.isPageActive && this.isPageVisible) {
        this.setData({
          activeAppointment: appointment
            ? SchoolRelation.decorateAppointment(
                appointment,
                AuthStore.getCurrentUser()
              )
            : null,
          appointmentError: '',
          appointmentErrorCode: ''
        });
      }
    } catch (error) {
      if (this.isPageActive && this.isPageVisible) {
        this.setData({
          appointmentError: '预约功能暂不可用',
          appointmentErrorCode: 'APPOINTMENT_SERVICE_ERROR'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ isLoadingAppointment: false });
      }
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

  closeBottomPanels() {
    if (!this.data.isExtensionPanelOpen) {
      return;
    }
    this.setData({
      isExtensionPanelOpen: false
    });
  },

  onTextInputFocus() {
    this.closeBottomPanels();
  },

  toggleInputMode() {
    if (this.data.isRecording || this.data.isPreparingRecording) {
      return;
    }
    wx.hideKeyboard();
    this.closeBottomPanels();
    this.setData({
      inputMode: this.data.inputMode === 'text' ? 'voice' : 'text'
    });
  },

  toggleExtensionPanel() {
    if (
      this.data.isRecording
      || this.data.isPreparingRecording
      || this.data.isUploadingMedia
    ) {
      return;
    }
    wx.hideKeyboard();
    const shouldOpen = !this.data.isExtensionPanelOpen;
    this.setData({
      isExtensionPanelOpen: shouldOpen
    }, () => {
      if (shouldOpen) {
        this.renderMessages(true);
      }
    });
  },

  showPermissionGuide(content) {
    wx.showModal({
      title: '需要权限',
      content,
      confirmText: '打开设置',
      success(result) {
        if (result.confirm) {
          wx.openSetting();
        }
      }
    });
  },

  getSetting() {
    return new Promise((resolve, reject) => {
      wx.getSetting({
        success: resolve,
        fail: reject
      });
    });
  },

  authorizeScope(scope) {
    return new Promise((resolve, reject) => {
      wx.authorize({
        scope,
        success: resolve,
        fail: reject
      });
    });
  },

  async ensureRecordPermission() {
    try {
      const setting = await this.getSetting();
      if (setting.authSetting && setting.authSetting['scope.record'] === true) {
        return true;
      }
      await this.authorizeScope('scope.record');
      return true;
    } catch (error) {
      if (this.isPageActive) {
        this.showPermissionGuide(
          '需要麦克风权限才能录制语音消息。请在设置中允许使用麦克风。'
        );
      }
      return false;
    }
  },

  initializeRecorder() {
    if (
      typeof wx === 'undefined'
      || typeof wx.getRecorderManager !== 'function'
    ) {
      this.recorderManager = null;
      return;
    }
    this.recorderManager = wx.getRecorderManager();
    this.onRecorderStartHandler = () => {
      this.recorderStartRequested = false;
      if (
        !this.isPageActive
        || !this.isPageVisible
        || !this.voicePressActive
      ) {
        this.recordStopAction = 'cancel';
        this.recorderManager.stop();
        return;
      }
      this.recordStopAction = 'send';
      this.recordingStartedAt = Date.now();
      this.setData({
        isPreparingRecording: false,
        isRecording: true,
        isCancellingVoice: false,
        recordingDuration: 0
      });
      this.startRecordingTicker();
    };
    this.onRecorderStopHandler = (result) => {
      this.recorderStartRequested = false;
      this.handleRecorderStop(result);
    };
    this.onRecorderErrorHandler = () => {
      this.recorderStartRequested = false;
      this.clearRecordingTicker();
      this.voicePressActive = false;
      this.recordStopAction = 'cancel';
      if (this.isPageActive) {
        this.setData({
          isPreparingRecording: false,
          isRecording: false,
          isCancellingVoice: false,
          recordingDuration: 0
        });
        wx.showToast({
          title: '录音失败，请重试',
          icon: 'none'
        });
      }
    };
    this.recorderListenersBound = false;
    this.bindRecorderListeners();
  },

  bindRecorderListeners() {
    if (
      !this.recorderManager
      || this.recorderListenersBound
      || !this.onRecorderStartHandler
      || !this.onRecorderStopHandler
      || !this.onRecorderErrorHandler
    ) {
      return;
    }
    this.recorderManager.onStart(this.onRecorderStartHandler);
    this.recorderManager.onStop(this.onRecorderStopHandler);
    this.recorderManager.onError(this.onRecorderErrorHandler);
    this.recorderListenersBound = true;
  },

  unbindRecorderListeners() {
    if (!this.recorderManager || !this.recorderListenersBound) {
      return;
    }
    if (typeof this.recorderManager.offStart === 'function') {
      this.recorderManager.offStart(this.onRecorderStartHandler);
    }
    if (typeof this.recorderManager.offStop === 'function') {
      this.recorderManager.offStop(this.onRecorderStopHandler);
    }
    if (typeof this.recorderManager.offError === 'function') {
      this.recorderManager.offError(this.onRecorderErrorHandler);
    }
    this.recorderListenersBound = false;
  },

  releaseRecorderState() {
    this.clearRecordingTicker();
    if (!this.recorderManager) {
      return;
    }
    this.unbindRecorderListeners();
    this.recorderStartRequested = false;
    this.recorderManager = null;
  },

  startRecordingTicker() {
    this.clearRecordingTicker();
    this.recordingTimer = setInterval(() => {
      if (!this.isPageActive || !this.data.isRecording) {
        return;
      }
      const seconds = Math.min(
        60,
        Math.max(0, Math.floor((Date.now() - this.recordingStartedAt) / 1000))
      );
      if (seconds !== this.data.recordingDuration) {
        this.setData({ recordingDuration: seconds });
      }
    }, 250);
  },

  clearRecordingTicker() {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
  },

  async onVoiceTouchStart(event) {
    if (
      !this.recorderManager
      || this.voicePressActive
      || this.data.isRecording
      || this.data.isPreparingRecording
      || this.data.isUploadingMedia
    ) {
      if (!this.recorderManager) {
        wx.showToast({
          title: '当前微信版本不支持录音',
          icon: 'none'
        });
      }
      return;
    }
    const touch = event && event.touches && event.touches[0];
    this.voicePressActive = true;
    this.voiceStartY = touch && Number.isFinite(Number(touch.clientY))
      ? Number(touch.clientY)
      : 0;
    this.recordStopAction = 'cancel';
    this.stopVoicePlayback();
    this.closeBottomPanels();
    this.setData({
      isPreparingRecording: true,
      isCancellingVoice: false,
      recordingDuration: 0
    });
    const authorized = await this.ensureRecordPermission();
    if (!authorized || !this.isPageActive || !this.voicePressActive) {
      if (this.isPageActive) {
        this.setData({
          isPreparingRecording: false,
          isCancellingVoice: false
        });
      }
      return;
    }
    try {
      this.recorderStartRequested = true;
      this.recorderManager.start({
        duration: RECORDING_MAX_DURATION_MS,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'mp3',
        frameSize: 4
      });
    } catch (error) {
      this.recorderStartRequested = false;
      this.voicePressActive = false;
      this.setData({
        isPreparingRecording: false,
        isRecording: false
      });
      wx.showToast({
        title: '录音启动失败，请重试',
        icon: 'none'
      });
    }
  },

  onVoiceTouchMove(event) {
    if (!this.voicePressActive) {
      return;
    }
    const touch = event && event.touches && event.touches[0];
    const currentY = touch && Number.isFinite(Number(touch.clientY))
      ? Number(touch.clientY)
      : this.voiceStartY;
    const isCancellingVoice = this.voiceStartY - currentY
      >= VOICE_CANCEL_THRESHOLD_PX;
    if (isCancellingVoice !== this.data.isCancellingVoice) {
      this.setData({ isCancellingVoice });
    }
  },

  finishVoicePress(action) {
    if (!this.voicePressActive) {
      return;
    }
    this.voicePressActive = false;
    this.recordStopAction = action;
    if (this.data.isPreparingRecording && !this.data.isRecording) {
      this.setData({
        isPreparingRecording: false,
        isCancellingVoice: false,
        recordingDuration: 0
      });
      return;
    }
    if (
      (this.data.isRecording || this.recorderStartRequested)
      && this.recorderManager
    ) {
      try {
        this.recorderManager.stop();
      } catch (error) {
        // 启动回调尚未到达时，状态清理仍应继续。
      }
    }
    this.recorderStartRequested = false;
  },

  onVoiceTouchEnd() {
    this.finishVoicePress(
      this.data.isCancellingVoice ? 'cancel' : 'send'
    );
  },

  onVoiceTouchCancel() {
    this.finishVoicePress('cancel');
  },

  cancelActiveRecording() {
    if (
      !this.voicePressActive
      && !this.data.isRecording
      && !this.data.isPreparingRecording
    ) {
      return;
    }
    this.voicePressActive = false;
    this.recordStopAction = 'cancel';
    this.recordingStartedAt = 0;
    this.clearRecordingTicker();
    if (this.data.isRecording && this.recorderManager) {
      this.recorderManager.stop();
    }
    if (this.isPageActive) {
      this.setData({
        isPreparingRecording: false,
        isRecording: false,
        isCancellingVoice: false,
        recordingDuration: 0
      });
    }
  },

  async handleRecorderStop(result) {
    this.clearRecordingTicker();
    this.voicePressActive = false;
    const stopAction = this.recordStopAction;
    const elapsed = this.recordingStartedAt
      ? Date.now() - this.recordingStartedAt
      : 0;
    this.recordStopAction = 'cancel';
    this.recordingStartedAt = 0;
    if (this.isPageActive) {
      this.setData({
        isPreparingRecording: false,
        isRecording: false,
        isCancellingVoice: false,
        recordingDuration: 0
      });
    }
    if (stopAction !== 'send' || !this.isPageActive) {
      return;
    }
    const durationMs = Number(result && result.duration) || elapsed;
    if (durationMs < ChatMediaService.MIN_VOICE_DURATION_MS) {
      wx.showToast({
        title: '说话时间太短',
        icon: 'none'
      });
      return;
    }
    const localTempPath = result && typeof result.tempFilePath === 'string'
      ? result.tempFilePath
      : '';
    if (!localTempPath) {
      wx.showToast({
        title: '录音文件不可用，请重试',
        icon: 'none'
      });
      return;
    }
    const clientMessageId = MessageService.createClientMessageId();
    await this.sendPendingMessage({
      messageId: `local_${clientMessageId}`,
      clientMessageId,
      senderPublicUserId: AuthStore.getCurrentUser().id,
      isMine: true,
      type: 'voice',
      content: '[语音]',
      localTempPath,
      media: {
        fileId: '',
        durationMs: Math.min(
          ChatMediaService.MAX_VOICE_DURATION_MS,
          Math.floor(durationMs)
        ),
        durationText: `${Math.max(1, Math.ceil(durationMs / 1000))}″`,
        size: 0,
        format: 'mp3'
      },
      createdAt: new Date().toISOString(),
      createdAtText: '刚刚',
      sendStatus: 'sending',
      uploadProgress: 0
    }, false);
  },

  initializeAudioPlayer() {
    this.audioContext = null;
    this.audioPlaybackDetails = null;
    this.audioPlaybackSequence = 0;
    this.audioReadyTimeoutId = null;
  },

  clearAudioReadyTimeout() {
    if (this.audioReadyTimeoutId) {
      clearTimeout(this.audioReadyTimeoutId);
      this.audioReadyTimeoutId = null;
    }
  },

  isCurrentAudioPlayer(audio, sequence) {
    return Boolean(
      audio
      && this.audioContext === audio
      && this.audioPlaybackSequence === sequence
    );
  },

  disposeAudioContext(audio, shouldStop = true) {
    if (!audio) {
      return;
    }
    if (shouldStop) {
      try {
        audio.stop();
      } catch (error) {
        // 未开始播放的实例无需额外处理。
      }
    }
    try {
      audio.destroy();
    } catch (error) {
      // 系统可能已经释放当前实例。
    }
  },

  clearPlayingVoiceState() {
    if (this.isPageActive && this.data.playingVoiceMessageId) {
      this.setData({ playingVoiceMessageId: '' });
    }
  },

  finishVoicePlayback(audio, sequence, eventName, options = {}) {
    const details = options.details || this.audioPlaybackDetails || {};
    const error = options.error || null;
    logVoicePlayback(eventName, details, error);
    if (!this.isCurrentAudioPlayer(audio, sequence)) {
      return false;
    }
    this.audioPlaybackSequence += 1;
    this.clearAudioReadyTimeout();
    this.audioContext = null;
    this.audioPlaybackDetails = null;
    this.disposeAudioContext(audio, false);
    this.clearPlayingVoiceState();
    if (options.showFailure && this.isPageActive) {
      wx.showToast({
        title: '语音播放失败',
        icon: 'none'
      });
    }
    return true;
  },

  stopVoicePlayback() {
    this.audioPlaybackSequence += 1;
    this.clearAudioReadyTimeout();
    const audio = this.audioContext;
    const details = this.audioPlaybackDetails || {};
    this.audioContext = null;
    this.audioPlaybackDetails = null;
    if (audio) {
      logVoicePlayback('stop-requested', details);
      this.disposeAudioContext(audio, true);
    }
    this.clearPlayingVoiceState();
  },

  destroyAudioPlayer() {
    this.stopVoicePlayback();
  },

  async onVoiceMessageTap(event) {
    const messageId = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.messageId
      : '';
    const message = this.data.messages.find(
      (item) => item.messageId === messageId
    );
    if (!message || message.type !== 'voice') {
      return;
    }
    if (message.sendStatus === 'failed') {
      this.retryMessage({
        currentTarget: {
          dataset: {
            clientMessageId: message.clientMessageId
          }
        }
      });
      return;
    }
    if (this.data.isRecording || this.data.isPreparingRecording) {
      return;
    }
    if (this.data.playingVoiceMessageId === messageId) {
      this.stopVoicePlayback();
      return;
    }
    if (
      typeof wx === 'undefined'
      || typeof wx.createInnerAudioContext !== 'function'
    ) {
      wx.showToast({
        title: '当前微信版本不支持语音播放',
        icon: 'none'
      });
      return;
    }
    this.stopVoicePlayback();
    this.audioPlaybackSequence += 1;
    const playbackSequence = this.audioPlaybackSequence;
    const playbackDetails = {
      messageId,
      sourceType: message.localTempPath
        ? 'local-temp-file'
        : 'cloud-file',
      tempUrlResolved: false
    };
    logVoicePlayback('resolve-start', playbackDetails);
    try {
      const source = message.localTempPath
        || await ChatMediaService.resolveTemporaryUrl(
          message.media && message.media.fileId
        );
      if (
        !message.localTempPath
        && typeof source === 'string'
        && /^https:\/\//i.test(source)
      ) {
        playbackDetails.sourceType = 'temporary-https-url';
        playbackDetails.tempUrlResolved = true;
      }
      if (
        !source
        || !this.isPageActive
        || playbackSequence !== this.audioPlaybackSequence
      ) {
        return;
      }
      logVoicePlayback('source-ready', playbackDetails);
      const audio = wx.createInnerAudioContext();
      if (!audio) {
        const error = new Error('audio context unavailable');
        error.code = 'AUDIO_CONTEXT_UNAVAILABLE';
        throw error;
      }
      let playRequested = false;
      this.audioContext = audio;
      this.audioPlaybackDetails = playbackDetails;
      audio.autoplay = false;
      audio.obeyMuteSwitch = false;
      audio.onCanplay(() => {
        logVoicePlayback('onCanplay', playbackDetails);
        if (
          playRequested
          || !this.isCurrentAudioPlayer(audio, playbackSequence)
        ) {
          return;
        }
        playRequested = true;
        try {
          audio.play();
        } catch (error) {
          this.finishVoicePlayback(
            audio,
            playbackSequence,
            'play-throw',
            {
              details: playbackDetails,
              error,
              showFailure: true
            }
          );
        }
      });
      audio.onPlay(() => {
        logVoicePlayback('onPlay', playbackDetails);
        if (this.isCurrentAudioPlayer(audio, playbackSequence)) {
          this.clearAudioReadyTimeout();
        }
      });
      audio.onEnded(() => {
        this.finishVoicePlayback(
          audio,
          playbackSequence,
          'onEnded',
          { details: playbackDetails }
        );
      });
      audio.onStop(() => {
        this.finishVoicePlayback(
          audio,
          playbackSequence,
          'onStop',
          { details: playbackDetails }
        );
      });
      audio.onError((error) => {
        this.finishVoicePlayback(
          audio,
          playbackSequence,
          'onError',
          {
            details: playbackDetails,
            error,
            showFailure: true
          }
        );
      });
      this.audioReadyTimeoutId = setTimeout(() => {
        const error = new Error('audio playback readiness timeout');
        error.code = 'AUDIO_READY_TIMEOUT';
        this.finishVoicePlayback(
          audio,
          playbackSequence,
          'ready-timeout',
          {
            details: playbackDetails,
            error,
            showFailure: true
          }
        );
      }, VOICE_PLAYBACK_READY_TIMEOUT_MS);
      this.setData({ playingVoiceMessageId: messageId });
      audio.src = source;
    } catch (error) {
      if (playbackSequence !== this.audioPlaybackSequence) {
        return;
      }
      if (this.audioContext) {
        this.finishVoicePlayback(
          this.audioContext,
          playbackSequence,
          'setup-error',
          {
            details: playbackDetails,
            error,
            showFailure: true
          }
        );
        return;
      }
      this.audioPlaybackSequence += 1;
      this.clearAudioReadyTimeout();
      logVoicePlayback('resolve-error', playbackDetails, error);
      this.clearPlayingVoiceState();
      if (this.isPageActive) {
        wx.showToast({
          title: '语音播放失败',
          icon: 'none'
        });
      }
    }
  },

  onAlbumTap() {
    this.chooseAndSendImages('album');
  },

  onCameraTap() {
    this.chooseAndSendImages('camera');
  },

  async chooseAndSendImages(sourceType) {
    if (this.data.isUploadingMedia || this.data.isSending) {
      return;
    }
    this.closeBottomPanels();
    this.setData({ isUploadingMedia: true });
    try {
      const selected = await ChatMediaService.chooseImages({
        sourceType,
        count: ChatMediaService.MAX_IMAGE_COUNT
      });
      if (!this.isPageActive || selected.length === 0) {
        return;
      }
      const images = await ChatMediaService.prepareImages(selected);
      for (const image of images) {
        if (!this.isPageActive) {
          break;
        }
        const clientMessageId = MessageService.createClientMessageId();
        await this.sendPendingMessage({
          messageId: `local_${clientMessageId}`,
          clientMessageId,
          senderPublicUserId: AuthStore.getCurrentUser().id,
          isMine: true,
          type: 'image',
          content: '[图片]',
          localTempPath: image.localTempPath,
          media: {
            fileId: '',
            width: image.width,
            height: image.height,
            size: image.size,
            displayMode: image.width / image.height > 1.35
              ? 'landscape'
              : image.width / image.height < 0.74 ? 'portrait' : 'square'
          },
          createdAt: new Date().toISOString(),
          createdAtText: '刚刚',
          sendStatus: 'sending',
          uploadProgress: 0
        }, false);
      }
    } catch (error) {
      if (
        this.isPageActive
        && error
        && error.code === 'PERMISSION_DENIED'
      ) {
        this.showPermissionGuide(
          sourceType === 'camera'
            ? '需要摄像头权限才能拍摄照片。请在设置中允许后重试。'
            : '需要照片访问权限才能从相册发送图片。请在设置中允许后重试。'
        );
      } else if (this.isPageActive) {
        wx.showToast({
          title: error && error.message
            ? error.message
            : '图片处理失败，请重试',
          icon: 'none'
        });
      }
    } finally {
      if (this.isPageActive) {
        this.setData({ isUploadingMedia: false });
      }
    }
  },

  async previewImageMessage(event) {
    const messageId = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.messageId
      : '';
    const images = this.data.messages.filter(
      (item) => item.type === 'image'
        && item.sendStatus !== 'sending'
        && (item.localTempPath || (item.media && item.media.fileId))
    );
    const currentIndex = images.findIndex(
      (item) => item.messageId === messageId
    );
    if (currentIndex < 0) {
      return;
    }
    try {
      const urls = await Promise.all(images.map(async (item) => (
        item.localTempPath
          || ChatMediaService.resolveTemporaryUrl(item.media.fileId)
      )));
      wx.previewImage({
        current: urls[currentIndex],
        urls
      });
    } catch (error) {
      wx.showToast({
        title: '图片暂时无法预览',
        icon: 'none'
      });
    }
  },

  onImageMessageTap(event) {
    const messageId = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.messageId
      : '';
    const message = this.data.messages.find(
      (item) => item.messageId === messageId
    );
    if (!message || message.type !== 'image') {
      return;
    }
    if (message.sendStatus === 'failed') {
      this.retryMessage({
        currentTarget: {
          dataset: {
            clientMessageId: message.clientMessageId
          }
        }
      });
      return;
    }
    this.previewImageMessage(event);
  },

  onLocationTap() {
    if (this.data.isSending || this.data.isRecording) {
      return;
    }
    this.closeBottomPanels();
    wx.chooseLocation({
      success: async (result) => {
        if (!this.isPageActive) {
          return;
        }
        const name = typeof result.name === 'string'
          ? result.name.trim()
          : '';
        const address = typeof result.address === 'string'
          ? result.address.trim()
          : '';
        const latitude = Number(result.latitude);
        const longitude = Number(result.longitude);
        if (
          !name
          || !address
          || !Number.isFinite(latitude)
          || !Number.isFinite(longitude)
        ) {
          wx.showToast({
            title: '所选地点信息不完整',
            icon: 'none'
          });
          return;
        }
        const clientMessageId = MessageService.createClientMessageId();
        await this.sendPendingMessage({
          messageId: `local_${clientMessageId}`,
          clientMessageId,
          senderPublicUserId: AuthStore.getCurrentUser().id,
          isMine: true,
          type: 'location',
          content: '[位置]',
          location: {
            name,
            address,
            latitude,
            longitude
          },
          createdAt: new Date().toISOString(),
          createdAtText: '刚刚',
          sendStatus: 'sending'
        }, false);
      },
      fail: (error) => {
        const text = String(error && error.errMsg || '').toLowerCase();
        if (text.includes('cancel')) {
          return;
        }
        if (
          text.includes('auth deny')
          || text.includes('permission')
          || text.includes('authorize')
          || text.includes('privacy')
        ) {
          this.showPermissionGuide(
            '需要位置权限才能选择并发送位置。请在设置中允许后重试。'
          );
          return;
        }
        wx.showToast({
          title: '地图暂时无法打开',
          icon: 'none'
        });
      }
    });
  },

  openLocationMessage(event) {
    const messageId = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.messageId
      : '';
    const message = this.data.messages.find(
      (item) => item.messageId === messageId
    );
    if (!message || message.type !== 'location' || !message.location) {
      return;
    }
    if (message.sendStatus === 'failed') {
      this.retryMessage({
        currentTarget: {
          dataset: {
            clientMessageId: message.clientMessageId
          }
        }
      });
      return;
    }
    wx.openLocation({
      name: message.location.name,
      address: message.location.address,
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      scale: 16,
      fail() {
        wx.showToast({
          title: '暂时无法打开地图',
          icon: 'none'
        });
      }
    });
  },

  async openProductPicker() {
    if (
      this.data.isSending
      || this.data.isRecording
      || this.data.isPreparingRecording
      || this.data.isUploadingMedia
    ) {
      return;
    }
    wx.hideKeyboard();
    this.setData({
      isExtensionPanelOpen: false
    });
    const opened = await NavigationService.safeNavigateTo(
      `${ROUTES.CHAT_PRODUCT_PICKER}?conversationId=${encodeURIComponent(this.conversationId)}`
    );
    if (!opened && this.isPageActive) {
      wx.showToast({
        title: '选择商品页面暂时无法打开',
        icon: 'none'
      });
    }
  },

  async openProductMessage(event) {
    const productId = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.productId
      : '';
    const messageId = event && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.messageId
      : '';
    const message = this.data.messages.find(
      (item) => item.messageId === messageId
    );
    if (!productId || !message || message.type !== 'product') {
      return;
    }
    if (message.sendStatus === 'failed') {
      this.retryMessage({
        currentTarget: {
          dataset: {
            clientMessageId: message.clientMessageId
          }
        }
      });
      return;
    }
    try {
      const product = await ProductService.getProductDetail(productId);
      if (!product || !this.isPageActive) {
        throw new Error('商品已失效');
      }
      NavigationService.safeNavigateTo(
        `${ROUTES.PRODUCT_DETAIL}?id=${encodeURIComponent(productId)}`
      );
    } catch (error) {
      wx.showToast({
        title: '商品已失效',
        icon: 'none'
      });
    }
  },

  onInput(event) {
    const value = event && event.detail
      && typeof event.detail.value === 'string'
      ? event.detail.value
      : '';
    this.setData({
      inputValue: value,
      hasInputContent: Boolean(value.trim()),
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
    const failedMessage = this.pendingMessages.find(
      (message) => message.sendStatus === 'failed'
        && message.content === content
    );
    if (failedMessage) {
      this.sendPendingMessage(failedMessage, true);
      return;
    }
    const clientMessageId = MessageService.createClientMessageId();
    this.sendPendingMessage({
      messageId: `local_${clientMessageId}`,
      clientMessageId,
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

  replacePendingMessage(clientMessageId, changes) {
    const index = this.pendingMessages.findIndex(
      (message) => message.clientMessageId === clientMessageId
    );
    if (index < 0) {
      return null;
    }
    const nextMessage = {
      ...this.pendingMessages[index],
      ...changes
    };
    this.pendingMessages.splice(index, 1, nextMessage);
    return nextMessage;
  },

  async uploadPendingMedia(message) {
    if (!['voice', 'image'].includes(message.type)) {
      return message;
    }
    const existingFileId = message.media && message.media.fileId;
    if (existingFileId) {
      return message;
    }
    const currentUser = AuthStore.getCurrentUser();
    if (!currentUser || !currentUser.id) {
      const error = new Error('登录状态已失效，请重新登录');
      error.code = 'AUTH_CONTEXT_MISSING';
      throw error;
    }
    let media = {
      ...(message.media || {})
    };
    if (message.type === 'voice') {
      const prepared = await ChatMediaService.prepareVoice({
        localTempPath: message.localTempPath,
        durationMs: media.durationMs
      });
      media = {
        ...media,
        durationMs: prepared.durationMs,
        durationText: `${Math.max(
          1,
          Math.ceil(prepared.durationMs / 1000)
        )}″`,
        size: prepared.size,
        format: prepared.format
      };
    }
    const fileId = await ChatMediaService.uploadFile({
      type: message.type,
      conversationId: this.conversationId,
      userId: currentUser.id,
      clientMessageId: message.clientMessageId,
      localTempPath: message.localTempPath,
      onProgress: (uploadProgress) => {
        if (!this.isPageActive) {
          return;
        }
        this.replacePendingMessage(message.clientMessageId, {
          media,
          uploadProgress,
          sendStatus: 'uploading'
        });
        this.renderMessages(false);
      }
    });
    const uploaded = this.replacePendingMessage(message.clientMessageId, {
      media: {
        ...media,
        fileId
      },
      uploadProgress: 100,
      sendStatus: 'sending'
    });
    return uploaded || {
      ...message,
      media: {
        ...media,
        fileId
      },
      uploadProgress: 100,
      sendStatus: 'sending'
    };
  },

  dispatchPendingMessage(message) {
    const common = {
      conversationId: this.conversationId,
      clientMessageId: message.clientMessageId
    };
    if (message.type === 'text') {
      return MessageService.sendTextMessage({
        ...common,
        content: message.content
      });
    }
    if (message.type === 'voice') {
      return MessageService.sendVoiceMessage({
        ...common,
        media: message.media
      });
    }
    if (message.type === 'image') {
      return MessageService.sendImageMessage({
        ...common,
        media: message.media
      });
    }
    if (message.type === 'location') {
      return MessageService.sendLocationMessage({
        ...common,
        location: message.location
      });
    }
    if (message.type === 'product') {
      return MessageService.sendProductMessage({
        ...common,
        productId: message.product && message.product.productId
      });
    }
    const error = new Error('暂不支持这种消息类型');
    error.code = 'INVALID_MESSAGE_TYPE';
    return Promise.reject(error);
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
      isUploadingMedia: ['voice', 'image'].includes(sending.type),
      sendDisabled: true
    });
    this.renderMessages(true);

    let uploadedFileId = sending.media && sending.media.fileId
      ? sending.media.fileId
      : '';
    try {
      const readyMessage = await this.uploadPendingMedia(sending);
      uploadedFileId = readyMessage.media && readyMessage.media.fileId
        ? readyMessage.media.fileId
        : '';
      const result = await this.dispatchPendingMessage(readyMessage);
      if (!this.isPageActive) {
        return true;
      }
      this.pendingMessages = this.pendingMessages.filter(
        (message) => message.clientMessageId !== sending.clientMessageId
      );
      const byId = new Map(
        this.serverMessages.map((message) => [message.messageId, message])
      );
      byId.set(result.message.messageId, result.message);
      this.serverMessages = [...byId.values()];
      const shouldClearInput = sending.type === 'text'
        && clearInput
        && this.data.inputValue.trim() === sending.content;
      const inputValue = shouldClearInput ? '' : this.data.inputValue;
      this.setData({
        isSending: false,
        isUploadingMedia: false,
        inputValue,
        hasInputContent: Boolean(inputValue.trim()),
        sendDisabled: !inputValue.trim()
          || !this.data.conversation.canSend
      });
      this.renderMessages(true);
      this.refreshLatestMessages();
      return true;
    } catch (error) {
      if (
        uploadedFileId
        && !ChatMediaService.shouldRetainUploadedFile(error)
      ) {
        await ChatMediaService.deleteUploadedFile(uploadedFileId);
      }
      if (!this.isPageActive) {
        return false;
      }
      const failedIndex = this.pendingMessages.findIndex(
        (message) => message.clientMessageId === sending.clientMessageId
      );
      if (failedIndex >= 0) {
        const failedMessage = this.pendingMessages[failedIndex];
        const retainFile = uploadedFileId
          && ChatMediaService.shouldRetainUploadedFile(error);
        this.pendingMessages.splice(failedIndex, 1, {
          ...failedMessage,
          media: failedMessage.media
            ? {
                ...failedMessage.media,
                fileId: retainFile ? uploadedFileId : ''
              }
            : undefined,
          sendStatus: 'failed',
          uploadProgress: retainFile ? 100 : 0
        });
      }
      this.setData({
        isSending: false,
        isUploadingMedia: false,
        hasInputContent: Boolean(this.data.inputValue.trim()),
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
      return false;
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

  onAppointmentTap() {
    if (this.data.appointmentErrorCode === 'APPOINTMENT_SERVICE_ERROR') {
      wx.showToast({
        title: this.data.appointmentError || '预约功能暂不可用',
        icon: 'none'
      });
      return;
    }
    const appointment = this.data.activeAppointment;
    if (appointment) {
      NavigationService.safeNavigateTo(
        `${ROUTES.APPOINTMENT_DETAIL}?appointmentId=${encodeURIComponent(appointment.appointmentId)}`
      );
      return;
    }
    const product = this.data.conversation
      && this.data.conversation.product;
    if (product && product.isCrossSchool) {
      wx.showToast({
        title: '该商品属于其他学校，不能创建新的面交预约',
        icon: 'none'
      });
      return;
    }
    if (
      !product
      || product.status !== 'available'
      || !this.data.conversation.canSend
    ) {
      wx.showToast({
        title: '当前商品不能创建面交预约',
        icon: 'none'
      });
      return;
    }
    NavigationService.safeNavigateTo(
      `${ROUTES.APPOINTMENT_CREATE}?conversationId=${encodeURIComponent(this.conversationId)}&productId=${encodeURIComponent(product.productId)}`
    );
  },

  openAppointmentMessage(event) {
    const appointmentId = event
      && event.currentTarget
      && event.currentTarget.dataset
      ? event.currentTarget.dataset.appointmentId
      : '';
    if (appointmentId) {
      NavigationService.safeNavigateTo(
        `${ROUTES.APPOINTMENT_DETAIL}?appointmentId=${encodeURIComponent(appointmentId)}`
      );
    }
  },

  retryConversation() {
    this.initializeConversation();
  },

  goMessages() {
    NavigationService.safeSwitchTab(ROUTES.MESSAGES);
  }
});
