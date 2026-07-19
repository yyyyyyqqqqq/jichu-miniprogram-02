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

record('WXML tags are balanced', () => {
  const voidTags = new Set(['input', 'image', 'icon', 'progress', 'slider', 'switch']);
  const wxmlFiles = files.filter((file) => path.extname(file) === '.wxml');
  for (const wxmlFile of wxmlFiles) {
    const source = readText(wxmlFile).replace(/<!--[\s\S]*?-->/g, '');
    const stack = [];
    const tagPattern = /<\/?([a-zA-Z][\w-]*)\b[^>]*>/g;
    let match;
    while ((match = tagPattern.exec(source))) {
      const fullTag = match[0];
      const tagName = match[1];
      if (fullTag.startsWith('</')) {
        const openTag = stack.pop();
        assert(openTag === tagName, `${relative(wxmlFile)} closes ${tagName} after ${openTag || 'nothing'}`);
      } else if (!fullTag.endsWith('/>') && !voidTags.has(tagName)) {
        stack.push(tagName);
      }
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
    for (const forbidden of forbiddenPatterns) {
      assert(!forbidden.pattern.test(source), `${relative(file)} contains ${forbidden.label}`);
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
    'userQuery'
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
  ['favoriteProduct', 'userQuery', 'productQuery'].forEach((functionName) => {
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
  assert(/cloud\.getWXContext\s*\(\s*\)/.test(source), 'authUser does not use getWXContext');
  assert(/cloud\.DYNAMIC_CURRENT_ENV/.test(source), 'authUser does not use the current cloud environment');
  assert(/createHash\(\s*['"]sha256['"]\s*\)/.test(source), 'authUser does not derive a deterministic user id');
  assert(!/event\.(?:openid|openId|OPENID)/.test(source), 'authUser trusts a client identity field');
  assert(/users\.doc\(userId\)\.set/.test(source), 'authUser does not use an idempotent user document id');
  assert(/['"]login['"]/.test(source) && /['"]current['"]/.test(source), 'authUser actions are incomplete');
  assert(/success:\s*true/.test(source) && /success:\s*false/.test(source), 'authUser response envelope is inconsistent');
  assert(/code/.test(source) && /message/.test(source) && /data/.test(source), 'authUser response fields are incomplete');
  assert(!/console\.(?:log|info|warn|error)/.test(source), 'authUser writes identity information to logs');

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
  assert(/status:\s*['"]available['"]/.test(functionSource), 'public profile exposes non-available products');
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

record('AuthService and AuthStore expose the required boundaries', () => {
  const AuthService = require(path.join(root, 'services/auth-service'));
  const AuthStore = require(path.join(root, 'store/auth-store'));

  ['login', 'getCurrentUser', 'isLoggedIn', 'clearLocalSession'].forEach((name) => {
    assert(typeof AuthService[name] === 'function', `AuthService.${name} is missing`);
  });
  [
    'bootstrap',
    'login',
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

  assert(/wx\.cloud\.init/.test(appSource), 'App does not initialize cloud development');
  assert(/AuthStore\.bootstrap\(\)\.catch/.test(appSource), 'App does not start bootstrap safely');
  assert(!/async\s+onLaunch/.test(appSource), 'App.onLaunch is async');
  assert(!/await\s+AuthStore\.bootstrap/.test(appSource), 'App.onLaunch blocks on bootstrap');
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
    'pages/product-edit/index.js'
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
  ['restoring', 'authenticated', 'error'].forEach((status) => {
    assert(
      loginTemplate.includes(status) || profileTemplate.includes(status),
      `auth UI does not cover ${status}`
    );
  });
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
    'userQuery'
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
      images: ['cloud://test-env.bucket/products/u_owner/20260717/public.jpg'],
      coverImage: 'cloud://test-env.bucket/products/u_owner/20260717/public.jpg',
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

  function createQuery(condition) {
    const orderRules = [];
    let offset = 0;
    let limit = records.length;
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
          total: records.filter((record) => matches(record, condition)).length
        };
      },
      async get() {
        const filtered = records
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
  const db = {
    command,
    RegExp({ regexp, options }) {
      return {
        $regexp: new RegExp(regexp, options)
      };
    },
    collection(name) {
      assert(name === 'products', `unexpected productQuery collection ${name}`);
      return {
        where(condition) {
          return createQuery(condition);
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
        OPENID: queryOpenId
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
    const listResult = await productQueryFunction.main({
      action: 'list',
      data: {
        page: 1,
        pageSize: 20,
        categoryId: 'all',
        sortBy: 'newest'
      }
    });
    assert(listResult.success === true, 'productQuery rejected a valid public list request');
    assert(listResult.data.list.length === 1, 'productQuery list leaked a hidden status');
    assert(
      !Object.prototype.hasOwnProperty.call(listResult.data.list[0], 'sellerOpenid'),
      'productQuery list leaked sellerOpenid'
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

    const cappedResult = await productQueryFunction.main({
      action: 'list',
      data: {
        page: 999999,
        pageSize: 999999,
        categoryId: 'all',
        sortBy: 'default'
      }
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

    const draft = {
      title: '编辑后的商品',
      description: '编辑后的商品描述内容完整',
      price: '29.90',
      categoryId: 'digital',
      condition: '八成新',
      location: '实验楼大厅'
    };
    const localImage = {
      tempFilePath: 'C:\\temp\\edit-new.jpg',
      size: 1024,
      fileType: 'image'
    };
    const updated = await ProductEditService.updateProduct({
      productId: 'product-edit-service',
      expectedVersion: 1,
      mutationId: 'mut_service_update_01',
      draft,
      existingFileIDs: [existingImage],
      localImages: [localImage],
      userId: 'u_owner'
    });
    assert(
      updated.version === 2 && uploadedFileIDs.length === 1,
      'product-edit service did not upload and update the product'
    );
    const updateRequest = requests.find((request) => (
      request.data.action === 'updateProduct'
    ));
    assert(
      updateRequest
      && updateRequest.name === 'manageProduct'
      && updateRequest.data.product.images.length === 2
      && updateRequest.data.product.images[0] === existingImage,
      'product-edit service did not preserve ordered final images'
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
        userId: 'u_owner'
      });
    } catch (error) {
      timeoutError = error;
    }
    assert(
      timeoutError
      && timeoutError.code === 'TIMEOUT'
      && timeoutError.outcomeUnknown === true
      && timeoutError.uploadedFileIds.length === 1,
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
  const cleanupImageA = 'cloud://test-env.bucket/products/u_owner/20260718/cleanup-a.jpg';
  const cleanupImageB = 'cloud://test-env.bucket/products/u_owner/20260718/cleanup-b.jpg';
  const sharedImage = 'cloud://test-env.bucket/products/u_owner/20260718/shared.jpg';
  const retainImage = 'cloud://test-env.bucket/products/u_owner/20260718/retain.jpg';
  const replaceOldImage = 'cloud://test-env.bucket/products/u_owner/20260718/replace-old.jpg';
  const replaceNewImage = 'cloud://test-env.bucket/products/u_owner/20260718/replace-new.jpg';
  const products = new Map([
    ['product-state', {
      _id: 'product-state',
      sellerOpenid: 'owner-openid',
      sellerId: 'u_owner',
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
      images: [ownerImageA, ownerImageB],
      coverImage: ownerImageA,
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
    ['product-foreign', {
      _id: 'product-foreign',
      sellerOpenid: 'foreign-openid',
      sellerId: 'u_foreign',
      status: 'available'
    }]
  ]);
  let currentOpenId = 'owner-openid';
  let deleteMode = 'success';
  const deletedFileIDs = [];
  const deleteStatusSnapshots = [];

  function matches(record, condition) {
    return Object.entries(condition).every(([key, value]) => {
      if (value && Array.isArray(value.$all)) {
        return Array.isArray(record[key])
          && value.$all.every((item) => record[key].includes(item));
      }
      return record[key] === value;
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
          assert(name === 'products', `unexpected transaction collection ${name}`);
          return {
            doc(id) {
              return {
                async get() {
                  return {
                    data: products.has(id) ? products.get(id) : null
                  };
                },
                async update({ data }) {
                  assert(products.has(id), `transaction updated missing product ${id}`);
                  products.set(id, Object.assign({}, products.get(id), data));
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
          Array.isArray(product.images) && product.images.includes(fileID)
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
        images: [ownerImageA, ownerImageC]
      }
    };
    const updated = await manageProductFunction.main(updateRequest);
    assert(
      updated.success === true
      && updated.data.version === 2
      && products.get('product-edit').title === '更新后的商品标题'
      && products.get('product-edit').categoryName === '数码'
      && products.get('product-edit').status === 'available'
      && products.get('product-edit').sellerOpenid === 'owner-openid'
      && products.get('product-edit').createdAt.original === true,
      'manageProduct did not update only allowed product fields'
    );
    assert(
      deletedFileIDs.includes(ownerImageB),
      'manageProduct did not delete a removed unreferenced old image'
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
      deleteStatusSnapshots
        .filter((status, index) => (
          [ownerImageA, ownerImageC].includes(deletedFileIDs[index])
        ))
        .every((status) => status === 'deleted'),
      'manageProduct deleted cloud images before database soft delete'
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
    location: '图书馆南门'
  };
  const localImages = [
    {
      tempFilePath: 'C:\\temp\\lamp-one.jpg',
      size: 1024,
      fileType: 'image'
    },
    {
      tempFilePath: 'C:\\temp\\lamp-two.png',
      size: 2048,
      fileType: 'image'
    }
  ];

  try {
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
        tempFilePath: 'C:\\temp\\payload.exe',
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
        tempFilePath: 'C:\\temp\\empty.jpg',
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

    const requestId = 'req_verification_0001';
    const result = await ProductPublishService.publishProduct({
      draft,
      localImages,
      userId: 'u_test',
      requestId
    });
    assert(result.productId === 'p_verification', 'publish service did not return the product id');
    assert(uploadedPaths.length === 2, 'publish service did not upload every selected image');
    assert(uploadedPaths.every((cloudPath) => cloudPath.startsWith('products/u_test/')), 'publish upload paths are not user-scoped');
    assert(functionRequests.length === 1, 'publish service called createProduct an unexpected number of times');
    assert(functionRequests[0].name === 'createProduct', 'publish service called the wrong cloud function');
    assert(functionRequests[0].data.requestId === requestId, 'publish service dropped the idempotency key');
    assert(functionRequests[0].data.product.price === 29.9, 'publish service sent a non-numeric price');
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
    const reused = await ProductPublishService.publishProduct({
      draft,
      localImages,
      userId: 'u_test',
      requestId,
      pendingFileIds
    });
    assert(reused.reused === true, 'publish retry did not preserve server idempotency');
    assert(uploadedPaths.length === 2, 'publish retry uploaded the same images again');

    functionMode = 'failure';
    let databaseError;
    try {
      await ProductPublishService.publishProduct({
        draft,
        localImages: [localImages[0]],
        userId: 'u_test',
        requestId: 'req_verification_0002'
      });
    } catch (error) {
      databaseError = error;
    }
    assert(databaseError && databaseError.code === 'DATABASE_ERROR', 'publish service did not preserve the business error');
    assert(deletedFileLists.length === 1, 'publish failure did not clean its uploaded image');
    assert(deletedFileLists[0].length === 1, 'publish cleanup targeted the wrong image count');
    const refusedForeignDelete = await ProductPublishService.deleteCloudFiles([
      'cloud://test-env.bucket/products/u_other/20260717/foreign.jpg'
    ], 'u_test');
    assert(refusedForeignDelete === false, 'publish cleanup accepted another user directory');
    assert(deletedFileLists.length === 1, 'publish cleanup attempted to delete another user file');
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
  const products = new Map();
  let setCount = 0;

  const openId = 'verification-openid';
  const appId = 'verification-appid';
  const userId = `u_${crypto
    .createHash('sha256')
    .update(`${appId}:${openId}`)
    .digest('hex')
    .slice(0, 32)}`;
  users.set(userId, {
    _id: userId,
    nickname: '验收同学',
    avatarUrl: 'cloud://test-env.bucket/avatars/user.jpg',
    campus: '示例大学',
    status: 'active'
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
      images: [
        `cloud://test-env.bucket/products/${userId}/20260717/lamp.jpg`
      ],
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
    assert(storedProduct.sellerId === userId, 'createProduct trusted a spoofed seller id');
    assert(storedProduct.sellerOpenid === openId, 'createProduct trusted a spoofed seller openid');
    assert(storedProduct.sellerName === '验收同学', 'createProduct trusted a spoofed seller name');
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
    return Object.entries(condition).every(([key, value]) => record[key] === value);
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
  ['offline', 'sold', 'deleted'].forEach((status) => {
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
    for (const unavailableStatus of ['offline', 'sold']) {
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
    return Object.entries(condition).every(([key, value]) => record[key] === value);
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
  ['available', 'offline', 'sold', 'deleted'].forEach((status, index) => {
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
    assert(profile.data.profile.activeProductCount === 1, 'public active product count is incorrect');
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
    assert(productsResult.data.list.length === 1, 'public products include a non-available status');
    assert(productsResult.data.list[0].status === 'available', 'public products status is not available');
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

async function verifyAuthStateFlow() {
  const AuthService = require(path.join(root, 'services/auth-service'));
  const AuthStore = require(path.join(root, 'store/auth-store'));
  const originalWx = global.wx;
  const originalGetCurrentUser = AuthService.getCurrentUser;
  const originalLogin = AuthService.login;
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
    nickname: '微信用户',
    avatarUrl: '',
    avatarText: '微',
    campus: '',
    bio: '',
    role: 'user',
    status: 'active',
    profileCompleted: false,
    createdAt: '',
    updatedAt: '',
    lastLoginAt: ''
  };
  const loginUser = {
    ...restoredUser,
    id: 'u_login',
    nickname: '登录用户',
    avatarText: '登'
  };

  try {
    AuthStore.logout();
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

    AuthStore.logout();
    let loginCalls = 0;
    AuthService.login = async () => {
      loginCalls += 1;
      return loginUser;
    };
    const firstLogin = AuthStore.login();
    const secondLogin = AuthStore.login();
    assert(firstLogin === secondLogin, 'login does not reuse the active promise');
    await firstLogin;
    await Promise.resolve();
    assert(loginCalls === 1, 'duplicate login triggered multiple service calls');
    assert(AuthStore.getCurrentUser().id === loginUser.id, 'login user was not stored');

    AuthStore.logout();
    let resolveStaleCurrent;
    AuthService.getCurrentUser = () => new Promise((resolve) => {
      resolveStaleCurrent = resolve;
    });
    const staleBootstrap = AuthStore.bootstrap({ force: true });
    AuthService.login = async () => loginUser;
    await AuthStore.login();
    resolveStaleCurrent(restoredUser);
    await staleBootstrap;
    assert(
      AuthStore.getCurrentUser().id === loginUser.id,
      'stale current request overwrote a newer login'
    );

    AuthStore.logout();
    assert(!AuthStore.isLoggedIn(), 'logout did not return to anonymous state');
    assert(!storage.has('auth:user-summary'), 'logout did not clear the local summary');
  } finally {
    AuthService.getCurrentUser = originalGetCurrentUser;
    AuthService.login = originalLogin;
    AuthStore.logout();
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

record('project.private.config.json is ignored and not tracked', () => {
  const ignoreResult = spawnSync('git', ['check-ignore', 'project.private.config.json'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert(ignoreResult.status === 0, 'project.private.config.json is not ignored');

  const trackedResult = spawnSync('git', ['ls-files', '--error-unmatch', 'project.private.config.json'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert(trackedResult.status !== 0, 'project.private.config.json is tracked');
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
  await verifyFavoriteProductFunctionFlow();
  checks.push('PASS favoriteProduct transactions, idempotency, status rules, pagination and privacy flow');
  await verifyUserQueryFunctionFlow();
  checks.push('PASS userQuery public profile whitelist, safe id and available-product pagination flow');
  await verifyAuthStateFlow();
  checks.push('PASS AuthStore bootstrap, login, cache, concurrency and logout flow');
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
