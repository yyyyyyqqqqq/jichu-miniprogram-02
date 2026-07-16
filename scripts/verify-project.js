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
    if (['.git', 'node_modules', 'miniprogram_npm'].includes(entry.name)) {
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

record('forbidden phase-one APIs and dependencies are absent', () => {
  const sourceRoots = [
    'app.js',
    'app.json',
    'components/',
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
    { pattern: /\bwx\.cloud\b/, label: 'wx.cloud' },
    { pattern: /@cloudbase\//, label: '@cloudbase' },
    { pattern: /tdesign-miniprogram/, label: 'tdesign-miniprogram' },
    { pattern: /\bopenid\b/i, label: 'hard-coded openid' }
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

record('Product model and service behavior are consistent', () => {
  const { PRODUCTS } = require(path.join(root, 'mock/index'));
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
    'publishedAtText',
    'status',
    'seller',
    'favoriteCount',
    'viewCount'
  ];

  assert(PRODUCTS.length >= 8, 'fewer than 8 Mock products');
  assert(new Set(PRODUCTS.map((product) => product.id)).size === PRODUCTS.length, 'duplicate Product id');
  for (const product of PRODUCTS) {
    for (const field of requiredFields) {
      assert(Object.prototype.hasOwnProperty.call(product, field), `${product.id || 'unknown'} missing ${field}`);
    }
    assert(!Object.prototype.hasOwnProperty.call(product, '_id'), `${product.id} contains _id`);
    assert(!Object.prototype.hasOwnProperty.call(product, 'productId'), `${product.id} contains productId`);
    assert(!Object.prototype.hasOwnProperty.call(product, 'goodsId'), `${product.id} contains goodsId`);
    assert(product.status === 'published', `${product.id} is not published`);
  }
});

async function verifyServiceFlow() {
  const ProductService = require(path.join(root, 'services/product-service'));

  const firstPage = await ProductService.getProducts({ page: 1, pageSize: 4 });
  assert(firstPage.list.length === 4, 'home first page did not return 4 products');
  assert(firstPage.hasMore === true, 'home first page should have more products');

  const digital = await ProductService.getProducts({ categoryId: 'digital', pageSize: 20 });
  assert(digital.list.length >= 2, 'digital category result is incomplete');
  assert(digital.list.every((product) => product.categoryId === 'digital'), 'category filter leaked data');

  const search = await ProductService.searchProducts('键盘');
  assert(search.list.some((product) => product.id === 'product-001'), 'search did not find product-001');

  const detail = await ProductService.getProductById('product-001');
  assert(detail && detail.id === 'product-001', 'detail lookup failed');

  const missing = await ProductService.getProductById('missing-product');
  assert(missing === null, 'missing detail should return null');
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

verifyServiceFlow()
  .then(() => {
    checks.push('PASS ProductService home, category, search and detail flow');
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
    errors.push(`ProductService flow: ${error.message}`);
    checks.forEach((message) => console.log(message));
    console.error('\nVerification failed:');
    errors.forEach((message) => console.error(`- ${message}`));
    process.exitCode = 1;
  });
