const { PRODUCTS } = require('../mock/index');
const {
  PRODUCT_STATUS,
  PRODUCT_STATUS_META,
  PUBLIC_PRODUCT_STATUSES,
  PRODUCT_SORT
} = require('../constants/product');
const { delay } = require('../utils/async');
const {
  formatPrice,
  formatPublishedTime,
  formatCount
} = require('../utils/format');

const MOCK_DELAY = 70;
const DEFAULT_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 20;
const PUBLIC_STATUS_SET = new Set(PUBLIC_PRODUCT_STATUSES);
const SORT_SET = new Set(Object.values(PRODUCT_SORT));

function cloneProduct(product) {
  const statusMeta = PRODUCT_STATUS_META[product.status]
    || PRODUCT_STATUS_META[PRODUCT_STATUS.OFFLINE];
  const priceText = formatPrice(product.price);
  const originalPrice = Number(product.originalPrice);
  const hasOriginalPrice = Number.isFinite(originalPrice)
    && originalPrice > Number(product.price);

  return {
    ...product,
    priceText,
    priceDisplay: priceText === '免费送' ? priceText : `¥${priceText}`,
    originalPriceText: hasOriginalPrice ? formatPrice(originalPrice) : '',
    originalPriceDisplay: hasOriginalPrice ? `¥${formatPrice(originalPrice)}` : '',
    hasOriginalPrice,
    publishedAtText: formatPublishedTime(product.publishedAt),
    statusText: statusMeta.text,
    statusClass: statusMeta.className,
    isReserved: product.status === PRODUCT_STATUS.RESERVED,
    isSold: product.status === PRODUCT_STATUS.SOLD,
    displayTags: product.tags.slice(0, 2),
    favoriteCountText: formatCount(product.favoriteCount),
    viewCountText: formatCount(product.viewCount),
    images: [...product.images],
    tags: [...product.tags],
    seller: {
      ...product.seller,
      initial: product.seller.nickname
        ? product.seller.nickname.slice(0, 1)
        : '校'
    }
  };
}

function normalizePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.floor(number), maximum);
}

function normalizeKeyword(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLowerCase()
    : '';
}

function normalizeCategoryId(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : 'all';
}

function normalizeSortBy(value) {
  return SORT_SET.has(value) ? value : PRODUCT_SORT.DEFAULT;
}

function normalizeStatuses(value) {
  if (value === undefined || value === null || value === '') {
    return PUBLIC_PRODUCT_STATUSES;
  }

  const requested = Array.isArray(value) ? value : [value];
  return requested.filter((status) => PUBLIC_STATUS_SET.has(status));
}

function matchesKeyword(product, keyword) {
  if (!keyword) {
    return true;
  }

  const searchableText = [
    product.title,
    product.description,
    product.categoryName,
    product.condition,
    product.locationName,
    ...product.tags
  ].join(' ').replace(/\s+/g, ' ').toLowerCase();

  return keyword.split(' ').every((token) => searchableText.includes(token));
}

function sortProducts(products, sortBy) {
  const list = [...products];

  if (sortBy === PRODUCT_SORT.NEWEST) {
    return list.sort((left, right) => (
      new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime()
    ));
  }

  if (sortBy === PRODUCT_SORT.PRICE_ASC) {
    return list.sort((left, right) => (
      Number(left.price) - Number(right.price)
      || new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime()
    ));
  }

  if (sortBy === PRODUCT_SORT.PRICE_DESC) {
    return list.sort((left, right) => (
      Number(right.price) - Number(left.price)
      || new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime()
    ));
  }

  return list;
}

async function getProducts(options = {}) {
  await delay(MOCK_DELAY);

  const categoryId = normalizeCategoryId(options.categoryId);
  const keyword = normalizeKeyword(options.keyword);
  const sortBy = normalizeSortBy(options.sortBy);
  const statuses = normalizeStatuses(options.status);
  const statusSet = new Set(statuses);
  const page = normalizePositiveInteger(options.page, 1);
  const pageSize = normalizePositiveInteger(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );

  const filtered = PRODUCTS.filter((product) => {
    const matchesStatus = statusSet.has(product.status)
      && PUBLIC_STATUS_SET.has(product.status);
    const matchesCategory = categoryId === 'all'
      || product.categoryId === categoryId;
    return matchesStatus
      && matchesCategory
      && matchesKeyword(product, keyword);
  });
  const sorted = sortProducts(filtered, sortBy);
  const start = (page - 1) * pageSize;
  const list = sorted.slice(start, start + pageSize).map(cloneProduct);

  return {
    list,
    total: sorted.length,
    page,
    pageSize,
    hasMore: start + list.length < sorted.length
  };
}

async function getProductById(id) {
  await delay(MOCK_DELAY);

  if (id === null || id === undefined) {
    return null;
  }

  const normalizedId = String(id).trim();
  if (!normalizedId) {
    return null;
  }

  const product = PRODUCTS.find((item) => (
    item.id === normalizedId && PUBLIC_STATUS_SET.has(item.status)
  ));

  return product ? cloneProduct(product) : null;
}

async function searchProducts(keyword) {
  return getProducts({
    keyword,
    page: 1,
    pageSize: MAX_PAGE_SIZE
  });
}

module.exports = {
  getProducts,
  getProductById,
  searchProducts
};
