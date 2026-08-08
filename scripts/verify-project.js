const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const errors = [];
const checks = [];
const textExtensions = new Set(['.js', '.json', '.wxml', '.wxss', '.md']);

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function record(name, callback) {
  try {
    callback();
    checks.push(`PASS ${name}`);
  } catch (error) {
    errors.push(`${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([
      '.git',
      'node_modules',
      'miniprogram_npm',
      'temp',
      'tmp'
    ].includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(fullPath));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

const files = walk(root);
const appJsonPath = path.join(root, 'app.json');
const appJson = readJson(appJsonPath);
const requiredCompanionExtensions = ['.js', '.json', '.wxml', '.wxss'];

record('all JSON files parse', () => {
  const jsonFiles = files.filter((file) => path.extname(file) === '.json');
  jsonFiles.forEach(readJson);
  assert(jsonFiles.length > 0, 'no JSON files found');
});

record('app.json pages are unique and complete', () => {
  assert(Array.isArray(appJson.pages) && appJson.pages.length > 0, 'pages is empty');
  assert(new Set(appJson.pages).size === appJson.pages.length, 'duplicate page paths');
  for (const page of appJson.pages) {
    for (const extension of requiredCompanionExtensions) {
      const filePath = path.join(root, `${page}${extension}`);
      assert(fs.existsSync(filePath), `missing ${relative(filePath)}`);
    }
  }
});

record('custom tab bar configuration is valid', () => {
  assert(appJson.tabBar && appJson.tabBar.custom === true, 'custom tab bar is not enabled');
  assert(Array.isArray(appJson.tabBar.list), 'tabBar.list is missing');
  for (const item of appJson.tabBar.list) {
    assert(appJson.pages.includes(item.pagePath), `tab page is not registered: ${item.pagePath}`);
  }
  for (const extension of requiredCompanionExtensions) {
    const filePath = path.join(root, `custom-tab-bar/index${extension}`);
    assert(fs.existsSync(filePath), `missing ${relative(filePath)}`);
  }
});

record('usingComponents paths and component files exist', () => {
  const jsonFiles = files.filter((file) => path.extname(file) === '.json');
  for (const jsonFile of jsonFiles) {
    const json = readJson(jsonFile);
    const components = json.usingComponents || {};
    for (const componentPath of Object.values(components)) {
      if (!componentPath.startsWith('/')) {
        continue;
      }
      for (const extension of requiredCompanionExtensions) {
        const filePath = path.join(root, `${componentPath.slice(1)}${extension}`);
        assert(fs.existsSync(filePath), `${relative(jsonFile)} references missing ${relative(filePath)}`);
      }
    }
  }

  const componentDirectories = fs.readdirSync(path.join(root, 'components'));
  assert(componentDirectories.length >= 5, 'expected at least five public components');
});

record('relative require paths resolve', () => {
  const jsFiles = files.filter((file) => path.extname(file) === '.js');
  const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const jsFile of jsFiles) {
    const source = readText(jsFile);
    let match;
    while ((match = requirePattern.exec(source))) {
      const request = match[1];
      if (!request.startsWith('.')) {
        continue;
      }
      const base = path.resolve(path.dirname(jsFile), request);
      const candidates = [base, `${base}.js`, `${base}.json`];
      const isOptionalPrivateCloudConfig = relative(jsFile) === 'config/cloud.js'
        && request === './cloud.private'
        && fs.existsSync(path.join(root, 'config/cloud.private.example.js'));
      if (isOptionalPrivateCloudConfig && !candidates.some(fs.existsSync)) {
        continue;
      }
      assert(candidates.some(fs.existsSync), `${relative(jsFile)} has unresolved require ${request}`);
      assert(!fs.existsSync(base) || !fs.statSync(base).isDirectory(), `${relative(jsFile)} uses unsupported directory require ${request}`);
    }
  }
});

record('JavaScript syntax is valid', () => {
  const jsFiles = files.filter((file) => path.extname(file) === '.js');
  for (const jsFile of jsFiles) {
    execFileSync(process.execPath, ['--check', jsFile], { stdio: 'pipe' });
  }
});

record('WXML attributes and tags are valid', () => {
  const voidTags = new Set(['input', 'image', 'icon', 'progress', 'slider', 'switch']);
  const wxmlFiles = files.filter((file) => path.extname(file) === '.wxml');
  for (const wxmlFile of wxmlFiles) {
    const source = readText(wxmlFile).replace(/<!--[\s\S]*?-->/g, '');
    const stack = [];
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== '<') {
        continue;
      }

      const tagStart = source.slice(index).match(/^<\/?([a-zA-Z][\w-]*)\b/);
      if (!tagStart) {
        continue;
      }

      let quote = '';
      let tagEnd = -1;
      for (let cursor = index + 1; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (quote) {
          if (character === quote && source[cursor - 1] !== '\\') {
            quote = '';
          }
          continue;
        }
        if (character === '"' || character === "'") {
          quote = character;
          continue;
        }
        if (character === '>') {
          tagEnd = cursor;
          break;
        }
      }

      assert(!quote, `${relative(wxmlFile)} has an unterminated attribute quote near offset ${index}`);
      assert(tagEnd >= 0, `${relative(wxmlFile)} has an unterminated tag near offset ${index}`);

      const fullTag = source.slice(index, tagEnd + 1);
      const tagName = tagStart[1];
      const conditionalNames = fullTag.match(/\bwx:(?:if|elif)\b/g) || [];
      const conditionalValues = [
        ...fullTag.matchAll(/\bwx:(?:if|elif)\s*=\s*(["'])(.*?)\1/gs)
      ];
      assert(
        conditionalNames.length === conditionalValues.length,
        `${relative(wxmlFile)} has an unquoted wx:if or wx:elif on ${tagName}`
      );
      conditionalValues.forEach((conditional) => {
        const value = conditional[2].trim();
        assert(
          value.startsWith('{{') && value.endsWith('}}'),
          `${relative(wxmlFile)} has a malformed wx:if or wx:elif value on ${tagName}`
        );
      });
      assert(
        !/\bwx:else\s*=/.test(fullTag),
        `${relative(wxmlFile)} uses wx:else with an expression on ${tagName}`
      );

      if (fullTag.startsWith('</')) {
        const openTag = stack.pop();
        assert(openTag === tagName, `${relative(wxmlFile)} closes ${tagName} after ${openTag || 'nothing'}`);
      } else if (!/\/\s*>$/.test(fullTag) && !voidTags.has(tagName)) {
        stack.push(tagName);
      }
      index = tagEnd;
    }
    assert(stack.length === 0, `${relative(wxmlFile)} has unclosed ${stack.join(', ')}`);
    assert(!/{{[^}]*\.\w+\s*\(/.test(source), `${relative(wxmlFile)} calls a JavaScript method inside WXML`);
  }
});

record('local image references exist', () => {
  const resourcePattern = /(?:src|iconPath|selectedIconPath)\s*[=:]\s*["'](\/?[^"'{}]+\.(?:png|jpg|jpeg|gif|webp|svg))["']/gi;
  for (const file of files) {
    if (!['.json', '.wxml', '.wxss', '.js'].includes(path.extname(file))) {
      continue;
    }
    const source = readText(file);
    let match;
    while ((match = resourcePattern.exec(source))) {
      const request = match[1];
      const filePath = request.startsWith('/')
        ? path.join(root, request.slice(1))
        : path.resolve(path.dirname(file), request);
      assert(fs.existsSync(filePath), `${relative(file)} references missing ${relative(filePath)}`);
    }
  }
});

record('source files are UTF-8 without BOM', () => {
  for (const file of files) {
    if (!textExtensions.has(path.extname(file))) {
      continue;
    }
    const buffer = fs.readFileSync(file);
    const hasBom = buffer.length >= 3
      && buffer[0] === 0xef
      && buffer[1] === 0xbb
      && buffer[2] === 0xbf;
    assert(!hasBom, `${relative(file)} contains UTF-8 BOM`);
  }
});

record('forbidden client APIs, secrets and dependencies are absent', () => {
  const sourceRoots = [
    'app.js',
    'app.json',
    'components/',
    'config/',
    'constants/',
    'custom-tab-bar/',
    'mock/',
    'pages/',
    'services/',
    'store/',
    'utils/'
  ];
  const sourceFiles = files.filter((file) => {
    const name = relative(file);
    return ['.js', '.json', '.wxml'].includes(path.extname(file))
      && sourceRoots.some((sourceRoot) => name === sourceRoot || name.startsWith(sourceRoot));
  });
  const forbiddenPatterns = [
    { pattern: /\bwx\.login\s*\(/, label: 'wx.login' },
    { pattern: /cloudbase/i, label: 'CloudBase' },
    { pattern: /tdesign/i, label: 'TDesign' },
    { pattern: /dayjs/i, label: 'dayjs' },
    { pattern: /\bopenid\b/i, label: 'client openid reference' },
    { pattern: /appsecret/i, label: 'AppSecret' },
    { pattern: /access[_ -]?token/i, label: 'Access Token' }
  ];

  for (const file of sourceFiles) {
    const source = readText(file);
    const auditableSource = source.replace(/YOUR_CLOUDBASE_ENV_ID/g, '');
    for (const forbidden of forbiddenPatterns) {
      assert(
        !forbidden.pattern.test(auditableSource),
        `${relative(file)} contains ${forbidden.label}`
      );
    }
  }

  const typeScriptFiles = files.filter((file) => path.extname(file) === '.ts');
  assert(typeScriptFiles.length === 0, `TypeScript files found: ${typeScriptFiles.map(relative).join(', ')}`);
});

record('pages do not access Mock products directly', () => {
  const pageFiles = files.filter((file) => relative(file).startsWith('pages/'));
  const directMockPattern = /require\(\s*['"][^'"]*mock\/(?:products|index)['"]\s*\)/;
  for (const file of pageFiles) {
    if (path.extname(file) !== '.js') {
      continue;
    }
    assert(!directMockPattern.test(readText(file)), `${relative(file)} accesses Mock data directly`);
  }
});

record('Product model fields and value types are valid', () => {
  const { PRODUCTS } = require(path.join(root, 'mock/index'));
  const {
    PRODUCT_STATUS
  } = require(path.join(root, 'constants/product'));
  const requiredFields = [
    'id',
    'title',
    'description',
    'price',
    'originalPrice',
    'categoryId',
    'categoryName',
    'condition',
    'images',
    'coverImage',
    'tags',
    'campus',
    'locationName',
    'distanceText',
    'publishedAt',
    'status',
    'seller',
    'favoriteCount',
    'viewCount'
  ];
  const allowedStatuses = new Set(Object.values(PRODUCT_STATUS));

  assert(PRODUCTS.length >= 14 && PRODUCTS.length <= 18, 'Mock product count must be between 14 and 18');
  assert(new Set(PRODUCTS.map((product) => product.id)).size === PRODUCTS.length, 'duplicate Product id');
  for (const product of PRODUCTS) {
    for (const field of requiredFields) {
      assert(Object.prototype.hasOwnProperty.call(product, field), `${product.id || 'unknown'} missing ${field}`);
    }
    assert(!Object.prototype.hasOwnProperty.call(product, '_id'), `${product.id} contains _id`);
    assert(!Object.prototype.hasOwnProperty.call(product, 'productId'), `${product.id} contains productId`);
    assert(!Object.prototype.hasOwnProperty.call(product, 'goodsId'), `${product.id} contains goodsId`);
    assert(allowedStatuses.has(product.status), `${product.id} has invalid status ${product.status}`);
    assert(typeof product.price === 'number' && Number.isFinite(product.price) && product.price >= 0, `${product.id} has invalid price`);
    assert(
      product.originalPrice === null
      || (typeof product.originalPrice === 'number' && Number.isFinite(product.originalPrice)),
      `${product.id} has invalid originalPrice`
    );
    assert(!Number.isNaN(new Date(product.publishedAt).getTime()), `${product.id} has invalid publishedAt`);
    assert(Array.isArray(product.images), `${product.id} images is not an array`);
    assert(Array.isArray(product.tags), `${product.id} tags is not an array`);
    assert(product.seller && typeof product.seller.id === 'string' && product.seller.id, `${product.id} seller.id is missing`);
    assert(typeof product.seller.nickname === 'string' && product.seller.nickname, `${product.id} seller.nickname is missing`);
  }
});

record('Mock fixtures cover public and hidden statuses', () => {
  const { PRODUCTS } = require(path.join(root, 'mock/index'));
  const { PRODUCT_STATUS } = require(path.join(root, 'constants/product'));
  const statuses = new Set(PRODUCTS.map((product) => product.status));

  [
    PRODUCT_STATUS.PUBLISHED,
    PRODUCT_STATUS.RESERVED,
    PRODUCT_STATUS.SOLD,
    PRODUCT_STATUS.DRAFT,
    PRODUCT_STATUS.OFFLINE,
    PRODUCT_STATUS.DELETED
  ].forEach((status) => {
    assert(statuses.has(status), `Mock products do not include ${status}`);
  });

  assert(PRODUCTS.some((product) => product.price === 0), 'Mock products do not include a free item');
});

record('format utilities handle price, time and count boundaries', () => {
  const {
    formatPrice,
    formatPublishedTime,
    formatCount
  } = require(path.join(root, 'utils/format'));
  const referenceTime = new Date('2026-07-16T12:00:00.000Z');

  assert(formatPrice(0) === '免费送', 'free price formatting is incorrect');
  assert(formatPrice(12) === '12', 'integer price formatting is incorrect');
  assert(formatPrice(12.5) === '12.5', 'decimal price formatting is incorrect');
  assert(formatPrice(12.345) === '12.35', 'price rounding is incorrect');
  assert(formatPrice('invalid') === '--', 'invalid price fallback is incorrect');
  assert(formatPublishedTime('2026-07-16T11:59:40.000Z', referenceTime) === '刚刚', 'just-now formatting is incorrect');
  assert(formatPublishedTime('2026-07-16T11:55:00.000Z', referenceTime) === '5分钟前', 'minute formatting is incorrect');
  assert(formatPublishedTime('2026-07-16T10:00:00.000Z', referenceTime) === '2小时前', 'hour formatting is incorrect');
  assert(formatPublishedTime('2026-07-15T08:00:00.000Z', referenceTime) === '昨天', 'yesterday formatting is incorrect');
  assert(formatPublishedTime('invalid', referenceTime) === '时间未知', 'invalid time fallback is incorrect');
  assert(formatCount(1200) === '1.2k', 'count formatting is incorrect');
});

record('source does not use external product image URLs', () => {
  const sourceFiles = files.filter((file) => (
    ['.js', '.json', '.wxml', '.wxss'].includes(path.extname(file))
  ));
  const externalImagePattern = /https?:\/\/[^\s"'()]+\.(?:png|jpg|jpeg|gif|webp|svg)/i;
  for (const file of sourceFiles) {
    assert(!externalImagePattern.test(readText(file)), `${relative(file)} uses an external image URL`);
  }
});

record('cloud function project structure is complete', () => {
  const projectConfig = readJson(path.join(root, 'project.config.json'));
  const functionRoot = projectConfig.cloudfunctionRoot;
  assert(functionRoot === 'cloudfunctions/', 'cloudfunctionRoot is not configured');

  [
    'authUser',
    'productQuery',
    'createProduct',
    'manageProduct',
    'favoriteProduct',
    'userQuery',
    'messageQuery',
    'messageAction'
  ].forEach((functionName) => {
    const functionDirectory = path.join(root, functionRoot, functionName);
    ['index.js', 'package.json', 'package-lock.json'].forEach((name) => {
      assert(
        fs.existsSync(path.join(functionDirectory, name)),
        `${functionName}/${name} is missing`
      );
    });

    const functionPackage = readJson(path.join(functionDirectory, 'package.json'));
    const functionLock = readJson(path.join(functionDirectory, 'package-lock.json'));
    assert(
      functionPackage.dependencies
      && typeof functionPackage.dependencies['wx-server-sdk'] === 'string',
      `${functionName} does not depend on wx-server-sdk`
    );
    assert(
      functionLock.packages
      && functionLock.packages['']
      && functionLock.packages[''].dependencies
      && functionLock.packages[''].dependencies['wx-server-sdk']
        === functionPackage.dependencies['wx-server-sdk'],
      `${functionName} package-lock does not preserve the wx-server-sdk dependency`
    );
    assert(
      functionLock.packages['node_modules/wx-server-sdk']
      && typeof functionLock.packages['node_modules/wx-server-sdk'].version
        === 'string',
      `${functionName} package-lock does not resolve wx-server-sdk`
    );
  });
});

record('cloud functions with runtime evidence lock the Node websocket dependency', () => {
  [
    'favoriteProduct',
    'userQuery',
    'productQuery',
    'messageQuery',
    'messageAction'
  ].forEach((functionName) => {
    const functionDirectory = path.join(root, 'cloudfunctions', functionName);
    const functionPackage = readJson(path.join(functionDirectory, 'package.json'));
    const functionLock = readJson(path.join(functionDirectory, 'package-lock.json'));
    const declaredVersion = functionPackage.dependencies
      && functionPackage.dependencies.ws;
    assert(
      typeof declaredVersion === 'string' && declaredVersion,
      `${functionName} does not declare ws as a production dependency`
    );
    assert(
      functionLock.packages
      && functionLock.packages['']
      && functionLock.packages[''].dependencies
      && functionLock.packages[''].dependencies.ws === declaredVersion,
      `${functionName} package-lock does not preserve the ws dependency`
    );
    assert(
      functionLock.packages['node_modules/ws']
      && typeof functionLock.packages['node_modules/ws'].version === 'string',
      `${functionName} package-lock does not resolve ws`
    );
  });
});

record('authUser obtains identity securely and returns a safe envelope', () => {
  const source = readText(path.join(root, 'cloudfunctions/authUser/index.js'));
  const serviceSource = readText(path.join(root, 'services/auth-service.js'));
  const loginSource = readText(path.join(root, 'pages/login/index.js'));
  const loginTemplate = readText(path.join(root, 'pages/login/index.wxml'));
  const avatarSource = readText(path.join(root, 'services/avatar-service.js'));
  assert(/cloud\.getWXContext\s*\(\s*\)/.test(source), 'authUser does not use getWXContext');
  assert(/cloud\.DYNAMIC_CURRENT_ENV/.test(source), 'authUser does not use the current cloud environment');
  assert(/createHash\(\s*['"]sha256['"]\s*\)/.test(source), 'authUser does not derive a deterministic user id');
  assert(!/event\.(?:openid|openId|OPENID)/.test(source), 'authUser trusts a client identity field');
  assert(/users\.doc\(userId\)\.set/.test(source), 'authUser does not use an idempotent user document id');
  assert(
    /['"]login['"]/.test(source)
    && /['"]current['"]/.test(source)
    && /['"]updateProfile['"]/.test(source),
    'authUser actions are incomplete'
  );
  assert(/success:\s*true/.test(source) && /success:\s*false/.test(source), 'authUser response envelope is inconsistent');
  assert(/code/.test(source) && /message/.test(source) && /data/.test(source), 'authUser response fields are incomplete');
  assert(!/console\.(?:log|info|warn|error)/.test(source), 'authUser writes identity information to logs');
  assert(!/nickname:\s*['"]微信用户['"]/.test(source), 'authUser still writes a fixed virtual nickname');
  assert(!/user-001|DEFAULT_USER|mock user|test user/i.test(source), 'authUser contains a fixed virtual user');
  assert(/profileCompleted:\s*Boolean/.test(source), 'authUser does not derive profile completion from submitted profile');
  assert(/isOwnedAvatar\(avatarUrl,\s*userId\)/.test(source), 'authUser does not constrain avatars to the current user path');
  assert(/type="nickname"/.test(loginTemplate), 'login page does not use the nickname input capability');
  assert(/open-type="chooseAvatar"/.test(loginTemplate), 'login page does not use the avatar selection capability');
  assert(/bindchooseavatar="onChooseAvatar"/.test(loginTemplate), 'login page does not handle the selected avatar');
  assert(/AvatarService\.uploadAvatar/.test(loginSource), 'login page does not upload the selected avatar');
  assert(/finally[\s\S]*isSubmitting:\s*false/.test(loginSource), 'login failure can leave the submit loading state active');
  assert(!/微信用户|user-001|DEFAULT_USER/i.test(loginSource + loginTemplate), 'login page contains fixed virtual profile data');
  assert(/avatars/.test(avatarSource) && /wx\.getImageInfo/.test(avatarSource), 'avatar upload does not validate image content');
  assert(
    /MAX_AVATAR_SIZE/.test(avatarSource)
    && /getFileSystemManager\(\)/.test(avatarSource)
    && /fileSystemManager\.getFileInfo/.test(avatarSource)
    && !/wx\.getFileInfo/.test(avatarSource),
    'avatar upload does not enforce file size through the current filesystem API'
  );
  assert(/wx\.cloud\.uploadFile/.test(avatarSource), 'avatar service does not upload to cloud storage');
  assert(!/\b(?:openid|sellerOpenid|senderOpenid)\b/i.test(serviceSource), 'AuthService accepts an internal identity field');

  const safeUserStart = source.indexOf('function toSafeUser');
  const safeUserEnd = source.indexOf('function createUserId');
  const safeUserSource = source.slice(safeUserStart, safeUserEnd);
  assert(safeUserStart >= 0 && safeUserEnd > safeUserStart, 'toSafeUser implementation is missing');
  assert(!/\bopenid\b/i.test(safeUserSource), 'authUser safe response includes openid');
});

record('favorites use guarded services, transactions and safe public fields', () => {
  const functionSource = readText(path.join(root, 'cloudfunctions/favoriteProduct/index.js'));
  const serviceSource = readText(path.join(root, 'services/favorite-service.js'));
  const pageSource = readText(path.join(root, 'pages/favorites/index.js'));
  const pageTemplate = readText(path.join(root, 'pages/favorites/index.wxml'));
  const detailSource = readText(path.join(root, 'pages/product-detail/index.js'));
  const detailTemplate = readText(path.join(root, 'pages/product-detail/index.wxml'));
  const profileTemplate = readText(path.join(root, 'pages/profile/index.wxml'));
  const configSource = readText(path.join(root, 'config/cloud.js'));

  assert(/cloud\.getWXContext\s*\(\s*\)/.test(functionSource), 'favoriteProduct does not use cloud identity');
  assert(!/request\.(?:userOpenid|openid|openId|OPENID)/.test(functionSource), 'favoriteProduct trusts a client identity');
  assert(/createFavoriteId\(openId,\s*productId\)/.test(functionSource), 'favorite relation id is not deterministic');
  assert(/db\.runTransaction/.test(functionSource), 'favorite mutations are not transactional');
  assert(/Math\.max\(0,\s*currentCount\s*-\s*1\)/.test(functionSource), 'favoriteCount can become negative');
  assert(/product\.sellerOpenid\s*===\s*openId/.test(functionSource), 'own-product favorite rejection is missing');
  assert(/product\.status\s*!==\s*['"]available['"]/.test(functionSource), 'non-available products can be newly favorited');
  assert(/product\.status\s*===\s*['"]deleted['"]/.test(functionSource), 'deleted product favorite rejection is missing');
  assert(/ALLOWED_LIST_STATUSES/.test(functionSource) && !/ALLOWED_LIST_STATUSES\s*=\s*new Set\(\[[^\]]*deleted/s.test(functionSource), 'deleted favorites can enter the list');
  assert(!/sellerOpenid\s*:/.test(functionSource.slice(functionSource.indexOf('function toFavoriteProduct'), functionSource.indexOf('async function getFavoriteStatus'))), 'favorite list returns sellerOpenid');
  assert(/\.skip\(offset\)[\s\S]*\.limit\(pageSize\)/.test(functionSource), 'favorite list pagination is missing');
  assert(/orderBy\(\s*['"]createdAt['"]\s*,\s*['"]desc['"]\s*\)[\s\S]*orderBy\(\s*['"]_id['"]\s*,\s*['"]desc['"]\s*\)/.test(functionSource), 'favorite list ordering does not match its deployed compound index');
  assert(/createSafeDiagnostic\(error,\s*trace\.step\)/.test(functionSource), 'favorite failures do not record a safe execution step');
  assert(!/console\.error\([^)]*\b(?:openId|productId|favoriteId|fileID)\b/s.test(functionSource), 'favorite failure log includes a sensitive identifier');
  assert(/wx\.cloud\.callFunction/.test(serviceSource), 'favorite service does not call its cloud function');
  assert(!/\b(?:userOpenid|openid|openId|OPENID)\b/.test(serviceSource), 'favorite service sends or references an identity field');
  assert(!/wx\.cloud\.database/.test(serviceSource), 'favorite service accesses the database directly');
  assert(/favoriteProductFunctionName/.test(configSource), 'favorite cloud function config is missing');
  assert(/AuthGuard\.requireLogin/.test(detailSource), 'detail favorite action does not use AuthGuard');
  assert(/isFavoriteLoading/.test(detailSource) && /disabled=/.test(detailTemplate), 'detail duplicate favorite protection is missing');
  assert(/listMyFavorites/.test(pageSource), 'favorites page does not load real data');
  assert(/onPullDownRefresh/.test(pageSource) && /onReachBottom/.test(pageSource), 'favorites page refresh or pagination is missing');
  assert(/removeFavorite/.test(pageSource) && /取消收藏/.test(pageTemplate), 'favorites page cannot remove favorites');
  assert(/我的收藏/.test(profileTemplate) && /查看收藏/.test(profileTemplate), 'profile favorite entry is still a placeholder');
});

record('public user profiles use a safe id and strict response whitelist', () => {
  const functionSource = readText(path.join(root, 'cloudfunctions/userQuery/index.js'));
  const serviceSource = readText(path.join(root, 'services/public-user-service.js'));
  const pageSource = readText(path.join(root, 'pages/user-profile/index.js'));
  const pageTemplate = readText(path.join(root, 'pages/user-profile/index.wxml'));
  const detailSource = readText(path.join(root, 'pages/product-detail/index.js'));
  const productQuerySource = readText(path.join(root, 'cloudfunctions/productQuery/index.js'));

  assert(/PUBLIC_USER_ID_PATTERN\s*=\s*\/\^u_/.test(functionSource), 'public user id is not constrained');
  assert(/_id:\s*publicUserId/.test(functionSource), 'public user id is not resolved server-side');
  assert(/sellerOpenid:\s*user\.openid/.test(functionSource), 'public products are not scoped through the server user mapping');
  assert(
    /PUBLIC_PRODUCT_STATUSES\s*=\s*\[['"]available['"],\s*['"]reserved['"]\]/
      .test(functionSource)
    && /status:\s*command\.in\(PUBLIC_PRODUCT_STATUSES\)/.test(functionSource),
    'public profile does not restrict products to available and reserved'
  );
  const profileStart = functionSource.indexOf('profile: {');
  const profileEnd = functionSource.indexOf('async function publicProducts');
  const profileSource = functionSource.slice(profileStart, profileEnd);
  assert(profileStart >= 0 && profileEnd > profileStart, 'public profile response is missing');
  assert(!/\bopenid\b/i.test(profileSource), 'public profile response exposes openid');
  assert(!/phone|mobile|role|status|lastLoginAt/.test(profileSource), 'public profile response includes a private field');
  const publicProductStart = functionSource.indexOf('function toPublicProduct');
  const publicProductEnd = functionSource.indexOf('async function findPublicUser');
  assert(!/sellerOpenid|\bopenid\b/i.test(functionSource.slice(publicProductStart, publicProductEnd)), 'public user products expose identity secrets');
  assert(!/\b(?:openid|openId|OPENID)\b/.test(serviceSource), 'public user client service references an internal identity');
  assert(/userId/.test(pageSource) && !/options\.(?:openid|openId)/.test(pageSource), 'public user page uses an unsafe URL parameter');
  assert(/在售商品/.test(pageTemplate) && !/关注|粉丝|评分|私信/.test(pageTemplate), 'public profile UI exceeds phase scope');
  assert(/sellerPublicUserId:\s*record\.sellerId/.test(productQuerySource), 'productQuery does not expose the safe seller public id');
  assert(!/sellerOpenid/.test(productQuerySource.slice(productQuerySource.indexOf('function toPublicProduct'), productQuerySource.indexOf('function toMyProduct'))), 'public product response exposes sellerOpenid');
  assert(/\?userId=/.test(detailSource) && !/\?openid=/.test(detailSource), 'detail seller link does not use publicUserId');
});

record('messaging uses guarded services, deterministic ids and safe response fields', () => {
  const appConfig = readJson(path.join(root, 'app.json'));
  const actionSource = readText(path.join(root, 'cloudfunctions/messageAction/index.js'));
  const querySource = readText(path.join(root, 'cloudfunctions/messageQuery/index.js'));
  const serviceSource = readText(path.join(root, 'services/message-service.js'));
  const cloudServiceSource = readText(path.join(root, 'services/cloud-service.js'));
  const messagesSource = readText(path.join(root, 'pages/messages/index.js'));
  const messagesTemplate = readText(path.join(root, 'pages/messages/index.wxml'));
  const chatSource = readText(path.join(root, 'pages/chat/index.js'));
  const chatTemplate = readText(path.join(root, 'pages/chat/index.wxml'));
  const detailSource = readText(path.join(root, 'pages/product-detail/index.js'));
  const productServiceSource = readText(path.join(root, 'services/product-service.js'));
  const cloudConfigSource = readText(path.join(root, 'config/cloud.js'));

  assert(appConfig.pages.includes('pages/messages/index'), 'messages page is not registered');
  assert(appConfig.pages.includes('pages/chat/index'), 'chat page is not registered');
  assert(/MessageService\.listConversations/.test(messagesSource), 'messages page does not load real conversations');
  assert(/onPullDownRefresh/.test(messagesSource) && /onReachBottom/.test(messagesSource), 'messages refresh or pagination is missing');
  assert(/requestVersion/.test(messagesSource) && /isPageActive/.test(messagesSource), 'messages stale-response protection is missing');
  assert(!/\bmock\b|后续阶段开放|尚未开放/i.test(messagesSource + messagesTemplate), 'messages page retains a Mock or placeholder production path');
  assert(/MessageService\.getConversation/.test(chatSource), 'chat page does not load conversation data');
  assert(/MessageService\.listMessages/.test(chatSource), 'chat page does not load message history');
  assert(/MessageService\.sendTextMessage/.test(chatSource), 'chat page does not send through MessageService');
  assert(/MessageService\.markConversationRead/.test(chatSource), 'chat page does not mark conversations read');
  assert(/setInterval/.test(chatSource) && /clearInterval/.test(chatSource), 'chat polling lifecycle is incomplete');
  assert(/sendStatus/.test(chatSource) && /retryMessage/.test(chatSource), 'chat send failure retry is missing');
  assert(/maxlength=/.test(chatTemplate) && !/rich-text/.test(chatTemplate), 'chat text safety boundary is incomplete');
  assert(!/wx\.cloud\.(?:database|callFunction)/.test(messagesSource + chatSource), 'message pages access cloud data directly');

  assert(/MessageService\.createOrGetConversation/.test(detailSource), 'detail contact action is not connected to real chat');
  assert(/const productId = typeof product\.id/.test(detailSource), 'detail contact action does not derive productId from the displayed product');
  assert(/createOrGetConversation\(\s*productId\s*\)/.test(detailSource), 'detail contact action does not submit the displayed product id');
  assert(!/createOrGetConversation\(\s*this\.data\.productId\s*\)/.test(detailSource), 'detail contact action submits stale route state');
  assert(!/product\.(?:_id|productId)/.test(detailSource), 'detail page mixes raw _id or productId with its normalized product model');
  assert(!/(?:sellerOpenid|sellerOpenId|OPENID)/.test(detailSource), 'detail contact action references a seller identity');
  assert(/isContactLoading/.test(detailSource), 'detail contact duplicate-click protection is missing');
  assert(/product\.id !== id/.test(productServiceSource), 'product detail does not verify response id consistency');
  assert(!/require\([^)]*mock/i.test(productServiceSource + detailSource), 'real product detail retains a Mock data source');

  assert(/messageQueryFunctionName/.test(cloudConfigSource), 'messageQuery config is missing');
  assert(/messageActionFunctionName/.test(cloudConfigSource), 'messageAction config is missing');
  assert(/CloudService\.callFunction/.test(serviceSource), 'MessageService does not use the centralized cloud caller');
  assert(/wx\.cloud\.callFunction/.test(cloudServiceSource), 'centralized cloud service does not call cloud functions');
  assert(/Promise\.race/.test(cloudServiceSource), 'centralized cloud timeout handling is missing');
  assert(!/CLOUD_NOT_READY/.test(serviceSource), 'MessageService still collapses failures into CLOUD_NOT_READY');
  assert(/FUNCTION_NOT_FOUND/.test(serviceSource) && /NETWORK_ERROR/.test(serviceSource) && /CLOUD_TIMEOUT/.test(serviceSource), 'MessageService transport errors are not distinct');
  assert(!/AuthStore/.test(serviceSource), 'MessageService incorrectly uses auth state as cloud readiness');
  assert(
    /Object\.assign\(\{\s*action\s*\},\s*data\)/.test(serviceSource),
    'messageAction payload is not flat'
  );
  assert(!/wx\.cloud\.database/.test(serviceSource), 'MessageService accesses the client database');
  assert(!/\b(?:senderOpenid|sellerOpenid|participantOpenids|OPENID)\b/.test(serviceSource), 'MessageService references an internal identity');

  assert(/cloud\.getWXContext\s*\(\s*\)/.test(actionSource), 'messageAction does not use cloud identity');
  assert(/cloud\.getWXContext\s*\(\s*\)/.test(querySource), 'messageQuery does not use cloud identity');
  assert(/createConversationId\(\s*productId,\s*participantAOpenid,\s*participantBOpenid\s*\)/.test(actionSource), 'conversation id is not deterministic');
  assert(/createMessageId\(\s*conversationId,\s*openId,\s*clientMessageId\s*\)/.test(actionSource), 'message id is not deterministic');
  assert(/db\.runTransaction/.test(actionSource), 'message writes are not transactional');
  assert(/transaction\.collection\(['"]messages['"]\)\.doc\(messageId\)/.test(actionSource), 'message transaction does not use deterministic document operations');
  const sendStart = actionSource.indexOf('async function sendTextMessage');
  const markReadStart = actionSource.indexOf('async function markConversationRead');
  assert(sendStart >= 0 && markReadStart > sendStart, 'message send implementation is missing');
  assert(!/\.where\s*\(/.test(actionSource.slice(sendStart, markReadStart)), 'message transaction assumes where queries are supported');
  assert(/product\.sellerOpenid/.test(actionSource) && !/data\.sellerOpenid/.test(actionSource), 'conversation creation trusts a client seller identity');
  assert(/sellerOpenid\s*===\s*identity\.openId/.test(actionSource), 'self-conversation rejection is missing');
  assert(/product\.status\s*===\s*['"]deleted['"][\s\S]*?ERROR_CODES\.PRODUCT_UNAVAILABLE/.test(actionSource), 'deleted product does not use the unavailable error');
  assert(/if\s*\(\s*!product\s*\)[\s\S]*?ERROR_CODES\.PRODUCT_NOT_FOUND/.test(actionSource), 'missing product does not use PRODUCT_NOT_FOUND');
  const productNotFoundReturns = actionSource.match(
    /return failure\(\s*ERROR_CODES\.PRODUCT_NOT_FOUND/g
  ) || [];
  assert(productNotFoundReturns.length === 1, 'PRODUCT_NOT_FOUND is used for a condition other than a missing document');
  assert(/PRODUCT_SELLER_UNAVAILABLE/.test(actionSource), 'missing seller identity is conflated with a missing product');
  assert(/productIdPresent[\s\S]*productIdLength[\s\S]*productFound[\s\S]*code/.test(actionSource), 'safe product lookup diagnostics are incomplete');
  assert(!/productId\s*:\s*productId/.test(
    actionSource.slice(
      actionSource.indexOf('function logProductLookupDiagnostic'),
      actionSource.indexOf('function createDigest')
    )
  ), 'cloud product diagnostics log the full product id');
  assert(/MESSAGE_MAX_LENGTH\s*=\s*500/.test(actionSource), 'message length limit is missing');
  assert(/participantBUnreadCount[\s\S]*\+\s*1/.test(actionSource) && /participantAUnreadCount[\s\S]*\+\s*1/.test(actionSource), 'recipient unread increments are incomplete');
  assert(/\[unreadField\]:\s*0/.test(actionSource), 'markRead does not clear only the caller slot');

  const safeMessageStart = querySource.indexOf('function toSafeMessage');
  const safeMessageEnd = querySource.indexOf('async function listMessages');
  const safeMessageSource = querySource.slice(safeMessageStart, safeMessageEnd);
  assert(safeMessageStart >= 0 && safeMessageEnd > safeMessageStart, 'safe message mapper is missing');
  assert(!/senderOpenid\s*:|participantAOpenid\s*:|participantBOpenid\s*:/.test(safeMessageSource), 'safe message response exposes an internal identity');
  assert(/isMine:\s*record\.senderOpenid\s*===\s*openId/.test(safeMessageSource), 'message ownership is not derived server-side');
  assert(/orderBy\(\s*['"]createdAt['"]\s*,\s*['"]desc['"]\s*\)[\s\S]*orderBy\(\s*['"]_id['"]\s*,\s*['"]desc['"]\s*\)/.test(querySource), 'message cursor ordering is unstable');
  assert(/orderBy\(\s*['"]lastMessageAt['"]\s*,\s*['"]desc['"]\s*\)[\s\S]*orderBy\(\s*['"]_id['"]\s*,\s*['"]desc['"]\s*\)/.test(querySource), 'conversation cursor ordering is unstable');
});

record('rich chat media, location, product and permission boundaries are wired', () => {
  const appConfig = readJson(path.join(root, 'app.json'));
  const pageSource = readText(path.join(root, 'pages/chat/index.js'));
  const pageTemplate = readText(path.join(root, 'pages/chat/index.wxml'));
  const pageStyle = readText(path.join(root, 'pages/chat/index.wxss'));
  const mediaSource = readText(path.join(root, 'services/chat-media-service.js'));
  const serviceSource = readText(path.join(root, 'services/message-service.js'));
  const actionSource = readText(
    path.join(root, 'cloudfunctions/messageAction/index.js')
  );
  const querySource = readText(
    path.join(root, 'cloudfunctions/messageQuery/index.js')
  );

  assert(
    appConfig.permission
      && appConfig.permission['scope.record']
      && appConfig.permission['scope.userLocation'],
    'microphone or location permission descriptions are missing'
  );
  assert(
    Array.isArray(appConfig.requiredPrivateInfos)
      && appConfig.requiredPrivateInfos.includes('chooseLocation'),
    'chooseLocation private API declaration is missing'
  );
  [
    'voice-switch.svg',
    'keyboard.svg',
    'gallery.svg',
    'camera.svg',
    'location.svg',
    'product.svg',
    'voice-play.svg'
  ].forEach((icon) => {
    assert(
      fs.existsSync(path.join(root, 'assets/icons/chat', icon)),
      `chat icon ${icon} is missing`
    );
  });
  assert(
    /wx\.getRecorderManager/.test(pageSource)
      && /touchstart="onVoiceTouchStart"/.test(pageTemplate)
      && /touchmove="onVoiceTouchMove"/.test(pageTemplate)
      && /touchend="onVoiceTouchEnd"/.test(pageTemplate)
      && /touchcancel="onVoiceTouchCancel"/.test(pageTemplate),
    'press-to-talk recording lifecycle is incomplete'
  );
  assert(
    /onShow\(\)[\s\S]{0,200}bindRecorderListeners\(\)/.test(pageSource)
      && /onHide\(\)[\s\S]{0,400}cancelActiveRecording\(\)[\s\S]{0,200}unbindRecorderListeners\(\)/.test(pageSource)
      && /offStart\(this\.onRecorderStartHandler\)/.test(pageSource)
      && /offStop\(this\.onRecorderStopHandler\)/.test(pageSource)
      && /offError\(this\.onRecorderErrorHandler\)/.test(pageSource)
      && /recorderStartRequested/.test(pageSource)
      && /\(this\.data\.isRecording \|\| this\.recorderStartRequested\)/.test(
        pageSource
      ),
    'global recorder listeners or start-request race are not scoped to the visible chat page'
  );
  assert(
    /wx\.createInnerAudioContext/.test(pageSource)
      && /stopVoicePlayback/.test(pageSource)
      && /destroyAudioPlayer/.test(pageSource)
      && /onCanplay/.test(pageSource)
      && /audioPlaybackSequence/.test(pageSource)
      && /this\.audioContext === audio/.test(pageSource)
      && /tempUrlResolved/.test(pageSource)
      && /AUDIO_READY_TIMEOUT/.test(pageSource),
    'single voice playback lifecycle is incomplete'
  );
  [
    'onVoiceMessageTap',
    'onImageMessageTap',
    'openLocationMessage',
    'openProductMessage'
  ].forEach((handler) => {
    assert(
      pageTemplate.includes(`catchtap="${handler}"`)
      && !pageTemplate.includes(`bindtap="${handler}"`),
      `chat message handler ${handler} does not stop tap propagation`
    );
  });
  assert(
    /if\s*\(\s*!message\s*\|\|\s*message\.type\s*!==\s*['"]voice['"]\s*\)\s*\{\s*return;?\s*\}/.test(
      pageSource
    ),
    'voice playback lacks a non-voice defensive return'
  );
  const voiceLabelStyle = pageStyle.slice(
    pageStyle.indexOf('.voice-record-button__label'),
    pageStyle.indexOf('.voice-record-button--active')
  );
  assert(
    /width:\s*100%/.test(voiceLabelStyle)
      && /height:\s*100%/.test(voiceLabelStyle)
      && /display:\s*flex/.test(voiceLabelStyle)
      && /align-items:\s*center/.test(voiceLabelStyle)
      && /justify-content:\s*center/.test(voiceLabelStyle)
      && /margin:\s*0/.test(voiceLabelStyle)
      && /padding:\s*0/.test(voiceLabelStyle)
      && /line-height:\s*normal/.test(voiceLabelStyle)
      && /white-space:\s*nowrap/.test(voiceLabelStyle),
    'voice record labels do not use full-height flex centering'
  );
  assert(
    /<view\s+class="voice-record-button__label">/.test(pageTemplate)
      && !/height:\s*32rpx|line-height:\s*32rpx/.test(voiceLabelStyle),
    'voice record label still depends on a fixed text line box'
  );
  const textMessageTemplate = pageTemplate.slice(
    pageTemplate.indexOf('item.type === \'text\''),
    pageTemplate.indexOf('item.type === \'voice\'')
  );
  const textBubbleStyle = pageStyle.slice(
    pageStyle.indexOf('.message-bubble--text'),
    pageStyle.indexOf('.message-bubble--voice')
  );
  assert(
    />\{\{item\.content\}\}<\/text>/.test(textMessageTemplate)
      && /height:\s*auto/.test(textBubbleStyle)
      && /min-height:\s*0/.test(textBubbleStyle)
      && /display:\s*inline-flex/.test(textBubbleStyle)
      && /flex:\s*0\s+1\s+auto/.test(textBubbleStyle)
      && /flex-direction:\s*column/.test(textBubbleStyle)
      && !/margin-top:\s*auto/.test(textBubbleStyle),
    'short text messages preserve template indentation or inherit rich-media sizing'
  );
  const inputStyle = pageStyle.slice(
    pageStyle.indexOf('.chat-composer__input {'),
    pageStyle.indexOf('.voice-record-button {')
  );
  const inputWrapStyle = pageStyle.slice(
    pageStyle.indexOf('.chat-composer__input-wrap {'),
    pageStyle.indexOf('.chat-composer__input {')
  );
  assert(
    /padding:\s*20rpx\s+20rpx\s+12rpx/.test(inputStyle)
      && /line-height:\s*40rpx/.test(inputStyle)
      && /min-height:\s*72rpx/.test(inputStyle)
      && /max-height:\s*176rpx/.test(inputStyle)
      && /transform:\s*translateY\((?:1|2)rpx\)/.test(inputStyle)
      && (inputStyle.match(/transform\s*:/g) || []).length === 1
      && !/padding-top\s*:|transform\s*:/.test(inputWrapStyle)
      && /\bauto-height\b/.test(pageTemplate)
      && /maxlength="\{\{maxLength\}\}"/.test(pageTemplate)
      && !/\bplaceholder(?:-class)?=/.test(pageTemplate)
      && !/输入消息/.test(pageTemplate)
      && !/chat-composer__input-placeholder/.test(pageStyle),
    'chat textarea lacks the native line-box optical alignment or growth limit'
  );
  const composerMainStyle = pageStyle.slice(
    pageStyle.indexOf('.chat-composer__main {'),
    pageStyle.indexOf('.chat-composer__input-wrap {')
  );
  const composerRightStyle = pageStyle.slice(
    pageStyle.indexOf('.chat-composer__right {'),
    pageStyle.indexOf('.chat-composer__plus {')
  );
  const composerSendStyle = pageStyle.slice(
    pageStyle.indexOf('.chat-composer__send {'),
    pageStyle.indexOf('.chat-composer__send::after')
  );
  assert(
    /width:\s*0/.test(composerMainStyle)
      && /min-width:\s*0/.test(composerMainStyle)
      && /flex:\s*1\s+1\s+auto/.test(composerMainStyle)
      && /width:\s*auto/.test(composerRightStyle)
      && /min-width:\s*72rpx/.test(composerRightStyle)
      && /max-width:\s*108rpx/.test(composerRightStyle)
      && /flex:\s*0\s+0\s+auto/.test(composerRightStyle)
      && !/width:\s*100%|flex:\s*1(?:\s|;)/.test(composerRightStyle)
      && /width:\s*auto/.test(composerSendStyle)
      && /min-width:\s*92rpx/.test(composerSendStyle)
      && /max-width:\s*108rpx/.test(composerSendStyle)
      && /flex:\s*0\s+0\s+auto/.test(composerSendStyle)
      && /padding:\s*0\s+14rpx/.test(composerSendStyle)
      && /margin:\s*0\s+0\s+2rpx/.test(composerSendStyle)
      && /white-space:\s*nowrap/.test(composerSendStyle)
      && !/width:\s*100%|flex:\s*1(?:\s|;)/.test(composerSendStyle)
      && /wx:if="\{\{inputMode === 'voice' \|\| !hasInputContent\}\}"/.test(
        pageTemplate
      )
      && /wx:else[\s\S]{0,100}class="chat-composer__send"/.test(pageTemplate),
    'chat composer does not preserve a flexible input with compact actions'
  );
  assert(
    /!\^https:\\\/\\\//.test(mediaSource)
      || /\^https:\\\/\\\//.test(mediaSource),
    'cloud media temporary URLs are not restricted to HTTPS'
  );
  assert(
    /chooseAndSendImages\('album'\)/.test(pageSource)
      && /chooseAndSendImages\('camera'\)/.test(pageSource)
      && /mediaType:\s*\[['"]image['"]\]/.test(mediaSource)
      && /sourceType:\s*\[sourceType\]/.test(mediaSource),
    'album and camera do not share an image-only send pipeline'
  );
  const extensionLabels = [
    '相册',
    '拍摄',
    '位置',
    '发送商品'
  ];
  extensionLabels.forEach((label) => {
    assert(pageTemplate.includes(`>${label}<`), `extension item ${label} is missing`);
  });
  assert(
    !/收藏|个人名片|文件|音乐|表情/.test(
      pageTemplate.slice(
        pageTemplate.indexOf('class="extension-panel"'),
        pageTemplate.indexOf('wx:if="{{isPreparingRecording')
      )
    ),
    'extension panel includes an out-of-scope item'
  );
  assert(
    /wx\.chooseLocation/.test(pageSource)
      && /wx\.openLocation/.test(pageSource),
    'location confirmation or map opening is missing'
  );
  assert(
    /listConversationProducts/.test(pageSource + serviceSource + querySource)
      && /ownerScope/.test(querySource)
      && /getParticipantSlot/.test(querySource)
      && /conversation\.productId/.test(querySource),
    'controlled participant product picker is incomplete'
  );
  assert(
    /sendVoiceMessage/.test(serviceSource)
      && /sendImageMessage/.test(serviceSource)
      && /sendLocationMessage/.test(serviceSource)
      && /sendProductMessage/.test(serviceSource),
    'rich message service methods are incomplete'
  );
  assert(
    /SELECTABLE_PRODUCT_STATUSES/.test(actionSource)
      && /send\.read_shared_product/.test(actionSource)
      && /ownerPublicUserId/.test(actionSource),
    'product snapshot is not reconstructed and checked server-side'
  );
  assert(
    /chat-media/.test(mediaSource)
      && /conversationId/.test(mediaSource)
      && /clientMessageId/.test(mediaSource)
      && /validateChatMediaPath/.test(actionSource),
    'chat media paths are not scoped or checked server-side'
  );
  assert(
    /deleteUploadedFile/.test(pageSource + mediaSource)
      && /shouldRetainUploadedFile/.test(pageSource + mediaSource),
    'orphan upload cleanup does not distinguish deterministic and ambiguous failures'
  );
  assert(
    !/localTempPath\s*:/.test(actionSource)
      && !/wx\.cloud\.database/.test(pageSource + serviceSource),
    'rich chat persists local paths or directly accesses the client database'
  );
  assert(
    /:\s*['"]unsupported['"]/.test(serviceSource)
      && /当前版本暂不支持此消息类型/.test(serviceSource + querySource),
    'unknown message types do not have a safe downgrade'
  );
});

record('chat product picker is a protected standalone paginated page', () => {
  const appConfig = readJson(path.join(root, 'app.json'));
  const routeSource = readText(path.join(root, 'constants/routes.js'));
  const chatSource = readText(path.join(root, 'pages/chat/index.js'));
  const chatTemplate = readText(path.join(root, 'pages/chat/index.wxml'));
  const chatStyle = readText(path.join(root, 'pages/chat/index.wxss'));
  const pickerSource = readText(
    path.join(root, 'pages/chat-product-picker/index.js')
  );
  const pickerTemplate = readText(
    path.join(root, 'pages/chat-product-picker/index.wxml')
  );
  const pickerStyle = readText(
    path.join(root, 'pages/chat-product-picker/index.wxss')
  );
  const pickerConfig = readJson(
    path.join(root, 'pages/chat-product-picker/index.json')
  );
  const querySource = readText(
    path.join(root, 'cloudfunctions/messageQuery/index.js')
  );

  assert(
    appConfig.pages.includes('pages/chat-product-picker/index')
      && /CHAT_PRODUCT_PICKER:\s*['"]\/pages\/chat-product-picker\/index['"]/.test(
        routeSource
      )
      && pickerConfig.navigationBarTitleText === '选择商品',
    'standalone chat product picker route is not fully registered'
  );
  assert(
    /ROUTES\.CHAT_PRODUCT_PICKER\}\?conversationId=/.test(chatSource)
      && /safeNavigateTo/.test(chatSource)
      && /isExtensionPanelOpen:\s*false/.test(
        chatSource.slice(
          chatSource.indexOf('async openProductPicker'),
          chatSource.indexOf('async openProductMessage')
        )
      ),
    'chat product entrance does not close the extension panel and navigate safely'
  );
  assert(
    !/isProductPickerOpen|productOwnerScope|productList|productCursor|productHasMore|isLoadingProducts|productError|productRequestVersion/.test(
      chatSource
    )
      && !/product-picker|switchProductOwner|selectConversationProduct|loadConversationProducts/.test(
        chatTemplate + chatStyle
      ),
    'legacy inline chat product picker state, template or style remains'
  );
  assert(
    /AuthGuard\.requireLogin/.test(pickerSource)
      && /CONVERSATION_ID_PATTERN\.test\(conversationId\)/.test(pickerSource)
      && /MessageService\.listConversationProducts/.test(pickerSource)
      && /ownerScope/.test(pickerSource)
      && /onReachBottom\(\)/.test(pickerSource)
      && /PRODUCT_PAGE_SIZE/.test(pickerSource)
      && /scopeStates/.test(pickerSource),
    'standalone picker lacks login, parameter, owner cache or pagination handling'
  );
  assert(
    /MessageService\.createClientMessageId/.test(pickerSource)
      && /MessageService\.sendProductMessage/.test(pickerSource)
      && /isSending/.test(pickerSource)
      && /pendingClientMessageId/.test(pickerSource)
      && /NavigationService\.safeNavigateBack/.test(pickerSource),
    'standalone picker lacks locked idempotent send and safe return'
  );
  assert(
    /我的商品/.test(pickerTemplate)
      && /对方商品/.test(pickerTemplate)
      && /product-card/.test(pickerTemplate + pickerStyle)
      && /viewState === 'loading'/.test(pickerTemplate)
      && /viewState === 'error'/.test(pickerTemplate)
      && /productList\.length === 0/.test(pickerTemplate)
      && /hasMore/.test(pickerTemplate),
    'standalone picker UI lacks tabs, larger cards, or complete list states'
  );
  assert(
    !/options\.(?:productId|ownerScope|openid|openId)|wx\.cloud\.database/.test(
      pickerSource
    )
      && /getParticipantSlot/.test(querySource)
      && /conversation\.productId/.test(querySource),
    'picker trusts client ownership/current-product data or accesses the database directly'
  );
  assert(
    /onShow\(\)[\s\S]{0,300}refreshLatestMessages\(\)/.test(chatSource)
      && /refreshLatestMessages[\s\S]{0,1800}renderMessages\(true\)/.test(
        chatSource
      ),
    'chat does not refresh and scroll after returning from product selection'
  );
});

record('AuthService and AuthStore expose the required boundaries', () => {
  const AuthService = require(path.join(root, 'services/auth-service'));
  const AuthStore = require(path.join(root, 'store/auth-store'));
  const storeSource = readText(path.join(root, 'store/auth-store.js'));

  ['login', 'updateProfile', 'getCurrentUser', 'isLoggedIn', 'clearLocalSession'].forEach((name) => {
    assert(typeof AuthService[name] === 'function', `AuthService.${name} is missing`);
  });
  [
    'bootstrap',
    'login',
    'updateProfile',
    'logout',
    'refreshCurrentUser',
    'getState',
    'getCurrentUser',
    'isLoggedIn',
    'subscribe'
  ].forEach((name) => {
    assert(typeof AuthStore[name] === 'function', `AuthStore.${name} is missing`);
  });

  const statusValues = Object.values(AuthStore.AUTH_STATUS);
  ['idle', 'restoring', 'anonymous', 'authenticated', 'error'].forEach((status) => {
    assert(statusValues.includes(status), `AuthStore status ${status} is missing`);
  });
  assert(
    /function isLoggedIn[\s\S]*profileCompleted\s*===\s*true/.test(storeSource),
    'incomplete virtual profile is treated as a completed login'
  );
});

record('productQuery enforces public reads, real pagination and safe errors', () => {
  const source = readText(path.join(root, 'cloudfunctions/productQuery/index.js'));
  const serviceSource = readText(path.join(root, 'services/product-service.js'));

  assert(
    /['"]list['"]/.test(source)
    && /['"]detail['"]/.test(source)
    && /['"]myProducts['"]/.test(source),
    'productQuery actions are incomplete'
  );
  assert(
    /if\s*\(\s*action\s*===\s*['"]list['"]\s*\)\s*{\s*return await listProducts\(data\);\s*}/s.test(source),
    'productQuery no longer routes the public list action to listProducts'
  );
  assert(
    /callProductQuery\(\s*['"]list['"]\s*,/.test(serviceSource),
    'ProductService no longer calls the public list action'
  );
  assert(/status:\s*command\.in\(PUBLIC_DETAIL_STATUSES\)/.test(source), 'productQuery detail does not filter public statuses');
  assert(/\.skip\(offset\)\.limit\(pageSize\)/.test(source), 'productQuery does not use database pagination');
  assert(/const MAX_PAGE = \d+/.test(source), 'productQuery does not cap the maximum page');
  assert(/normalizePositiveInteger\(data\.page,\s*1,\s*MAX_PAGE\)/.test(source), 'productQuery page cap is not enforced');
  assert(/\.count\(\)/.test(source), 'productQuery does not calculate a real total');
  assert(/PRODUCT_NOT_FOUND/.test(source), 'productQuery does not expose PRODUCT_NOT_FOUND');
  assert(/INVALID_PARAMS/.test(source), 'productQuery does not expose INVALID_PARAMS');
  assert(/DATABASE_ERROR/.test(source), 'productQuery does not expose DATABASE_ERROR');
  assert(!/wx\.cloud\.database/.test(source), 'productQuery uses a client database API');
  assert(!/['"]seed['"]/.test(source), 'productQuery exposes a production seed action');
  assert(!/PRODUCT_SEED_ENABLED|SEED_PRODUCTS_V1|seed-products/.test(source), 'productQuery retains production seed code');
  assert(/cloud\.getWXContext\s*\(\s*\)/.test(source), 'productQuery myProducts does not use getWXContext');
  assert(/sellerOpenid:\s*openId/.test(source), 'productQuery myProducts does not scope queries to the caller');
  assert(
    !fs.existsSync(path.join(root, 'cloudfunctions/productQuery/seed-products.js')),
    'productQuery seed fixture is still packaged with the production function'
  );

  const publicProductStart = source.indexOf('function toPublicProduct');
  const publicProductEnd = source.indexOf('async function listProducts');
  const publicProductSource = source.slice(publicProductStart, publicProductEnd);
  assert(
    publicProductStart >= 0 && publicProductEnd > publicProductStart,
    'productQuery public field mapper is missing'
  );
  assert(!/sellerOpenid|\bopenid\b/i.test(publicProductSource), 'productQuery returns a seller identity secret');
});

record('my-products lifecycle uses guarded services and server ownership checks', () => {
  const appConfig = readJson(path.join(root, 'app.json'));
  const pageSource = readText(path.join(root, 'pages/my-products/index.js'));
  const pageTemplate = readText(path.join(root, 'pages/my-products/index.wxml'));
  const pageConfig = readJson(path.join(root, 'pages/my-products/index.json'));
  const serviceSource = readText(path.join(root, 'services/my-products-service.js'));
  const functionSource = readText(path.join(root, 'cloudfunctions/manageProduct/index.js'));
  const cloudConfigSource = readText(path.join(root, 'config/cloud.js'));
  const authGuardSource = readText(path.join(root, 'services/auth-guard.js'));

  assert(appConfig.pages.includes('pages/my-products/index'), 'my-products page is not registered');
  assert(pageConfig.enablePullDownRefresh === true, 'my-products pull-down refresh is not enabled');
  assert(/AuthGuard\.requireLogin/.test(pageSource), 'my-products page does not use AuthGuard');
  assert(/MyProductsService\.getMyProducts/.test(pageSource), 'my-products page does not use its query service');
  assert(/MyProductsService\.manageProduct/.test(pageSource), 'my-products page does not use its management service');
  assert(/requestVersion/.test(pageSource), 'my-products stale-request protection is missing');
  assert(/isManaging/.test(pageSource) && /actionPromise/.test(pageSource), 'my-products duplicate action protection is missing');
  assert(/onPullDownRefresh/.test(pageSource) && /onReachBottom/.test(pageSource), 'my-products refresh or pagination is missing');
  assert(
    /viewState:\s*['"]error['"]/.test(pageSource)
    && /['"]success['"]\s*:\s*['"]empty['"]/.test(pageSource),
    'my-products empty or error state is missing'
  );
  assert(/showModal/.test(pageSource), 'my-products destructive actions lack confirmation');
  assert(/takeOffline/.test(pageTemplate) && /relist/.test(pageTemplate) && /markSold/.test(pageTemplate), 'my-products action buttons are incomplete');
  assert(!/wx\.cloud\.(?:database|callFunction)/.test(pageSource), 'my-products page accesses cloud data directly');
  assert(
    /AUTH_TARGETS\.MY_PRODUCTS[\s\S]*hasPreviousRoute\(ROUTES\.MY_PRODUCTS\)[\s\S]*safeNavigateBack/.test(authGuardSource),
    'my-products login return can create a duplicate page'
  );

  assert(/wx\.cloud\.callFunction/.test(serviceSource), 'my-products service does not call cloud functions');
  assert(/Promise\.race/.test(serviceSource), 'my-products service timeout handling is missing');
  assert(/manageProductFunctionName/.test(cloudConfigSource), 'manageProduct function name is not centralized');
  assert(!/sellerOpenid|ownerOpenid|\bopenid\b/i.test(serviceSource), 'my-products service sends a client identity field');
  assert(!/wx\.cloud\.database/.test(serviceSource), 'my-products service accesses the client database');

  assert(/cloud\.getWXContext\s*\(\s*\)/.test(functionSource), 'manageProduct does not use getWXContext');
  assert(/product\.sellerOpenid\s*!==\s*openId/.test(functionSource), 'manageProduct does not enforce ownership');
  assert(/PRODUCT_FORBIDDEN/.test(functionSource), 'manageProduct does not expose PRODUCT_FORBIDDEN');
  assert(/PRODUCT_NOT_FOUND/.test(functionSource), 'manageProduct does not expose PRODUCT_NOT_FOUND');
  assert(/INVALID_STATUS_TRANSITION/.test(functionSource), 'manageProduct does not expose INVALID_STATUS_TRANSITION');
  assert(/UNAUTHORIZED/.test(functionSource), 'manageProduct does not expose UNAUTHORIZED');
  assert(/runProductTransaction/.test(functionSource), 'manageProduct state changes are not transaction protected');
  assert(/version:\s*version\s*\+\s*1/.test(functionSource), 'manageProduct state changes do not increment version');
  assert(!/request\.(?:sellerOpenid|ownerOpenid|openid|openId|status)/.test(functionSource), 'manageProduct trusts a client authorization or status field');
});

record('product editing and soft deletion enforce versioned safe mutations', () => {
  const appConfig = readJson(path.join(root, 'app.json'));
  const routeSource = readText(path.join(root, 'constants/routes.js'));
  const editPageSource = readText(path.join(root, 'pages/product-edit/index.js'));
  const editTemplate = readText(path.join(root, 'pages/product-edit/index.wxml'));
  const editServiceSource = readText(path.join(root, 'services/product-edit-service.js'));
  const formServiceSource = readText(path.join(root, 'services/product-form-service.js'));
  const manageSource = readText(path.join(root, 'cloudfunctions/manageProduct/index.js'));
  const querySource = readText(path.join(root, 'cloudfunctions/productQuery/index.js'));
  const createSource = readText(path.join(root, 'cloudfunctions/createProduct/index.js'));
  const myProductsSource = readText(path.join(root, 'pages/my-products/index.js'));
  const myProductsTemplate = readText(path.join(root, 'pages/my-products/index.wxml'));

  assert(appConfig.pages.includes('pages/product-edit/index'), 'product-edit page is not registered');
  assert(/PRODUCT_EDIT/.test(routeSource), 'product-edit protected route is missing');
  assert(/AuthGuard\.requireLogin/.test(editPageSource), 'product-edit page does not use AuthGuard');
  assert(/ProductEditService\.getEditableProduct/.test(editPageSource), 'product-edit page does not load owner-only data');
  assert(/ProductEditService\.updateProduct/.test(editPageSource), 'product-edit page does not use the edit service');
  assert(/isSubmitting/.test(editPageSource) && /submitPromise/.test(editPageSource), 'product-edit duplicate submit protection is missing');
  assert(/viewState:\s*['"]error['"]/.test(editPageSource) && /onRetry/.test(editPageSource), 'product-edit load error recovery is missing');
  assert(/enableAlertBeforeUnload/.test(editPageSource), 'product-edit unsaved-change warning is missing');
  assert(/onRemoveImage/.test(editTemplate) && /onChooseImages/.test(editTemplate), 'product-edit image controls are incomplete');
  assert(!/wx\.cloud\.(?:database|callFunction|uploadFile|deleteFile)/.test(editPageSource), 'product-edit page accesses cloud resources directly');

  assert(/chooseImages/.test(formServiceSource) && /splitImages/.test(formServiceSource), 'shared product form image logic is missing');
  assert(/ProductPublishService\.validateProductFields/.test(editServiceSource), 'product-edit does not reuse publish validation');
  assert(/ProductPublishService\.uploadLocalImages/.test(editServiceSource), 'product-edit does not reuse safe image upload');
  assert(/ProductPublishService\.deleteCloudFiles/.test(editServiceSource), 'product-edit cannot roll back new uploads');
  assert(!/sellerOpenid|ownerOpenid|\bopenid\b/i.test(editServiceSource), 'product-edit service sends a client identity');
  assert(!/filesToDelete/.test(editServiceSource), 'product-edit service sends a trusted deletion list');

  assert(/getEditableProduct/.test(manageSource), 'owner-only editable product action is missing');
  assert(/updateProduct/.test(manageSource), 'product update action is missing');
  assert(/softDelete/.test(manageSource), 'soft delete action is missing');
  assert(/retryImageCleanup/.test(manageSource), 'image cleanup retry action is missing');
  assert(/ALLOWED_UPDATE_FIELDS/.test(manageSource), 'server update field whitelist is missing');
  assert(/PRODUCT_VERSION_CONFLICT/.test(manageSource), 'version conflict error is missing');
  assert(/db\.runTransaction/.test(manageSource), 'database mutations do not use a transaction');
  assert(/getProductVersion/.test(manageSource), 'legacy product version compatibility is missing');
  assert(/status:\s*['"]deleted['"]/.test(manageSource), 'soft delete does not write deleted status');
  assert(/deletedAt:\s*db\.serverDate/.test(manageSource), 'soft delete timestamp is missing');
  assert(!/\.remove\s*\(/.test(manageSource), 'soft delete physically removes a product document');
  assert(/isFileStillReferenced/.test(manageSource), 'server image reference check is missing');
  assert(/cloud\.deleteFile/.test(manageSource), 'server image cleanup is missing');
  assert(
    manageSource.indexOf('await document.update') < manageSource.indexOf('await cleanupImages'),
    'image cleanup is not ordered after database mutation'
  );
  assert(!/request\.filesToDelete/.test(manageSource), 'server trusts a client deletion list');
  assert(/imageCleanupStatus/.test(manageSource) && /partial_failed/.test(manageSource), 'cleanup retry state is missing');

  assert(/version:\s*1/.test(createSource), 'new products do not start at version 1');
  assert(/MY_PRODUCT_STATUSES/.test(querySource) && !/MY_PRODUCT_STATUSES\s*=\s*\[[^\]]*deleted/s.test(querySource), 'deleted products can enter myProducts');
  assert(/softDelete/.test(myProductsSource) && /softDelete/.test(myProductsTemplate), 'my-products soft delete entry is missing');
  assert(/PRODUCT_EDIT/.test(myProductsSource), 'my-products edit entry is missing');
});

record('ProductService centralizes cloud access and data normalization', () => {
  const source = readText(path.join(root, 'services/product-service.js'));
  const cloudConfigSource = readText(path.join(root, 'config/cloud.js'));
  const homeSource = readText(path.join(root, 'pages/home/index.js'));
  const detailSource = readText(path.join(root, 'pages/product-detail/index.js'));

  assert(/wx\.cloud\.callFunction/.test(source), 'ProductService does not call the query cloud function');
  assert(/normalizeProduct/.test(source) && /normalizeProductList/.test(source), 'product normalization is incomplete');
  assert(/productFunctionName/.test(cloudConfigSource), 'product cloud function name is not centralized');
  assert(/productTimeoutMs/.test(cloudConfigSource), 'product request timeout is not centralized');
  assert(!/wx\.cloud\.(?:database|callFunction)/.test(homeSource), 'home accesses cloud data directly');
  assert(!/wx\.cloud\.(?:database|callFunction)/.test(detailSource), 'detail accesses cloud data directly');
  assert(/requestVersion/.test(homeSource), 'home stale-request protection is missing');
  assert(/mergeProducts/.test(homeSource), 'home product de-duplication is missing');
});

record('createProduct trusts cloud identity and writes safe product fields', () => {
  const functionSource = readText(path.join(root, 'cloudfunctions/createProduct/index.js'));
  const serviceSource = readText(path.join(root, 'services/product-publish-service.js'));
  const publishSource = readText(path.join(root, 'pages/publish/index.js'));
  const publishTemplate = readText(path.join(root, 'pages/publish/index.wxml'));
  const homeSource = readText(path.join(root, 'pages/home/index.js'));
  const appStoreSource = readText(path.join(root, 'store/app-store.js'));
  const cloudConfigSource = readText(path.join(root, 'config/cloud.js'));

  assert(/cloud\.getWXContext\s*\(\s*\)/.test(functionSource), 'createProduct does not use getWXContext');
  assert(!/event\.(?:openid|openId|OPENID)/.test(functionSource), 'createProduct trusts a client identity field');
  assert(/createHash\(\s*['"]sha256['"]\s*\)/.test(functionSource), 'createProduct does not derive deterministic ids');
  assert(/createProductId\(userId,\s*requestId\)/.test(functionSource), 'createProduct request id is not idempotent');
  assert(/users\.where/.test(functionSource), 'createProduct does not verify the real user record');
  assert(/typeof value !== ['"]number['"]/.test(functionSource), 'createProduct does not require a numeric price');
  assert(/isOwnedProductImage\(fileID,\s*userId\)/.test(functionSource), 'createProduct does not strictly constrain uploaded image ownership');
  assert(!/fileID\.includes\(folder\)/.test(functionSource), 'createProduct still uses substring image ownership checks');
  assert(/IMAGE_FILE_NAME_PATTERN/.test(functionSource), 'createProduct does not restrict image file names and extensions');
  assert(/products\.doc\(productId\)\.set/.test(functionSource), 'createProduct does not use a deterministic product document');
  assert(/status:\s*['"]available['"]/.test(functionSource), 'createProduct does not force the initial status');
  assert(/viewCount:\s*0/.test(functionSource) && /favoriteCount:\s*0/.test(functionSource), 'createProduct does not initialize counters');
  assert(/db\.serverDate\(\)/.test(functionSource), 'createProduct does not use server timestamps');
  assert(/toSellerFields\(user,\s*identity,\s*userId\)/.test(functionSource), 'createProduct does not build seller fields server-side');
  assert(/success:\s*true/.test(functionSource) && /success:\s*false/.test(functionSource), 'createProduct response envelope is inconsistent');

  assert(/wx\.cloud\.uploadFile/.test(serviceSource), 'publish service does not upload images');
  assert(/wx\.cloud\.deleteFile/.test(serviceSource), 'publish service does not clean orphaned images');
  assert(/wx\.getImageInfo/.test(serviceSource), 'publish service does not verify that local files decode as images');
  assert(/isOwnedProductImage/.test(serviceSource), 'publish cleanup is not scoped to the current user directory');
  assert(/wx\.cloud\.callFunction/.test(serviceSource), 'publish service does not call createProduct');
  assert(/requestId/.test(serviceSource), 'publish service does not carry an idempotency key');
  assert(/Promise\.race/.test(serviceSource), 'publish service request timeouts are missing');
  assert(!/wx\.cloud\.database/.test(serviceSource), 'publish service writes the database directly');
  assert(/createProductFunctionName/.test(cloudConfigSource), 'createProduct function name is not centralized');

  assert(/AuthGuard\.requireLogin/.test(publishSource), 'publish page does not reuse the login guard');
  assert(/isSubmitting/.test(publishSource) && /finally/.test(publishSource), 'publish duplicate-click or loading cleanup is missing');
  const formServiceSource = readText(path.join(root, 'services/product-form-service.js'));
  assert(/chooseImages/.test(publishSource) && /wx\.chooseMedia/.test(formServiceSource), 'publish page cannot choose product images');
  assert(/previewImages/.test(publishSource) && /wx\.previewMedia/.test(formServiceSource), 'publish page cannot preview product images');
  assert(/publishProduct/.test(publishSource), 'publish page does not use the publish service');
  assert(/(?:bindtap|catchtap)="onRemoveImage"/.test(publishTemplate), 'publish page cannot remove a selected image');
  assert(!/wx\.cloud\.(?:database|callFunction)/.test(publishSource), 'publish page accesses cloud data directly');
  assert(/markProductsChanged/.test(publishSource), 'publish success does not invalidate the home list');
  assert(/getProductsVersion/.test(homeSource), 'home does not observe published product changes');
  assert(/productsVersion/.test(appStoreSource), 'product refresh version is missing');
});

record('App bootstrap is non-blocking and cloud initialization is centralized', () => {
  const appSource = readText(path.join(root, 'app.js'));
  const cloudConfigSource = readText(path.join(root, 'config/cloud.js'));
  const cloudServiceSource = readText(path.join(root, 'services/cloud-service.js'));
  const clientJavaScript = files.filter((filePath) => (
    filePath.endsWith('.js')
    && !filePath.includes(`${path.sep}cloudfunctions${path.sep}`)
    && !filePath.includes(`${path.sep}scripts${path.sep}`)
  )).map((filePath) => readText(filePath)).join('\n');

  assert(/CloudService\.ensureCloudReady\(\)/.test(appSource), 'App does not start centralized cloud initialization');
  assert(/then\(\(\)\s*=>\s*AuthStore\.bootstrap\(\)\)/.test(appSource), 'App bootstrap does not wait for cloud initialization');
  assert(!/async\s+onLaunch/.test(appSource), 'App.onLaunch is async');
  assert(!/await\s+AuthStore\.bootstrap/.test(appSource), 'App.onLaunch blocks on bootstrap');
  assert(
    /assertCloudEnvironmentConfigured\(\)/.test(cloudServiceSource)
      && /wx\.cloud\.init\(\s*{\s*env:\s*environmentId,\s*traceUser:\s*true/s.test(cloudServiceSource),
    'centralized cloud initialization does not use the fixed environment'
  );
  assert(
    (clientJavaScript.match(/wx\.cloud\.init\s*\(/g) || []).length === 1,
    'client has more than one cloud initialization entry'
  );
  assert(/cloudInitPromise/.test(cloudServiceSource) && /cloudReady/.test(cloudServiceSource), 'cloud initialization is not a singleton promise');
  assert(/cloudInitPromise\s*=\s*null/.test(cloudServiceSource), 'failed cloud initialization cannot be retried');
  assert(!/setTimeout/.test(
    cloudServiceSource.slice(
      cloudServiceSource.indexOf('function ensureCloudReady'),
      cloudServiceSource.indexOf('function isCloudReady')
    )
  ), 'cloud initialization uses a timer to guess readiness');
  assert(/environmentId/.test(cloudConfigSource), 'cloud environment configuration is missing');
  assert(/auth:user-summary/.test(cloudConfigSource), 'auth cache key is not centralized');
});

record('local auth cache contains only safe summary fields', () => {
  const source = readText(path.join(root, 'store/auth-store.js'));
  const start = source.indexOf('function writeCachedUser');
  const end = source.indexOf('function clearCachedUser');
  const cacheWriter = source.slice(start, end);

  assert(start >= 0 && end > start, 'safe cache writer is missing');
  ['id', 'nickname', 'avatarUrl', 'campus', 'profileCompleted'].forEach((field) => {
    assert(new RegExp(`\\b${field}\\b`).test(cacheWriter), `cached user field ${field} is missing`);
  });
  assert(!/\bopenid\b/i.test(cacheWriter), 'local cache stores openid');
  assert(!/\brole\b/.test(cacheWriter), 'local cache stores role');
  assert(!/access[_ -]?token/i.test(cacheWriter), 'local cache stores an access token');
});

record('login navigation uses a target whitelist without arbitrary redirects', () => {
  const guardSource = readText(path.join(root, 'services/auth-guard.js'));
  const routeSource = readText(path.join(root, 'constants/routes.js'));

  assert(/VALID_TARGETS/.test(guardSource), 'auth target whitelist is missing');
  assert(/AUTH_TARGET_CONFIG/.test(routeSource), 'auth target route mapping is missing');
  assert(!/[?&]redirect=/.test(guardSource), 'auth guard accepts an arbitrary redirect URL');
  assert(!/decodeURIComponent\s*\(\s*options\.(?:redirect|url)/.test(guardSource), 'auth guard decodes an arbitrary route');
  assert(/safeSwitchTab/.test(guardSource), 'auth guard does not support tab targets');
  assert(/safeRedirectTo/.test(guardSource), 'auth guard does not support normal page targets');
});

record('all protected entrances use AuthGuard', () => {
  const requiredGuardFiles = [
    'custom-tab-bar/index.js',
    'pages/publish/index.js',
    'pages/messages/index.js',
    'pages/favorites/index.js',
    'pages/my-products/index.js',
    'pages/profile/index.js',
    'pages/product-detail/index.js',
    'pages/product-edit/index.js',
    'pages/chat/index.js'
  ];

  requiredGuardFiles.forEach((name) => {
    const source = readText(path.join(root, name));
    assert(/AuthGuard/.test(source), `${name} does not import AuthGuard`);
    assert(/requireLogin/.test(source), `${name} does not call requireLogin`);
  });
});

record('login and profile pages implement auth state UI', () => {
  const loginSource = readText(path.join(root, 'pages/login/index.js'));
  const loginTemplate = readText(path.join(root, 'pages/login/index.wxml'));
  const profileSource = readText(path.join(root, 'pages/profile/index.js'));
  const profileTemplate = readText(path.join(root, 'pages/profile/index.wxml'));

  assert(/AuthStore\.login/.test(loginSource), 'login page does not call AuthStore.login');
  assert(/isLoggingIn/.test(loginSource) && /disabled=/.test(loginTemplate), 'login duplicate-click protection is missing');
  assert(/navigateAfterLogin/.test(loginSource), 'login page does not return to a safe target');
  assert(/AuthStore\.subscribe/.test(profileSource), 'profile page does not subscribe to auth state');
  assert(/AuthStore\.logout/.test(profileSource), 'profile page does not implement logout');
  assert(
    /authStatus/.test(loginSource)
    && /isLoggedIn/.test(profileSource)
    && loginTemplate.includes('error'),
    'auth UI does not cover restoring, authenticated and error states'
  );
});

record('core page cleanup and navigation failure recovery are present', () => {
  const homeSource = readText(path.join(root, 'pages/home/index.js'));
  const publishSource = readText(path.join(root, 'pages/publish/index.js'));
  const loginSource = readText(path.join(root, 'pages/login/index.js'));

  assert(/onPullDownRefresh[\s\S]*finally[\s\S]*stopPullDownRefresh/.test(homeSource), 'home pull-down refresh can remain active');
  assert(/requestVersion/.test(homeSource) && /isPageActive/.test(homeSource), 'home stale page request protection is missing');
  assert(/finally[\s\S]*closeSubmissionLoading/.test(publishSource), 'publish Loading is not closed in finally');
  assert(/finally[\s\S]*isSubmitting:\s*false/.test(publishSource), 'publish button can remain disabled after failure');
  assert(/const navigated = await AuthGuard\.navigateAfterLogin/.test(loginSource), 'login does not observe navigation failure');
  assert(/isReturning:\s*false/.test(loginSource), 'login navigation failure does not unlock the return state');
});

record('runtime logs are minimal and do not include sensitive payloads', () => {
  const runtimeFiles = files.filter((file) => (
    path.extname(file) === '.js'
    && !relative(file).startsWith('scripts/')
    && !relative(file).startsWith('mock/')
  ));

  runtimeFiles.forEach((file) => {
    const source = readText(file);
    const logCalls = source.match(/console\.(?:log|info|warn|error)\s*\([\s\S]*?\);/g) || [];
    logCalls.forEach((call) => {
      assert(!/\bOPENID\b|\bopenid\b/i.test(call), `${relative(file)} logs an identity field`);
      assert(
        !/,\s*(?:error|event|request|record|user|product|tempFilePath|fileID)\b/.test(call),
        `${relative(file)} logs a sensitive runtime payload`
      );
    });
  });
});

record('cloud function dependencies are ignored and not tracked', () => {
  [
    'authUser',
    'productQuery',
    'createProduct',
    'manageProduct',
    'favoriteProduct',
    'userQuery',
    'messageQuery',
    'messageAction'
  ].forEach((functionName) => {
    const modulePath = `cloudfunctions/${functionName}/node_modules`;
    const ignored = spawnSync(
      'git',
      ['check-ignore', '--no-index', `${modulePath}/verification-placeholder.js`],
      { cwd: root, encoding: 'utf8' }
    );
    assert(ignored.status === 0, `${functionName} node_modules is not ignored`);

    const tracked = spawnSync(
      'git',
      ['ls-files', modulePath],
      { cwd: root, encoding: 'utf8' }
    );
    assert(!tracked.stdout.trim(), `${functionName} node_modules is tracked`);
  });
});

async function verifyServiceFlow() {
  const ProductService = require(path.join(root, 'services/product-service'));
  const { PRODUCTS } = require(path.join(root, 'mock/index'));
  const {
    PRODUCT_STATUS,
    PUBLIC_PRODUCT_STATUSES,
    PRODUCT_SORT
  } = require(path.join(root, 'constants/product'));
  const originalWx = global.wx;
  const queryFixtures = PRODUCTS.map((product) => ({
    ...product,
    _id: product.id,
    location: product.locationName,
    sellerId: product.seller && product.seller.id,
    sellerName: product.seller && product.seller.nickname,
    sellerAvatar: product.seller && product.seller.avatar,
    sellerVerified: product.seller && product.seller.verified === true,
    createdAt: new Date(product.publishedAt),
    updatedAt: new Date(product.publishedAt)
  }));

  function matchesKeyword(product, keyword) {
    if (!keyword) {
      return true;
    }
    const searchable = [
      product.title,
      product.description,
      product.categoryName,
      product.condition,
      product.location,
      ...product.tags
    ].join(' ').toLowerCase();
    return keyword.toLowerCase().split(' ').every((token) => searchable.includes(token));
  }

  function sortProducts(list, sortBy) {
    const sorted = [...list];
    if (sortBy === PRODUCT_SORT.NEWEST) {
      return sorted.sort((left, right) => right.createdAt - left.createdAt);
    }
    if (sortBy === PRODUCT_SORT.PRICE_ASC) {
      return sorted.sort((left, right) => (
        left.price - right.price || right.createdAt - left.createdAt
      ));
    }
    if (sortBy === PRODUCT_SORT.PRICE_DESC) {
      return sorted.sort((left, right) => (
        right.price - left.price || right.createdAt - left.createdAt
      ));
    }
    return sorted.sort((left, right) => (
      right.favoriteCount - left.favoriteCount
      || right.viewCount - left.viewCount
      || right.createdAt - left.createdAt
    ));
  }

  global.wx = {
    cloud: {
      init() {},
      callFunction({ name, data, success, fail }) {
        if (name !== 'productQuery') {
          fail({ errMsg: 'cloud function not found' });
          return;
        }

        const request = data.data || {};
        if (data.action === 'list') {
          const statuses = Array.isArray(request.statuses)
            ? request.statuses
            : PUBLIC_PRODUCT_STATUSES;
          const filtered = queryFixtures.filter((product) => (
            statuses.includes(product.status)
            && (request.categoryId === 'all' || product.categoryId === request.categoryId)
            && matchesKeyword(product, request.keyword)
          ));
          const sorted = sortProducts(filtered, request.sortBy);
          const start = (request.page - 1) * request.pageSize;
          const list = sorted.slice(start, start + request.pageSize);
          success({
            result: {
              success: true,
              code: 'OK',
              message: '',
              data: {
                list,
                total: sorted.length,
                page: request.page,
                pageSize: request.pageSize,
                hasMore: start + list.length < sorted.length
              }
            }
          });
          return;
        }

        if (data.action === 'detail') {
          const product = queryFixtures.find((item) => (
            item._id === request.productId
            && PUBLIC_PRODUCT_STATUSES.includes(item.status)
          ));
          success({
            result: product
              ? {
                success: true,
                code: 'OK',
                message: '',
                data: { product }
              }
              : {
                success: false,
                code: 'PRODUCT_NOT_FOUND',
                message: '商品不存在或已下架',
                data: null
              }
          });
          return;
        }

        fail({ errMsg: 'unsupported action' });
      }
    }
  };

  try {
    const firstPage = await ProductService.getProducts({ page: 1, pageSize: 6 });
    assert(firstPage.list.length === 6, 'home first page did not return 6 products');
    assert(firstPage.hasMore === true, 'home first page should have more products');
    assert(firstPage.total === 15, 'public product total is incorrect');
    assert(firstPage.list.every((product) => PUBLIC_PRODUCT_STATUSES.includes(product.status)), 'home returned a hidden status');

    const digital = await ProductService.getProducts({ categoryId: 'digital', pageSize: 20 });
    assert(digital.list.length >= 3, 'digital category result is incomplete');
    assert(digital.list.every((product) => product.categoryId === 'digital'), 'category filter leaked data');

    const search = await ProductService.searchProducts('  键盘  ');
    assert(search.list.some((product) => product.id === 'product-001'), 'search did not find product-001');

    const spacedSearch = await ProductService.searchProducts('机械   键盘');
    assert(spacedSearch.list.some((product) => product.id === 'product-001'), 'multi-word search normalization is incorrect');

    const locationSearch = await ProductService.searchProducts('图书馆南门');
    assert(locationSearch.list.some((product) => product.id === 'product-002'), 'location search did not find product-002');

    const combined = await ProductService.getProducts({
      categoryId: 'digital',
      keyword: ' 键盘 ',
      sortBy: PRODUCT_SORT.PRICE_ASC,
      pageSize: 20
    });
    assert(combined.list.length === 1 && combined.list[0].id === 'product-001', 'category and search combination is incorrect');

    const newest = await ProductService.getProducts({
      sortBy: PRODUCT_SORT.NEWEST,
      pageSize: 20
    });
    for (let index = 1; index < newest.list.length; index += 1) {
      assert(
        new Date(newest.list[index - 1].createdAt).getTime()
        >= new Date(newest.list[index].createdAt).getTime(),
        'newest sorting is incorrect'
      );
    }

    const priceAscending = await ProductService.getProducts({
      sortBy: PRODUCT_SORT.PRICE_ASC,
      pageSize: 20
    });
    for (let index = 1; index < priceAscending.list.length; index += 1) {
      assert(
        priceAscending.list[index - 1].price <= priceAscending.list[index].price,
        'ascending price sorting is incorrect'
      );
    }
    assert(priceAscending.list[0].price === 0, 'free product is not first in ascending price sort');
    assert(priceAscending.list[0].priceDisplay === '免费送', 'free product display is incorrect');

    const priceDescending = await ProductService.getProducts({
      sortBy: PRODUCT_SORT.PRICE_DESC,
      pageSize: 20
    });
    for (let index = 1; index < priceDescending.list.length; index += 1) {
      assert(
        priceDescending.list[index - 1].price >= priceDescending.list[index].price,
        'descending price sorting is incorrect'
      );
    }

    const reservedOnly = await ProductService.getProducts({
      status: PRODUCT_STATUS.RESERVED,
      pageSize: 20
    });
    assert(
      reservedOnly.list.length === 1
      && reservedOnly.list[0].status === PRODUCT_STATUS.RESERVED,
      'status filtering is incorrect'
    );

    const hiddenStatusQuery = await ProductService.getProducts({
      status: [
        PRODUCT_STATUS.DRAFT,
        PRODUCT_STATUS.OFFLINE,
        PRODUCT_STATUS.DELETED
      ],
      pageSize: 20
    });
    assert(hiddenStatusQuery.list.length === 0, 'hidden status query leaked public products');

    const clamped = await ProductService.getProducts({ page: 0, pageSize: 999 });
    assert(clamped.page === 1, 'page lower bound is incorrect');
    assert(clamped.pageSize === 20, 'pageSize upper bound is incorrect');

    const pagedIds = [];
    let page = 1;
    let pageResult;
    do {
      pageResult = await ProductService.getProducts({ page, pageSize: 6 });
      pagedIds.push(...pageResult.list.map((product) => product.id));
      page += 1;
    } while (pageResult.hasMore);
    assert(pagedIds.length === firstPage.total, 'pagination did not return the full public list');
    assert(new Set(pagedIds).size === pagedIds.length, 'pagination returned duplicate products');
    assert(pageResult.hasMore === false, 'final page hasMore should be false');

    const detail = await ProductService.getProductById('product-001');
    assert(detail && detail.id === 'product-001', 'detail lookup failed');
    assert(detail.priceDisplay === '¥129', 'detail price display is incorrect');

    const legacySingleImage = ProductService.normalizeProduct({
      _id: 'legacy-single-image',
      title: '旧单图商品',
      coverUrl: 'cloud://test-env.bucket/products/u_owner/20260718/legacy.jpg',
      price: 10,
      status: 'available'
    });
    assert(
      legacySingleImage.images.length === 1
      && legacySingleImage.coverImage === legacySingleImage.images[0]
      && legacySingleImage.video === null,
      'ProductService does not normalize an old single-image product without video'
    );
    const multiMediaProduct = ProductService.normalizeProduct({
      _id: 'multi-media-product',
      title: '多媒体商品',
      images: [
        'cloud://test-env.bucket/products/u_owner/20260718/one.jpg',
        'cloud://test-env.bucket/products/u_owner/20260718/two.jpg'
      ],
      coverImage: 'cloud://test-env.bucket/products/u_owner/20260718/one.jpg',
      video: {
        fileID: 'cloud://test-env.bucket/products/u_owner/20260718/demo.mp4',
        duration: 12,
        width: 1080,
        height: 1920,
        size: 1024
      },
      price: 10,
      status: 'available'
    });
    assert(
      multiMediaProduct.images.length === 2
      && multiMediaProduct.video
      && multiMediaProduct.video.fileID.endsWith('/demo.mp4'),
      'ProductService dropped valid multi-image or video detail media'
    );
    const invalidVideoProduct = ProductService.normalizeProduct({
      _id: 'invalid-video-product',
      title: '异常视频商品',
      images: ['cloud://test-env.bucket/products/u_owner/20260718/one.jpg'],
      video: [{ fileID: 'cloud://invalid/video.mp4' }],
      price: 10,
      status: 'available'
    });
    assert(invalidVideoProduct.video === null, 'invalid product video does not degrade safely');

    const reservedDetail = await ProductService.getProductById('product-005');
    assert(reservedDetail && reservedDetail.isReserved, 'reserved detail is unavailable');

    const soldDetail = await ProductService.getProductById('product-015');
    assert(soldDetail && soldDetail.isSold, 'sold detail is unavailable');

    const missing = await ProductService.getProductById('missing-product');
    assert(missing === null, 'missing detail should return null');

    const blank = await ProductService.getProductById('  ');
    assert(blank === null, 'blank detail id should return null');

    const offline = await ProductService.getProductById('product-017');
    assert(offline === null, 'offline detail should not be public');
  } finally {
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyProductQueryFunctionFlow() {
  const functionPath = path.join(root, 'cloudfunctions/productQuery/index.js');
  const originalLoad = Module._load;
  const marketCore = require(path.join(root, 'cloudfunctions/productQuery/market-core.js'));
  const queryAppId = 'wx-verify-product-query';
  const querySchoolId = 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const records = [
    {
      _id: 'product-public',
      title: '公开商品',
      description: '用于验证公开字段过滤。',
      price: 12,
      originalPrice: null,
      categoryId: 'life',
      categoryName: '生活',
      condition: '九成新',
      images: [
        'cloud://test-env.bucket/products/u_owner/20260717/public.jpg',
        'cloud://test-env.bucket/products/u_owner/20260717/public-2.jpg'
      ],
      coverImage: 'cloud://test-env.bucket/products/u_owner/20260717/public.jpg',
      video: {
        fileID: 'cloud://test-env.bucket/products/u_owner/20260717/public.mp4',
        posterFileID: '',
        duration: 12,
        width: 1080,
        height: 1920,
        size: 2048
      },
      coverLabel: '公开',
      coverTone: 'sand',
      location: '图书馆南门',
      campus: '示例大学',
      distanceText: '校内面交',
      sellerId: 'u_owner',
      sellerOpenid: 'private-openid',
      sellerName: '公开卖家名',
      sellerAvatar: '',
      sellerVerified: false,
      status: 'available',
      tags: ['台灯'],
      viewCount: 1,
      favoriteCount: 2,
      createdAt: new Date('2026-07-17T08:00:00.000Z'),
      updatedAt: new Date('2026-07-17T08:00:00.000Z')
    },
    {
      _id: 'product-sold',
      title: '已售商品',
      description: '已售商品保留详情但不进入公开列表。',
      price: 30,
      categoryId: 'life',
      categoryName: '生活',
      status: 'sold',
      sellerOpenid: 'private-openid',
      favoriteCount: 0,
      viewCount: 3,
      createdAt: new Date('2026-07-17T07:30:00.000Z')
    },
    {
      _id: 'product-reserved',
      title: '已预定商品',
      description: '已预定商品保留公开列表和详情。',
      price: 28,
      categoryId: 'life',
      categoryName: '生活',
      status: 'reserved',
      sellerOpenid: 'private-openid',
      favoriteCount: 1,
      viewCount: 4,
      createdAt: new Date('2026-07-17T07:45:00.000Z')
    },
    {
      _id: 'product-owner-offline',
      title: '本人下架商品',
      description: '仅本人列表可以读取。',
      price: 20,
      categoryId: 'life',
      categoryName: '生活',
      status: 'offline',
      sellerOpenid: 'private-openid',
      favoriteCount: 0,
      viewCount: 2,
      createdAt: new Date('2026-07-17T07:00:00.000Z')
    },
    {
      _id: 'product-foreign-offline',
      title: '他人下架商品',
      description: '不得出现在本人列表。',
      price: 25,
      categoryId: 'life',
      categoryName: '生活',
      status: 'offline',
      sellerOpenid: 'foreign-openid',
      favoriteCount: 0,
      viewCount: 2,
      createdAt: new Date('2026-07-17T06:30:00.000Z')
    },
    {
      _id: 'product-owner-deleted',
      title: '本人已删除商品',
      description: '软删除商品不得出现在任何正常查询中。',
      price: 26,
      categoryId: 'life',
      categoryName: '生活',
      status: 'deleted',
      sellerOpenid: 'private-openid',
      favoriteCount: 0,
      viewCount: 0,
      createdAt: new Date('2026-07-17T06:00:00.000Z')
    },
    {
      _id: 'product-hidden',
      title: '隐藏商品',
      description: '该商品不应被公开读取。',
      price: 99,
      categoryId: 'life',
      status: 'draft',
      favoriteCount: 0,
      viewCount: 0,
      createdAt: new Date('2026-07-16T08:00:00.000Z')
    }
  ];

  function matches(record, condition) {
    if (!condition || typeof condition !== 'object') {
      return true;
    }
    if (Array.isArray(condition.$and)) {
      return condition.$and.every((item) => matches(record, item));
    }
    if (Array.isArray(condition.$or)) {
      return condition.$or.some((item) => matches(record, item));
    }
    return Object.entries(condition).every(([key, expected]) => {
      if (expected && Array.isArray(expected.$in)) {
        return expected.$in.includes(record[key]);
      }
      if (expected && expected.$regexp instanceof RegExp) {
        const value = Array.isArray(record[key])
          ? record[key].join(' ')
          : String(record[key] || '');
        return expected.$regexp.test(value);
      }
      return record[key] === expected;
    });
  }

  function createQuery(condition, sourceRecords = records) {
    const orderRules = [];
    let offset = 0;
    let limit = sourceRecords.length;
    const query = {
      orderBy(field, direction) {
        orderRules.push({ field, direction });
        return query;
      },
      skip(value) {
        offset = value;
        return query;
      },
      limit(value) {
        limit = value;
        return query;
      },
      async count() {
        return {
          total: sourceRecords.filter((record) => matches(record, condition)).length
        };
      },
      async get() {
        const filtered = sourceRecords
          .filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const rule of orderRules) {
              const leftValue = left[rule.field];
              const rightValue = right[rule.field];
              if (leftValue === rightValue) {
                continue;
              }
              const direction = rule.direction === 'desc' ? -1 : 1;
              return leftValue > rightValue ? direction : -direction;
            }
            return 0;
          });
        return {
          data: filtered.slice(offset, offset + limit)
        };
      }
    };
    return query;
  }

  const command = {
    in(value) {
      return { $in: value };
    },
    and(value) {
      return { $and: value };
    },
    or(value) {
      return { $or: value };
    }
  };
  const auxiliaryRecords = {
    users: [{
      _id: marketCore.createUserId(queryAppId, 'private-openid'),
      openid: 'private-openid',
      status: 'active',
      profileCompleted: true,
      nickname: '验证用户',
      avatarUrl: 'cloud://avatar',
      schoolId: querySchoolId,
      schoolName: '示例大学'
    }],
    schools: [{
      _id: querySchoolId,
      name: '示例大学',
      platformStatus: 'active',
      officialStatus: 'valid'
    }]
  };
  const db = {
    command,
    RegExp({ regexp, options }) {
      return {
        $regexp: new RegExp(regexp, options)
      };
    },
    collection(name) {
      assert(['products', 'users', 'schools'].includes(name), `unexpected productQuery collection ${name}`);
      const sourceRecords = name === 'products' ? records : auxiliaryRecords[name];
      return {
        where(condition) {
          return createQuery(condition, sourceRecords);
        }
      };
    }
  };
  let queryOpenId = 'private-openid';
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return {
        OPENID: queryOpenId,
        APPID: queryAppId
      };
    }
  };

  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(functionPath)];
    const productQueryFunction = require(functionPath);
    const listResult = await productQueryFunction.__test.listLegacyProducts({
      page: 1,
      pageSize: 20,
      categoryId: 'all',
      sortBy: 'newest'
    });
    assert(listResult.success === true, 'productQuery rejected a valid public list request');
    assert(
      listResult.data.list.length === 2
      && listResult.data.list.some((product) => product.status === 'available')
      && listResult.data.list.some((product) => product.status === 'reserved'),
      'productQuery list does not expose exactly available and reserved products'
    );
    assert(
      !Object.prototype.hasOwnProperty.call(listResult.data.list[0], 'sellerOpenid'),
      'productQuery list leaked sellerOpenid'
    );
    assert(
      listResult.data.list.every((product) => (
        !Object.prototype.hasOwnProperty.call(product, 'images')
        && !Object.prototype.hasOwnProperty.call(product, 'video')
        && typeof product.coverImage === 'string'
      )),
      'productQuery list returns full media instead of the cover-only DTO'
    );
    assert(
      !listResult.data.list.some((product) => product.status === 'sold'),
      'productQuery public list still includes sold products'
    );

    const soldDetail = await productQueryFunction.main({
      action: 'detail',
      data: {
        productId: 'product-sold'
      }
    });
    assert(
      soldDetail.success === true && soldDetail.data.product.status === 'sold',
      'productQuery no longer exposes sold product detail'
    );
    const publicDetail = await productQueryFunction.main({
      action: 'detail',
      data: {
        productId: 'product-public'
      }
    });
    assert(
      publicDetail.success === true
      && publicDetail.data.product.images.length === 2
      && publicDetail.data.product.video.fileID.endsWith('/public.mp4'),
      'productQuery detail does not return the complete valid media DTO'
    );
    const reservedDetail = await productQueryFunction.main({
      action: 'detail',
      data: {
        productId: 'product-reserved'
      }
    });
    assert(
      reservedDetail.success === true
      && reservedDetail.data.product.status === 'reserved',
      'productQuery does not expose reserved product detail'
    );

    const availableOwnerProducts = await productQueryFunction.main({
      action: 'myProducts',
      data: {
        status: 'available',
        page: 1,
        pageSize: 20
      }
    });
    assert(
      availableOwnerProducts.success === true
      && availableOwnerProducts.data.list.length === 2
      && availableOwnerProducts.data.list.some(
        (product) => product.status === 'reserved'
      ),
      'myProducts in-sale tab omits the owner reserved product'
    );

    const myProductsResult = await productQueryFunction.main({
      action: 'myProducts',
      data: {
        status: 'offline',
        page: 1,
        pageSize: 20
      }
    });
    assert(myProductsResult.success === true, 'productQuery rejected myProducts');
    assert(
      myProductsResult.data.list.length === 1
      && myProductsResult.data.list[0]._id === 'product-owner-offline',
      'productQuery myProducts leaked another owner or missed the caller product'
    );
    assert(
      !Object.prototype.hasOwnProperty.call(
        myProductsResult.data.list[0],
        'sellerOpenid'
      ),
      'productQuery myProducts leaked sellerOpenid'
    );
    assert(
      !myProductsResult.data.list.some((product) => product.status === 'deleted'),
      'productQuery myProducts exposed a deleted product'
    );

    const deletedDetail = await productQueryFunction.main({
      action: 'detail',
      data: {
        productId: 'product-owner-deleted'
      }
    });
    assert(
      deletedDetail.success === false
      && deletedDetail.code === 'PRODUCT_NOT_FOUND',
      'productQuery exposed a deleted product detail'
    );

    queryOpenId = '';
    const unauthorizedMyProducts = await productQueryFunction.main({
      action: 'myProducts',
      data: {
        status: 'available'
      }
    });
    assert(
      unauthorizedMyProducts.success === false
      && unauthorizedMyProducts.code === 'UNAUTHORIZED',
      'productQuery myProducts accepts a missing cloud identity'
    );
    queryOpenId = 'private-openid';

    const cappedResult = await productQueryFunction.__test.listLegacyProducts({
      page: 999999,
      pageSize: 999999,
      categoryId: 'all',
      sortBy: 'default'
    });
    assert(
      cappedResult.data.page === 100 && cappedResult.data.pageSize === 20,
      'productQuery does not cap abusive pagination values'
    );

    const hiddenDetail = await productQueryFunction.main({
      action: 'detail',
      data: {
        productId: 'product-hidden'
      }
    });
    assert(
      hiddenDetail.success === false && hiddenDetail.code === 'PRODUCT_NOT_FOUND',
      'productQuery detail returned a hidden product'
    );

    const seedResult = await productQueryFunction.main({
      action: 'seed',
      data: {
        confirm: 'SEED_PRODUCTS_V1'
      }
    });
    assert(
      seedResult.success === false && seedResult.code === 'INVALID_ACTION',
      'productQuery still exposes the production seed action'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function verifyMyProductsServiceFlow() {
  const servicePath = path.join(root, 'services/my-products-service');
  const originalWx = global.wx;
  const requests = [];

  global.wx = {
    cloud: {
      init() {},
      callFunction({ name, data, success }) {
        requests.push({ name, data });
        if (name === 'productQuery') {
          success({
            result: {
              success: true,
              code: 'OK',
              message: '',
              data: {
                list: [{
                  _id: 'product-owner-offline',
                  title: '本人下架商品',
                  price: 20,
                  status: 'offline',
                  createdAt: new Date('2026-07-17T07:00:00.000Z'),
                  updatedAt: new Date('2026-07-17T07:10:00.000Z')
                }],
                total: 1,
                page: 1,
                pageSize: 6,
                hasMore: false
              }
            }
          });
          return;
        }
        success({
          result: {
            success: true,
            code: 'OK',
            message: '',
            data: {
              productId: data.productId,
              status: 'available',
              reused: false
            }
          }
        });
      }
    }
  };

  try {
    delete require.cache[require.resolve(servicePath)];
    const MyProductsService = require(servicePath);
    const result = await MyProductsService.getMyProducts({
      status: 'offline',
      page: 1,
      pageSize: 6
    });
    assert(
      result.list.length === 1
      && result.list[0].id === 'product-owner-offline'
      && result.list[0].status === 'offline',
      'my-products service did not normalize the owner list'
    );
    assert(requests[0].name === 'productQuery', 'my-products service called the wrong query function');
    assert(requests[0].data.action === 'myProducts', 'my-products service called the wrong query action');
    assert(
      !/sellerOpenid|ownerOpenid|\bopenid\b/i.test(JSON.stringify(requests[0].data)),
      'my-products service sent a client identity field'
    );

    const managed = await MyProductsService.manageProduct(
      'relist',
      'product-owner-offline'
    );
    assert(
      managed.productId === 'product-owner-offline'
      && managed.status === 'available',
      'my-products service did not normalize the management result'
    );
    assert(requests[1].name === 'manageProduct', 'my-products service called the wrong management function');
    assert(
      Object.keys(requests[1].data).sort().join(',') === 'action,productId',
      'my-products service sent fields beyond action and productId'
    );

    let invalidActionError;
    try {
      await MyProductsService.manageProduct(
        'delete',
        'product-owner-offline'
      );
    } catch (error) {
      invalidActionError = error;
    }
    assert(
      invalidActionError && invalidActionError.code === 'INVALID_ACTION',
      'my-products service accepted an unsupported management action'
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

async function verifyProductEditServiceFlow() {
  const servicePath = path.join(root, 'services/product-edit-service');
  const originalWx = global.wx;
  const requests = [];
  const uploadedFileIDs = [];
  const deletedFileLists = [];
  const existingImage = 'cloud://test-env.bucket/products/u_owner/20260718/existing.jpg';
  let mode = 'success';

  global.wx = {
    getImageInfo({ success }) {
      success({
        width: 800,
        height: 600,
        type: 'jpeg'
      });
    },
    cloud: {
      init() {},
      uploadFile({ cloudPath, success }) {
        const fileID = `cloud://test-env.bucket/${cloudPath}`;
        uploadedFileIDs.push(fileID);
        success({ fileID });
        return {
          abort() {}
        };
      },
      deleteFile({ fileList, success }) {
        deletedFileLists.push(fileList.slice());
        success({
          fileList: fileList.map((fileID) => ({
            fileID,
            status: 0
          }))
        });
      },
      callFunction({ name, data, success, fail }) {
        requests.push({ name, data });
        if (mode === 'timeout') {
          fail({
            errMsg: 'request:fail timeout'
          });
          return;
        }
        if (data.action === 'getEditableProduct') {
          success({
            result: {
              success: true,
              code: 'OK',
              message: '',
              data: {
                product: {
                  id: 'product-edit-service',
                  title: '待编辑商品',
                  description: '待编辑商品描述完整',
                  price: 20,
                  categoryId: 'life',
                  condition: '九成新',
                  location: '图书馆南门',
                  locationDetail: {
                    name: '图书馆南门',
                    address: '示例大学图书馆南侧公共区域',
                    latitude: 31.2304,
                    longitude: 121.4737
                  },
                  images: [existingImage],
                  status: 'available'
                },
                version: 1
              }
            }
          });
          return;
        }
        if (mode === 'conflict') {
          success({
            result: {
              success: false,
              code: 'PRODUCT_VERSION_CONFLICT',
              message: '商品信息已在其他页面发生变化，请刷新后重新编辑',
              data: null
            }
          });
          return;
        }
        if (data.action === 'softDelete') {
          success({
            result: {
              success: true,
              code: 'OK',
              message: '',
              data: {
                productId: data.productId,
                status: 'deleted',
                version: 2,
                reused: false,
                cleanupPending: false
              }
            }
          });
          return;
        }
        success({
          result: {
            success: true,
            code: 'OK',
            message: '',
            data: {
              productId: data.productId,
              version: 2,
              reused: false,
              cleanupPending: false
            }
          }
        });
      }
    }
  };

  try {
    delete require.cache[require.resolve(servicePath)];
    const ProductEditService = require(servicePath);
    const loaded = await ProductEditService.getEditableProduct(
      'product-edit-service'
    );
    assert(
      loaded.product.title === '待编辑商品'
      && loaded.version === 1
      && loaded.product.images[0] === existingImage,
      'product-edit service did not normalize editable product data'
    );
    assert(
      loaded.product.locationDetail
      && loaded.product.locationDetail.name === loaded.product.location,
      'product-edit service did not preserve the editable map location'
    );

    const draft = {
      title: '编辑后的商品',
      description: '编辑后的商品描述内容完整',
      price: '29.90',
      categoryId: 'digital',
      condition: '八成新',
      location: '实验楼大厅',
      locationDetail: {
        name: '实验楼大厅',
        address: '示例大学实验楼一层公共大厅',
        latitude: 31.231,
        longitude: 121.474
      }
    };
    const localImage = {
      tempFilePath: '<TEMP_ROOT>\\edit-new.jpg',
      size: 1024,
      fileType: 'image'
    };
    const localVideo = {
      tempFilePath: '<TEMP_ROOT>\\edit-demo.mp4',
      size: 2048,
      duration: 12,
      width: 1080,
      height: 1920,
      fileType: 'video'
    };
    const updated = await ProductEditService.updateProduct({
      productId: 'product-edit-service',
      expectedVersion: 1,
      mutationId: 'mut_service_update_01',
      draft,
      existingFileIDs: [existingImage],
      localImages: [localImage],
      localVideo,
      userId: 'u_owner'
    });
    assert(
      updated.version === 2 && uploadedFileIDs.length === 2,
      'product-edit service did not upload and update the product'
    );
    const updateRequest = requests.find((request) => (
      request.data.action === 'updateProduct'
    ));
    assert(
      updateRequest
      && updateRequest.name === 'manageProduct'
      && updateRequest.data.product.images.length === 2
      && updateRequest.data.product.images[0] === existingImage
      && updateRequest.data.product.video.fileID.endsWith('.mp4')
      && updateRequest.data.product.locationDetail.name === draft.location,
      'product-edit service did not preserve ordered images and upload the video'
    );
    assert(
      !/sellerOpenid|ownerOpenid|\bopenid\b|filesToDelete/i.test(
        JSON.stringify(updateRequest.data)
      )
      && !Object.prototype.hasOwnProperty.call(
        updateRequest.data.product,
        'status'
      ),
      'product-edit service sent an identity, status or deletion authority'
    );

    mode = 'conflict';
    let conflictError;
    try {
      await ProductEditService.updateProduct({
        productId: 'product-edit-service',
        expectedVersion: 1,
        mutationId: 'mut_service_update_02',
        draft,
        existingFileIDs: [existingImage],
        localImages: [localImage],
        localVideo,
        userId: 'u_owner'
      });
    } catch (error) {
      conflictError = error;
    }
    assert(
      conflictError && conflictError.code === 'PRODUCT_VERSION_CONFLICT',
      'product-edit service did not surface a version conflict'
    );
    assert(
      deletedFileLists.some((fileList) => (
        fileList.includes(uploadedFileIDs[uploadedFileIDs.length - 1])
      )),
      'product-edit service did not roll back a new upload after update failure'
    );

    mode = 'timeout';
    const deletesBeforeTimeout = deletedFileLists.length;
    let timeoutError;
    try {
      await ProductEditService.updateProduct({
        productId: 'product-edit-service',
        expectedVersion: 1,
        mutationId: 'mut_service_update_03',
        draft,
        existingFileIDs: [],
        localImages: [localImage],
        localVideo,
        userId: 'u_owner'
      });
    } catch (error) {
      timeoutError = error;
    }
    assert(
      timeoutError
      && timeoutError.code === 'TIMEOUT'
      && timeoutError.outcomeUnknown === true
      && timeoutError.uploadedFileIds.length === 1
      && timeoutError.uploadedVideoFileId.endsWith('.mp4'),
      'product-edit service did not preserve an ambiguous update for retry'
    );
    assert(
      deletedFileLists.length === deletesBeforeTimeout,
      'product-edit service deleted an upload while database outcome was unknown'
    );

    mode = 'success';
    const deleted = await ProductEditService.softDelete({
      productId: 'product-edit-service',
      expectedVersion: 1,
      mutationId: 'mut_service_delete_01'
    });
    assert(
      deleted.status === 'deleted' && deleted.version === 2,
      'product-edit service did not normalize soft delete success'
    );
    const deleteRequest = requests.find((request) => (
      request.data.action === 'softDelete'
    ));
    assert(
      Object.keys(deleteRequest.data).sort().join(',')
        === 'action,expectedVersion,mutationId,productId',
      'soft delete service sent fields beyond its versioned mutation envelope'
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

async function verifyManageProductFunctionFlow() {
  const functionPath = path.join(root, 'cloudfunctions/manageProduct/index.js');
  const originalLoad = Module._load;
  const ownerImageA = 'cloud://test-env.bucket/products/u_owner/20260718/a.jpg';
  const ownerImageB = 'cloud://test-env.bucket/products/u_owner/20260718/b.jpg';
  const ownerImageC = 'cloud://test-env.bucket/products/u_owner/20260718/c.jpg';
  const ownerVideoOld = 'cloud://test-env.bucket/products/u_owner/20260718/demo-old.mp4';
  const ownerVideoNew = 'cloud://test-env.bucket/products/u_owner/20260718/demo-new.mp4';
  const cleanupImageA = 'cloud://test-env.bucket/products/u_owner/20260718/cleanup-a.jpg';
  const cleanupImageB = 'cloud://test-env.bucket/products/u_owner/20260718/cleanup-b.jpg';
  const sharedImage = 'cloud://test-env.bucket/products/u_owner/20260718/shared.jpg';
  const retainImage = 'cloud://test-env.bucket/products/u_owner/20260718/retain.jpg';
  const replaceOldImage = 'cloud://test-env.bucket/products/u_owner/20260718/replace-old.jpg';
  const replaceNewImage = 'cloud://test-env.bucket/products/u_owner/20260718/replace-new.jpg';
  const legacyLocationImage = 'cloud://test-env.bucket/products/u_owner/20260718/legacy-location.jpg';
  const modernLocationImage = 'cloud://test-env.bucket/products/u_owner/20260718/modern-location.jpg';
  const products = new Map([
    ['product-state', {
      _id: 'product-state',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      schoolName: '示例大学',
      status: 'available'
    }],
    ['product-edit', {
      _id: 'product-edit',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      status: 'available',
      title: '原商品标题',
      description: '原商品描述内容完整',
      price: 20,
      categoryId: 'life',
      categoryName: '生活',
      condition: '九成新',
      location: '图书馆南门',
      locationDetail: {
        name: '图书馆南门',
        address: '示例大学图书馆南侧公共区域',
        latitude: 31.2304,
        longitude: 121.4737
      },
      images: [ownerImageA, ownerImageB],
      coverImage: ownerImageA,
      video: {
        fileID: ownerVideoOld,
        posterFileID: '',
        duration: 10,
        width: 1080,
        height: 1920,
        size: 2048
      },
      createdAt: { original: true }
    }],
    ['product-cleanup', {
      _id: 'product-cleanup',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      status: 'available',
      version: 1,
      title: '清理测试商品',
      description: '清理测试商品描述',
      price: 30,
      categoryId: 'life',
      condition: '八成新',
      location: '操场东门',
      images: [cleanupImageA, cleanupImageB],
      coverImage: cleanupImageA
    }],
    ['product-shared-owner', {
      _id: 'product-shared-owner',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      status: 'available',
      version: 1,
      title: '共享图片商品一',
      description: '共享图片商品描述一',
      price: 40,
      categoryId: 'life',
      condition: '九成新',
      location: '教学楼门口',
      images: [sharedImage],
      coverImage: sharedImage
    }],
    ['product-retain', {
      _id: 'product-retain',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      status: 'available',
      version: 1,
      title: '保留图片商品',
      description: '保留全部旧图片测试描述',
      price: 41,
      categoryId: 'life',
      condition: '九成新',
      location: '教学楼门口',
      images: [retainImage],
      coverImage: retainImage
    }],
    ['product-replace', {
      _id: 'product-replace',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      status: 'available',
      version: 1,
      title: '替换图片商品',
      description: '全部替换图片测试描述',
      price: 42,
      categoryId: 'life',
      condition: '九成新',
      location: '教学楼门口',
      images: [replaceOldImage],
      coverImage: replaceOldImage
    }],
    ['product-shared-other', {
      _id: 'product-shared-other',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      status: 'offline',
      version: 1,
      title: '共享图片商品二',
      description: '共享图片商品描述二',
      price: 45,
      categoryId: 'life',
      condition: '八成新',
      location: '教学楼门口',
      images: [sharedImage],
      coverImage: sharedImage
    }],
    ['product-legacy-location', {
      _id: 'product-legacy-location',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      status: 'available',
      version: 1,
      title: '旧地点商品',
      description: '只有地点字符串的旧商品描述',
      price: 18,
      categoryId: 'life',
      condition: '八成新',
      location: '旧图书馆门口',
      images: [legacyLocationImage],
      coverImage: legacyLocationImage
    }],
    ['product-modern-location', {
      _id: 'product-modern-location',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
      status: 'available',
      version: 1,
      title: '新版地点商品',
      description: '已有结构化地点的新版商品描述',
      price: 28,
      categoryId: 'life',
      condition: '九成新',
      location: '体育馆入口',
      locationDetail: {
        name: '体育馆入口',
        address: '示例大学体育馆公共入口',
        latitude: 31.231,
        longitude: 121.474
      },
      images: [modernLocationImage],
      coverImage: modernLocationImage
    }],
    ['product-foreign', {
      _id: 'product-foreign',
      sellerOpenid: 'foreign-openid',
      sellerId: 'u_foreign',
      status: 'available'
    }]
  ]);
  const users = new Map([
    ['u_owner', {
      _id: 'u_owner',
      openid: 'owner-openid',
      status: 'active',
      schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      schoolName: '示例大学'
    }]
  ]);
  let currentOpenId = 'owner-openid';
  let deleteMode = 'success';
  const deletedFileIDs = [];
  const deleteStatusSnapshots = [];

  function matches(record, condition) {
    return Object.entries(condition).every(([key, value]) => {
      const actual = key.split('.').reduce(
        (result, segment) => result && result[segment],
        record
      );
      if (value && Array.isArray(value.$all)) {
        return Array.isArray(actual)
          && value.$all.every((item) => actual.includes(item));
      }
      return actual === value;
    });
  }

  function createQuery(condition) {
    let queryLimit = products.size;
    const query = {
      limit(value) {
        queryLimit = value;
        return query;
      },
      async get() {
        return {
          data: [...products.values()]
            .filter((product) => matches(product, condition))
            .slice(0, queryLimit)
        };
      },
      async update({ data }) {
        let updated = 0;
        products.forEach((product, id) => {
          if (!matches(product, condition)) {
            return;
          }
          products.set(id, Object.assign({}, product, data));
          updated += 1;
        });
        return {
          stats: {
            updated
          }
        };
      }
    };
    return query;
  }

  const db = {
    command: {
      all(values) {
        return {
          $all: values
        };
      }
    },
    collection(name) {
      assert(name === 'products', `unexpected manageProduct collection ${name}`);
      return {
        where(condition) {
          return createQuery(condition);
        }
      };
    },
    async runTransaction(callback) {
      const transaction = {
        collection(name) {
          assert(['products', 'users'].includes(name), `unexpected transaction collection ${name}`);
          const records = name === 'products' ? products : users;
          return {
            doc(id) {
              return {
                async get() {
                  return {
                    data: records.has(id) ? records.get(id) : null
                  };
                },
                async update({ data }) {
                  assert(records.has(id), `transaction updated missing ${name} ${id}`);
                  records.set(id, Object.assign({}, records.get(id), data));
                  return {
                    stats: {
                      updated: 1
                    }
                  };
                }
              };
            }
          };
        }
      };
      return {
        result: await callback(transaction)
      };
    },
    serverDate() {
      return {
        $serverDate: true
      };
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return {
        OPENID: currentOpenId
      };
    },
    async deleteFile({ fileList }) {
      fileList.forEach((fileID) => {
        deletedFileIDs.push(fileID);
        const referencingProduct = [...products.values()].find((product) => (
          (Array.isArray(product.images) && product.images.includes(fileID))
          || (product.video && [
            product.video.fileID,
            product.video.posterFileID
          ].includes(fileID))
        ));
        deleteStatusSnapshots.push(
          referencingProduct ? referencingProduct.status : 'unreferenced'
        );
      });
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          status: deleteMode === 'success' ? 0 : -1
        }))
      };
    }
  };

  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(functionPath)];
    const manageProductFunction = require(functionPath);

    const editable = await manageProductFunction.main({
      action: 'getEditableProduct',
      productId: 'product-edit'
    });
    assert(
      editable.success === true
      && editable.data.version === 1
      && editable.data.product.id === 'product-edit'
      && !Object.prototype.hasOwnProperty.call(
        editable.data.product,
        'sellerOpenid'
      ),
      'manageProduct failed to return safe owner-only editable data'
    );
    assert(
      editable.data.product.locationDetail
      && editable.data.product.locationDetail.name === '图书馆南门',
      'manageProduct dropped a modern product location during edit loading'
    );

    const legacyEditable = await manageProductFunction.main({
      action: 'getEditableProduct',
      productId: 'product-legacy-location'
    });
    assert(
      legacyEditable.success === true
      && legacyEditable.data.product.location === '旧图书馆门口'
      && legacyEditable.data.product.locationDetail === null,
      'manageProduct cannot safely load a legacy string-only location'
    );

    const preservedLegacyLocation = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-legacy-location',
      expectedVersion: 1,
      mutationId: 'mut_legacy_location_keep_01',
      product: {
        title: '旧地点商品文字更新',
        description: '只修改其他字段并继续保留旧地点字符串',
        price: 19,
        categoryId: 'life',
        condition: '八成新',
        location: '旧图书馆门口',
        images: [legacyLocationImage]
      }
    });
    assert(
      preservedLegacyLocation.success === true
      && products.get('product-legacy-location').location === '旧图书馆门口'
      && products.get('product-legacy-location').locationDetail === null,
      'manageProduct requires a migration when a legacy location was unchanged'
    );

    const changedLegacyLocationWithoutDetail = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-legacy-location',
      expectedVersion: 2,
      mutationId: 'mut_legacy_location_missing_02',
      product: {
        title: '旧地点商品文字更新',
        description: '尝试只改变地点字符串但不提交结构化地点',
        price: 19,
        categoryId: 'life',
        condition: '八成新',
        location: '新图书馆南门',
        images: [legacyLocationImage]
      }
    });
    assert(
      changedLegacyLocationWithoutDetail.success === false
      && changedLegacyLocationWithoutDetail.code === 'INVALID_PRODUCT_FIELD'
      && products.get('product-legacy-location').location === '旧图书馆门口',
      'manageProduct accepts a changed legacy location without locationDetail'
    );

    const selectedLegacyLocation = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-legacy-location',
      expectedVersion: 2,
      mutationId: 'mut_legacy_location_select_03',
      product: {
        title: '旧地点商品文字更新',
        description: '重新选择地图地点后保存结构化地点信息',
        price: 19,
        categoryId: 'life',
        condition: '八成新',
        location: '新图书馆南门',
        locationDetail: {
          name: '新图书馆南门',
          address: '示例大学新图书馆南侧公共区域',
          latitude: 31.232,
          longitude: 121.475
        },
        images: [legacyLocationImage]
      }
    });
    assert(
      selectedLegacyLocation.success === true
      && products.get('product-legacy-location').locationDetail.name
        === '新图书馆南门',
      'manageProduct did not store a newly selected location for a legacy product'
    );

    const preservedModernLocation = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-modern-location',
      expectedVersion: 1,
      mutationId: 'mut_modern_location_keep_01',
      product: {
        title: '新版地点商品文字更新',
        description: '普通编辑时不应丢失已有结构化地点',
        price: 29,
        categoryId: 'life',
        condition: '九成新',
        location: '体育馆入口',
        images: [modernLocationImage]
      }
    });
    assert(
      preservedModernLocation.success === true
      && products.get('product-modern-location').locationDetail.address
        === '示例大学体育馆公共入口',
      'manageProduct dropped an existing locationDetail during ordinary editing'
    );

    const invalidModernLocation = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-modern-location',
      expectedVersion: 2,
      mutationId: 'mut_modern_location_invalid_02',
      product: {
        title: '新版地点商品文字更新',
        description: '非法地点对象不应覆盖已有结构化地点',
        price: 29,
        categoryId: 'life',
        condition: '九成新',
        location: '体育馆入口',
        locationDetail: {
          name: '体育馆入口',
          address: '示例大学体育馆公共入口',
          latitude: 0,
          longitude: 0
        },
        images: [modernLocationImage]
      }
    });
    assert(
      invalidModernLocation.success === false
      && invalidModernLocation.code === 'INVALID_PRODUCT_FIELD'
      && products.get('product-modern-location').locationDetail.latitude
        === 31.231,
      'manageProduct accepted an invalid location or damaged the stored location'
    );

    const offline = await manageProductFunction.main({
      action: 'takeOffline',
      productId: 'product-state'
    });
    assert(
      offline.success === true
      && offline.data.status === 'offline'
      && offline.data.version === 2
      && offline.data.reused === false,
      'manageProduct failed available -> offline'
    );
    assert(
      products.get('product-state').offlineAt.$serverDate === true,
      'manageProduct did not write offlineAt'
    );

    const repeatedOffline = await manageProductFunction.main({
      action: 'takeOffline',
      productId: 'product-state'
    });
    assert(
      repeatedOffline.success === true
      && repeatedOffline.data.reused === true
      && repeatedOffline.data.version === 2,
      'manageProduct repeated takeOffline is not idempotent'
    );

    const relisted = await manageProductFunction.main({
      action: 'relist',
      productId: 'product-state'
    });
    assert(
      relisted.success === true
      && relisted.data.status === 'available'
      && relisted.data.version === 3
      && products.get('product-state').offlineAt === null
      && products.get('product-state').relistedAt.$serverDate === true,
      'manageProduct failed offline -> available'
    );

    const sold = await manageProductFunction.main({
      action: 'markSold',
      productId: 'product-state'
    });
    assert(
      sold.success === true
      && sold.data.status === 'sold'
      && sold.data.version === 4
      && products.get('product-state').soldAt.$serverDate === true,
      'manageProduct failed available -> sold'
    );

    const repeatedSold = await manageProductFunction.main({
      action: 'markSold',
      productId: 'product-state'
    });
    assert(
      repeatedSold.success === true && repeatedSold.data.reused === true,
      'manageProduct repeated markSold is not idempotent'
    );

    const invalidRelist = await manageProductFunction.main({
      action: 'relist',
      productId: 'product-state'
    });
    assert(
      invalidRelist.success === false
      && invalidRelist.code === 'INVALID_STATUS_TRANSITION',
      'manageProduct allows sold -> available'
    );

    const updateRequest = {
      action: 'updateProduct',
      productId: 'product-edit',
      expectedVersion: 1,
      mutationId: 'mut_update_product_001',
      product: {
        title: '更新后的商品标题',
        description: '更新后的商品描述内容完整',
        price: 29.9,
        categoryId: 'digital',
        categoryName: '伪造分类名',
        condition: '八成新',
        location: '实验楼大厅',
        locationDetail: {
          name: '实验楼大厅',
          address: '示例大学实验楼一层公共大厅',
          latitude: 31.231,
          longitude: 121.474
        },
        images: [ownerImageA, ownerImageC],
        video: {
          fileID: ownerVideoNew,
          posterFileID: '',
          duration: 12,
          width: 1080,
          height: 1920,
          size: 4096
        }
      }
    };
    const updated = await manageProductFunction.main(updateRequest);
    assert(
      updated.success === true
      && updated.data.version === 2
      && products.get('product-edit').title === '更新后的商品标题'
      && products.get('product-edit').categoryName === '数码'
      && products.get('product-edit').locationDetail.name === '实验楼大厅'
      && products.get('product-edit').video.fileID === ownerVideoNew
      && products.get('product-edit').status === 'available'
      && products.get('product-edit').sellerOpenid === 'owner-openid'
      && products.get('product-edit').createdAt.original === true,
      'manageProduct did not update only allowed product fields'
    );
    assert(
      deletedFileIDs.includes(ownerImageB)
      && deletedFileIDs.includes(ownerVideoOld),
      'manageProduct did not delete removed unreferenced image and video files'
    );

    const repeatedUpdate = await manageProductFunction.main(updateRequest);
    assert(
      repeatedUpdate.success === true
      && repeatedUpdate.data.reused === true
      && repeatedUpdate.data.version === 2,
      'manageProduct update retry is not idempotent'
    );

    const staleUpdate = await manageProductFunction.main(Object.assign(
      {},
      updateRequest,
      {
        mutationId: 'mut_update_product_002',
        expectedVersion: 1
      }
    ));
    assert(
      staleUpdate.success === false
      && staleUpdate.code === 'PRODUCT_VERSION_CONFLICT',
      'manageProduct accepted a stale product version'
    );

    const forgedStatusUpdate = await manageProductFunction.main(Object.assign(
      {},
      updateRequest,
      {
        mutationId: 'mut_update_product_003',
        expectedVersion: 2,
        product: Object.assign({}, updateRequest.product, {
          status: 'sold'
        })
      }
    ));
    assert(
      forgedStatusUpdate.success === false
      && forgedStatusUpdate.code === 'INVALID_PRODUCT_FIELD'
      && products.get('product-edit').status === 'available',
      'manageProduct accepted a forged status field'
    );

    deleteMode = 'fail';
    const cleanupPartial = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-cleanup',
      expectedVersion: 1,
      mutationId: 'mut_cleanup_failure_01',
      product: {
        title: '清理失败但业务成功',
        description: '清理失败时数据库更新仍然成功',
        price: 31,
        categoryId: 'life',
        categoryName: '生活',
        condition: '八成新',
        location: '操场东门',
        images: [cleanupImageA]
      }
    });
    assert(
      cleanupPartial.success === true
      && cleanupPartial.data.cleanupPending === true
      && products.get('product-cleanup').title === '清理失败但业务成功'
      && products.get('product-cleanup').imageCleanupStatus === 'partial_failed',
      'image cleanup failure rolled back a successful database update'
    );

    deleteMode = 'success';
    const cleanupRetry = await manageProductFunction.main({
      action: 'retryImageCleanup',
      productId: 'product-cleanup'
    });
    assert(
      cleanupRetry.success === true
      && cleanupRetry.data.cleanupPending === false
      && products.get('product-cleanup').imageCleanupStatus === 'completed',
      'image cleanup retry did not complete a pending cleanup'
    );

    const deletedCountBeforeRetain = deletedFileIDs.length;
    const retainedAllImages = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-retain',
      expectedVersion: 1,
      mutationId: 'mut_retain_images_001',
      product: {
        title: '保留全部旧图片',
        description: '只更新文字并保留全部旧图片',
        price: 41,
        categoryId: 'life',
        categoryName: '生活',
        condition: '九成新',
        location: '教学楼门口',
        images: [retainImage]
      }
    });
    assert(
      retainedAllImages.success === true
      && deletedFileIDs.length === deletedCountBeforeRetain,
      'manageProduct deleted an image when all old images were retained'
    );

    const replacedAllImages = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-replace',
      expectedVersion: 1,
      mutationId: 'mut_replace_images_01',
      product: {
        title: '全部替换商品图片',
        description: '全部旧图片替换为本次新图片',
        price: 42,
        categoryId: 'life',
        categoryName: '生活',
        condition: '九成新',
        location: '教学楼门口',
        images: [replaceNewImage]
      }
    });
    assert(
      replacedAllImages.success === true
      && products.get('product-replace').images[0] === replaceNewImage
      && deletedFileIDs.includes(replaceOldImage),
      'manageProduct failed to replace all old images safely'
    );

    const beforeSharedDeleteCount = deletedFileIDs
      .filter((fileID) => fileID === sharedImage).length;
    const sharedDeleted = await manageProductFunction.main({
      action: 'softDelete',
      productId: 'product-shared-owner',
      expectedVersion: 1,
      mutationId: 'mut_shared_delete_001'
    });
    assert(
      sharedDeleted.success === true
      && sharedDeleted.data.status === 'deleted'
      && sharedDeleted.data.cleanupPending === false
      && deletedFileIDs.filter((fileID) => fileID === sharedImage).length
        === beforeSharedDeleteCount,
      'manageProduct deleted an image still referenced by another product'
    );

    const softDeleted = await manageProductFunction.main({
      action: 'softDelete',
      productId: 'product-edit',
      expectedVersion: 2,
      mutationId: 'mut_soft_delete_001'
    });
    assert(
      softDeleted.success === true
      && softDeleted.data.status === 'deleted'
      && softDeleted.data.version === 3
      && products.get('product-edit').status === 'deleted'
      && products.get('product-edit').deletedAt.$serverDate === true
      && products.has('product-edit'),
      'manageProduct did not soft delete the product'
    );
    assert(
      [ownerImageA, ownerImageC, ownerVideoNew].every(
        (fileID) => deletedFileIDs.includes(fileID)
      )
      &&
      deleteStatusSnapshots
        .filter((status, index) => (
          [ownerImageA, ownerImageC, ownerVideoNew].includes(deletedFileIDs[index])
        ))
        .every((status) => status === 'deleted'),
      'manageProduct deleted cloud media before database soft delete'
    );

    const repeatedDelete = await manageProductFunction.main({
      action: 'softDelete',
      productId: 'product-edit',
      expectedVersion: 2,
      mutationId: 'mut_soft_delete_002'
    });
    assert(
      repeatedDelete.success === true
      && repeatedDelete.data.reused === true
      && repeatedDelete.data.version === 3,
      'manageProduct repeated soft delete is not idempotent'
    );

    const deletedEdit = await manageProductFunction.main({
      action: 'getEditableProduct',
      productId: 'product-edit'
    });
    assert(
      deletedEdit.success === false && deletedEdit.code === 'PRODUCT_DELETED',
      'manageProduct allows a deleted product to be edited'
    );

    const deletedTransition = await manageProductFunction.main({
      action: 'takeOffline',
      productId: 'product-edit'
    });
    assert(
      deletedTransition.success === false
      && deletedTransition.code === 'PRODUCT_DELETED',
      'manageProduct allows a deleted product status transition'
    );

    const forbidden = await manageProductFunction.main({
      action: 'takeOffline',
      productId: 'product-foreign',
      sellerOpenid: 'foreign-openid'
    });
    assert(
      forbidden.success === false && forbidden.code === 'PRODUCT_FORBIDDEN',
      'manageProduct trusts a forged sellerOpenid'
    );
    assert(
      products.get('product-foreign').status === 'available',
      'manageProduct changed another owner product'
    );

    const forbiddenEdit = await manageProductFunction.main({
      action: 'getEditableProduct',
      productId: 'product-foreign'
    });
    assert(
      forbiddenEdit.success === false
      && forbiddenEdit.code === 'PRODUCT_FORBIDDEN',
      'manageProduct returned another owner editable data'
    );

    const forbiddenMediaUpdate = await manageProductFunction.main({
      action: 'updateProduct',
      productId: 'product-foreign',
      expectedVersion: 1,
      mutationId: 'mut_foreign_media_001',
      product: {
        title: '越权媒体修改',
        description: '越权媒体修改不应写入商品',
        price: 20,
        categoryId: 'life',
        condition: '九成新',
        location: '图书馆南门',
        images: [ownerImageA],
        video: {
          fileID: ownerVideoNew,
          posterFileID: '',
          duration: 12,
          width: 1080,
          height: 1920,
          size: 4096
        }
      }
    });
    assert(
      forbiddenMediaUpdate.success === false
      && forbiddenMediaUpdate.code === 'PRODUCT_FORBIDDEN'
      && !products.get('product-foreign').video,
      'manageProduct allowed a non-owner to replace product media'
    );

    const forbiddenDelete = await manageProductFunction.main({
      action: 'softDelete',
      productId: 'product-foreign',
      expectedVersion: 1,
      mutationId: 'mut_foreign_delete_01'
    });
    assert(
      forbiddenDelete.success === false
      && forbiddenDelete.code === 'PRODUCT_FORBIDDEN'
      && products.get('product-foreign').status === 'available',
      'manageProduct soft deleted another owner product'
    );

    const missing = await manageProductFunction.main({
      action: 'takeOffline',
      productId: 'product-missing'
    });
    assert(
      missing.success === false && missing.code === 'PRODUCT_NOT_FOUND',
      'manageProduct does not distinguish a missing product'
    );

    const invalidParams = await manageProductFunction.main({
      action: 'takeOffline'
    });
    assert(
      invalidParams.success === false && invalidParams.code === 'INVALID_PARAMS',
      'manageProduct accepts a missing product id'
    );

    currentOpenId = '';
    const unauthorized = await manageProductFunction.main({
      action: 'takeOffline',
      productId: 'product-foreign'
    });
    assert(
      unauthorized.success === false && unauthorized.code === 'UNAUTHORIZED',
      'manageProduct accepts a missing cloud identity'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function verifyPublishServiceFlow() {
  const ProductPublishService = require(path.join(
    root,
    'services/product-publish-service'
  ));
  const originalWx = global.wx;
  const uploadedPaths = [];
  const deletedFileLists = [];
  const functionRequests = [];
  let functionMode = 'success';

  global.wx = {
    getImageInfo({ success }) {
      success({
        width: 1200,
        height: 900,
        type: 'jpeg'
      });
    },
    cloud: {
      init() {},
      uploadFile({ cloudPath, success }) {
        uploadedPaths.push(cloudPath);
        success({
          fileID: `cloud://test-env.bucket/${cloudPath}`
        });
        return {
          abort() {}
        };
      },
      deleteFile({ fileList, success }) {
        deletedFileLists.push(fileList.slice());
        success({
          fileList: fileList.map((fileID) => ({
            fileID,
            status: 0
          }))
        });
      },
      callFunction({ name, data, success }) {
        functionRequests.push({ name, data });
        if (functionMode === 'invalid-location') {
          success({
            result: {
              success: false,
              code: 'INVALID_LOCATION_DETAIL',
              message: 'Error: raw cloud stack must not be displayed',
              data: null
            }
          });
          return;
        }
        if (functionMode === 'failure') {
          success({
            result: {
              success: false,
              code: 'DATABASE_ERROR',
              message: '商品保存失败，请稍后重试',
              data: null
            }
          });
          return;
        }
        success({
          result: {
            success: true,
            code: 'OK',
            message: '',
            data: {
              productId: 'p_verification',
              reused: functionMode === 'reused'
            }
          }
        });
      }
    }
  };

  const draft = {
    title: '  校园二手台灯  ',
    description: '宿舍自用，功能正常，可在图书馆附近交易。',
    price: '29.90',
    categoryId: 'life',
    condition: '九成新',
    location: '图书馆南门',
    locationDetail: {
      name: '图书馆南门',
      address: '示例大学图书馆南侧公共区域',
      latitude: 31.2304,
      longitude: 121.4737
    }
  };
  const localImages = [
    {
      tempFilePath: '<TEMP_ROOT>\\lamp-one.jpg',
      size: 1024,
      fileType: 'image'
    },
    {
      tempFilePath: '<TEMP_ROOT>\\lamp-two.png',
      size: 2048,
      fileType: 'image'
    }
  ];
  const localVideo = {
    tempFilePath: '<TEMP_ROOT>\\lamp-demo.mp4',
    size: 4096,
    duration: 15,
    width: 1080,
    height: 1920,
    fileType: 'video'
  };

  try {
    let missingLocationError;
    try {
      ProductPublishService.validateProductDraft(
        Object.assign({}, draft, { locationDetail: null }),
        localImages
      );
    } catch (error) {
      missingLocationError = error;
    }
    assert(
      missingLocationError && missingLocationError.code === 'LOCATION_REQUIRED',
      'publish validation accepts a product without a selected map location'
    );

    let missingImageError;
    try {
      ProductPublishService.validateProductDraft(draft, []);
    } catch (error) {
      missingImageError = error;
    }
    assert(missingImageError && missingImageError.code === 'IMAGE_REQUIRED', 'publish validation accepts a draft without images');

    let invalidPriceError;
    try {
      ProductPublishService.validateProductDraft(
        Object.assign({}, draft, { price: '1.234' }),
        localImages
      );
    } catch (error) {
      invalidPriceError = error;
    }
    assert(invalidPriceError && invalidPriceError.code === 'PRICE_INVALID', 'publish validation accepts an invalid price');

    let invalidImageTypeError;
    try {
      ProductPublishService.validateProductDraft(draft, [{
        tempFilePath: '<TEMP_ROOT>\\payload.exe',
        size: 1024,
        fileType: 'image'
      }]);
    } catch (error) {
      invalidImageTypeError = error;
    }
    assert(
      invalidImageTypeError && invalidImageTypeError.code === 'IMAGE_TYPE_INVALID',
      'publish validation accepts a non-image extension'
    );

    let invalidImageSizeError;
    try {
      ProductPublishService.validateProductDraft(draft, [{
        tempFilePath: '<TEMP_ROOT>\\empty.jpg',
        size: 0,
        fileType: 'image'
      }]);
    } catch (error) {
      invalidImageSizeError = error;
    }
    assert(
      invalidImageSizeError && invalidImageSizeError.code === 'IMAGE_SIZE_INVALID',
      'publish validation accepts an empty image'
    );

    const normalized = ProductPublishService.validateProductDraft(draft, localImages);
    assert(normalized.title === '校园二手台灯', 'publish validation does not normalize the title');
    assert(normalized.price === 29.9 && typeof normalized.price === 'number', 'publish validation does not produce a numeric price');
    let oversizedVideoError;
    try {
      ProductPublishService.validateProductDraft(
        draft,
        localImages,
        Object.assign({}, localVideo, { size: 51 * 1024 * 1024 })
      );
    } catch (error) {
      oversizedVideoError = error;
    }
    assert(
      oversizedVideoError && oversizedVideoError.code === 'VIDEO_TOO_LARGE',
      'publish validation accepts an oversized product video'
    );

    const requestId = 'req_verification_0001';
    const result = await ProductPublishService.publishProduct({
      draft,
      localImages,
      localVideo,
      userId: 'u_test',
      requestId
    });
    assert(result.productId === 'p_verification', 'publish service did not return the product id');
    assert(uploadedPaths.length === 3, 'publish service did not upload every selected image and video');
    assert(uploadedPaths.every((cloudPath) => cloudPath.startsWith('products/u_test/')), 'publish upload paths are not user-scoped');
    assert(functionRequests.length === 1, 'publish service called createProduct an unexpected number of times');
    assert(functionRequests[0].name === 'createProduct', 'publish service called the wrong cloud function');
    assert(functionRequests[0].data.requestId === requestId, 'publish service dropped the idempotency key');
    assert(functionRequests[0].data.product.price === 29.9, 'publish service sent a non-numeric price');
    assert(
      functionRequests[0].data.product.images.length === 2
      && functionRequests[0].data.product.video.fileID.endsWith('.mp4'),
      'publish service did not send the complete product media payload'
    );
    assert(
      functionRequests[0].data.product.location === draft.location
      && functionRequests[0].data.product.locationDetail.name === draft.location,
      'publish service dropped or mismatched the selected map location'
    );
    [
      'sellerId',
      'sellerOpenid',
      'status',
      'viewCount',
      'favoriteCount',
      'createdAt',
      'updatedAt'
    ].forEach((field) => {
      assert(!(field in functionRequests[0].data.product), `publish service sent protected field ${field}`);
    });

    functionMode = 'reused';
    const pendingFileIds = functionRequests[0].data.product.images.slice();
    const pendingVideoFileId = functionRequests[0].data.product.video.fileID;
    const reused = await ProductPublishService.publishProduct({
      draft,
      localImages,
      localVideo,
      userId: 'u_test',
      requestId,
      pendingFileIds,
      pendingVideoFileId
    });
    assert(reused.reused === true, 'publish retry did not preserve server idempotency');
    assert(uploadedPaths.length === 3, 'publish retry uploaded the same media again');

    functionMode = 'failure';
    let databaseError;
    try {
      await ProductPublishService.publishProduct({
        draft,
        localImages: [localImages[0]],
        localVideo,
        userId: 'u_test',
        requestId: 'req_verification_0002'
      });
    } catch (error) {
      databaseError = error;
    }
    assert(databaseError && databaseError.code === 'DATABASE_ERROR', 'publish service did not preserve the business error');
    assert(deletedFileLists.length === 1, 'publish failure did not clean its uploaded image');
    assert(deletedFileLists[0].length === 2, 'publish cleanup did not include the uploaded image and video');
    const refusedForeignDelete = await ProductPublishService.deleteCloudFiles([
      'cloud://test-env.bucket/products/u_other/20260717/foreign.jpg'
    ], 'u_test');
    assert(refusedForeignDelete === false, 'publish cleanup accepted another user directory');
    assert(deletedFileLists.length === 1, 'publish cleanup attempted to delete another user file');

    functionMode = 'invalid-location';
    let locationBusinessError;
    try {
      await ProductPublishService.publishProduct({
        draft,
        localImages,
        localVideo,
        userId: 'u_test',
        requestId: 'req_verification_location_error',
        pendingFileIds,
        pendingVideoFileId
      });
    } catch (error) {
      locationBusinessError = error;
    }
    assert(
      locationBusinessError
      && locationBusinessError.code === 'INVALID_LOCATION_DETAIL'
      && locationBusinessError.message === '交易地点信息无效，请重新选择',
      'publish service exposes a raw cloud error or lacks a friendly location error'
    );
  } finally {
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyCreateProductFunctionFlow() {
  const crypto = require('crypto');
  const functionPath = path.join(root, 'cloudfunctions/createProduct/index.js');
  const originalLoad = Module._load;
  const users = new Map();
  const schools = new Map();
  const products = new Map();
  let setCount = 0;

  const openId = 'verification-openid';
  const appId = 'verification-appid';
  const userId = `u_${crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex')
    .slice(0, 32)}`;
  const schoolId = `s_${'a'.repeat(32)}`;
  users.set(userId, {
    _id: userId,
    openid: openId,
    nickname: '验收同学',
    avatarUrl: 'cloud://test-env.bucket/avatars/user.jpg',
    campus: '示例大学',
    status: 'active',
    profileCompleted: true,
    schoolId,
    schoolName: '客户端旧学校名称'
  });
  schools.set(schoolId, {
    _id: schoolId,
    name: '示例大学',
    officialStatus: 'valid',
    platformStatus: 'active'
  });

  function createCollection(store, name) {
    return {
      where(query) {
        return {
          limit() {
            return this;
          },
          async get() {
            const item = store.get(query._id);
            return {
              data: item ? [item] : []
            };
          }
        };
      },
      doc(id) {
        return {
          async set({ data }) {
            setCount += 1;
            store.set(id, Object.assign({ _id: id }, data));
          }
        };
      },
      name
    };
  }

  const db = {
    collection(name) {
      if (name === 'users') {
        return createCollection(users, name);
      }
      if (name === 'products') {
        return createCollection(products, name);
      }
      if (name === 'schools') {
        return createCollection(schools, name);
      }
      throw new Error(`unexpected collection ${name}`);
    },
    serverDate() {
      return {
        $serverDate: true
      };
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return {
        OPENID: openId,
        APPID: appId
      };
    }
  };

  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(functionPath)];
    const createProductFunction = require(functionPath);
    const requestId = 'req_server_verification_0001';
    const validProduct = {
      title: '  云端验收台灯  ',
      description: '真实服务端字段校验用商品描述。',
      price: 29.9,
      categoryId: 'life',
      condition: '九成新',
      location: '图书馆南门',
      locationDetail: {
        name: '图书馆南门',
        address: '示例大学图书馆南侧公共区域',
        latitude: 31.2304,
        longitude: 121.4737
      },
      images: [
        `cloud://test-env.bucket/products/${userId}/20260717/lamp.jpg`
      ],
      video: {
        fileID: `cloud://test-env.bucket/products/${userId}/20260717/lamp-demo.mp4`,
        posterFileID: '',
        duration: 12,
        width: 1080,
        height: 1920,
        size: 2048
      },
      sellerId: 'u_spoofed',
      sellerOpenid: 'spoofed-openid',
      sellerName: '伪造卖家',
      status: 'sold',
      viewCount: 999,
      favoriteCount: 999,
      createdAt: 'client-time',
      updatedAt: 'client-time'
    };

    const created = await createProductFunction.main({
      requestId,
      product: validProduct
    });
    assert(created.success === true && created.data.reused === false, 'createProduct did not create a valid product');
    assert(setCount === 1 && products.size === 1, 'createProduct wrote an unexpected number of documents');
    const storedProduct = products.get(created.data.productId);
    assert(storedProduct.price === 29.9 && typeof storedProduct.price === 'number', 'createProduct did not store a numeric price');
    assert(storedProduct.coverImage === validProduct.images[0], 'createProduct cover image is not the first cloud file');
    assert(
      storedProduct.location === validProduct.location
      && storedProduct.locationDetail.name === validProduct.location,
      'createProduct did not validate and store the selected map location'
    );
    assert(
      storedProduct.images.length === 1
      && storedProduct.video.fileID === validProduct.video.fileID,
      'createProduct did not save the complete image and video media fields'
    );
    assert(storedProduct.sellerId === userId, 'createProduct trusted a spoofed seller id');
    assert(storedProduct.sellerOpenid === openId, 'createProduct trusted a spoofed seller openid');
    assert(storedProduct.sellerName === '验收同学', 'createProduct trusted a spoofed seller name');
    assert(storedProduct.schoolId === schoolId, 'createProduct did not bind the verified user school');
    assert(storedProduct.schoolName === '示例大学', 'createProduct trusted a stale or spoofed school name');
    assert(storedProduct.status === 'available', 'createProduct trusted a spoofed product status');
    assert(storedProduct.viewCount === 0 && storedProduct.favoriteCount === 0, 'createProduct trusted spoofed counters');
    assert(storedProduct.createdAt.$serverDate === true, 'createProduct trusted a client creation time');
    assert(storedProduct.updatedAt.$serverDate === true, 'createProduct trusted a client update time');

    const repeated = await createProductFunction.main({
      requestId,
      product: validProduct
    });
    assert(repeated.success === true && repeated.data.reused === true, 'createProduct repeat request is not idempotent');
    assert(setCount === 1 && products.size === 1, 'createProduct repeat request created a duplicate');

    const stringPrice = await createProductFunction.main({
      requestId: 'req_server_verification_0002',
      product: Object.assign({}, validProduct, {
        price: '29.90'
      })
    });
    assert(stringPrice.success === false && stringPrice.code === 'INVALID_PARAMS', 'createProduct accepts a string price');

    const infinitePrice = await createProductFunction.main({
      requestId: 'req_server_verification_0003',
      product: Object.assign({}, validProduct, {
        price: Infinity
      })
    });
    assert(infinitePrice.success === false && infinitePrice.code === 'INVALID_PARAMS', 'createProduct accepts an infinite price');

    const tooManyImages = await createProductFunction.main({
      requestId: 'req_server_verification_0004',
      product: Object.assign({}, validProduct, {
        images: Array.from({ length: 7 }, (_, index) => (
          `cloud://test-env.bucket/products/${userId}/20260717/lamp-${index}.jpg`
        ))
      })
    });
    assert(tooManyImages.success === false && tooManyImages.code === 'INVALID_PARAMS', 'createProduct accepts too many images');

    const extraVideos = await createProductFunction.main({
      requestId: 'req_server_verification_video_array',
      product: Object.assign({}, validProduct, {
        video: [validProduct.video, validProduct.video]
      })
    });
    assert(
      extraVideos.success === false && extraVideos.code === 'INVALID_PARAMS',
      'createProduct accepts more than one product video'
    );

    const oversizedVideo = await createProductFunction.main({
      requestId: 'req_server_verification_video_size',
      product: Object.assign({}, validProduct, {
        video: Object.assign({}, validProduct.video, {
          size: 51 * 1024 * 1024
        })
      })
    });
    assert(
      oversizedVideo.success === false && oversizedVideo.code === 'INVALID_PARAMS',
      'createProduct accepts an oversized product video'
    );

    const noVideo = await createProductFunction.main({
      requestId: 'req_server_verification_no_video',
      product: Object.assign({}, validProduct, {
        video: undefined
      })
    });
    const noVideoRecord = products.get(noVideo.data && noVideo.data.productId);
    assert(
      noVideo.success === true && noVideoRecord && noVideoRecord.video === null,
      'createProduct is not backward compatible with an image-only product'
    );

    const productCountBeforeInvalidLocations = products.size;
    const invalidLocationCases = [
      {
        label: 'missing locationDetail',
        patch: { locationDetail: undefined }
      },
      {
        label: 'mismatched location name',
        patch: {
          locationDetail: Object.assign({}, validProduct.locationDetail, {
            name: '体育馆入口'
          })
        }
      },
      {
        label: 'out-of-range latitude',
        patch: {
          locationDetail: Object.assign({}, validProduct.locationDetail, {
            latitude: 91
          })
        }
      },
      {
        label: 'out-of-range longitude',
        patch: {
          locationDetail: Object.assign({}, validProduct.locationDetail, {
            longitude: -181
          })
        }
      },
      {
        label: 'zero coordinate pair',
        patch: {
          locationDetail: Object.assign({}, validProduct.locationDetail, {
            latitude: 0,
            longitude: 0
          })
        }
      },
      {
        label: 'extra location field',
        patch: {
          locationDetail: Object.assign({}, validProduct.locationDetail, {
            accuracy: 10
          })
        }
      },
      {
        label: 'non-numeric coordinate',
        patch: {
          locationDetail: Object.assign({}, validProduct.locationDetail, {
            latitude: '31.2304'
          })
        }
      },
      {
        label: 'overlong address',
        patch: {
          locationDetail: Object.assign({}, validProduct.locationDetail, {
            address: '地'.repeat(121)
          })
        }
      }
    ];
    for (let index = 0; index < invalidLocationCases.length; index += 1) {
      const testCase = invalidLocationCases[index];
      const invalidLocation = await createProductFunction.main({
        requestId: `req_server_location_invalid_${index}`,
        product: Object.assign({}, validProduct, testCase.patch)
      });
      assert(
        invalidLocation.success === false
        && invalidLocation.code === 'INVALID_LOCATION_DETAIL'
        && invalidLocation.message === '交易地点信息无效，请重新选择'
        && invalidLocation.data === null
        && !Object.prototype.hasOwnProperty.call(invalidLocation, 'stack'),
        `createProduct accepts ${testCase.label} or exposes an unsafe error`
      );
    }
    assert(
      products.size === productCountBeforeInvalidLocations,
      'createProduct wrote a product after invalid location validation'
    );

    const trimmedLocation = await createProductFunction.main({
      requestId: 'req_server_location_trimmed_valid',
      product: Object.assign({}, validProduct, {
        location: '  图书馆南门  ',
        locationDetail: Object.assign({}, validProduct.locationDetail, {
          name: '  图书馆南门  ',
          address: '  示例大学图书馆南侧  公共区域  '
        })
      })
    });
    const trimmedLocationRecord = products.get(
      trimmedLocation.data && trimmedLocation.data.productId
    );
    assert(
      trimmedLocation.success === true
      && trimmedLocationRecord.location === '图书馆南门'
      && trimmedLocationRecord.locationDetail.name === '图书馆南门'
      && trimmedLocationRecord.locationDetail.address
        === '示例大学图书馆南侧 公共区域',
      'createProduct does not trim and store a valid location safely'
    );

    const embeddedUserFolder = await createProductFunction.main({
      requestId: 'req_server_verification_0005',
      product: Object.assign({}, validProduct, {
        images: [
          `cloud://test-env.bucket/foreign/products/${userId}/20260717/lamp.jpg`
        ]
      })
    });
    assert(
      embeddedUserFolder.success === false && embeddedUserFolder.code === 'INVALID_PARAMS',
      'createProduct accepts a user folder embedded in an unrelated path'
    );

    users.clear();
    const missingUser = await createProductFunction.main({
      requestId: 'req_server_verification_0006',
      product: validProduct
    });
    assert(missingUser.success === false && missingUser.code === 'USER_NOT_FOUND', 'createProduct accepts a missing user');

    users.set(userId, {
      _id: userId,
      openid: openId,
      nickname: '停用用户',
      avatarUrl: '',
      campus: '示例大学',
      status: 'disabled'
    });
    const disabledUser = await createProductFunction.main({
      requestId: 'req_server_verification_0007',
      product: validProduct
    });
    assert(disabledUser.success === false && disabledUser.code === 'USER_DISABLED', 'createProduct accepts a disabled user');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function verifyFavoriteProductFunctionFlow() {
  const functionPath = path.join(root, 'cloudfunctions/favoriteProduct/index.js');
  const originalLoad = Module._load;
  const productRecords = new Map();
  const favoriteRecords = new Map();
  let currentOpenId = 'owner-openid';
  let forcedFavoriteReadError = null;

  function missingDocumentError(id) {
    const error = new Error(`document.get:fail document with _id ${id} does not exist`);
    error.errCode = -1;
    error.errMsg = error.message;
    return error;
  }

  function createDocument(records, id) {
    return {
      async get() {
        if (records === favoriteRecords && forcedFavoriteReadError) {
          throw forcedFavoriteReadError;
        }
        if (!records.has(id)) {
          throw missingDocumentError(id);
        }
        return { data: { ...records.get(id) } };
      },
      async set(options) {
        records.set(id, { _id: id, ...options.data });
        return { stats: { created: 1 } };
      },
      async update(options) {
        if (!records.has(id)) {
          throw missingDocumentError(id);
        }
        records.set(id, { ...records.get(id), ...options.data });
        return { stats: { updated: 1 } };
      },
      async remove() {
        const existed = records.delete(id);
        return { stats: { removed: existed ? 1 : 0 } };
      }
    };
  }

  function matches(record, condition) {
    return Object.entries(condition).every(([key, value]) => {
      if (value && Array.isArray(value.$in)) {
        return value.$in.includes(record[key]);
      }
      return record[key] === value;
    });
  }

  function createQuery(records, condition) {
    let offset = 0;
    let limit = 100;
    const orders = [];
    const query = {
      orderBy(field, direction) {
        orders.push({ field, direction });
        return query;
      },
      skip(value) {
        offset = value;
        return query;
      },
      limit(value) {
        limit = value;
        return query;
      },
      async count() {
        return {
          total: [...records.values()].filter((record) => matches(record, condition)).length
        };
      },
      async get() {
        const data = [...records.values()]
          .filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const order of orders) {
              const leftValue = left[order.field] instanceof Date
                ? left[order.field].getTime()
                : left[order.field];
              const rightValue = right[order.field] instanceof Date
                ? right[order.field].getTime()
                : right[order.field];
              if (leftValue === rightValue) {
                continue;
              }
              const compared = leftValue < rightValue ? -1 : 1;
              return order.direction === 'desc' ? -compared : compared;
            }
            return 0;
          })
          .slice(offset, offset + limit)
          .map((record) => ({ ...record }));
        return { data };
      }
    };
    return query;
  }

  function collection(name) {
    const records = name === 'products' ? productRecords : favoriteRecords;
    return {
      doc(id) {
        return createDocument(records, id);
      },
      where(condition) {
        return createQuery(records, condition);
      }
    };
  }

  const database = {
    collection,
    serverDate() {
      return new Date('2026-07-18T10:00:00.000Z');
    },
    async runTransaction(callback) {
      return {
        result: await callback({ collection })
      };
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return {
        OPENID: currentOpenId,
        APPID: 'test-app'
      };
    }
  };

  const baseProduct = {
    title: '收藏测试商品',
    description: '用于隔离测试',
    price: 12,
    categoryId: 'life',
    categoryName: '生活',
    condition: '九成新',
    images: [],
    coverImage: '',
    coverLabel: '收藏',
    coverTone: 'mint',
    location: '图书馆',
    campus: '示例大学',
    distanceText: '校内面交',
    sellerId: 'u_seller',
    sellerName: '卖家',
    sellerAvatar: '',
    sellerVerified: false,
    tags: [],
    viewCount: 3,
    createdAt: new Date('2026-07-18T08:00:00.000Z')
  };
  productRecords.set('product-available', {
    _id: 'product-available',
    ...baseProduct,
    sellerOpenid: 'seller-openid',
    status: 'available'
  });
  productRecords.set('product-own', {
    _id: 'product-own',
    ...baseProduct,
    sellerOpenid: 'owner-openid',
    status: 'available',
    favoriteCount: 0
  });
  ['reserved', 'offline', 'sold', 'deleted'].forEach((status) => {
    productRecords.set(`product-${status}`, {
      _id: `product-${status}`,
      ...baseProduct,
      sellerOpenid: 'seller-openid',
      status,
      favoriteCount: 0
    });
  });

  Module._load = function(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(functionPath)];

  try {
    const favoriteFunction = require(functionPath);
    const initialStatus = await favoriteFunction.main({
      action: 'getFavoriteStatus',
      data: { productId: 'product-available' }
    });
    assert(
      initialStatus.success === true && initialStatus.data.isFavorited === false,
      'missing favorite relation was treated as a database error'
    );

    const added = await favoriteFunction.main({
      action: 'addFavorite',
      data: { productId: 'product-available', userOpenid: 'forged' }
    });
    assert(added.success === true && added.data.favoriteCount === 1, 'first favorite did not increment once');
    assert(productRecords.get('product-available').favoriteCount === 1, 'favoriteCount was not persisted');
    assert(favoriteRecords.size === 1, 'favorite relation was not created');
    assert(
      [...favoriteRecords.values()][0].userOpenid === currentOpenId,
      'favorite relation trusted a forged identity'
    );

    const repeated = await favoriteFunction.main({
      action: 'addFavorite',
      data: { productId: 'product-available' }
    });
    assert(repeated.success === true && repeated.data.favoriteCount === 1, 'repeat favorite was not idempotent');
    assert(productRecords.get('product-available').favoriteCount === 1, 'repeat favorite incremented the count');
    assert(favoriteRecords.size === 1, 'repeat favorite created another relation');

    const status = await favoriteFunction.main({
      action: 'getFavoriteStatus',
      data: { productId: 'product-available' }
    });
    assert(status.success === true && status.data.isFavorited === true, 'favorite status is incorrect');

    const own = await favoriteFunction.main({
      action: 'addFavorite',
      data: { productId: 'product-own' }
    });
    assert(own.success === false && own.code === 'CANNOT_FAVORITE_OWN_PRODUCT', 'own product can be favorited');
    for (const unavailableStatus of ['reserved', 'offline', 'sold']) {
      const unavailable = await favoriteFunction.main({
        action: 'addFavorite',
        data: { productId: `product-${unavailableStatus}` }
      });
      assert(
        unavailable.success === false && unavailable.code === 'PRODUCT_NOT_FAVORITABLE',
        `${unavailableStatus} product can be newly favorited`
      );
    }
    const deleted = await favoriteFunction.main({
      action: 'addFavorite',
      data: { productId: 'product-deleted' }
    });
    assert(deleted.success === false && deleted.code === 'PRODUCT_NOT_FOUND', 'deleted product can be favorited');
    const missing = await favoriteFunction.main({
      action: 'getFavoriteStatus',
      data: { productId: 'product-missing' }
    });
    assert(missing.success === false && missing.code === 'PRODUCT_NOT_FOUND', 'missing product status leaks a database error');

    const removed = await favoriteFunction.main({
      action: 'removeFavorite',
      data: { productId: 'product-available' }
    });
    assert(removed.success === true && removed.data.favoriteCount === 0, 'remove favorite did not decrement');
    const repeatedRemove = await favoriteFunction.main({
      action: 'removeFavorite',
      data: { productId: 'product-available' }
    });
    assert(repeatedRemove.success === true && repeatedRemove.data.favoriteCount === 0, 'repeat remove was not idempotent');
    assert(productRecords.get('product-available').favoriteCount === 0, 'favoriteCount became negative');

    const databaseReadError = new Error('document.get:fail database request failed');
    databaseReadError.errCode = -1;
    databaseReadError.errMsg = databaseReadError.message;
    forcedFavoriteReadError = databaseReadError;
    const originalConsoleError = console.error;
    let failureDiagnostic = null;
    console.error = (label, diagnostic) => {
      if (label === '[favoriteProduct] request failed') {
        failureDiagnostic = diagnostic;
      }
    };
    let failedRead;
    try {
      failedRead = await favoriteFunction.main({
        action: 'addFavorite',
        data: { productId: 'product-available' }
      });
    } finally {
      console.error = originalConsoleError;
      forcedFavoriteReadError = null;
    }
    assert(
      failedRead.success === false && failedRead.code === 'DATABASE_ERROR',
      'a real favorite relation read failure was swallowed'
    );
    assert(favoriteRecords.size === 0, 'failed relation read created a favorite');
    assert(
      productRecords.get('product-available').favoriteCount === 0,
      'failed relation read changed favoriteCount'
    );
    assert(
      failureDiagnostic
      && failureDiagnostic.step === 'add.read_relation'
      && failureDiagnostic.reason === 'database_read_failed',
      'real relation read failure does not emit a safe diagnostic category'
    );

    const concurrent = await Promise.all([
      favoriteFunction.main({
        action: 'addFavorite',
        data: { productId: 'product-available' }
      }),
      favoriteFunction.main({
        action: 'addFavorite',
        data: { productId: 'product-available' }
      })
    ]);
    assert(concurrent.every((result) => result.success), 'concurrent favorite failed');
    assert(productRecords.get('product-available').favoriteCount === 1, 'concurrent favorite incremented more than once');

    favoriteRecords.set('manual-offline', {
      _id: 'manual-offline',
      userOpenid: currentOpenId,
      productId: 'product-offline',
      createdAt: new Date('2026-07-18T09:30:00.000Z')
    });
    favoriteRecords.set('manual-reserved', {
      _id: 'manual-reserved',
      userOpenid: currentOpenId,
      productId: 'product-reserved',
      createdAt: new Date('2026-07-18T09:40:00.000Z')
    });
    favoriteRecords.set('manual-sold', {
      _id: 'manual-sold',
      userOpenid: currentOpenId,
      productId: 'product-sold',
      createdAt: new Date('2026-07-18T09:20:00.000Z')
    });
    favoriteRecords.set('manual-deleted', {
      _id: 'manual-deleted',
      userOpenid: currentOpenId,
      productId: 'product-deleted',
      createdAt: new Date('2026-07-18T09:10:00.000Z')
    });
    const list = await favoriteFunction.main({
      action: 'listMyFavorites',
      data: { page: 1, pageSize: 20 }
    });
    assert(list.success === true, 'favorite list failed');
    assert(list.data.list.some((item) => item.status === 'reserved'), 'reserved favorite is not displayed');
    assert(list.data.list.some((item) => item.status === 'offline'), 'offline favorite is not displayed');
    assert(list.data.list.some((item) => item.status === 'sold'), 'sold favorite is not displayed');
    assert(!list.data.list.some((item) => item.status === 'deleted'), 'deleted favorite is displayed');
    assert(
      list.data.list.every((item) => !Object.prototype.hasOwnProperty.call(item, 'sellerOpenid')),
      'favorite list leaked sellerOpenid'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function verifyUserQueryFunctionFlow() {
  const functionPath = path.join(root, 'cloudfunctions/userQuery/index.js');
  const originalLoad = Module._load;
  const userRecords = new Map();
  const productRecords = new Map();

  function matches(record, condition) {
    return Object.entries(condition).every(([key, value]) => {
      if (value && Array.isArray(value.$in)) {
        return value.$in.includes(record[key]);
      }
      return record[key] === value;
    });
  }

  function createQuery(records, condition) {
    let offset = 0;
    let limit = 100;
    const orders = [];
    const query = {
      orderBy(field, direction) {
        orders.push({ field, direction });
        return query;
      },
      skip(value) {
        offset = value;
        return query;
      },
      limit(value) {
        limit = value;
        return query;
      },
      async count() {
        return { total: [...records.values()].filter((record) => matches(record, condition)).length };
      },
      async get() {
        const data = [...records.values()]
          .filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const order of orders) {
              const leftValue = left[order.field] instanceof Date ? left[order.field].getTime() : left[order.field];
              const rightValue = right[order.field] instanceof Date ? right[order.field].getTime() : right[order.field];
              if (leftValue === rightValue) {
                continue;
              }
              const compared = leftValue < rightValue ? -1 : 1;
              return order.direction === 'desc' ? -compared : compared;
            }
            return 0;
          })
          .slice(offset, offset + limit)
          .map((record) => ({ ...record }));
        return { data };
      }
    };
    return query;
  }

  const database = {
    command: {
      in(value) {
        return { $in: value };
      }
    },
    collection(name) {
      const records = name === 'users' ? userRecords : productRecords;
      return {
        where(condition) {
          return createQuery(records, condition);
        }
      };
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database() {
      return database;
    }
  };

  const publicUserId = 'u_1234567890abcdef1234567890abcdef';
  userRecords.set(publicUserId, {
    _id: publicUserId,
    openid: 'private-user-openid',
    nickname: '',
    avatarUrl: '',
    campus: '',
    bio: '',
    role: 'admin',
    status: 'active',
    lastLoginAt: new Date(),
    createdAt: new Date('2025-09-01T00:00:00.000Z')
  });
  ['available', 'reserved', 'offline', 'sold', 'deleted'].forEach((status, index) => {
    productRecords.set(`public-${status}`, {
      _id: `public-${status}`,
      title: `${status} 商品`,
      description: '公开商品测试',
      price: index + 1,
      categoryId: 'life',
      categoryName: '生活',
      condition: '九成新',
      images: [],
      coverImage: '',
      coverLabel: '商品',
      coverTone: 'mint',
      location: '图书馆',
      campus: '示例大学',
      distanceText: '校内面交',
      sellerId: publicUserId,
      sellerOpenid: 'private-user-openid',
      sellerName: '卖家',
      sellerAvatar: '',
      sellerVerified: false,
      tags: [],
      status,
      favoriteCount: undefined,
      viewCount: 0,
      createdAt: new Date(`2026-07-${18 - index}T08:00:00.000Z`)
    });
  });

  Module._load = function(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(functionPath)];

  try {
    const userQuery = require(functionPath);
    const profile = await userQuery.main({
      action: 'publicProfile',
      data: { publicUserId }
    });
    assert(profile.success === true, 'public profile query failed');
    assert(profile.data.profile.nickname === '即出用户', 'public profile default nickname is missing');
    assert(profile.data.profile.activeProductCount === 2, 'public active product count is incorrect');
    ['openid', 'role', 'status', 'lastLoginAt'].forEach((field) => {
      assert(
        !Object.prototype.hasOwnProperty.call(profile.data.profile, field),
        `public profile leaked ${field}`
      );
    });

    const productsResult = await userQuery.main({
      action: 'publicProducts',
      data: { publicUserId, page: 1, pageSize: 6 }
    });
    assert(productsResult.success === true, 'public products query failed');
    assert(
      productsResult.data.list.length === 2
      && productsResult.data.list.some((item) => item.status === 'available')
      && productsResult.data.list.some((item) => item.status === 'reserved'),
      'public products do not expose exactly available and reserved statuses'
    );
    assert(productsResult.data.list[0].favoriteCount === 0, 'missing favoriteCount is not normalized');
    assert(
      !Object.prototype.hasOwnProperty.call(productsResult.data.list[0], 'sellerOpenid'),
      'public products leaked sellerOpenid'
    );

    const missing = await userQuery.main({
      action: 'publicProfile',
      data: {
        publicUserId: 'u_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }
    });
    assert(missing.success === false && missing.code === 'USER_NOT_FOUND', 'missing public user leaks an internal error');
    const invalid = await userQuery.main({
      action: 'publicProfile',
      data: { publicUserId: 'private-user-openid' }
    });
    assert(invalid.success === false && invalid.code === 'INVALID_PARAMS', 'unsafe public user id is accepted');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function verifyCloudServiceFlow() {
  const servicePath = path.join(root, 'services/cloud-service.js');
  const configPath = path.join(root, 'config/cloud.js');
  const {
    CLOUD_CONFIG,
    PUBLIC_ENVIRONMENT_ID
  } = require(configPath);
  const originalWx = global.wx;
  const originalEnvironmentId = CLOUD_CONFIG.environmentId;
  const originalEnvironmentSource = CLOUD_CONFIG.environmentSource;
  let initCalls = 0;
  let initOptions = null;
  let shouldFailInit = true;
  let callMode = 'success';

  global.wx = {
    cloud: {
      init(options) {
        initCalls += 1;
        initOptions = options;
        if (shouldFailInit) {
          shouldFailInit = false;
          throw {
            errCode: 'INIT_FAILURE',
            errMsg: 'init failed'
          };
        }
      },
      callFunction(options) {
        if (callMode === 'functionNotFound') {
          options.fail({
            errCode: -501000,
            errMsg: 'cloud.callFunction:fail function not found'
          });
          return;
        }
        if (callMode === 'network') {
          options.fail({
            errCode: 'NETWORK',
            errMsg: 'request:fail network error'
          });
          return;
        }
        if (callMode === 'timeout') {
          return;
        }
        options.success({
          result: {
            success: true
          }
        });
      }
    }
  };
  CLOUD_CONFIG.environmentId = 'verification-cloud-environment';
  CLOUD_CONFIG.environmentSource = 'verification';
  delete require.cache[require.resolve(servicePath)];

  try {
    const CloudService = require(servicePath);
    CLOUD_CONFIG.environmentId = PUBLIC_ENVIRONMENT_ID;
    let missingConfigError;
    try {
      await CloudService.ensureCloudReady();
    } catch (error) {
      missingConfigError = error;
    }
    assert(
      missingConfigError
      && missingConfigError.code === 'CLOUD_CONFIG_MISSING'
      && initCalls === 0,
      'missing private cloud configuration is not rejected clearly'
    );
    CLOUD_CONFIG.environmentId = 'verification-cloud-environment';

    let initError;
    try {
      await CloudService.ensureCloudReady();
    } catch (error) {
      initError = error;
    }
    assert(
      initError && initError.code === 'CLOUD_INIT_FAILED',
      'cloud init failure is not classified separately'
    );

    const firstRetry = CloudService.ensureCloudReady();
    const concurrentRetry = CloudService.ensureCloudReady();
    assert(
      firstRetry === concurrentRetry,
      'concurrent cloud initialization does not share one promise'
    );
    await firstRetry;
    assert(initCalls === 2, 'failed cloud initialization cannot be retried safely');
    assert(
      initOptions
      && initOptions.env === 'verification-cloud-environment'
      && initOptions.traceUser === true,
      'cloud initialization uses the wrong environment'
    );
    await CloudService.ensureCloudReady();
    assert(initCalls === 2, 'ready cloud state initializes more than once');

    callMode = 'functionNotFound';
    let functionError;
    try {
      await CloudService.callFunction({
        name: 'missingFunction',
        data: {},
        timeoutMs: 20
      });
    } catch (error) {
      functionError = error;
    }
    assert(
      functionError && functionError.code === 'FUNCTION_NOT_FOUND',
      'function-not-found is not classified separately'
    );

    callMode = 'network';
    let networkError;
    try {
      await CloudService.callFunction({
        name: 'messageAction',
        data: {},
        timeoutMs: 20
      });
    } catch (error) {
      networkError = error;
    }
    assert(
      networkError && networkError.code === 'NETWORK_ERROR',
      'network failure is not classified separately'
    );

    callMode = 'timeout';
    let timeoutError;
    try {
      await CloudService.callFunction({
        name: 'messageAction',
        data: {},
        timeoutMs: 5
      });
    } catch (error) {
      timeoutError = error;
    }
    assert(
      timeoutError && timeoutError.code === 'CLOUD_TIMEOUT',
      'cloud timeout is not classified separately'
    );
  } finally {
    CLOUD_CONFIG.environmentId = originalEnvironmentId;
    CLOUD_CONFIG.environmentSource = originalEnvironmentSource;
    delete require.cache[require.resolve(servicePath)];
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyMessageServiceFlow() {
  const servicePath = path.join(root, 'services/message-service');
  const cloudServicePath = path.join(root, 'services/cloud-service');
  const originalWx = global.wx;
  const requests = [];
  let responseFailureCode = '';
  const conversationId = `c_${'a'.repeat(64)}`;
  const messageId = `m_${'b'.repeat(64)}`;
  const publicUserId = `u_${'c'.repeat(32)}`;
  const now = '2026-07-19T10:00:00.000Z';
  const safeConversation = {
    conversationId,
    otherUser: {
      publicUserId,
      nickname: '卖家',
      avatarUrl: '',
      campus: '即出大学'
    },
    product: {
      productId: 'product-message',
      title: '测试商品',
      coverImage: '',
      price: 12,
      status: 'available'
    },
    lastMessage: '你好',
    lastMessageType: 'text',
    lastMessageAt: now,
    unreadCount: 1,
    canSend: true
  };
  const safeMessage = {
    messageId,
    senderPublicUserId: publicUserId,
    isMine: true,
    type: 'text',
    content: '你好',
    createdAt: now
  };

  global.wx = {
    cloud: {
      init() {},
      callFunction(options) {
        requests.push({
          name: options.name,
          data: JSON.parse(JSON.stringify(options.data))
        });
        const action = options.data.action;
        let data;
        if (action === 'createOrGetConversation') {
          data = { conversationId, reused: false };
        } else if (action === 'listConversations') {
          data = {
            list: [safeConversation],
            hasMore: false,
            nextCursor: null
          };
        } else if (action === 'getConversation') {
          data = { conversation: safeConversation };
        } else if (action === 'listMessages') {
          data = {
            list: [safeMessage],
            hasMore: false,
            nextCursor: null
          };
        } else if (action === 'listConversationProducts') {
          const queryData = options.data.data || {};
          data = {
            ownerScope: queryData.ownerScope,
            owner: safeConversation.otherUser,
            list: [{
              productId: 'product-shared',
              title: '可分享商品',
              coverImage: '',
              price: 23,
              status: 'available',
              ownerPublicUserId: publicUserId,
              ownerScope: queryData.ownerScope
            }],
            hasMore: false,
            nextCursor: null
          };
        } else if (action === 'sendTextMessage') {
          data = { message: safeMessage, reused: false };
        } else if (action === 'sendMessage') {
          const type = options.data.type;
          const richMessage = {
            messageId: `m_${({
              voice: 'd',
              image: 'e',
              location: 'f',
              product: '1'
            })[type].repeat(64)}`,
            senderPublicUserId: publicUserId,
            isMine: true,
            type,
            createdAt: now
          };
          if (type === 'voice' || type === 'image') {
            richMessage.media = options.data.media;
          } else if (type === 'location') {
            richMessage.location = options.data.location;
          } else {
            richMessage.product = {
              productId: options.data.productId,
              title: '可分享商品',
              coverImage: '',
              price: 23,
              status: 'available',
              ownerPublicUserId: publicUserId
            };
          }
          data = { message: richMessage, reused: false };
        } else {
          data = { conversationId, unreadCount: 0 };
        }
        options.success({
          result: {
            success: !responseFailureCode,
            code: responseFailureCode || 'OK',
            message: responseFailureCode
              ? '业务状态不允许'
              : '',
            data: responseFailureCode ? null : data
          }
        });
      }
    }
  };

  try {
    delete require.cache[require.resolve(cloudServicePath)];
    delete require.cache[require.resolve(servicePath)];
    const MessageService = require(servicePath);
    const created = await MessageService.createOrGetConversation(
      'product-message'
    );
    assert(created.conversationId === conversationId, 'MessageService rejected a safe conversation id');
    assert(
      Object.keys(requests[0].data).join(',') === 'action,productId',
      'createOrGetConversation sends fields other than action and productId'
    );
    assert(
      requests[0].name === 'messageAction'
      && requests[0].data.action === 'createOrGetConversation',
      'createOrGetConversation does not call messageAction'
    );

    const conversationsResult = await MessageService.listConversations();
    assert(conversationsResult.list.length === 1, 'MessageService did not normalize the conversation list');
    assert(conversationsResult.list[0].unreadCount === 1, 'MessageService lost the unread count');
    const conversation = await MessageService.getConversation(conversationId);
    assert(conversation.otherUser.publicUserId === publicUserId, 'MessageService lost the safe other-user id');
    const messagesResult = await MessageService.listMessages(conversationId);
    assert(messagesResult.list[0].messageId === messageId, 'MessageService did not normalize message history');

    const clientMessageId = 'msg_verification_0001';
    const sent = await MessageService.sendTextMessage({
      conversationId,
      content: '  你好  ',
      clientMessageId
    });
    assert(sent.message.content === '你好', 'MessageService did not trim outgoing text');
    const sendRequest = requests.find((request) => (
      request.data.action === 'sendTextMessage'
    ));
    assert(
      sendRequest.data.clientMessageId === clientMessageId,
      'MessageService dropped the message idempotency key'
    );

    const selectableProducts = await MessageService.listConversationProducts(
      conversationId,
      {
        ownerScope: 'other',
        pageSize: 8
      }
    );
    assert(
      selectableProducts.list.length === 1
      && selectableProducts.list[0].ownerScope === 'other'
      && selectableProducts.list[0].ownerPublicUserId === publicUserId,
      'MessageService did not normalize controlled conversation products'
    );
    const voiceFileId = 'cloud://verification-env/chat-media/voice/file.mp3';
    const voiceSent = await MessageService.sendVoiceMessage({
      conversationId,
      clientMessageId: 'msg_service_voice_0001',
      media: {
        fileId: voiceFileId,
        durationMs: 2500,
        size: 12000,
        format: 'mp3'
      }
    });
    assert(
      voiceSent.message.type === 'voice'
      && voiceSent.message.media.durationText === '3″',
      'MessageService did not normalize a voice message'
    );
    const imageSent = await MessageService.sendImageMessage({
      conversationId,
      clientMessageId: 'msg_service_image_0001',
      media: {
        fileId: 'cloud://verification-env/chat-media/image/file.jpg',
        width: 1200,
        height: 800,
        size: 230000
      }
    });
    assert(
      imageSent.message.type === 'image'
      && imageSent.message.media.displayMode === 'landscape',
      'MessageService did not normalize an image message'
    );
    const locationSent = await MessageService.sendLocationMessage({
      conversationId,
      clientMessageId: 'msg_service_location_0001',
      location: {
        name: '教学楼',
        address: '即出大学一号教学楼',
        latitude: 31.2,
        longitude: 121.4
      }
    });
    assert(
      locationSent.message.location.name === '教学楼',
      'MessageService did not normalize a location message'
    );
    const productSent = await MessageService.sendProductMessage({
      conversationId,
      clientMessageId: 'msg_service_product_0001',
      productId: 'product-shared',
      title: '客户端伪造标题'
    });
    assert(
      productSent.message.product.title === '可分享商品',
      'MessageService did not preserve the server product snapshot'
    );
    const richRequests = requests.filter(
      (request) => request.data.action === 'sendMessage'
    );
    assert(
      richRequests.length === 4
      && richRequests.every(
        (request) => !('senderPublicUserId' in request.data)
          && !('createdAt' in request.data)
          && !('product' in request.data)
      ),
      'MessageService sends protected identity, time, or product snapshot fields'
    );
    const unsupported = MessageService.normalizeMessage({
      messageId: `m_${'9'.repeat(64)}`,
      senderPublicUserId: publicUserId,
      isMine: false,
      type: 'future-message',
      createdAt: now
    });
    assert(
      unsupported.type === 'unsupported'
      && /不支持/.test(unsupported.content),
      'MessageService does not safely downgrade unknown message types'
    );
    const corruptRichMessage = MessageService.normalizeMessage({
      messageId: `m_${'8'.repeat(64)}`,
      senderPublicUserId: publicUserId,
      isMine: false,
      type: 'voice',
      media: {
        fileId: ''
      },
      createdAt: now
    });
    assert(
      corruptRichMessage.type === 'unsupported'
      && /不支持/.test(corruptRichMessage.content),
      'a corrupt rich message breaks the whole message page'
    );
    const richRequestCount = requests.length;
    let invalidLocationError;
    try {
      await MessageService.sendLocationMessage({
        conversationId,
        clientMessageId: 'msg_service_location_bad',
        location: {
          name: '错误地点',
          address: '错误坐标',
          latitude: 91,
          longitude: 181
        }
      });
    } catch (error) {
      invalidLocationError = error;
    }
    assert(
      invalidLocationError
      && invalidLocationError.code === 'INVALID_LOCATION'
      && requests.length === richRequestCount,
      'invalid location is sent to the cloud or uses an unstable error code'
    );
    assert(
      !/openid|seller/i.test(JSON.stringify(requests)),
      'MessageService sent an internal identity field'
    );

    const requestCount = requests.length;
    let emptyError = null;
    try {
      await MessageService.sendTextMessage({
        conversationId,
        content: '   ',
        clientMessageId: 'msg_verification_0002'
      });
    } catch (error) {
      emptyError = error;
    }
    assert(emptyError && emptyError.code === 'MESSAGE_EMPTY', 'MessageService accepts empty text');
    assert(requests.length === requestCount, 'MessageService sent an invalid empty message request');
    await MessageService.markConversationRead(conversationId);

    responseFailureCode = 'PRODUCT_UNAVAILABLE';
    let businessError;
    try {
      await MessageService.createOrGetConversation('product-message');
    } catch (error) {
      businessError = error;
    }
    assert(
      businessError && businessError.code === 'PRODUCT_UNAVAILABLE',
      'MessageService does not preserve cloud business error codes'
    );
  } finally {
    delete require.cache[require.resolve(servicePath)];
    delete require.cache[require.resolve(cloudServicePath)];
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyChatMediaServiceFlow() {
  const mediaServicePath = path.join(root, 'services/chat-media-service');
  const cloudServicePath = path.join(root, 'services/cloud-service');
  const { CLOUD_CONFIG } = require(path.join(root, 'config/cloud'));
  const originalWx = global.wx;
  const originalEnvironmentId = CLOUD_CONFIG.environmentId;
  const originalEnvironmentSource = CLOUD_CONFIG.environmentSource;
  const conversationId = `c_${'7'.repeat(64)}`;
  const userId = `u_${'8'.repeat(32)}`;
  const clientMessageId = 'msg_media_service_0001';
  const selectedOptions = [];
  const uploads = [];
  const deletedFiles = [];

  CLOUD_CONFIG.environmentId = 'verification-env';
  CLOUD_CONFIG.environmentSource = 'verification';
  global.wx = {
    getFileSystemManager() {
      return {
        getFileInfo(options) {
          setImmediate(() => options.success({ size: 32000 }));
        }
      };
    },
    getImageInfo(options) {
      setImmediate(() => options.success({
        width: 1200,
        height: 800
      }));
    },
    chooseMedia(options) {
      selectedOptions.push({
        mediaType: options.mediaType,
        sourceType: options.sourceType,
        count: options.count
      });
      setImmediate(() => options.success({
        tempFiles: [{
          tempFilePath: 'temp/verification.jpg'
        }]
      }));
    },
    cloud: {
      init() {},
      uploadFile(options) {
        uploads.push({
          cloudPath: options.cloudPath,
          filePath: options.filePath
        });
        setImmediate(() => options.success({
          fileID: `cloud://verification-env/${options.cloudPath}`
        }));
        return {
          onProgressUpdate(callback) {
            setImmediate(() => callback({ progress: 73 }));
          },
          abort() {}
        };
      },
      deleteFile(options) {
        deletedFiles.push(...options.fileList);
        setImmediate(() => options.success({ fileList: [] }));
      },
      getTempFileURL(options) {
        setImmediate(() => options.success({
          fileList: [{
            fileID: options.fileList[0],
            status: 0,
            tempFileURL: 'https://verification.invalid/chat-media'
          }]
        }));
      }
    }
  };

  try {
    delete require.cache[require.resolve(mediaServicePath)];
    delete require.cache[require.resolve(cloudServicePath)];
    const ChatMediaService = require(mediaServicePath);
    const selected = await ChatMediaService.chooseImages({
      sourceType: 'album',
      count: 9
    });
    assert(
      selected.length === 1
      && selectedOptions[0].mediaType.length === 1
      && selectedOptions[0].mediaType[0] === 'image'
      && selectedOptions[0].sourceType[0] === 'album',
      'chat media chooser is not restricted to album images'
    );
    const prepared = await ChatMediaService.prepareImages(selected);
    assert(
      prepared[0].width === 1200
      && prepared[0].height === 800
      && prepared[0].size === 32000,
      'chat media image metadata validation failed'
    );
    const progressValues = [];
    const fileId = await ChatMediaService.uploadFile({
      type: 'image',
      conversationId,
      userId,
      clientMessageId,
      localTempPath: prepared[0].localTempPath,
      onProgress(progress) {
        progressValues.push(progress);
      }
    });
    const expectedPath = [
      'chat-media',
      'image',
      conversationId,
      userId
    ].join('/');
    assert(
      uploads.length === 1
      && uploads[0].cloudPath.startsWith(`${expectedPath}/`)
      && uploads[0].cloudPath.endsWith(`/${clientMessageId}.jpg`)
      && fileId === `cloud://verification-env/${uploads[0].cloudPath}`,
      'chat media upload path is not conversation/user/message scoped'
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert(progressValues.includes(73), 'chat media upload progress is not forwarded');
    const temporaryUrl = await ChatMediaService.resolveTemporaryUrl(fileId);
    assert(
      temporaryUrl === 'https://verification.invalid/chat-media',
      'chat media temporary URL resolution failed'
    );
    global.wx.cloud.getTempFileURL = (options) => {
      setImmediate(() => options.success({
        fileList: [{
          fileID: options.fileList[0],
          status: 0,
          tempFileURL: 'http://verification.invalid/insecure-media'
        }]
      }));
    };
    let insecureTemporaryUrlError;
    try {
      await ChatMediaService.resolveTemporaryUrl(fileId);
    } catch (error) {
      insecureTemporaryUrlError = error;
    }
    assert(
      insecureTemporaryUrlError
      && insecureTemporaryUrlError.code === 'UNKNOWN_ERROR',
      'chat media accepts a non-HTTPS temporary URL'
    );
    const deleted = await ChatMediaService.deleteUploadedFile(fileId);
    assert(
      deleted === true && deletedFiles[0] === fileId,
      'chat media orphan cleanup did not target the uploaded file'
    );
    const cleanupWarnings = [];
    const originalConsoleWarn = console.warn;
    global.wx.getAccountInfoSync = () => ({
      miniProgram: {
        envVersion: 'develop'
      }
    });
    global.wx.cloud.deleteFile = (options) => {
      setImmediate(() => options.fail({
        code: 'DELETE_FAILED',
        errMsg: `must-not-log ${fileId}`
      }));
    };
    console.warn = (...args) => cleanupWarnings.push(args);
    let failedCleanup;
    try {
      failedCleanup = await ChatMediaService.deleteUploadedFile(fileId);
    } finally {
      console.warn = originalConsoleWarn;
    }
    const cleanupLog = JSON.stringify(cleanupWarnings);
    assert(
      failedCleanup === false
      && cleanupLog.includes('DELETE_FAILED')
      && !cleanupLog.includes(fileId)
      && !cleanupLog.includes('must-not-log'),
      'orphan cleanup failure is silent or logs a sensitive file id'
    );

    global.wx.chooseMedia = (options) => {
      setImmediate(() => options.fail({ errMsg: 'chooseMedia:fail cancel' }));
    };
    const cancelled = await ChatMediaService.chooseImages({
      sourceType: 'camera',
      count: 1
    });
    assert(cancelled.length === 0, 'media picker cancellation is treated as an error');

    let invalidPathError;
    try {
      await ChatMediaService.uploadFile({
        type: 'voice',
        conversationId,
        userId: 'forged-user',
        clientMessageId,
        localTempPath: 'temp/verification.mp3'
      });
    } catch (error) {
      invalidPathError = error;
    }
    assert(
      invalidPathError && invalidPathError.code === 'INVALID_ARGUMENT',
      'chat media accepts an invalid user-scoped path'
    );
    assert(
      ChatMediaService.shouldRetainUploadedFile({
        code: 'CLOUD_TIMEOUT'
      })
      && !ChatMediaService.shouldRetainUploadedFile({
        code: 'INVALID_MEDIA'
      }),
      'chat media cleanup cannot distinguish ambiguous send outcomes'
    );
  } finally {
    CLOUD_CONFIG.environmentId = originalEnvironmentId;
    CLOUD_CONFIG.environmentSource = originalEnvironmentSource;
    delete require.cache[require.resolve(mediaServicePath)];
    delete require.cache[require.resolve(cloudServicePath)];
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyChatAudioPageFlow() {
  const pagePath = path.join(root, 'pages/chat/index.js');
  const mediaServicePath = path.join(root, 'services/chat-media-service');
  const originalWx = global.wx;
  const originalPage = global.Page;
  const ChatMediaService = require(mediaServicePath);
  const originalResolveTemporaryUrl = ChatMediaService.resolveTemporaryUrl;
  const audioInstances = [];
  const toasts = [];
  let pageDefinition;
  let resolveAttempts = 0;

  function createAudioInstance() {
    const handlers = {};
    const instance = {
      autoplay: true,
      obeyMuteSwitch: true,
      playCalls: 0,
      stopCalls: 0,
      destroyCalls: 0,
      source: '',
      set src(value) {
        this.source = value;
      },
      get src() {
        return this.source;
      },
      onCanplay(callback) {
        handlers.canplay = callback;
      },
      onPlay(callback) {
        handlers.play = callback;
      },
      onEnded(callback) {
        handlers.ended = callback;
      },
      onStop(callback) {
        handlers.stop = callback;
      },
      onError(callback) {
        handlers.error = callback;
      },
      play() {
        this.playCalls += 1;
        if (handlers.play) {
          handlers.play();
        }
      },
      stop() {
        this.stopCalls += 1;
        if (handlers.stop) {
          handlers.stop();
        }
      },
      destroy() {
        this.destroyCalls += 1;
      },
      triggerCanplay() {
        if (handlers.canplay) {
          handlers.canplay();
        }
      },
      triggerEnded() {
        if (handlers.ended) {
          handlers.ended();
        }
      },
      triggerError(error) {
        if (handlers.error) {
          handlers.error(error);
        }
      }
    };
    audioInstances.push(instance);
    return instance;
  }

  global.wx = {
    createInnerAudioContext: createAudioInstance,
    showToast(options) {
      toasts.push(options && options.title);
    },
    getAccountInfoSync() {
      return {
        miniProgram: {
          envVersion: 'release'
        }
      };
    },
    getDeviceInfo() {
      return {
        platform: 'ios'
      };
    }
  };
  global.Page = (definition) => {
    pageDefinition = definition;
  };
  ChatMediaService.resolveTemporaryUrl = async () => {
    resolveAttempts += 1;
    if (resolveAttempts === 1) {
      const error = new Error('temporary URL unavailable');
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    return 'https://verification.invalid/voice.mp3';
  };

  try {
    delete require.cache[require.resolve(pagePath)];
    require(pagePath);
    assert(pageDefinition, 'chat page definition was not captured');
    const messages = [
      {
        messageId: 'voice-message-1',
        clientMessageId: 'voice-client-1',
        type: 'voice',
        media: {
          fileId: 'cloud://verification-env/chat-media/voice/one.mp3'
        }
      },
      {
        messageId: 'voice-message-2',
        clientMessageId: 'voice-client-2',
        type: 'voice',
        media: {
          fileId: 'cloud://verification-env/chat-media/voice/two.mp3'
        }
      },
      { messageId: 'image-message', type: 'image' },
      { messageId: 'location-message', type: 'location' },
      { messageId: 'product-message', type: 'product' },
      { messageId: 'text-message', type: 'text' },
      { messageId: 'unknown-message', type: 'unsupported' }
    ];
    const page = {
      ...pageDefinition,
      data: {
        ...pageDefinition.data,
        messages,
        isRecording: false,
        isPreparingRecording: false,
        playingVoiceMessageId: ''
      },
      isPageActive: true,
      setData(changes) {
        Object.assign(this.data, changes);
      }
    };
    const tapEvent = (messageId) => ({
      currentTarget: {
        dataset: {
          messageId
        }
      }
    });
    page.initializeAudioPlayer();

    for (const messageId of [
      'image-message',
      'location-message',
      'product-message',
      'text-message',
      'unknown-message'
    ]) {
      await page.onVoiceMessageTap(tapEvent(messageId));
    }
    assert(
      audioInstances.length === 0 && toasts.length === 0,
      'non-voice messages enter playback or show a voice failure'
    );

    await page.onVoiceMessageTap(tapEvent('voice-message-1'));
    assert(
      audioInstances.length === 0
      && toasts.length === 1
      && toasts[0] === '语音播放失败',
      'temporary URL failure is not isolated to the selected voice message'
    );
    await page.onVoiceMessageTap(tapEvent('image-message'));
    assert(
      toasts.length === 1,
      'a non-voice click shows a voice playback failure after URL resolution failed'
    );

    await page.onVoiceMessageTap(tapEvent('voice-message-1'));
    const firstAudio = audioInstances[0];
    assert(
      firstAudio
      && firstAudio.source.startsWith('https://')
      && firstAudio.playCalls === 0
      && firstAudio.autoplay === false
      && firstAudio.obeyMuteSwitch === false,
      'voice playback does not wait for a playable HTTPS source'
    );
    firstAudio.triggerCanplay();
    assert(
      firstAudio.playCalls === 1
      && page.data.playingVoiceMessageId === 'voice-message-1',
      'onCanplay did not start the selected voice exactly once'
    );
    firstAudio.triggerCanplay();
    assert(firstAudio.playCalls === 1, 'repeated onCanplay starts duplicate playback');

    await page.onVoiceMessageTap(tapEvent('voice-message-2'));
    const secondAudio = audioInstances[1];
    assert(
      firstAudio.stopCalls === 1
      && firstAudio.destroyCalls >= 1
      && secondAudio
      && page.data.playingVoiceMessageId === 'voice-message-2',
      'starting a new voice does not stop and destroy the previous instance'
    );
    firstAudio.triggerError({
      errCode: 10001,
      errMsg: 'late failure https://sensitive.invalid/one.mp3'
    });
    assert(
      toasts.length === 1
      && page.data.playingVoiceMessageId === 'voice-message-2',
      'a stale audio error changes the active playback or shows a toast'
    );
    secondAudio.triggerCanplay();
    secondAudio.triggerEnded();
    assert(
      page.data.playingVoiceMessageId === ''
      && secondAudio.destroyCalls >= 1,
      'playback end does not clear state and release the current instance'
    );

    await page.onVoiceMessageTap(tapEvent('voice-message-2'));
    const thirdAudio = audioInstances[2];
    thirdAudio.triggerCanplay();
    await page.onVoiceMessageTap(tapEvent('voice-message-2'));
    assert(
      thirdAudio.stopCalls === 1
      && thirdAudio.destroyCalls >= 1
      && page.data.playingVoiceMessageId === ''
      && toasts.length === 1,
      'tapping the active voice does not stop silently'
    );

    await page.onVoiceMessageTap(tapEvent('voice-message-1'));
    const fourthAudio = audioInstances[3];
    fourthAudio.triggerError({
      errCode: 10002,
      errMsg: 'decode failed cloud://verification-env/private/path.mp3'
    });
    assert(
      toasts.length === 2
      && page.data.playingVoiceMessageId === ''
      && fourthAudio.destroyCalls >= 1,
      'current audio errors do not clean state or show one failure toast'
    );
    await page.onVoiceMessageTap(tapEvent('voice-message-1'));
    const retryAudio = audioInstances[4];
    retryAudio.triggerCanplay();
    retryAudio.triggerEnded();
    assert(
      retryAudio.playCalls === 1,
      'voice playback cannot be retried after a URL or decoder failure'
    );

    await page.onVoiceMessageTap(tapEvent('voice-message-2'));
    const unloadAudio = audioInstances[5];
    page.destroyAudioPlayer();
    assert(
      unloadAudio.stopCalls === 1
      && unloadAudio.destroyCalls >= 1
      && page.audioContext === null,
      'page cleanup does not stop and destroy the active audio instance'
    );
  } finally {
    ChatMediaService.resolveTemporaryUrl = originalResolveTemporaryUrl;
    delete require.cache[require.resolve(pagePath)];
    if (originalPage === undefined) {
      delete global.Page;
    } else {
      global.Page = originalPage;
    }
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

async function verifyMessagingFunctionFlow() {
  const crypto = require('crypto');
  const actionPath = path.join(root, 'cloudfunctions/messageAction/index.js');
  const queryPath = path.join(root, 'cloudfunctions/messageQuery/index.js');
  const originalLoad = Module._load;
  const stores = {
    users: new Map(),
    products: new Map(),
    conversations: new Map(),
    messages: new Map()
  };
  let currentOpenId = 'verification-buyer-openid';
  const appId = 'verification-appid';
  let serverTick = 0;

  function userId(openId) {
    return `u_${crypto
      .createHash('sha256')
      .update(`${appId}:${openId}`)
      .digest('hex')
      .slice(0, 32)}`;
  }

  function missingDocumentError(id) {
    const error = new Error(
      `document.get:fail document with _id ${id} does not exist`
    );
    error.code = -1;
    return error;
  }

  function cloneRecord(record) {
    return record ? { ...record } : record;
  }

  function createDocument(store, id) {
    return {
      async get() {
        if (!store.has(id)) {
          throw missingDocumentError(id);
        }
        return { data: cloneRecord(store.get(id)) };
      },
      async set({ data }) {
        store.set(id, {
          _id: id,
          ...data
        });
        return { _id: id };
      },
      async update({ data }) {
        if (!store.has(id)) {
          throw missingDocumentError(id);
        }
        store.set(id, {
          ...store.get(id),
          ...data,
          _id: id
        });
        return { updated: 1 };
      }
    };
  }

  function comparable(value) {
    return value instanceof Date ? value.getTime() : value;
  }

  function matches(record, condition) {
    if (!condition || typeof condition !== 'object') {
      return true;
    }
    if (Array.isArray(condition.$or)) {
      return condition.$or.some((item) => matches(record, item));
    }
    return Object.entries(condition).every(([key, expected]) => {
      if (key === '$or') {
        return expected.some((item) => matches(record, item));
      }
      const actual = record[key];
      if (expected && typeof expected === 'object' && expected.__op) {
        if (expected.__op === 'lt') {
          return comparable(actual) < comparable(expected.value);
        }
        if (expected.__op === 'gt') {
          return comparable(actual) > comparable(expected.value);
        }
        if (expected.__op === 'eq') {
          return comparable(actual) === comparable(expected.value);
        }
        if (expected.__op === 'in') {
          return expected.value.includes(actual);
        }
      }
      return comparable(actual) === comparable(expected);
    });
  }

  function createQuery(store, condition = null) {
    const orders = [];
    let limitValue = Number.MAX_SAFE_INTEGER;
    return {
      where(nextCondition) {
        return createQuery(store, nextCondition);
      },
      orderBy(field, direction) {
        orders.push({ field, direction });
        return this;
      },
      limit(value) {
        limitValue = value;
        return this;
      },
      async get() {
        const data = [...store.values()]
          .filter((record) => matches(record, condition))
          .sort((left, right) => {
            for (const order of orders) {
              const leftValue = comparable(left[order.field]);
              const rightValue = comparable(right[order.field]);
              if (leftValue === rightValue) {
                continue;
              }
              const compared = leftValue < rightValue ? -1 : 1;
              return order.direction === 'desc' ? -compared : compared;
            }
            return 0;
          })
          .slice(0, limitValue)
          .map(cloneRecord);
        return { data };
      }
    };
  }

  function createCollection(name) {
    const store = stores[name];
    assert(store, `unexpected messaging collection ${name}`);
    const query = createQuery(store);
    return {
      doc(id) {
        return createDocument(store, id);
      },
      where: query.where.bind(query),
      orderBy: query.orderBy.bind(query),
      limit: query.limit.bind(query),
      get: query.get.bind(query)
    };
  }

  const database = {
    command: {
      or(conditions) {
        return { $or: conditions };
      },
      lt(value) {
        return { __op: 'lt', value };
      },
      eq(value) {
        return { __op: 'eq', value };
      },
      gt(value) {
        return { __op: 'gt', value };
      },
      in(value) {
        return { __op: 'in', value };
      }
    },
    collection: createCollection,
    serverDate() {
      serverTick += 1;
      return new Date(Date.UTC(2026, 6, 19, 10, 0, serverTick));
    },
    async runTransaction(callback) {
      return {
        result: await callback({
          collection: createCollection
        })
      };
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'verification',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return {
        OPENID: currentOpenId,
        APPID: appId
      };
    }
  };

  const buyerOpenId = currentOpenId;
  const sellerOpenId = 'verification-seller-openid';
  const attackerOpenId = 'verification-attacker-openid';
  const buyerUserId = userId(buyerOpenId);
  const sellerUserId = userId(sellerOpenId);
  const attackerUserId = userId(attackerOpenId);
  [
    [buyerUserId, buyerOpenId, '买家'],
    [sellerUserId, sellerOpenId, '卖家'],
    [attackerUserId, attackerOpenId, '其他用户']
  ].forEach(([id, openid, nickname]) => {
    stores.users.set(id, {
      _id: id,
      openid,
      nickname,
      avatarUrl: '',
      campus: '即出大学',
      status: 'active'
    });
  });

  function addProduct(
    id,
    ownerOpenId,
    ownerUserId,
    status = 'available',
    options = {}
  ) {
    const product = {
      _id: id,
      title: `商品 ${id}`,
      coverImage: '',
      price: 12,
      status,
      sellerId: ownerUserId,
      sellerName: '卖家',
      sellerAvatar: '',
      createdAt: options.createdAt || new Date(
        Date.UTC(2026, 6, 18, 10, stores.products.size, 0)
      )
    };
    if (options.includeSellerOpenid !== false) {
      product.sellerOpenid = ownerOpenId;
    }
    stores.products.set(id, product);
  }
  addProduct('product-message-1', sellerOpenId, sellerUserId);
  addProduct('product-message-2', sellerOpenId, sellerUserId);
  addProduct('product-message-concurrent', sellerOpenId, sellerUserId);
  addProduct(
    'product-message-legacy',
    sellerOpenId,
    sellerUserId,
    'available',
    { includeSellerOpenid: false }
  );
  addProduct(
    'product-message-no-seller',
    '',
    '',
    'available',
    { includeSellerOpenid: false }
  );
  addProduct('product-own', buyerOpenId, buyerUserId);
  addProduct('product-third-party', attackerOpenId, attackerUserId);
  addProduct(
    'product-inconsistent-owner',
    sellerOpenId,
    attackerUserId
  );
  addProduct('product-seller-sold', sellerOpenId, sellerUserId, 'sold');
  addProduct('product-buyer-reserved', buyerOpenId, buyerUserId, 'reserved');
  addProduct('product-deleted', sellerOpenId, sellerUserId, 'deleted');
  addProduct('product-offline', sellerOpenId, sellerUserId, 'offline');
  stores.products.get('product-message-2').coverImage
    = 'cloud://verification-env/products/product-message-2/cover.jpg';

  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(actionPath)];
    delete require.cache[require.resolve(queryPath)];
    const messageAction = require(actionPath);
    const messageQuery = require(queryPath);

    currentOpenId = '';
    const loginRequired = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-message-1' }
    });
    assert(loginRequired.code === 'LOGIN_REQUIRED', 'unauthenticated conversation creation is allowed');
    const queryLoginRequired = await messageQuery.main({
      action: 'listConversations',
      data: {}
    });
    assert(queryLoginRequired.code === 'LOGIN_REQUIRED', 'unauthenticated conversation query is allowed');

    currentOpenId = buyerOpenId;
    const missing = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-missing' }
    });
    assert(missing.code === 'PRODUCT_NOT_FOUND', 'missing product can create a conversation');
    const own = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-own' }
    });
    assert(own.code === 'SELF_CONVERSATION_FORBIDDEN', 'own product can create a conversation');
    const deleted = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-deleted' }
    });
    assert(
      deleted.code === 'PRODUCT_UNAVAILABLE',
      'deleted product is conflated with a missing product'
    );
    const offline = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-offline' }
    });
    assert(offline.code === 'PRODUCT_UNAVAILABLE', 'offline product can create a new conversation');

    const created = await messageAction.main({
      action: 'createOrGetConversation',
      data: {
        productId: 'product-message-1',
        sellerOpenid: attackerOpenId
      }
    });
    assert(created.success === true, 'valid conversation creation failed');
    const conversationId = created.data.conversationId;
    assert(stores.conversations.size === 1, 'conversation was not persisted once');
    const repeated = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-message-1' }
    });
    assert(
      repeated.success === true
      && repeated.data.conversationId === conversationId
      && repeated.data.reused === true,
      'repeat conversation creation is not idempotent'
    );

    const concurrentResults = await Promise.all([
      messageAction.main({
        action: 'createOrGetConversation',
        data: { productId: 'product-message-concurrent' }
      }),
      messageAction.main({
        action: 'createOrGetConversation',
        data: { productId: 'product-message-concurrent' }
      })
    ]);
    assert(
      concurrentResults.every((result) => result.success)
      && concurrentResults[0].data.conversationId
        === concurrentResults[1].data.conversationId,
      'concurrent conversation creation does not converge on one id'
    );
    assert(stores.conversations.size === 2, 'concurrent creation produced duplicate conversations');

    const legacySeller = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-message-legacy' }
    });
    assert(
      legacySeller.success === true
      && legacySeller.code === 'OK',
      'available product cannot resolve its trusted seller user'
    );
    const unavailableSeller = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-message-no-seller' }
    });
    assert(
      unavailableSeller.code === 'PRODUCT_SELLER_UNAVAILABLE',
      'missing seller identity is reported as a missing product'
    );

    const empty = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '   ',
        clientMessageId: 'msg_verification_empty'
      }
    });
    assert(empty.code === 'MESSAGE_EMPTY', 'empty message is accepted');
    const tooLong = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '长'.repeat(501),
        clientMessageId: 'msg_verification_long'
      }
    });
    assert(tooLong.code === 'MESSAGE_TOO_LONG', 'overlong message is accepted');

    const firstSend = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '  你好  ',
        clientMessageId: 'msg_verification_0001',
        senderPublicUserId: attackerUserId
      }
    });
    assert(firstSend.success === true, 'valid text message failed');
    assert(firstSend.data.message.content === '你好', 'message content was not trimmed');
    const repeatedSend = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '你好',
        clientMessageId: 'msg_verification_0001'
      }
    });
    assert(
      repeatedSend.success === true
      && repeatedSend.data.reused === true
      && stores.messages.size === 1,
      'repeated clientMessageId duplicated a message'
    );
    const conflictingTextReplay = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '试图覆盖原消息',
        clientMessageId: 'msg_verification_0001'
      }
    });
    const conflictingTypeReplay = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_verification_0001',
        type: 'location',
        location: {
          name: '',
          address: '',
          latitude: 999,
          longitude: 999
        }
      }
    });
    assert(
      conflictingTextReplay.success === true
      && conflictingTextReplay.data.reused === true
      && conflictingTextReplay.data.message.content === '你好'
      && conflictingTypeReplay.success === true
      && conflictingTypeReplay.data.reused === true
      && conflictingTypeReplay.data.message.type === 'text'
      && conflictingTypeReplay.data.message.content === '你好'
      && stores.messages.size === 1,
      'idempotency conflict did not preserve the first committed message'
    );

    let conversation = stores.conversations.get(conversationId);
    const buyerSlot = conversation.participantAOpenid === buyerOpenId ? 'A' : 'B';
    const sellerSlot = buyerSlot === 'A' ? 'B' : 'A';
    assert(
      conversation[`participant${sellerSlot}UnreadCount`] === 1
      && conversation[`participant${buyerSlot}UnreadCount`] === 0
      && conversation.lastMessage === '你好'
      && conversation.lastMessageType === 'text',
      'send or conflicting replay changed recipient unread/last-message state'
    );
    assert(
      firstSend.data.message.senderPublicUserId === buyerUserId,
      'message sender public id trusted a client field'
    );

    const selfProducts = await messageQuery.main({
      action: 'listConversationProducts',
      data: {
        conversationId,
        ownerScope: 'self',
        pageSize: 8
      }
    });
    assert(
      selfProducts.success === true
      && selfProducts.data.list.some(
        (product) => product.productId === 'product-own'
      )
      && selfProducts.data.list.some(
        (product) => product.productId === 'product-buyer-reserved'
      )
      && selfProducts.data.list.every(
        (product) => product.ownerPublicUserId === buyerUserId
      ),
      'conversation product query does not limit self products to the caller'
    );
    const otherProducts = await messageQuery.main({
      action: 'listConversationProducts',
      data: {
        conversationId,
        ownerScope: 'other',
        pageSize: 8
      }
    });
    assert(
      otherProducts.success === true
      && otherProducts.data.list.every(
          (product) => product.ownerPublicUserId === sellerUserId
          && product.productId !== 'product-message-1'
          && product.productId !== 'product-inconsistent-owner'
          && !['deleted', 'offline'].includes(product.status)
      )
      && otherProducts.data.list.some(
        (product) => product.productId === 'product-seller-sold'
      ),
      'conversation product query leaks the current or hidden product'
    );
    assert(
      !JSON.stringify({
        selfProducts,
        otherProducts
      }).includes(attackerOpenId),
      'conversation product query leaked a third-party identity'
    );
    currentOpenId = sellerOpenId;
    const sellerSelfPageOne = await messageQuery.main({
      action: 'listConversationProducts',
      data: {
        conversationId,
        ownerScope: 'self',
        pageSize: 1
      }
    });
    const sellerSelfPageTwo = await messageQuery.main({
      action: 'listConversationProducts',
      data: {
        conversationId,
        ownerScope: 'self',
        pageSize: 1,
        cursor: sellerSelfPageOne.data.nextCursor
      }
    });
    const sellerOtherProducts = await messageQuery.main({
      action: 'listConversationProducts',
      data: {
        conversationId,
        ownerScope: 'other',
        pageSize: 8
      }
    });
    assert(
      sellerSelfPageOne.success === true
      && sellerSelfPageOne.data.list.length === 1
      && sellerSelfPageOne.data.list[0].ownerPublicUserId === sellerUserId
      && sellerSelfPageOne.data.list[0].productId !== 'product-message-1'
      && sellerSelfPageOne.data.hasMore === true
      && sellerSelfPageOne.data.nextCursor
      && sellerSelfPageTwo.success === true
      && sellerSelfPageTwo.data.list.length === 1
      && sellerSelfPageTwo.data.list[0].productId
        !== sellerSelfPageOne.data.list[0].productId
      && sellerOtherProducts.success === true
      && sellerOtherProducts.data.list.every(
        (product) => product.ownerPublicUserId === buyerUserId
      ),
      'role-reversed product query or stable pagination failed'
    );
    currentOpenId = buyerOpenId;

    const voiceClientMessageId = 'msg_rich_voice_0001';
    const voiceFileId = [
      'cloud://verification-env/chat-media/voice',
      conversationId,
      buyerUserId,
      '20260726',
      `${voiceClientMessageId}.mp3`
    ].join('/');
    const voiceSend = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: voiceClientMessageId,
        type: 'voice',
        senderPublicUserId: attackerUserId,
        media: {
          fileId: voiceFileId,
          durationMs: 6200,
          size: 32100,
          format: 'mp3'
        }
      }
    });
    assert(
      voiceSend.success === true
      && voiceSend.data.message.type === 'voice'
      && voiceSend.data.message.senderPublicUserId === buyerUserId
      && stores.conversations.get(conversationId).lastMessage === '[语音]',
      'voice message did not preserve trusted identity or summary'
    );
    const repeatedVoice = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: voiceClientMessageId,
        type: 'voice',
        media: {
          fileId: voiceFileId,
          durationMs: 6200,
          size: 32100,
          format: 'mp3'
        }
      }
    });
    assert(
      repeatedVoice.success === true
      && repeatedVoice.data.reused === true
      && repeatedVoice.data.message.messageId
        === voiceSend.data.message.messageId,
      'voice retry with the same clientMessageId created a duplicate'
    );
    const forgedVoice = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_voice_forged',
        type: 'voice',
        media: {
          fileId: `cloud://verification-env/chat-media/voice/${conversationId}/${attackerUserId}/20260726/msg_rich_voice_forged.mp3`,
          durationMs: 2000,
          size: 1000,
          format: 'mp3'
        }
      }
    });
    assert(
      forgedVoice.code === 'INVALID_MEDIA',
      'voice message accepts another user media directory'
    );
    const crossConversationVoiceId = 'msg_rich_voice_cross_conversation';
    const crossConversationVoice = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: crossConversationVoiceId,
        type: 'voice',
        media: {
          fileId: `cloud://verification-env/chat-media/voice/${concurrentResults[0].data.conversationId}/${buyerUserId}/20260726/${crossConversationVoiceId}.mp3`,
          durationMs: 2000,
          size: 1000,
          format: 'mp3'
        }
      }
    });
    const voiceUsingImageDirectory = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_voice_image_directory',
        type: 'voice',
        media: {
          fileId: `cloud://verification-env/chat-media/image/${conversationId}/${buyerUserId}/20260726/msg_rich_voice_image_directory.mp3`,
          durationMs: 2000,
          size: 1000,
          format: 'mp3'
        }
      }
    });
    assert(
      crossConversationVoice.code === 'INVALID_MEDIA'
      && voiceUsingImageDirectory.code === 'INVALID_MEDIA',
      'voice media accepts another conversation or image directory'
    );

    const imageClientMessageId = 'msg_rich_image_0001';
    const imageSend = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: imageClientMessageId,
        type: 'image',
        media: {
          fileId: `cloud://verification-env/chat-media/image/${conversationId}/${buyerUserId}/20260726/${imageClientMessageId}.jpg`,
          width: 1280,
          height: 960,
          size: 480000
        }
      }
    });
    assert(
      imageSend.success === true
      && imageSend.data.message.media.width === 1280
      && stores.conversations.get(conversationId).lastMessage === '[图片]',
      'image message metadata or summary is invalid'
    );
    const imageUsingVoiceDirectory = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_image_voice_directory',
        type: 'image',
        media: {
          fileId: `cloud://verification-env/chat-media/voice/${conversationId}/${buyerUserId}/20260726/msg_rich_image_voice_directory.jpg`,
          width: 100,
          height: 100,
          size: 1000
        }
      }
    });
    const imageUsingProductCover = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_image_product_cover',
        type: 'image',
        media: {
          fileId: stores.products.get('product-message-2').coverImage,
          width: 100,
          height: 100,
          size: 1000
        }
      }
    });
    const imageUsingAvatar = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_image_avatar',
        type: 'image',
        media: {
          fileId: `cloud://verification-env/avatars/${buyerUserId}/avatar.jpg`,
          width: 100,
          height: 100,
          size: 1000
        }
      }
    });
    assert(
      imageUsingVoiceDirectory.code === 'INVALID_MEDIA'
      && imageUsingProductCover.code === 'INVALID_MEDIA'
      && imageUsingAvatar.code === 'INVALID_MEDIA',
      'image media accepts voice, product-cover, or avatar paths'
    );
    const forgedConversationId = `c_${'0'.repeat(64)}`;
    const forgedConversationSend = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId: forgedConversationId,
        clientMessageId: 'msg_rich_forged_conversation',
        type: 'image',
        media: {
          fileId: `cloud://verification-env/chat-media/image/${forgedConversationId}/${buyerUserId}/20260726/msg_rich_forged_conversation.jpg`,
          width: 100,
          height: 100,
          size: 1000
        }
      }
    });
    assert(
      forgedConversationSend.code === 'CONVERSATION_NOT_FOUND',
      'a forged conversation id reaches media persistence'
    );

    const invalidLocation = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_location_bad',
        type: 'location',
        location: {
          name: '错误地点',
          address: '错误坐标',
          latitude: 120,
          longitude: 181
        }
      }
    });
    assert(
      invalidLocation.code === 'INVALID_LOCATION',
      'out-of-range location coordinates are accepted'
    );
    const incompleteLocation = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_location_incomplete',
        type: 'location',
        location: {
          name: '缺少地址',
          latitude: 31.2,
          longitude: 121.4
        }
      }
    });
    const overlongLocation = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_location_long',
        type: 'location',
        location: {
          name: '地'.repeat(81),
          address: '址'.repeat(201),
          latitude: 31.2,
          longitude: 121.4
        }
      }
    });
    assert(
      incompleteLocation.code === 'INVALID_LOCATION'
      && overlongLocation.code === 'INVALID_LOCATION',
      'incomplete or overlong location payload is accepted'
    );
    const locationSend = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_location_0001',
        type: 'location',
        location: {
          name: '东区图书馆',
          address: '即出大学东区 1 号',
          latitude: 31.2304,
          longitude: 121.4737
        }
      }
    });
    assert(
      locationSend.success === true
      && locationSend.data.message.location.name === '东区图书馆'
      && stores.conversations.get(conversationId).lastMessage === '[位置]',
      'valid location message or summary failed'
    );

    const currentProductShare = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_product_current',
        type: 'product',
        productId: 'product-message-1'
      }
    });
    assert(
      currentProductShare.code === 'INVALID_PRODUCT',
      'current conversation product can be shared as another product'
    );
    const thirdPartyProductShare = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_product_third',
        type: 'product',
        productId: 'product-third-party'
      }
    });
    assert(
      thirdPartyProductShare.code === 'PRODUCT_NOT_ACCESSIBLE',
      'third-party product can be forged into a conversation'
    );
    const inconsistentProductShare = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_product_inconsistent',
        type: 'product',
        productId: 'product-inconsistent-owner'
      }
    });
    assert(
      inconsistentProductShare.code === 'PRODUCT_NOT_ACCESSIBLE',
      'inconsistent trusted and public product owners are accepted'
    );
    const unavailableProductResults = await Promise.all([
      ['product-missing', 'msg_rich_product_missing'],
      ['product-deleted', 'msg_rich_product_deleted'],
      ['product-offline', 'msg_rich_product_offline']
    ].map(([productId, clientMessageId]) => messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId,
        type: 'product',
        productId
      }
    })));
    assert(
      unavailableProductResults.every(
        (result) => result.code === 'PRODUCT_NOT_ACCESSIBLE'
      ),
      'missing, deleted, or offline product can be shared'
    );
    const productSend = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_rich_product_0001',
        type: 'product',
        productId: 'product-message-2',
        product: {
          title: '伪造标题',
          price: 0,
          coverImage: `cloud://verification-env/avatars/${attackerUserId}/avatar.jpg`,
          ownerPublicUserId: attackerUserId
        }
      }
    });
    assert(
      productSend.success === true
      && productSend.data.message.product.title
        === stores.products.get('product-message-2').title
      && productSend.data.message.product.price === 12
      && productSend.data.message.product.coverImage
        === stores.products.get('product-message-2').coverImage
      && productSend.data.message.product.ownerPublicUserId === sellerUserId
      && stores.conversations.get(conversationId).lastMessage === '[商品]',
      'product message trusted a client snapshot or lost its summary'
    );

    const richHistory = await messageQuery.main({
      action: 'listMessages',
      data: {
        conversationId,
        pageSize: 20
      }
    });
    const richTypes = new Set(
      richHistory.data.list.map((message) => message.type)
    );
    assert(
      ['text', 'voice', 'image', 'location', 'product'].every(
        (type) => richTypes.has(type)
      ),
      'rich messages do not round-trip through messageQuery'
    );
    assert(
      !/"senderOpenid"|"fileName"|"localTempPath"/.test(
        JSON.stringify(richHistory)
      ),
      'rich message response leaks internal identity or local paths'
    );

    currentOpenId = attackerOpenId;
    const forbiddenSend = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '越权',
        clientMessageId: 'msg_verification_attack'
      }
    });
    assert(forbiddenSend.code === 'FORBIDDEN', 'non-participant can send messages');
    const forbiddenConversation = await messageQuery.main({
      action: 'getConversation',
      data: { conversationId }
    });
    assert(forbiddenConversation.code === 'FORBIDDEN', 'non-participant can read a conversation');
    const forbiddenMessages = await messageQuery.main({
      action: 'listMessages',
      data: { conversationId }
    });
    assert(forbiddenMessages.code === 'FORBIDDEN', 'non-participant can read messages');
    const forbiddenRichResults = await Promise.all([
      messageAction.main({
        action: 'sendMessage',
        data: {
          conversationId,
          clientMessageId: 'msg_rich_attacker_voice',
          type: 'voice',
          media: {
            fileId: `cloud://verification-env/chat-media/voice/${conversationId}/${attackerUserId}/20260726/msg_rich_attacker_voice.mp3`,
            durationMs: 2000,
            size: 1000,
            format: 'mp3'
          }
        }
      }),
      messageAction.main({
        action: 'sendMessage',
        data: {
          conversationId,
          clientMessageId: 'msg_rich_attacker_location',
          type: 'location',
          location: {
            name: '合法格式地点',
            address: '合法格式地址',
            latitude: 31.2,
            longitude: 121.4
          }
        }
      }),
      messageAction.main({
        action: 'sendMessage',
        data: {
          conversationId,
          clientMessageId: 'msg_rich_attacker_product',
          type: 'product',
          productId: 'product-third-party'
        }
      })
    ]);
    assert(
      forbiddenRichResults.every((result) => result.code === 'FORBIDDEN'),
      'non-participant can send legal-format rich messages'
    );
    const attackerList = await messageQuery.main({
      action: 'listConversations',
      data: {}
    });
    assert(
      attackerList.success === true && attackerList.data.list.length === 0,
      'conversation list leaked another user conversation'
    );
    const attackerProducts = await messageQuery.main({
      action: 'listConversationProducts',
      data: {
        conversationId,
        ownerScope: 'self'
      }
    });
    assert(
      attackerProducts.code === 'FORBIDDEN',
      'non-participant can query conversation products'
    );

    currentOpenId = sellerOpenId;
    const sellerSend = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '还在的',
        clientMessageId: 'msg_verification_0002'
      }
    });
    assert(
      sellerSend.success === true
      && [...stores.messages.values()].some(
        (message) => message.content === '还在的'
      ),
      'second participant could not send'
    );
    conversation = stores.conversations.get(conversationId);
    assert(
      conversation[`participant${buyerSlot}UnreadCount`] === 1,
      'second message did not increment buyer unread'
    );
    const marked = await messageAction.main({
      action: 'markConversationRead',
      data: { conversationId }
    });
    assert(marked.success === true, 'markRead failed');
    conversation = stores.conversations.get(conversationId);
    assert(
      conversation[`participant${sellerSlot}UnreadCount`] === 0
      && conversation[`participant${buyerSlot}UnreadCount`] === 1,
      'markRead changed the other participant unread slot'
    );
    const repeatedMark = await messageAction.main({
      action: 'markConversationRead',
      data: { conversationId }
    });
    assert(repeatedMark.success === true, 'repeat markRead is not idempotent');

    currentOpenId = buyerOpenId;
    const secondConversation = await messageAction.main({
      action: 'createOrGetConversation',
      data: { productId: 'product-message-2' }
    });
    assert(secondConversation.success === true, 'second conversation creation failed');
    const firstConversationPage = await messageQuery.main({
      action: 'listConversations',
      data: { pageSize: 1 }
    });
    assert(
      firstConversationPage.success === true
      && firstConversationPage.data.list.length === 1
      && firstConversationPage.data.hasMore === true
      && firstConversationPage.data.nextCursor,
      'conversation cursor first page is invalid'
    );
    const secondConversationPage = await messageQuery.main({
      action: 'listConversations',
      data: {
        pageSize: 1,
        cursor: firstConversationPage.data.nextCursor
      }
    });
    assert(
      secondConversationPage.success === true
      && secondConversationPage.data.list.length === 1
      && secondConversationPage.data.list[0].conversationId
        !== firstConversationPage.data.list[0].conversationId,
      'conversation cursor pagination duplicated an item'
    );

    const safeConversationResult = await messageQuery.main({
      action: 'getConversation',
      data: { conversationId }
    });
    assert(safeConversationResult.success === true, 'participant cannot read conversation');
    const messagePageOne = await messageQuery.main({
      action: 'listMessages',
      data: {
        conversationId,
        pageSize: 1
      }
    });
    const messagePageTwo = await messageQuery.main({
      action: 'listMessages',
      data: {
        conversationId,
        pageSize: 1,
        cursor: messagePageOne.data.nextCursor
      }
    });
    assert(
      messagePageOne.data.list.length === 1
      && messagePageTwo.data.list.length === 1
      && messagePageOne.data.list[0].messageId
        !== messagePageTwo.data.list[0].messageId,
      'message cursor pagination duplicated an item'
    );
    const safePayload = JSON.stringify({
      conversation: safeConversationResult,
      messages: messagePageOne
    });
    assert(
      !safePayload.includes(buyerOpenId)
      && !safePayload.includes(sellerOpenId)
      && !/"senderOpenid"|"participantAOpenid"|"participantBOpenid"/.test(safePayload),
      'messaging response leaked an internal identity'
    );

    stores.products.get('product-message-1').status = 'sold';
    const soldConversationSend = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '已售会话继续',
        clientMessageId: 'msg_verification_0003'
      }
    });
    assert(soldConversationSend.success === true, 'existing sold-product conversation cannot continue');
    stores.products.get('product-message-1').status = 'deleted';
    const deletedConversationSend = await messageAction.main({
      action: 'sendTextMessage',
      data: {
        conversationId,
        content: '删除后发送',
        clientMessageId: 'msg_verification_0004'
      }
    });
    assert(
      deletedConversationSend.code === 'PRODUCT_UNAVAILABLE',
      'deleted-product conversation still accepts new messages'
    );
    const deletedConversationReplay = await messageAction.main({
      action: 'sendMessage',
      data: {
        conversationId,
        clientMessageId: 'msg_verification_0003',
        type: 'location',
        location: {
          name: '',
          address: '',
          latitude: 999,
          longitude: 999
        }
      }
    });
    assert(
      deletedConversationReplay.success === true
      && deletedConversationReplay.data.reused === true
      && deletedConversationReplay.data.message.type === 'text'
      && deletedConversationReplay.data.message.content === '已售会话继续',
      'a committed retry stops being idempotent after the product is deleted'
    );

    const invalidAction = await messageAction.main({
      action: 'invalidAction',
      data: {}
    });
    const invalidQuery = await messageQuery.main({
      action: 'invalidAction',
      data: {}
    });
    assert(
      invalidAction.code === 'INVALID_ACTION'
      && invalidQuery.code === 'INVALID_ACTION',
      'messaging cloud functions accept an invalid action'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(actionPath)];
    delete require.cache[require.resolve(queryPath)];
  }
}

