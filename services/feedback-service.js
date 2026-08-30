const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');

const CONTENT_MAX_LENGTH = 1000;
const ERROR_MESSAGES = Object.freeze({
  INVALID_ACTION: '反馈操作不受支持',
  UNAUTHORIZED: '请先登录后提交反馈',
  INVALID_CONTENT: '请输入 1～1000 个字符的反馈内容',
  INVALID_REQUEST_ID: '反馈请求参数不正确',
  RATE_LIMITED: '提交过于频繁，请稍后再试',
  DATABASE_ERROR: '反馈暂时无法保存，请稍后再试',
  INTERNAL_ERROR: '反馈服务暂不可用，请稍后再试',
  INVALID_RESPONSE: '反馈服务返回异常',
  NETWORK_ERROR: '网络连接失败，请稍后再试',
  CLOUD_TIMEOUT: '反馈提交超时，请重新尝试',
  CLOUD_UNAVAILABLE: '当前微信版本不支持云服务',
  CLOUD_INIT_FAILED: '反馈服务初始化失败，请稍后再试',
  CLOUD_CALL_FAILED: '反馈服务暂不可用，请稍后再试',
  FUNCTION_NOT_FOUND: '反馈服务尚未部署'
});

class FeedbackError extends Error {
  constructor(code, message) {
    super(ERROR_MESSAGES[code] || message || ERROR_MESSAGES.INTERNAL_ERROR);
    this.name = 'FeedbackError';
    this.code = code || 'INTERNAL_ERROR';
  }
}

function normalizeContent(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createRequestId() {
  return `feedback_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

async function submit(content, requestId = createRequestId()) {
  const normalized = normalizeContent(content);
  if (!normalized || normalized.length > CONTENT_MAX_LENGTH) {
    throw new FeedbackError('INVALID_CONTENT');
  }
  let response;
  try {
    response = await CloudService.callFunction({
      name: CLOUD_CONFIG.feedbackActionFunctionName,
      data: { action: 'submit', content: normalized, requestId },
      timeoutMs: CLOUD_CONFIG.feedbackActionTimeoutMs
    });
  } catch (error) {
    const classified = CloudService.classifyCallError(error);
    throw new FeedbackError(classified.code, classified.message);
  }
  const payload = response && response.result;
  if (!payload || payload.success !== true || !payload.data || payload.data.accepted !== true) {
    throw new FeedbackError(
      payload && payload.code ? payload.code : 'INVALID_RESPONSE',
      payload && payload.message
    );
  }
  return payload.data;
}

module.exports = {
  CONTENT_MAX_LENGTH,
  FeedbackError,
  normalizeContent,
  createRequestId,
  submit
};
