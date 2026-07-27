const {
  PRODUCT_PUBLISH_LIMITS,
  PRODUCT_CONDITIONS,
  PRODUCT_PUBLISH_CATEGORIES
} = require('../constants/product-publish');
const LocationService = require('./location-service');

function buildDraft(data = {}) {
  return {
    title: data.title,
    description: data.description,
    price: data.price,
    categoryId: data.categoryId,
    condition: data.condition,
    location: data.location,
    locationDetail: LocationService.normalizeLocation(data.locationDetail)
  };
}

function createLocalImage(file) {
  const tempFilePath = file && typeof file.tempFilePath === 'string'
    ? file.tempFilePath
    : '';
  return {
    key: `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'local',
    tempFilePath,
    previewUrl: tempFilePath,
    size: Number(file && file.size),
    fileType: file && typeof file.fileType === 'string'
      ? file.fileType.toLowerCase()
      : 'image'
  };
}

function normalizeVideoNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function createLocalVideo(file) {
  const tempFilePath = file && typeof file.tempFilePath === 'string'
    ? file.tempFilePath
    : '';
  const duration = normalizeVideoNumber(file && file.duration);
  return {
    key: `local-video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'local',
    tempFilePath,
    previewUrl: tempFilePath,
    fileType: file && typeof file.fileType === 'string'
      ? file.fileType.toLowerCase()
      : 'video',
    size: normalizeVideoNumber(file && file.size),
    duration,
    durationText: formatVideoDuration(duration),
    width: normalizeVideoNumber(file && file.width),
    height: normalizeVideoNumber(file && file.height)
  };
}

function createExistingVideo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const fileID = typeof value.fileID === 'string' && value.fileID.startsWith('cloud://')
    ? value.fileID
    : '';
  if (!fileID) {
    return null;
  }
  const duration = normalizeVideoNumber(value.duration);
  return {
    key: `existing-video-${fileID}`,
    kind: 'existing',
    fileID,
    tempFilePath: fileID,
    previewUrl: fileID,
    fileType: 'video',
    size: normalizeVideoNumber(value.size),
    duration,
    durationText: formatVideoDuration(duration),
    width: normalizeVideoNumber(value.width),
    height: normalizeVideoNumber(value.height),
    posterFileID: typeof value.posterFileID === 'string'
      ? value.posterFileID
      : ''
  };
}

function formatVideoDuration(value) {
  const seconds = Math.max(0, Math.ceil(normalizeVideoNumber(value)));
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function createExistingImages(fileIDs) {
  if (!Array.isArray(fileIDs)) {
    return [];
  }
  return fileIDs
    .filter((fileID, index, list) => (
      typeof fileID === 'string'
      && fileID.startsWith('cloud://')
      && list.indexOf(fileID) === index
    ))
    .map((fileID, index) => ({
      key: `existing-${index}-${fileID}`,
      kind: 'existing',
      fileID,
      tempFilePath: fileID,
      previewUrl: fileID,
      size: 0,
      fileType: 'image'
    }));
}

async function chooseImages(currentImages, maximum) {
  const images = Array.isArray(currentImages) ? currentImages : [];
  const maxImages = Number.isInteger(maximum)
    ? maximum
    : PRODUCT_PUBLISH_LIMITS.MAX_IMAGES;
  const remaining = maxImages - images.length;
  if (remaining <= 0) {
    return {
      additions: [],
      invalidCount: 0,
      oversizedCount: 0
    };
  }

  const result = await new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: resolve,
      fail: reject
    });
  });
  const existingPaths = new Set(
    images.map((image) => image && image.tempFilePath).filter(Boolean)
  );
  const selected = Array.isArray(result.tempFiles) ? result.tempFiles : [];
  const additions = [];
  let invalidCount = 0;
  let oversizedCount = 0;

  selected.forEach((file) => {
    const image = createLocalImage(file);
    if (
      !image.tempFilePath
      || existingPaths.has(image.tempFilePath)
      || image.fileType !== 'image'
      || !Number.isFinite(image.size)
      || image.size <= 0
    ) {
      invalidCount += 1;
      return;
    }
    if (image.size > PRODUCT_PUBLISH_LIMITS.MAX_IMAGE_SIZE) {
      oversizedCount += 1;
      return;
    }
    existingPaths.add(image.tempFilePath);
    additions.push(image);
  });

  return {
    additions: additions.slice(0, remaining),
    invalidCount,
    oversizedCount
  };
}

