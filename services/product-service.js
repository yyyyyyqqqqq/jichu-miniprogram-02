const { PRODUCTS } = require('../mock/index');
const { PRODUCT_STATUS } = require('../constants/product');
const { delay } = require('../utils/async');
const { formatPrice } = require('../utils/format');

const MOCK_DELAY = 80;
const DEFAULT_PAGE_SIZE = 6;

function cloneProduct(product) {
  return {
    ...product,
    priceText: formatPrice(product.price),
    originalPriceText: formatPrice(product.originalPrice),
    images: [...product.images],
    tags: [...product.tags],
    seller: {
      ...product.seller,
      initial: product.seller.nickname ? product.seller.nickname.slice(0, 1) : '校'
    }
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.floor(number);
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
    ...product.tags
  ].join(' ').toLowerCase();

  return searchableText.includes(keyword);
}

async function getProducts(options = {}) {
  await delay(MOCK_DELAY);

  const categoryId = typeof options.categoryId === 'string'
    ? options.categoryId.trim()
    : 'all';
  const keyword = typeof options.keyword === 'string'
    ? options.keyword.trim().toLowerCase()
    : '';
  const page = normalizePositiveInteger(options.page, 1);
  const pageSize = normalizePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE);

  const filtered = PRODUCTS.filter((product) => {
    const isPublished = product.status === PRODUCT_STATUS.PUBLISHED;
    const matchesCategory = !categoryId
      || categoryId === 'all'
      || product.categoryId === categoryId;
    return isPublished && matchesCategory && matchesKeyword(product, keyword);
  });

  const start = (page - 1) * pageSize;
  const list = filtered.slice(start, start + pageSize).map(cloneProduct);

  return {
    list,
    total: filtered.length,
    page,
    pageSize,
    hasMore: start + list.length < filtered.length
  };
}

async function getProductById(id) {
  await delay(MOCK_DELAY);
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!normalizedId) {
    return null;
  }

  const product = PRODUCTS.find((item) => (
    item.id === normalizedId && item.status === PRODUCT_STATUS.PUBLISHED
  ));
  return product ? cloneProduct(product) : null;
}

async function searchProducts(keyword) {
  return getProducts({
    keyword,
    page: 1,
    pageSize: PRODUCTS.length
  });
}

module.exports = {
  getProducts,
  getProductById,
  searchProducts
};
