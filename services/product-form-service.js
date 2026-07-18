const {
  PRODUCT_PUBLISH_LIMITS,
  PRODUCT_CONDITIONS,
  PRODUCT_PUBLISH_CATEGORIES
} = require('../constants/product-publish');

function buildDraft(data = {}) {
  return {
    title: data.title,
    description: data.description,
    price: data.price,
    categoryId: data.categoryId,
    condition: data.condition,
    location: data.location
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

function createFormSnapshot(data = {}) {
  const images = Array.isArray(data.images) ? data.images : [];
  return JSON.stringify({
    title: typeof data.title === 'string' ? data.title : '',
    description: typeof data.description === 'string' ? data.description : '',
    price: typeof data.price === 'string' ? data.price : String(data.price || ''),
    categoryId: typeof data.categoryId === 'string' ? data.categoryId : '',
    condition: typeof data.condition === 'string' ? data.condition : '',
    location: typeof data.location === 'string' ? data.location : '',
    images: images.map((image) => (
      image && image.kind === 'existing'
        ? `cloud:${image.fileID}`
        : `local:${image && image.tempFilePath || ''}`
    ))
  });
}

module.exports = {
  PRODUCT_PUBLISH_LIMITS,
  PRODUCT_CONDITIONS,
  PRODUCT_PUBLISH_CATEGORIES,
  buildDraft,
  chooseImages,
  createExistingImages,
  previewImages,
  splitImages,
  createFormSnapshot
};
