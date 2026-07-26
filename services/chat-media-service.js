const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');

const MAX_IMAGE_COUNT = 9;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_SIZE = 10 * 1024 * 1024;
const MIN_VOICE_DURATION_MS = 1000;
const MAX_VOICE_DURATION_MS = 60000;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const AMBIGUOUS_ERROR_CODES = new Set([
  'NETWORK_ERROR',
  'CLOUD_TIMEOUT',
  'CLOUD_CALL_FAILED',
  'UPLOAD_TIMEOUT',
  'MESSAGE_SEND_FAILED',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'UNKNOWN_ERROR'
]);

const ERROR_MESSAGES = {
  INVALID_ARGUMENT: '媒体参数不正确',
  IMAGE_COUNT_INVALID: '一次最多选择 9 张图片',
  IMAGE_TYPE_INVALID: '请选择有效的图片',
  IMAGE_SIZE_INVALID: '图片文件大小无效',
  IMAGE_TOO_LARGE: '单张图片不能超过 10MB',
  VOICE_TYPE_INVALID: '录音文件格式不正确',
  VOICE_SIZE_INVALID: '录音文件大小无效',
  VOICE_TOO_LARGE: '录音文件不能超过 10MB',
  VOICE_TOO_SHORT: '说话时间太短',
  VOICE_TOO_LONG: '语音消息不能超过 60 秒',
  AUTH_CONTEXT_MISSING: '登录状态已失效，请重新登录',
  CLOUD_UNAVAILABLE: '媒体服务暂不可用',
  MEDIA_UPLOAD_FAILED: '媒体上传失败，请稍后重试',
  UPLOAD_TIMEOUT: '媒体上传超时，请检查网络后重试',
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  PERMISSION_DENIED: '需要相关权限才能继续',
  UNKNOWN_ERROR: '媒体处理失败，请稍后重试'
};

class ChatMediaError extends Error {
  constructor(code, message, cause) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN_ERROR);
    this.name = 'ChatMediaError';
    this.code = code || 'UNKNOWN_ERROR';
    this.cause = cause || null;
  }
}

