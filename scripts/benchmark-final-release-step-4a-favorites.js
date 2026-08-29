const fs = require('fs');
const path = require('path');
const Module = require('module');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const FUNCTION_PATH = path.join(ROOT, 'cloudfunctions', 'favoriteProduct', 'index.js');
const ITERATIONS = 7;
const PAGE_SIZE = 10;
const DOCUMENT_DELAY_MS = 20;

function parseOutputPath(argv) {
  const index = argv.indexOf('--output');
  if (index === -1 || !argv[index + 1]) {
    return '';
  }
  return path.resolve(ROOT, argv[index + 1]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return Number(sorted[index].toFixed(2));
}

function createProduct(index) {
  return {
    _id: `product-${index}`,
    title: `收藏商品 ${index}`,
    price: index,
    originalPrice: index + 10,
    coverImage: `cloud://fixture/product-${index}.jpg`,
    category: 'books',
    condition: 'good',
    description: 'Step 4A read-only performance fixture',
    schoolId: 's_00000000000000000000000000000000',
    schoolName: '性能基准学校',
    campus: '主校区',
    tradeLocation: '校内',
    distanceText: '1km',
    sellerId: `seller-${index}`,
    sellerName: `卖家 ${index}`,
    sellerAvatar: '',
    sellerVerified: true,
    status: 'available',
    tags: ['benchmark'],
    viewCount: index,
    favoriteCount: index,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-02T00:00:00.000Z')
  };
}

function createCloudMock() {
  const relations = Array.from({ length: PAGE_SIZE }, (_, index) => ({
    _id: `favorite-${index}`,
    productId: `product-${index}`,
    userOpenid: 'benchmark-openid',
    createdAt: new Date(Date.UTC(2026, 7, 20, 0, 0, PAGE_SIZE - index))
  }));
  const productMap = new Map(
    relations.map((relation, index) => [relation.productId, createProduct(index)])
  );

  function createFavoriteQuery() {
    return {
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      skip() {
        return this;
      },
      limit() {
        return this;
      },
      async count() {
        return { total: relations.length };
      },
      async get() {
        return { data: relations };
      }
    };
  }

  const database = {
    collection(name) {
      if (name === 'favorites') {
        return createFavoriteQuery();
      }
      if (name === 'products') {
        return {
          doc(productId) {
            return {
              async get() {
                await delay(DOCUMENT_DELAY_MS);
                return { data: productMap.get(productId) || null };
              }
            };
          }
        };
      }
      return {
        doc() {
          return {
            async get() {
              return { data: null };
            }
          };
        }
      };
    },
    async runTransaction(callback) {
      return callback(database);
    },
    serverDate() {
      return new Date();
    }
  };

  return {
    DYNAMIC_CURRENT_ENV: 'benchmark',
    init() {},
    database() {
      return database;
    },
    getWXContext() {
      return {
        OPENID: 'benchmark-openid',
        APPID: 'benchmark-appid'
      };
    }
  };
}

async function main() {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const originalLoad = Module._load;
  Module._load = function loadWithCloudMock(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return createCloudMock();
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let favoriteProduct;
  try {
    delete require.cache[require.resolve(FUNCTION_PATH)];
    favoriteProduct = require(FUNCTION_PATH);
  } finally {
    Module._load = originalLoad;
  }

  const durations = [];
  let expectedIds = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now();
    const response = await favoriteProduct.main({
      action: 'listMyFavorites',
      data: { page: 1, pageSize: PAGE_SIZE }
    });
    durations.push(performance.now() - startedAt);
    if (!response.success || response.data.list.length !== PAGE_SIZE) {
      throw new Error(`Favorite list benchmark failed at iteration ${index + 1}`);
    }
    const ids = response.data.list.map((item) => item.id);
    if (index === 0) {
      expectedIds = ids;
    } else if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
      throw new Error('Favorite list order changed between benchmark iterations');
    }
  }

  const report = {
    benchmark: 'final-release-step-4a-favorite-hydration',
    generatedAt: new Date().toISOString(),
    dataSource: 'local deterministic read-only wx-server-sdk mock',
    iterations: ITERATIONS,
    pageSize: PAGE_SIZE,
    documentDelayMs: DOCUMENT_DELAY_MS,
    expectedSerialFloorMs: PAGE_SIZE * DOCUMENT_DELAY_MS,
    measurementsMs: durations.map((value) => Number(value.toFixed(2))),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: percentile(durations, 1),
    resultCount: expectedIds.length,
    stableOrder: true,
    businessWrites: 0
  };

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
