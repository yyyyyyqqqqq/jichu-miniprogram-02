const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

async function verifyLocationService(root) {
  const servicePath = path.join(root, 'services/location-service');
  const originalWx = global.wx;
  delete require.cache[require.resolve(servicePath)];
  const LocationService = require(servicePath);

  try {
    const normalized = LocationService.normalizeLocation({
      name: '  图书馆南门  ',
      address: ' 示例大学  图书馆南侧 ',
      latitude: '31.2304',
      longitude: 121.4737,
      ignored: 'not persisted'
    });
    assert(
      normalized
      && normalized.name === '图书馆南门'
      && normalized.address === '示例大学 图书馆南侧'
      && normalized.latitude === 31.2304
      && !Object.prototype.hasOwnProperty.call(normalized, 'ignored'),
      'location service did not normalize the selected fields safely'
    );
    assert(
      LocationService.normalizeLocation({
        name: '无效地点',
        address: '无效坐标',
        latitude: 91,
        longitude: 121
      }) === null,
      'location service accepts an out-of-range latitude'
    );
    assert(
      LocationService.normalizeLocation({
        name: '无效地点',
        address: '无效坐标',
        latitude: 0,
        longitude: 0
      }) === null,
      'location service accepts the empty coordinate pair'
    );

    global.wx = {
      chooseLocation({ success }) {
        success({
          name: '体育馆入口',
          address: '示例大学体育馆公共入口',
          latitude: 31.231,
          longitude: 121.474
        });
      }
    };
    const selected = await LocationService.chooseLocation();
    assert(
      selected.cancelled === false
      && selected.location.name === '体育馆入口',
      'location service did not return a valid user-selected location'
    );

    global.wx = {
      chooseLocation({ fail }) {
        fail({ errMsg: 'chooseLocation:fail cancel' });
      }
    };
    const cancelled = await LocationService.chooseLocation();
    assert(
      cancelled.cancelled === true && cancelled.location === null,
      'location cancellation is treated as an error or stale location'
    );

    global.wx = {
      chooseLocation({ fail }) {
        fail({ errMsg: 'chooseLocation:fail auth deny' });
      }
    };
    let permissionError;
    try {
      await LocationService.chooseLocation();
    } catch (error) {
      permissionError = error;
    }
    assert(
      permissionError
      && permissionError.code === 'LOCATION_PERMISSION_DENIED',
      'location permission failure is not classified safely'
    );
  } finally {
    delete require.cache[require.resolve(servicePath)];
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyProductLocationFlow(root) {
  await verifyLocationService(root);

  const appConfig = JSON.parse(read(root, 'app.json'));
  const publishPage = read(root, 'pages/publish/index.js');
  const publishTemplate = read(root, 'pages/publish/index.wxml');
  const publishStyle = read(root, 'pages/publish/index.wxss');
  const editPage = read(root, 'pages/product-edit/index.js');
  const editTemplate = read(root, 'pages/product-edit/index.wxml');
  const pickerPage = read(root, 'pages/location-picker/index.js');
  const appointmentPage = read(root, 'pages/appointment-create/index.js');
  const formService = read(root, 'services/product-form-service.js');
  const publishService = read(root, 'services/product-publish-service.js');
  const createFunction = read(root, 'cloudfunctions/createProduct/index.js');
  const manageFunction = read(root, 'cloudfunctions/manageProduct/index.js');
  const appointmentButtonStyle = read(
    root,
    'pages/appointment-detail/index.wxss'
  );
  const profileEditTemplate = read(root, 'pages/profile-edit/index.wxml');
  const profileEditStyle = read(root, 'pages/profile-edit/index.wxss');

  assert(
    appConfig.requiredPrivateInfos.includes('chooseLocation')
    && /校园面交地点/.test(
      appConfig.permission['scope.userLocation'].desc
    ),
    'product map selection privacy declaration is missing or outdated'
  );

  assert(
    /bindtap="onChooseLocation"/.test(publishTemplate)
    && /location-selector__address/.test(publishTemplate)
    && !/onLocationInput/.test(publishTemplate),
    'publish page still accepts a free-text location or lacks map selection UI'
  );
  assert(
    /location-selector--empty/.test(publishTemplate)
    && /location-selector__spacer/.test(publishTemplate)
    && /location-selector__placeholder-wrap/.test(publishTemplate)
    && /grid-template-columns:\s*48rpx minmax\(0,\s*1fr\) 48rpx/.test(
      publishStyle
    )
    && /location-selector__placeholder\s*\{[\s\S]*line-height:\s*32rpx/.test(
      publishStyle
    ),
    'publish location placeholder no longer uses the accepted centered grid layout'
  );
  assert(
    /LocationService\.chooseLocation\(\)/.test(publishPage)
    && /isChoosingLocation/.test(publishPage)
    && /result\.cancelled/.test(publishPage)
    && /locationDetail:\s*null/.test(publishPage),
    'publish page lacks map selection locking, cancellation, or reset handling'
  );
  assert(
    /bindtap="onChooseLocation"/.test(editTemplate)
    && /location-selector__legacy/.test(editTemplate)
    && /locationDetail:\s*product\.locationDetail/.test(editPage),
    'product edit does not support new map data and legacy location display'
  );
  assert(
    /LocationService/.test(pickerPage)
    && !/wx\.chooseLocation/.test(pickerPage)
    && /ROUTES\.LOCATION_PICKER/.test(appointmentPage)
    && /locationSelected/.test(appointmentPage),
    'appointment location picker did not keep the shared selection flow'
  );
  assert(
    /locationDetail/.test(formService)
    && /requireLocationDetail:\s*true/.test(publishService)
    && /LOCATION_REQUIRED:\s*'请选择交易地点'/.test(publishService),
    'new product drafts do not require a selected normalized map location'
  );
  assert(
    /LOCATION_DETAIL_FIELDS/.test(createFunction)
    && /normalizeProductLocation/.test(createFunction)
    && /INVALID_LOCATION_DETAIL/.test(createFunction)
    && /LOCATION_DETAIL_FIELDS/.test(manageFunction)
    && /ALLOWED_UPDATE_FIELDS/.test(manageFunction)
    && /existingLocationDetail/.test(manageFunction)
    && /locationChanged/.test(manageFunction),
    'cloud product create/edit validation does not enforce new locations and preserve legacy data'
  );
  assert(
    /INVALID_LOCATION_DETAIL:\s*'交易地点信息无效，请重新选择'/.test(
      publishService
    )
    && /throw createError\(payload\.code \|\| 'UNKNOWN_ERROR'\)/.test(
      publishService
    ),
    'publish service lacks a safe friendly cloud location error mapping'
  );

  [
    'cloudfunctions/productQuery/index.js',
    'cloudfunctions/favoriteProduct/index.js',
    'cloudfunctions/userQuery/index.js',
    'cloudfunctions/messageQuery/index.js'
  ].forEach((relativePath) => {
    assert(
      !/locationDetail/.test(read(root, relativePath)),
      `${relativePath} exposes precise product location data publicly`
    );
  });

  const relevantSource = [
    publishPage,
    editPage,
    pickerPage,
    read(root, 'services/location-service.js')
  ].join('\n');
  assert(
    !/wx\.getLocation|startLocationUpdate|onLocationChange/.test(relevantSource),
    'product map selection introduces automatic or continuous location access'
  );
  assert(
    /align-items:\s*center/.test(appointmentButtonStyle)
    && /line-height:\s*normal/.test(appointmentButtonStyle),
    'appointment button centering fix was reverted'
  );
  assert(
    /class="save-button"/.test(profileEditTemplate)
    && /\.save-button[\s\S]*align-items:\s*center/.test(
      profileEditStyle
    ),
    'profile save button centering fix was reverted'
  );

  return true;
}

module.exports = {
  verifyProductLocationFlow
};