function createError(code, message, cause) {
  return new ChatMediaError(code, message, cause);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeConversationId(value) {
  const conversationId = normalizeString(value);
  return /^c_[a-f0-9]{64}$/.test(conversationId) ? conversationId : '';
}

function normalizeUserId(value) {
  const userId = normalizeString(value);
  return /^u_[a-f0-9]{32}$/.test(userId) ? userId : '';
}

function normalizeClientMessageId(value) {
  const clientMessageId = normalizeString(value);
  return /^[a-zA-Z0-9_-]{8,80}$/.test(clientMessageId)
    ? clientMessageId
    : '';
}

function normalizeFileExtension(filePath, allowedExtensions) {
  const path = normalizeString(filePath).split('?')[0];
  const match = path.match(/\.([a-zA-Z0-9]{2,5})$/);
  const extension = match ? match[1].toLowerCase() : '';
  return allowedExtensions.has(extension) ? extension : '';
}

function formatDateFolder(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('');
}

function getCloudFilePath(fileId) {
  if (
    typeof fileId !== 'string'
    || fileId.length > 1024
    || !fileId.startsWith('cloud://')
  ) {
    return '';
  }
  const match = fileId.match(/^cloud:\/\/[^/]+\/(.+)$/);
  return match ? match[1] : '';
}

function buildCloudPath(options = {}) {
  const type = options.type === 'voice' ? 'voice' : 'image';
  const conversationId = normalizeConversationId(options.conversationId);
  const userId = normalizeUserId(options.userId);
  const clientMessageId = normalizeClientMessageId(options.clientMessageId);
  const extension = type === 'voice'
    ? 'mp3'
    : normalizeFileExtension(
      options.localTempPath,
      ALLOWED_IMAGE_EXTENSIONS
    );
  if (!conversationId || !userId || !clientMessageId || !extension) {
    throw createError('INVALID_ARGUMENT');
  }
  return [
    'chat-media',
    type,
    conversationId,
    userId,
    formatDateFolder(),
    `${clientMessageId}.${extension}`
  ].join('/');
}

function isCancelError(error) {
  const text = normalizeString(
    error && (error.errMsg || error.message)
  ).toLowerCase();
  return text.includes('cancel');
}

function isPermissionDeniedError(error) {
  const text = normalizeString(
    error && (error.errMsg || error.message)
  ).toLowerCase();
  return text.includes('auth deny')
    || text.includes('authorize')
    || text.includes('permission')
    || text.includes('privacy');
}

function mapMediaError(error, fallbackCode = 'UNKNOWN_ERROR') {
  if (error instanceof ChatMediaError) {
    return error;
  }
  if (isPermissionDeniedError(error)) {
    return createError('PERMISSION_DENIED', '', error);
  }
  const classified = CloudService.classifyCallError(error);
  if (
    classified.code === 'NETWORK_ERROR'
    || classified.code === 'CLOUD_TIMEOUT'
  ) {
    return createError(classified.code, '', error);
  }
  return createError(fallbackCode, '', error);
}

function getLocalFileInfo(filePath) {
  const path = normalizeString(filePath);
  if (!path || typeof wx === 'undefined') {
    return Promise.reject(createError('INVALID_ARGUMENT'));
  }
  const manager = typeof wx.getFileSystemManager === 'function'
    ? wx.getFileSystemManager()
    : null;
  if (!manager || typeof manager.getFileInfo !== 'function') {
    return Promise.reject(createError('CLOUD_UNAVAILABLE'));
  }
  return new Promise((resolve, reject) => {
    manager.getFileInfo({
      filePath: path,
      success: resolve,
      fail(error) {
        reject(mapMediaError(error, 'INVALID_ARGUMENT'));
      }
    });
  });
}

function validateImageDecoding(filePath) {
  if (typeof wx === 'undefined' || typeof wx.getImageInfo !== 'function') {
    return Promise.reject(createError('CLOUD_UNAVAILABLE'));
  }
  let timeoutId;
  const request = new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: filePath,
      success: resolve,
      fail(error) {
        reject(mapMediaError(error, 'IMAGE_TYPE_INVALID'));
      }
    });
  });
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError('IMAGE_TYPE_INVALID'));
    }, CLOUD_CONFIG.chatMediaValidationTimeoutMs);
  });
  return Promise.race([request, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

async function prepareImage(localImage) {
  const localTempPath = normalizeString(
    localImage && (localImage.tempFilePath || localImage.path)
  );
  const extension = normalizeFileExtension(
    localTempPath,
    ALLOWED_IMAGE_EXTENSIONS
  );
  if (!localTempPath || !extension) {
    throw createError('IMAGE_TYPE_INVALID');
  }
  const [fileInfo, imageInfo] = await Promise.all([
    getLocalFileInfo(localTempPath),
    validateImageDecoding(localTempPath)
  ]);
  const size = Number(fileInfo && fileInfo.size);
  const width = Number(imageInfo && imageInfo.width);
  const height = Number(imageInfo && imageInfo.height);
  if (!Number.isFinite(size) || size <= 0) {
    throw createError('IMAGE_SIZE_INVALID');
  }
  if (size > MAX_IMAGE_SIZE) {
    throw createError('IMAGE_TOO_LARGE');
  }
  if (
    !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(height)
    || height <= 0
  ) {
    throw createError('IMAGE_TYPE_INVALID');
  }
  return {
    localTempPath,
    width: Math.floor(width),
    height: Math.floor(height),
    size: Math.floor(size),
    extension
  };
}

async function prepareVoice(options = {}) {
  const localTempPath = normalizeString(options.localTempPath);
  const durationMs = Number(options.durationMs);
  if (
    !localTempPath
    || normalizeFileExtension(localTempPath, new Set(['mp3'])) !== 'mp3'
  ) {
    throw createError('VOICE_TYPE_INVALID');
  }
  if (!Number.isFinite(durationMs) || durationMs < MIN_VOICE_DURATION_MS) {
    throw createError('VOICE_TOO_SHORT');
  }
  if (durationMs > MAX_VOICE_DURATION_MS) {
    throw createError('VOICE_TOO_LONG');
  }
  const fileInfo = await getLocalFileInfo(localTempPath);
  const size = Number(fileInfo && fileInfo.size);
  if (!Number.isFinite(size) || size <= 0) {
    throw createError('VOICE_SIZE_INVALID');
  }
  if (size > MAX_VOICE_SIZE) {
    throw createError('VOICE_TOO_LARGE');
  }
  return {
    localTempPath,
    durationMs: Math.floor(durationMs),
    size: Math.floor(size),
    format: 'mp3'
  };
}

function chooseImages(options = {}) {
  const sourceType = options.sourceType === 'camera' ? 'camera' : 'album';
  const count = Math.min(
    MAX_IMAGE_COUNT,
    Math.max(1, Math.floor(Number(options.count) || MAX_IMAGE_COUNT))
  );
  if (typeof wx === 'undefined' || typeof wx.chooseMedia !== 'function') {
    return Promise.reject(createError('CLOUD_UNAVAILABLE'));
  }
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: [sourceType],
      sizeType: ['compressed'],
      success(result) {
        const files = Array.isArray(result && result.tempFiles)
          ? result.tempFiles
          : [];
        if (files.length > count || files.length > MAX_IMAGE_COUNT) {
          reject(createError('IMAGE_COUNT_INVALID'));
          return;
        }
        resolve(files);
      },
      fail(error) {
        if (isCancelError(error)) {
          resolve([]);
          return;
        }
        reject(mapMediaError(error, 'IMAGE_TYPE_INVALID'));
      }
    });
  });
}