async function verifyAuthUserFunctionFlow() {
  const functionPath = path.join(root, 'cloudfunctions/authUser/index.js');
  const originalLoad = Module._load;
  const users = new Map();
  const schools = new Map([
    [`s_${'a'.repeat(32)}`, {
      _id: `s_${'a'.repeat(32)}`,
      name: '验证大学',
      officialStatus: 'valid',
      platformStatus: 'active'
    }]
  ]);
  let activeIdentity = {
    OPENID: 'openid-user-a',
    APPID: 'app-verification'
  };
  const database = {
    collection(name) {
      assert(
        name === 'users' || name === 'schools',
        'authUser accessed an unexpected collection'
      );
      const records = name === 'users' ? users : schools;
      return {
        where(condition) {
          return {
            limit() {
              return {
                async get() {
                  const record = records.get(condition._id);
                  return {
                    data: record ? [{ ...record }] : []
                  };
                }
              };
            }
          };
        },
        doc(id) {
          return {
            async get() {
              const record = records.get(id);
              if (!record) {
                throw new Error('document does not exist');
              }
              return {
                data: { ...record }
              };
            },
            async set({ data }) {
              records.set(id, {
                ...data,
                _id: id
              });
            },
            async update({ data }) {
              const existing = records.get(id);
              if (!existing) {
                throw new Error('document does not exist');
              }
              records.set(id, {
                ...existing,
                ...data,
                _id: id
              });
            }
          };
        }
      };
    },
    serverDate() {
      return new Date('2026-07-23T08:00:00.000Z');
    },
    async runTransaction(callback) {
      return callback({
        collection: database.collection.bind(database)
      });
    }
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return { ...activeIdentity };
    }
  };

  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return cloudMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(functionPath)];

  try {
    const authUser = require(functionPath);
    const beforeLogin = await authUser.main({
      action: 'current'
    });
    assert(
      beforeLogin.success === false
      && beforeLogin.code === 'USER_NOT_FOUND',
      'unregistered identity received a virtual user'
    );

    const invalidNickname = await authUser.main({
      action: 'login',
      data: {
        profile: {
          nickname: '   '
        }
      }
    });
    assert(
      invalidNickname.code === 'INVALID_NICKNAME'
      && users.size === 0,
      'empty nickname created a user'
    );

    const firstLogin = await authUser.main({
      action: 'login',
      OPENID: 'forged-root-openid',
      data: {
        profile: {
          nickname: '用户甲',
          campus: '第一大学',
          openid: 'forged-profile-openid',
          publicUserId: 'u_forged'
        }
      }
    });
    assert(firstLogin.success === true, 'first real identity login failed');
    assert(users.size === 1, 'first login did not create exactly one user');
    const userAId = firstLogin.data.user.publicUserId;
    const storedUserA = users.get(userAId);
    assert(
      storedUserA
      && storedUserA.openid === activeIdentity.OPENID,
      'authUser trusted a client identity instead of getWXContext'
    );
    assert(
      firstLogin.data.user.id === userAId
      && firstLogin.data.user.profileCompleted === false,
      'first login safe user or profile state is incorrect'
    );

    const repeatedLogin = await authUser.main({
      action: 'login',
      data: {
        profile: {
          nickname: '用户甲',
          campus: '第一大学'
        }
      }
    });
    assert(
      repeatedLogin.success === true
      && repeatedLogin.data.user.publicUserId === userAId
      && users.size === 1,
      'repeated login created a second user or changed publicUserId'
    );

    activeIdentity = {
      OPENID: 'openid-user-b',
      APPID: 'app-verification'
    };
    const userBLogin = await authUser.main({
      action: 'login',
      data: {
        profile: {
          nickname: '用户乙',
          campus: ''
        }
      }
    });
    const userBId = userBLogin.data.user.publicUserId;
    assert(
      userBLogin.success === true
      && users.size === 2
      && userBId !== userAId
      && users.get(userBId).openid !== users.get(userAId).openid,
      'different real identities did not create distinct public users'
    );

    activeIdentity = {
      OPENID: 'openid-user-concurrent',
      APPID: 'app-verification'
    };
    const concurrentResults = await Promise.all([
      authUser.main({
        action: 'login',
        data: {
          profile: {
            nickname: '并发用户',
            campus: ''
          }
        }
      }),
      authUser.main({
        action: 'login',
        data: {
          profile: {
            nickname: '并发用户',
            campus: ''
          }
        }
      })
    ]);
    assert(
      concurrentResults.every((result) => result.success)
      && concurrentResults[0].data.user.publicUserId
        === concurrentResults[1].data.user.publicUserId
      && users.size === 3,
      'concurrent first login created duplicate users'
    );

    activeIdentity = {
      OPENID: 'openid-user-a',
      APPID: 'app-verification'
    };
    const invalidAvatar = await authUser.main({
      action: 'updateProfile',
      data: {
        profile: {
          nickname: '用户甲',
          campus: '第一大学',
          avatarUrl: `cloud://test.bucket/avatars/${userBId}/20260723/avatar.jpg`
        }
      }
    });
    assert(
      invalidAvatar.code === 'INVALID_AVATAR',
      'profile update accepted another user avatar path'
    );

    const overlongNickname = await authUser.main({
      action: 'updateProfile',
      data: {
        profile: {
          nickname: '超'.repeat(21),
          campus: '',
          avatarUrl: `cloud://test.bucket/avatars/${userAId}/20260723/avatar.jpg`
        }
      }
    });
    assert(
      overlongNickname.code === 'INVALID_NICKNAME',
      'profile update accepted an overlong nickname'
    );

    const updateA = await authUser.main({
      action: 'updateProfile',
      data: {
        profile: {
          nickname: '真实用户甲',
          campus: '第一大学',
          avatarUrl: `cloud://test.bucket/avatars/${userAId}/20260723/avatar.jpg`,
          publicUserId: userBId,
          openid: 'forged-openid'
        }
      }
    });
    assert(
      updateA.success === true
      && updateA.data.user.publicUserId === userAId
      && updateA.data.user.profileCompleted === true
      && users.get(userAId).nickname === '真实用户甲',
      'updateProfile did not update the current real user'
    );

    activeIdentity = {
      OPENID: 'openid-user-b',
      APPID: 'app-verification'
    };
    const victimNickname = users.get(userAId).nickname;
    const updateB = await authUser.main({
      action: 'updateProfile',
      data: {
        profile: {
          nickname: '真实用户乙',
          campus: '',
          avatarUrl: `cloud://test.bucket/avatars/${userBId}/20260723/avatar.png`,
          publicUserId: userAId
        }
      }
    });
    assert(
      updateB.success === true
      && updateB.data.user.publicUserId === userBId
      && users.get(userAId).nickname === victimNickname,
      'updateProfile modified a client-selected public user'
    );

    const currentB = await authUser.main({
      action: 'current'
    });
    assert(
      currentB.success === true
      && currentB.data.user.publicUserId === userBId,
      'current did not restore the existing real user'
    );
    assert(
      currentB.data.user.schoolRequired === true
      && currentB.data.user.schoolUnavailable === false,
      'legacy user without school was not marked for school selection'
    );

    const invalidSchool = await authUser.main({
      action: 'selectSchool',
      data: {
        schoolId: 'invalid-school'
      }
    });
    assert(
      invalidSchool.code === 'INVALID_SCHOOL_ID',
      'authUser accepted an invalid school id'
    );

    const activeSchoolId = `s_${'a'.repeat(32)}`;
    const selectedSchool = await authUser.main({
      action: 'selectSchool',
      data: {
        schoolId: activeSchoolId,
        schoolName: '伪造学校名称',
        publicUserId: userAId
      }
    });
    assert(
      selectedSchool.success === true
      && selectedSchool.data.user.publicUserId === userBId
      && selectedSchool.data.user.schoolId === activeSchoolId
      && selectedSchool.data.user.schoolName === '验证大学'
      && selectedSchool.data.user.schoolRequired === false
      && users.get(userBId).schoolName === '验证大学',
      'authUser did not bind the active school from trusted data'
    );

    const selectedAtBeforeRetry = users.get(userBId).schoolSelectedAt;
    const repeatedSelection = await authUser.main({
      action: 'selectSchool',
      data: {
        schoolId: activeSchoolId
      }
    });
    assert(
      repeatedSelection.success === true
      && users.get(userBId).schoolSelectedAt === selectedAtBeforeRetry
      && repeatedSelection.data.user.schoolVersion === 1,
      'same-school retry was not idempotent'
    );

    const safePayload = JSON.stringify({
      firstLogin,
      updateA,
      currentB,
      selectedSchool
    });
    assert(
      !safePayload.includes('openid-user-a')
      && !safePayload.includes('openid-user-b')
      && !/"(?:openid|OPENID|_openid|sellerOpenid|senderOpenid|participantAOpenid|participantBOpenid)"/.test(safePayload),
      'authUser response leaked an internal identity'
    );

    const invalidAction = await authUser.main({
      action: 'invalidAction'
    });
    assert(
      invalidAction.code === 'INVALID_ACTION',
      'authUser accepted an invalid action'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(functionPath)];
  }
}

