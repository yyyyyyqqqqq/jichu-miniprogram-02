const AuthGuard = require('../../services/auth-guard');
const FeedbackService = require('../../services/feedback-service');
const { AUTH_TARGETS } = require('../../constants/routes');

Page({
  data: {
    content: '',
    contentLength: 0,
    maxLength: FeedbackService.CONTENT_MAX_LENGTH,
    isSubmitting: false,
    errorMessage: '',
    successMessage: ''
  },

  async onShow() {
    await AuthGuard.requireIdentity({ target: AUTH_TARGETS.FEEDBACK });
  },

  onContentInput(event) {
    const value = event && event.detail && typeof event.detail.value === 'string'
      ? event.detail.value.slice(0, FeedbackService.CONTENT_MAX_LENGTH)
      : '';
    this.setData({
      content: value,
      contentLength: value.length,
      errorMessage: '',
      successMessage: ''
    });
  },

  async onSubmitTap() {
    if (this.data.isSubmitting) return;
    const content = FeedbackService.normalizeContent(this.data.content);
    if (!content) {
      this.setData({ errorMessage: '请输入反馈内容', successMessage: '' });
      return;
    }
    if (content.length > FeedbackService.CONTENT_MAX_LENGTH) {
      this.setData({ errorMessage: '反馈内容不能超过 1000 个字符', successMessage: '' });
      return;
    }
    const allowed = await AuthGuard.requireIdentity({ target: AUTH_TARGETS.FEEDBACK });
    if (!allowed) return;

    this.setData({ isSubmitting: true, errorMessage: '', successMessage: '' });
    try {
      await FeedbackService.submit(content);
      this.setData({
        content: '',
        contentLength: 0,
        successMessage: '反馈已收到，感谢你的建议'
      });
      wx.showToast({ title: '提交成功', icon: 'success' });
    } catch (error) {
      this.setData({
        errorMessage: error && error.message ? error.message : '提交失败，请稍后再试'
      });
    } finally {
      this.setData({ isSubmitting: false });
    }
  }
});