async function prepareImages(files) {
  if (!Array.isArray(files) || files.length > MAX_IMAGE_COUNT) {
    throw createError('IMAGE_COUNT_INVALID');
  }
  const result = [];
  for (const file of files) {
    result.push(await prepareImage(file));
  }
  return result;
}

async function uploadFile(options = {}) {
  await CloudService.ensureCloudReady();
  if (
    typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.uploadFile !== 'function'
  ) {
    throw createError('CLOUD_UNAVAILABLE');
  }
  const cloudPath = buildCloudPath(options);
  const localTempPath = normalizeString(options.localTempPath);
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : () => {};
  let timeoutId;
  let uploadTask;
  let settled = false;
  return new Promise((resolve, reject) => {
    function finish(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      callback(value);
    }
    uploadTask = wx.cloud.uploadFile({
      cloudPath,
      filePath: localTempPath,
      success(result) {
        const fileId = normalizeString(result && result.fileID);
        if (!fileId || getCloudFilePath(fileId) !== cloudPath) {
          finish(reject, createError('MEDIA_UPLOAD_FAILED'));
          return;
        }
        finish(resolve, fileId);
      },
      fail(error) {
        finish(reject, mapMediaError(error, 'MEDIA_UPLOAD_FAILED'));
      }
    });
    if (uploadTask && typeof uploadTask.onProgressUpdate === 'function') {
      uploadTask.onProgressUpdate((event) => {
        const progress = Number(event && event.progress);
        onProgress(Number.isFinite(progress)
          ? Math.max(0, Math.min(100, Math.floor(progress)))
          : 0);
      });
    }
    timeoutId = setTimeout(() => {
      finish(reject, createError('UPLOAD_TIMEOUT'));
      if (uploadTask && typeof uploadTask.abort === 'function') {
        uploadTask.abort();
      }
    }, CLOUD_CONFIG.chatMediaUploadTimeoutMs);
  });
}

async function deleteUploadedFile(fileId) {
  const path = getCloudFilePath(fileId);
  if (
    !path.startsWith('chat-media/')
    || typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.deleteFile !== 'function'
  ) {
    return false;
  }
  try {
    await CloudService.ensureCloudReady();
    await new Promise((resolve, reject) => {
      wx.cloud.deleteFile({
        fileList: [fileId],
        success: resolve,
        fail: reject
      });
    });
    return true;
  } catch (error) {
    if (isDevelopmentEnvironment()) {
      console.warn('[chat-media] orphan cleanup failed', {
        code: error && (error.code || error.errCode)
          ? String(error.code || error.errCode)
          : 'UNKNOWN'
      });
    }
    return false;
  }
}

async function resolveTemporaryUrl(fileId) {
  const id = normalizeString(fileId);
  if (!getCloudFilePath(id)) {
    throw createError('INVALID_ARGUMENT');
  }
  await CloudService.ensureCloudReady();
  if (
    typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.getTempFileURL !== 'function'
  ) {
    throw createError('CLOUD_UNAVAILABLE');
  }
  const result = await new Promise((resolve, reject) => {
    wx.cloud.getTempFileURL({
      fileList: [id],
      success: resolve,
      fail: reject
    });
  }).catch((error) => {
    throw mapMediaError(error);
  });
  const item = result && Array.isArray(result.fileList)
    ? result.fileList[0]
    : null;
  const url = normalizeString(item && item.tempFileURL);
  if (
    !url
    || !/^https:\/\//i.test(url)
    || (item && Number(item.status) !== 0)
  ) {
    throw createError('UNKNOWN_ERROR');
  }
  return url;
}

function shouldRetainUploadedFile(error) {
  return Boolean(error && AMBIGUOUS_ERROR_CODES.has(error.code));
}

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

module.exports = {
  ChatMediaError,
  MAX_IMAGE_COUNT,
  MIN_VOICE_DURATION_MS,
  MAX_VOICE_DURATION_MS,
  chooseImages,
  prepareImages,
  prepareVoice,
  uploadFile,
  deleteUploadedFile,
  resolveTemporaryUrl,
  isCancelError,
  isPermissionDeniedError,
  shouldRetainUploadedFile
};