async function verifyAvatarServiceFlow() {
  const servicePath = path.join(root, 'services/avatar-service.js');
  const originalWx = global.wx;
  const uploadedPaths = [];
  let fileSize = 1024;
  let imageType = 'jpeg';

  global.wx = {
    getFileSystemManager() {
      return {
        getFileInfo({ success }) {
          success({
            size: fileSize
          });
        }
      };
    },
    getImageInfo({ success }) {
      success({
        type: imageType,
        width: 200,
        height: 200
      });
    },
    cloud: {
      init() {},
      uploadFile({ cloudPath, success }) {
        uploadedPaths.push(cloudPath);
        success({
          fileID: `cloud://test.bucket/${cloudPath}`
        });
        return {
          abort() {}
        };
      }
    }
  };
  delete require.cache[require.resolve(servicePath)];

  try {
    const AvatarService = require(servicePath);
    const userId = `u_${'a'.repeat(32)}`;
    const fileID = await AvatarService.uploadAvatar({
      tempFilePath: 'wxfile://chosen-avatar',
      userId
    });
    assert(
      fileID.startsWith(`cloud://test.bucket/avatars/${userId}/`)
      && uploadedPaths.length === 1,
      'avatar was not uploaded to the current user path'
    );

    fileSize = 6 * 1024 * 1024;
    let oversizeError;
    try {
      await AvatarService.uploadAvatar({
        tempFilePath: 'wxfile://oversize-avatar',
        userId
      });
    } catch (error) {
      oversizeError = error;
    }
    assert(
      oversizeError && oversizeError.code === 'AVATAR_TOO_LARGE',
      'oversized avatar was accepted'
    );

    fileSize = 1024;
    imageType = 'svg';
    let typeError;
    try {
      await AvatarService.uploadAvatar({
        tempFilePath: 'wxfile://unsafe-avatar',
        userId
      });
    } catch (error) {
      typeError = error;
    }
    assert(
      typeError && typeError.code === 'INVALID_AVATAR',
      'unsupported avatar type was accepted'
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

async function verifyAuthStateFlow() {
  const AuthService = require(path.join(root, 'services/auth-service'));
  const AuthStore = require(path.join(root, 'store/auth-store'));
  const originalWx = global.wx;
  const originalGetCurrentUser = AuthService.getCurrentUser;
  const originalLogin = AuthService.login;
  const originalUpdateProfile = AuthService.updateProfile;
  const storage = new Map();

  global.wx = {
    getStorageSync(key) {
      return storage.get(key);
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    }
  };

  const restoredUser = {
    id: 'u_restored',
    nickname: '恢复用户',
    avatarUrl: 'cloud://test.bucket/avatars/u_restored/20260723/avatar.jpg',
    avatarText: '恢',
    campus: '',
    bio: '',
    role: 'user',
    status: 'active',
    profileCompleted: true,
    createdAt: '',
    updatedAt: '',
    lastLoginAt: ''
  };
  const loginUser = {
    ...restoredUser,
    id: 'u_login',
    nickname: '登录用户',
    avatarText: '登',
    avatarUrl: 'cloud://test.bucket/avatars/u_login/20260723/avatar.jpg',
    profileCompleted: true
  };

  try {
    AuthStore.clearSession();
    let currentCalls = 0;
    AuthService.getCurrentUser = async () => {
      currentCalls += 1;
      return restoredUser;
    };

    const firstBootstrap = AuthStore.bootstrap({ force: true });
    const secondBootstrap = AuthStore.bootstrap({ force: true });
    assert(firstBootstrap === secondBootstrap, 'bootstrap does not reuse the active promise');
    await firstBootstrap;
    await Promise.resolve();
    assert(currentCalls === 1, 'bootstrap called current more than once');
    assert(AuthStore.isLoggedIn(), 'bootstrap did not authenticate the restored user');

    const cached = storage.get('auth:user-summary');
    assert(cached && cached.id === restoredUser.id, 'safe user summary was not cached');
    assert(!Object.prototype.hasOwnProperty.call(cached, 'openid'), 'cached summary contains openid');
    assert(!Object.prototype.hasOwnProperty.call(cached, 'role'), 'cached summary contains role');

    AuthStore.clearSession();
    let loginCalls = 0;
    AuthService.login = async (profile) => {
      loginCalls += 1;
      assert(profile.nickname === '登录用户', 'AuthStore dropped the submitted profile');
      return loginUser;
    };
    const loginProfile = {
      nickname: '登录用户',
      campus: ''
    };
    const firstLogin = AuthStore.login(loginProfile);
    const secondLogin = AuthStore.login(loginProfile);
    assert(firstLogin === secondLogin, 'login does not reuse the active promise');
    await firstLogin;
    await Promise.resolve();
    assert(loginCalls === 1, 'duplicate login triggered multiple service calls');
    assert(AuthStore.getCurrentUser().id === loginUser.id, 'login user was not stored');

    const updatedUser = {
      ...loginUser,
      nickname: '更新用户',
      avatarText: '更'
    };
    let updateCalls = 0;
    AuthService.updateProfile = async () => {
      updateCalls += 1;
      return updatedUser;
    };
    const firstUpdate = AuthStore.updateProfile({
      nickname: '更新用户',
      avatarUrl: updatedUser.avatarUrl,
      campus: ''
    });
    const secondUpdate = AuthStore.updateProfile({
      nickname: '更新用户',
      avatarUrl: updatedUser.avatarUrl,
      campus: ''
    });
    assert(firstUpdate === secondUpdate, 'profile update does not reuse the active promise');
    await firstUpdate;
    await Promise.resolve();
    assert(
      updateCalls === 1
      && AuthStore.getCurrentUser().nickname === '更新用户',
      'profile update did not refresh AuthStore'
    );

    AuthStore.clearSession();
    let resolveStaleCurrent;
    AuthService.getCurrentUser = () => new Promise((resolve) => {
      resolveStaleCurrent = resolve;
    });
    const staleBootstrap = AuthStore.bootstrap({ force: true });
    AuthService.login = async () => loginUser;
    await AuthStore.login(loginProfile);
    resolveStaleCurrent(restoredUser);
    await staleBootstrap;
    assert(
      AuthStore.getCurrentUser().id === loginUser.id,
      'stale current request overwrote a newer login'
    );

    AuthStore.clearSession();
    assert(!AuthStore.isLoggedIn(), 'logout did not return to anonymous state');
    assert(!storage.has('auth:user-summary'), 'logout did not clear the local summary');
  } finally {
    AuthService.getCurrentUser = originalGetCurrentUser;
    AuthService.login = originalLogin;
    AuthService.updateProfile = originalUpdateProfile;
    AuthStore.clearSession();
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

record('public placeholders and local private configurations are isolated', () => {
  const publicProjectConfig = readJson(path.join(root, 'project.config.json'));
  const cloudConfigPath = path.join(root, 'config/cloud.js');
  const privateCloudConfigPath = path.join(root, 'config/cloud.private.js');
  const exampleCloudConfigPath = path.join(root, 'config/cloud.private.example.js');

  assert(
    publicProjectConfig.appid === 'YOUR_WECHAT_APP_ID',
    'project.config.json does not keep the public AppID placeholder'
  );
  assert(
    readText(cloudConfigPath).includes("const PUBLIC_ENVIRONMENT_ID = 'YOUR_CLOUDBASE_ENV_ID'"),
    'config/cloud.js does not keep the public cloud environment placeholder'
  );
  assert(fs.existsSync(exampleCloudConfigPath), 'private cloud configuration example is missing');

  [
    'project.private.config.json',
    'config/cloud.private.js'
  ].forEach((privatePath) => {
    const ignoreResult = spawnSync('git', ['check-ignore', privatePath], {
      cwd: root,
      encoding: 'utf8'
    });
    assert(ignoreResult.status === 0, `${privatePath} is not ignored`);

    const trackedResult = spawnSync(
      'git',
      ['ls-files', '--error-unmatch', privatePath],
      { cwd: root, encoding: 'utf8' }
    );
    assert(trackedResult.status !== 0, `${privatePath} is tracked`);
  });

  const exampleIgnoreResult = spawnSync(
    'git',
    ['check-ignore', '--no-index', 'config/cloud.private.example.js'],
    { cwd: root, encoding: 'utf8' }
  );
  assert(
    exampleIgnoreResult.status !== 0,
    'config/cloud.private.example.js is ignored instead of publishable'
  );

  const originalLoad = Module._load;
  delete require.cache[require.resolve(cloudConfigPath)];
  try {
    Module._load = function loadWithMissingPrivateConfig(request, parent, isMain) {
      if (
        request === './cloud.private'
        && parent
        && parent.filename === cloudConfigPath
      ) {
        const error = new Error('Cannot find module ./cloud.private');
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const fallbackConfig = require(cloudConfigPath);
    assert(
      fallbackConfig.CLOUD_CONFIG.environmentId === 'YOUR_CLOUDBASE_ENV_ID'
      && fallbackConfig.CLOUD_CONFIG.environmentSource === 'public-placeholder',
      'missing private cloud configuration does not fall back to the public placeholder'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(cloudConfigPath)];
  }

  if (fs.existsSync(path.join(root, 'project.private.config.json'))) {
    const privateProjectConfig = readJson(path.join(root, 'project.private.config.json'));
    assert(
      typeof privateProjectConfig.appid === 'string'
      && /^wx[a-zA-Z0-9]{16}$/.test(privateProjectConfig.appid)
      && privateProjectConfig.appid !== 'YOUR_WECHAT_APP_ID',
      'project.private.config.json does not contain a valid local AppID'
    );
  }

  if (fs.existsSync(privateCloudConfigPath)) {
    const privateCloudConfig = require(privateCloudConfigPath);
    assert(
      privateCloudConfig
      && typeof privateCloudConfig.environmentId === 'string'
      && privateCloudConfig.environmentId.trim()
      && privateCloudConfig.environmentId !== 'YOUR_CLOUDBASE_ENV_ID',
      'config/cloud.private.js does not contain a valid local environment ID'
    );
  }
});

record('product media UI and DTO boundaries are wired', () => {
  const detailPageSource = readText(path.join(root, 'pages/product-detail/index.js'));
  const detailTemplateSource = readText(path.join(root, 'pages/product-detail/index.wxml'));
  const publishPageSource = readText(path.join(root, 'pages/publish/index.js'));
  const editPageSource = readText(path.join(root, 'pages/product-edit/index.js'));
  const formServiceSource = readText(path.join(root, 'services/product-form-service.js'));
  const publishServiceSource = readText(path.join(root, 'services/product-publish-service.js'));
  const querySource = readText(path.join(root, 'cloudfunctions/productQuery/index.js'));
  const favoriteSource = readText(path.join(root, 'cloudfunctions/favoriteProduct/index.js'));
  const userQuerySource = readText(path.join(root, 'cloudfunctions/userQuery/index.js'));

  assert(/<swiper\b/.test(detailTemplateSource), 'product detail does not use a native image swiper');
  assert(/bindchange="onImageSwiperChange"/.test(detailTemplateSource), 'product detail swiper does not track the current image');
  assert(/bindtap="onPreviewProductImage"/.test(detailTemplateSource), 'product detail images cannot be previewed');
  assert(/<video\b/.test(detailTemplateSource), 'product detail does not render the optional product video');
  assert(/onHide\(\)[\s\S]*pauseProductVideo/.test(detailPageSource), 'product detail does not pause video when hidden');
  assert(/chooseVideo/.test(publishPageSource) && /chooseVideo/.test(editPageSource), 'publish or edit page cannot choose a product video');
  assert(/wx\.chooseMedia/.test(formServiceSource) && /mediaType:\s*\['video'\]/.test(formServiceSource), 'video selection does not use the guarded media picker');
  assert(/uploadLocalVideo/.test(publishServiceSource), 'product video upload flow is missing');
  assert(/includeMedia/.test(querySource), 'product query does not separate list and detail media DTOs');
  assert(!/\bimages:\s*record\.images/.test(favoriteSource), 'favorite list still returns all product images');
  assert(!/\bimages:\s*record\.images/.test(userQuerySource), 'public profile list still returns all product images');
});

record('product detail preview preserves state until an explicit product change', () => {
  const detailPageSource = readText(
    path.join(root, 'pages/product-detail/index.js')
  );
  const detailTemplateSource = readText(
    path.join(root, 'pages/product-detail/index.wxml')
  );
  const editPageSource = readText(
    path.join(root, 'pages/product-edit/index.js')
  );
  const myProductsSource = readText(
    path.join(root, 'pages/my-products/index.js')
  );

  const onLoadSource = detailPageSource.slice(
    detailPageSource.indexOf('onLoad(options)'),
    detailPageSource.indexOf('onShow()')
  );
  const onShowSource = detailPageSource.slice(
    detailPageSource.indexOf('onShow()'),
    detailPageSource.indexOf('onHide()')
  );
  const previewSource = detailPageSource.slice(
    detailPageSource.indexOf('onPreviewProductImage(event)'),
    detailPageSource.indexOf('onProductVideoError()')
  );

  assert(
    (onLoadSource.match(/this\.loadProduct\(\)/g) || []).length === 1
      && /observedProductsVersion\s*=\s*AppStore\.getProductsVersion\(\)/.test(
        onLoadSource
      ),
    'product detail does not perform one version-observed initial load'
  );
  assert(
    /const productsVersion = AppStore\.getProductsVersion\(\)/.test(
      onShowSource
    )
      && /productsVersion === this\.observedProductsVersion[\s\S]*return/.test(
        onShowSource
      )
      && /this\.observedProductsVersion = productsVersion/.test(onShowSource)
      && /viewState === 'success'[\s\S]*this\.loadProduct\(\)/.test(
        onShowSource
      )
      && !/hasShown/.test(detailPageSource),
    'product detail still reloads unconditionally whenever onShow runs'
  );
  assert(
    /wx\.previewImage\(\{[\s\S]*current:\s*selected\.url,[\s\S]*urls/.test(
      previewSource
    )
      && !/loadProduct|observedProductsVersion|markProductsChanged|scrollTop|navigateTo|redirectTo/.test(
        previewSource
      ),
    'product image preview mutates refresh state, scroll state, or navigation'
  );
  assert(
    /bindtap="onPreviewProductImage"/.test(detailTemplateSource)
      && !/<(?:view|swiper|swiper-item)[^>]*bindtap="[^"]*"[^>]*>[\s\S]{0,300}<image[^>]*bindtap="onPreviewProductImage"/.test(
        detailTemplateSource
      ),
    'product image preview can bubble into a parent tap action'
  );
  assert(
    /AppStore\.markProductsChanged\(\)/.test(editPageSource)
      && /AppStore\.markProductsChanged\(\)/.test(myProductsSource),
    'product edits or status changes do not publish an explicit refresh version'
  );
  assert(
    /AppStore\.markFavoritesChanged\(\);[\s\S]{0,120}this\.observedProductsVersion = AppStore\.getProductsVersion\(\)/.test(
      detailPageSource
    )
      && /hasRecordedViewAttempt/.test(detailPageSource),
    'local favorite changes cause a later reload or view recording is unguarded'
  );
});

record('product view display and protected invocation boundaries are wired', () => {
  const cardTemplate = readText(path.join(root, 'components/product-card/index.wxml'));
  const favoritesTemplate = readText(path.join(root, 'pages/favorites/index.wxml'));
  const publicProfileTemplate = readText(path.join(root, 'pages/user-profile/index.wxml'));
  const myProductsTemplate = readText(path.join(root, 'pages/my-products/index.wxml'));
  const detailTemplate = readText(path.join(root, 'pages/product-detail/index.wxml'));
  const detailPage = readText(path.join(root, 'pages/product-detail/index.js'));
  const viewService = readText(path.join(root, 'services/product-view-service.js'));
  const viewFunction = readText(path.join(root, 'cloudfunctions/productViewAction/index.js'));
  const manageFunction = readText(path.join(root, 'cloudfunctions/manageProduct/index.js'));
  const createFunction = readText(path.join(root, 'cloudfunctions/createProduct/index.js'));

  [cardTemplate, favoritesTemplate, publicProfileTemplate, myProductsTemplate]
    .forEach((template, index) => {
      assert(
        !/viewCountText/.test(template),
        `product list template ${index + 1} still displays view count`
      );
    });
  assert(
    /\{\{product\.viewCountText\}\}\s*人浏览\s*·\s*\{\{product\.favoriteCountText\}\}\s*人收藏/.test(detailTemplate),
    'product detail does not use the unified weak view/favorite copy'
  );
  assert(!/次浏览|人关注/.test(detailTemplate), 'product detail keeps the old view/favorite wording');
  assert(
    /setData\([\s\S]*viewState:\s*'success'[\s\S]*recordViewIfEligible\(\)/.test(detailPage),
    'product detail does not attempt view recording after a successful detail render'
  );
  assert(
    /hasRecordedViewAttempt/.test(detailPage)
    && /AuthStore\.is(?:LoggedIn|SchoolReady)\(\)/.test(detailPage),
    'product detail lacks per-page or school-ready view recording guards'
  );
  assert(
    /data:\s*\{\s*productId:\s*id\s*\}/.test(viewService)
    && !/viewerOpenid\s*:/.test(viewService)
    && !/viewCount\s*:/.test(viewService),
    'product view service sends protected identity or counter fields'
  );
  assert(
    /getWXContext\(\)/.test(viewFunction)
    && /command\.inc\(1\)/.test(viewFunction)
    && /runTransaction/.test(viewFunction),
    'product view cloud function lacks trusted identity or atomic transaction update'
  );
  assert(
    !/viewCount\s*:\s*(?:data|request|productInput|input)\./.test(manageFunction)
    && /viewCount:\s*0/.test(createFunction),
    'product create/manage boundary allows a client-controlled view count'
  );
});

async function runAsyncChecks() {
  await verifyServiceFlow();
  checks.push('PASS ProductService filtering, sorting, pagination and detail boundaries');
  await verifyProductQueryFunctionFlow();
  checks.push('PASS productQuery public fields, owner filtering, query limits and disabled seed action');
  await verifyMyProductsServiceFlow();
  checks.push('PASS MyProductsService query, management payload and error boundaries');
  await verifyProductEditServiceFlow();
  checks.push('PASS ProductEditService upload, rollback, retry and versioned payload boundaries');
  await verifyManageProductFunctionFlow();
  checks.push('PASS manageProduct ownership, transactions, editing, soft delete and cleanup boundaries');
  await verifyPublishServiceFlow();
  checks.push('PASS ProductPublishService validation, upload, idempotency and cleanup flow');
  await verifyCreateProductFunctionFlow();
  checks.push('PASS createProduct identity, protected fields, validation and idempotency flow');
  const { verifyProductLocationFlow } = require('./verify-product-locations');
  await verifyProductLocationFlow(root);
  checks.push('PASS strict new-product map validation, legacy data editing and privacy boundaries');
  await verifyFavoriteProductFunctionFlow();
  checks.push('PASS favoriteProduct transactions, idempotency, status rules, pagination and privacy flow');
  await verifyUserQueryFunctionFlow();
  checks.push('PASS userQuery public profile whitelist, safe id and available-product pagination flow');
  await verifyCloudServiceFlow();
  checks.push('PASS centralized cloud initialization, retry, concurrency and transport error classification');
  const { verifyProductViewFlow } = require('./verify-product-views');
  await verifyProductViewFlow(root);
  checks.push('PASS product view owner exclusion, rolling window, atomic concurrency and failure degradation flow');
  await verifyMessageServiceFlow();
  checks.push('PASS MessageService payload, normalization, validation and identity boundaries');
  await verifyChatMediaServiceFlow();
  checks.push('PASS chat media selection, validation, scoped upload and cleanup flow');
  await verifyChatAudioPageFlow();
  checks.push('PASS chat message tap isolation and iOS-safe voice playback lifecycle');
  await verifyMessagingFunctionFlow();
  checks.push('PASS messaging identity, permissions, idempotency, unread counts, cursors and privacy flow');
  checks.push('PASS rich message types, media paths, location ranges and participant-product boundaries');
  const {
    verifyAppointmentFlow,
    verifyChatAppointmentDegradation
  } = require('./verify-appointments');
  const appointmentResult = await verifyAppointmentFlow(root);
  assert(appointmentResult.creation, 'appointment creation verification did not finish');
  checks.push('PASS appointment creation validation, identity, active uniqueness and idempotency flow');
  assert(appointmentResult.permissions, 'appointment permission verification did not finish');
  checks.push('PASS appointment participant queries, privacy and third-party isolation flow');
  assert(appointmentResult.transitions, 'appointment transition verification did not finish');
  checks.push('PASS appointment state machine, seller-only completion, sold linkage and cleanup flow');
  assert(
    appointmentResult.productReservationLinkage,
    'appointment product reservation linkage verification did not finish'
  );
  checks.push('PASS appointment reserved linkage, single acceptance, recovery, display and refresh flow');
  assert(appointmentResult.messaging, 'appointment messaging verification did not finish');
  checks.push('PASS appointment system messages, unread idempotency and MessageService compatibility flow');
  assert(
    appointmentResult.paginationAndLocation,
    'appointment pagination and location verification did not finish'
  );
  checks.push('PASS appointment stable pagination and real map location boundaries');
  await verifyChatAppointmentDegradation(root);
  checks.push('PASS chat keeps messages available when appointment lookup fails and preserves message errors');
  await verifyAuthUserFunctionFlow();
  checks.push('PASS authUser real identities, unique users, profile validation, updates and privacy flow');
  await verifyAvatarServiceFlow();
  checks.push('PASS AvatarService decoding, size, type and user-scoped upload flow');
  await verifyAuthStateFlow();
  checks.push('PASS AuthStore bootstrap, login, profile update, cache, concurrency and logout flow');
  const { verifySchoolFlow } = require('./verify-schools');
  const schoolResult = await verifySchoolFlow(root);
  assert(schoolResult.source, 'school source verification did not finish');
  checks.push('PASS official XLS source inspection, immutable parsing and complete data profile');
  assert(schoolResult.normalization, 'school normalization verification did not finish');
  checks.push('PASS school normalization, deterministic IDs, stable outputs and P0/P1 validation');
  assert(schoolResult.import, 'school import verification did not finish');
  checks.push('PASS school dry-run, confirmation gate, idempotent import and operations-field preservation');
  assert(schoolResult.query, 'school query verification did not finish');
  checks.push('PASS schoolQuery active-only list, prefix/code search, stable cursors and safe detail fields');
  assert(schoolResult.service, 'school service verification did not finish');
  checks.push('PASS SchoolService parameter, response and error normalization without user binding');
  const {
    verifySchoolSelectionFlow
  } = require('./verify-school-selection');
  const schoolSelectionResult = await verifySchoolSelectionFlow(root);
  assert(
    schoolSelectionResult.checks >= 40,
    'school selection verification coverage is incomplete'
  );
  checks.push('PASS user school state compatibility, active validation and binding idempotency');
  checks.push('PASS AuthStore school cache, immediate refresh, concurrency and logout cleanup');
  checks.push('PASS school-required routing, target preservation and duplicate navigation prevention');
  checks.push('PASS school selection loading, search, confirmation, failure and stale-response states');
  checks.push('PASS phase 16 school selection boundaries and active-only school service');
  const {
    verifyProductSchoolBindingFlow
  } = require('./verify-product-school-binding');
  const productSchoolBindingResult = await verifyProductSchoolBindingFlow(root);
  assert(
    productSchoolBindingResult.checks >= 35,
    'product school binding verification coverage is incomplete'
  );
  checks.push('PASS trusted product school binding, immutable editing and legacy compatibility');
  const {
    verifyPhase18Flow
  } = require('./verify-phase-18-school-scoped-market');
  const phase18Result = await verifyPhase18Flow(root);
  assert(
    phase18Result.checks >= 50,
    'phase 18 school-scoped market verification coverage is incomplete'
  );
  checks.push('PASS phase 18 dual-track market, signed seek cursors and client scope isolation');
  const {
    verifyPhase18SchoolChangeFlow
  } = require('./verify-phase-18-school-change');
  const schoolChangeResult = await verifyPhase18SchoolChangeFlow(root);
  assert(
    schoolChangeResult.checks >= 45,
    'phase 18 school change verification coverage is incomplete'
  );
  checks.push('PASS controlled school change, authoritative refresh and immutable product ownership');
}

runAsyncChecks()
  .then(() => {
    checks.forEach((message) => console.log(message));
    if (errors.length > 0) {
      console.error('\nVerification failed:');
      errors.forEach((message) => console.error(`- ${message}`));
      process.exitCode = 1;
      return;
    }
    console.log(`\nVerification succeeded: ${checks.length} checks passed.`);
  })
  .catch((error) => {
    errors.push(`async verification flow: ${error.message}`);
    checks.forEach((message) => console.log(message));
    console.error('\nVerification failed:');
    errors.forEach((message) => console.error(`- ${message}`));
    process.exitCode = 1;
  });
