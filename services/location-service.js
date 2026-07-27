const LOCATION_LIMITS = {
  NAME_MAX_LENGTH: 80,
  ADDRESS_MAX_LENGTH: 120
};

const ERROR_MESSAGES = {
  LOCATION_INVALID: '所选地点信息不完整，请重新选择',
  LOCATION_PERMISSION_DENIED: '地图选点功能暂不可用，请稍后再试',
  LOCATION_UNAVAILABLE: '暂时无法打开地图，请稍后重试'
};

class LocationSelectionError extends Error {
  constructor(code, message) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.LOCATION_UNAVAILABLE);
    this.name = 'LocationSelectionError';
    this.code = code || 'LOCATION_UNAVAILABLE';
  }
}

function normalizeString(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeCoordinate(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function normalizeLocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const name = normalizeString(value.name);
  const address = normalizeString(value.address);
  const latitude = normalizeCoordinate(value.latitude, -90, 90);
  const longitude = normalizeCoordinate(value.longitude, -180, 180);
  if (
    !name
    || name.length > LOCATION_LIMITS.NAME_MAX_LENGTH
    || !address
    || address.length > LOCATION_LIMITS.ADDRESS_MAX_LENGTH
    || latitude === null
    || longitude === null
    || (latitude === 0 && longitude === 0)
  ) {
    return null;
  }
  return {
    name,
    address,
    latitude,
    longitude
  };
}

function classifyError(error) {
  const message = normalizeString(error && error.errMsg).toLowerCase();
  if (message.includes('cancel')) {
    return 'LOCATION_CANCELLED';
  }
  if (
    message.includes('auth deny')
    || message.includes('authorize')
    || message.includes('permission')
  ) {
    return 'LOCATION_PERMISSION_DENIED';
  }
  return 'LOCATION_UNAVAILABLE';
}

function chooseLocation() {
  if (typeof wx === 'undefined' || typeof wx.chooseLocation !== 'function') {
    return Promise.reject(new LocationSelectionError('LOCATION_UNAVAILABLE'));
  }
  return new Promise((resolve, reject) => {
    wx.chooseLocation({
      success(result) {
        const location = normalizeLocation(result);
        if (!location) {
          reject(new LocationSelectionError('LOCATION_INVALID'));
          return;
        }
        resolve({
          cancelled: false,
          location
        });
      },
      fail(error) {
        const code = classifyError(error);
        if (code === 'LOCATION_CANCELLED') {
          resolve({
            cancelled: true,
            location: null
          });
          return;
        }
        reject(new LocationSelectionError(code));
      }
    });
  });
}

function getErrorMessage(error) {
  return error && ERROR_MESSAGES[error.code]
    ? ERROR_MESSAGES[error.code]
    : ERROR_MESSAGES.LOCATION_UNAVAILABLE;
}

module.exports = {
  LOCATION_LIMITS,
  LocationSelectionError,
  normalizeLocation,
  chooseLocation,
  getErrorMessage
};
