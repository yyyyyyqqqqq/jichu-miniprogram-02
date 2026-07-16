const fs = require('fs');
const path = require('path');
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

  ['authUser', 'productQuery'].forEach((functionName) => {
    const functionDirectory = path.join(root, functionRoot, functionName);
    ['index.js', 'package.json', 'package-lock.json'].forEach((name) => {
      assert(
        fs.existsSync(path.join(functionDirectory, name)),
        `${functionName}/${name} is missing`
      );
    });

    const functionPackage = readJson(path.join(functionDirectory, 'package.json'));
    assert(
      functionPackage.dependencies
      && typeof functionPackage.dependencies['wx-server-sdk'] === 'string',
      `${functionName} does not depend on wx-server-sdk`
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
  const seedSource = readText(path.join(root, 'cloudfunctions/productQuery/seed-products.js'));

  assert(/['"]list['"]/.test(source) && /['"]detail['"]/.test(source), 'productQuery actions are incomplete');
  assert(/status:\s*command\.in\(PUBLIC_STATUSES\)/.test(source), 'productQuery detail does not filter public statuses');
  assert(/\.skip\(offset\)\.limit\(pageSize\)/.test(source), 'productQuery does not use database pagination');
  assert(/\.count\(\)/.test(source), 'productQuery does not calculate a real total');
  assert(/PRODUCT_NOT_FOUND/.test(source), 'productQuery does not expose PRODUCT_NOT_FOUND');
  assert(/INVALID_PARAMS/.test(source), 'productQuery does not expose INVALID_PARAMS');
  assert(/DATABASE_ERROR/.test(source), 'productQuery does not expose DATABASE_ERROR');
  assert(!/wx\.cloud\.database/.test(source), 'productQuery uses a client database API');
  assert(/PRODUCT_SEED_ENABLED/.test(source), 'product seed action is not explicitly protected');
  assert(/SEED_PRODUCTS_V1/.test(source), 'product seed action lacks an explicit confirmation');
  assert((seedSource.match(/product-\d{3}/g) || []).length >= 10, 'product seed has fewer than ten fixtures');
  ['available', 'reserved', 'sold', 'offline'].forEach((status) => {
    assert(seedSource.includes(`'${status}'`), `product seed does not include ${status}`);
  });
  assert(/new Date\(createdAt\)/.test(seedSource), 'product seed timestamps are not real Date values');
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
    'pages/product-detail/index.js'
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

record('cloud function dependencies are ignored and not tracked', () => {
  ['authUser', 'productQuery'].forEach((functionName) => {
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
  const { SEED_PRODUCTS } = require(path.join(
    root,
    'cloudfunctions/productQuery/seed-products'
  ));
  const {
    PRODUCT_STATUS,
    PUBLIC_PRODUCT_STATUSES,
    PRODUCT_SORT
  } = require(path.join(root, 'constants/product'));
  const originalWx = global.wx;

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
          const filtered = SEED_PRODUCTS.filter((product) => (
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
          const product = SEED_PRODUCTS.find((item) => (
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