async function chooseVideo() {
  const result = await new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: PRODUCT_PUBLISH_LIMITS.MAX_VIDEOS,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: PRODUCT_PUBLISH_LIMITS.MAX_VIDEO_DURATION,
      camera: 'back',
      success: resolve,
      fail: reject
    });
  });
  const selected = Array.isArray(result.tempFiles) ? result.tempFiles : [];
  if (selected.length !== 1) {
    return {
      video: null,
      errorCode: 'VIDEO_INVALID'
    };
  }
  const video = createLocalVideo(selected[0]);
  if (!video.tempFilePath || video.fileType !== 'video' || video.size <= 0) {
    return {
      video: null,
      errorCode: 'VIDEO_INVALID'
    };
  }
  if (video.size > PRODUCT_PUBLISH_LIMITS.MAX_VIDEO_SIZE) {
    return {
      video: null,
      errorCode: 'VIDEO_TOO_LARGE'
    };
  }
  if (
    video.duration <= 0
    || video.duration > PRODUCT_PUBLISH_LIMITS.MAX_VIDEO_DURATION
  ) {
    return {
      video: null,
      errorCode: 'VIDEO_DURATION_INVALID'
    };
  }
  if (
    video.width > PRODUCT_PUBLISH_LIMITS.MAX_VIDEO_DIMENSION
    || video.height > PRODUCT_PUBLISH_LIMITS.MAX_VIDEO_DIMENSION
  ) {
    return {
      video: null,
      errorCode: 'VIDEO_INVALID'
    };
  }
  return {
    video,
    errorCode: ''
  };
}

function previewImages(images, index) {
  const list = Array.isArray(images) ? images : [];
  if (!Number.isInteger(index) || !list[index]) {
    return false;
  }
  wx.previewMedia({
    current: index,
    sources: list.map((image) => ({
      url: image.previewUrl || image.tempFilePath || image.fileID,
      type: 'image'
    }))
  });
  return true;
}

function splitImages(images) {
  const existingFileIDs = [];
  const localImages = [];
  const seenFileIDs = new Set();
  const seenPaths = new Set();

  (Array.isArray(images) ? images : []).forEach((image) => {
    if (
      image
      && image.kind === 'existing'
      && typeof image.fileID === 'string'
      && !seenFileIDs.has(image.fileID)
    ) {
      seenFileIDs.add(image.fileID);
      existingFileIDs.push(image.fileID);
      return;
    }
    const tempFilePath = image && typeof image.tempFilePath === 'string'
      ? image.tempFilePath
      : '';
    if (tempFilePath && !seenPaths.has(tempFilePath)) {
      seenPaths.add(tempFilePath);
      localImages.push(image);
    }
  });

  return {
    existingFileIDs,
    localImages
  };
}

function splitVideo(video) {
  if (video && video.kind === 'existing' && video.fileID) {
    return {
      existingVideo: {
        fileID: video.fileID,
        posterFileID: video.posterFileID || '',
        duration: normalizeVideoNumber(video.duration),
        width: normalizeVideoNumber(video.width),
        height: normalizeVideoNumber(video.height),
        size: normalizeVideoNumber(video.size)
      },
      localVideo: null
    };
  }
  return {
    existingVideo: null,
    localVideo: video && video.kind === 'local' ? video : null
  };
}

function createFormSnapshot(data = {}) {
  const images = Array.isArray(data.images) ? data.images : [];
  const video = data.video && typeof data.video === 'object'
    ? data.video
    : null;
  return JSON.stringify({
    title: typeof data.title === 'string' ? data.title : '',
    description: typeof data.description === 'string' ? data.description : '',
    price: typeof data.price === 'string' ? data.price : String(data.price || ''),
    categoryId: typeof data.categoryId === 'string' ? data.categoryId : '',
    condition: typeof data.condition === 'string' ? data.condition : '',
    location: typeof data.location === 'string' ? data.location : '',
    locationDetail: LocationService.normalizeLocation(data.locationDetail),
    images: images.map((image) => (
      image && image.kind === 'existing'
        ? `cloud:${image.fileID}`
        : `local:${image && image.tempFilePath || ''}`
    )),
    video: video
      ? (video.kind === 'existing'
        ? `cloud:${video.fileID}`
        : `local:${video.tempFilePath || ''}`)
      : ''
  });
}

module.exports = {
  PRODUCT_PUBLISH_LIMITS,
  PRODUCT_CONDITIONS,
  PRODUCT_PUBLISH_CATEGORIES,
  buildDraft,
  chooseImages,
  chooseVideo,
  createExistingImages,
  createExistingVideo,
  formatVideoDuration,
  previewImages,
  splitImages,
  splitVideo,
  createFormSnapshot
};
