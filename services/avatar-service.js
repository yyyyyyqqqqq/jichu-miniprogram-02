const { CLOUD_CONFIG } = require('../config/cloud');
const CloudService = require('./cloud-service');

const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

const ERROR_MESSAGES = {
  INVALID_AVATAR: '请选择有效的头像图片',
  AVATAR_TOO_LARGE: '头像图片不能超过 5MB',
  AVATAR_UPLOAD_FAILED: '头像上传失败，请稍后重试',
  AVATAR_UPLOAD_TIMEOUT: '头像上传超时，请检查网络后重试',
  CLOUD_NOT_READY: '头像上传服务暂不可用'
};

class AvatarError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.AVATAR_UPLOAD_FAILED);
    this.name = 'AvatarError';
    this.code = code || 'AVATAR_UPLOAD_FAILED';
  }
}

function createError(code) {
  return new AvatarError(code, ERROR_MESSAGES[code]);
}

function normalizeUserId(value) {
  const userId = typeof value === 'string' ? value.trim() : '';
  return /^u_[a-f0-9]{32}$/.test(userId) ? userId : '';
}

function randomToken(length = 16) {
  let value = '';
  while (value.length < length) {
    value += Math.random().toString(36).slice(2);
  }
  return value.slice(0, length);
}

function formatDateFolder(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function getCloudFilePath(fileID) {
  if (
    typeof fileID !== 'string'
    || fileID.length > 1024
    || !fileID.startsWith('cloud://')
  ) {
    return '';
  }
  const match = fileID.match(/^cloud:\/\/[^/]+\/(.+)$/);
  return match ? match[1] : '';
}

function getFileInfo(filePath) {
  return new Promise((resolve, reject) => {
    if (
      typeof wx.getFileSystemManager !== 'function'
    ) {
      reject(createError('CLOUD_NOT_READY'));
      return;
    }
    const fileSystemManager = wx.getFileSystemManager();
    if (
      !fileSystemManager
      || typeof fileSystemManager.getFileInfo !== 'function'
    ) {
      reject(createError('CLOUD_NOT_READY'));
      return;
    }
    fileSystemManager.getFileInfo({
      filePath,
      success: resolve,
      fail() {
        reject(createError('INVALID_AVATAR'));
      }
    });
  });
}

function getImageInfo(filePath) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: filePath,
      success: resolve,
      fail() {
        reject(createError('INVALID_AVATAR'));
      }
    });
  });
}

async function validateAvatar(filePath) {
  if (
    typeof wx === 'undefined'
    || typeof wx.getImageInfo !== 'function'
  ) {
    throw createError('CLOUD_NOT_READY');
  }

  let timeoutId;
  const validation = Promise.all([
    getFileInfo(filePath),
    getImageInfo(filePath)
  ]);
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(createError('INVALID_AVATAR'));
    }, CLOUD_CONFIG.avatarImageValidationTimeoutMs);
  });
  const [fileInfo, imageInfo] = await Promise.race([
    validation,
    timeout
  ]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });

  const size = Number(fileInfo && fileInfo.size);
  if (!Number.isFinite(size) || size <= 0) {
    throw createError('INVALID_AVATAR');
  }
  if (size > MAX_AVATAR_SIZE) {
    throw createError('AVATAR_TOO_LARGE');
  }
  const type = String(imageInfo && imageInfo.type || '').toLowerCase();
  if (
    !ALLOWED_IMAGE_TYPES.has(type)
    || !Number.isFinite(Number(imageInfo.width))
    || Number(imageInfo.width) <= 0
    || !Number.isFinite(Number(imageInfo.height))
    || Number(imageInfo.height) <= 0
  ) {
    throw createError('INVALID_AVATAR');
  }
  return type === 'jpeg' ? 'jpg' : type;
}

async function uploadAvatar(options = {}) {
  const filePath = typeof options.tempFilePath === 'string'
    ? options.tempFilePath
    : '';
  const userId = normalizeUserId(options.userId);
  if (!filePath || !userId) {
    throw createError('INVALID_AVATAR');
  }
  const extension = await validateAvatar(filePath);
  try {
    await CloudService.ensureCloudReady();
  } catch (error) {
    throw createError('CLOUD_NOT_READY');
  }
  if (typeof wx.cloud.uploadFile !== 'function') {
    throw createError('CLOUD_NOT_READY');
  }
  const cloudPath = [
    'avatars',
    userId,
    formatDateFolder(),
    `${Date.now()}-${randomToken()}.${extension}`
  ].join('/');

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
      filePath,
      success(response) {
        const fileID = response && typeof response.fileID === 'string'
          ? response.fileID
          : '';
        if (getCloudFilePath(fileID) !== cloudPath) {
          finish(reject, createError('AVATAR_UPLOAD_FAILED'));
          return;
        }
        finish(resolve, fileID);
      },
      fail(error) {
        const message = String(error && error.errMsg || '').toLowerCase();
        finish(
          reject,
          createError(
            message.includes('timeout')
              ? 'AVATAR_UPLOAD_TIMEOUT'
              : 'AVATAR_UPLOAD_FAILED'
          )
        );
      }
    });
    timeoutId = setTimeout(() => {
      if (uploadTask && typeof uploadTask.abort === 'function') {
        uploadTask.abort();
      }
      finish(reject, createError('AVATAR_UPLOAD_TIMEOUT'));
    }, CLOUD_CONFIG.avatarUploadTimeoutMs);
    if (settled) {
      clearTimeout(timeoutId);
    }
  });
}

module.exports = {
  AvatarError,
  uploadAvatar
};
