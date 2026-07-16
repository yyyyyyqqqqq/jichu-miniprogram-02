const PRODUCT_STATUS = {
  DRAFT: 'draft',
  AVAILABLE: 'available',
  // 保留旧名称，避免已有页面或开发数据因状态迁移失效。
  PUBLISHED: 'available',
  RESERVED: 'reserved',
  SOLD: 'sold',
  OFFLINE: 'offline',
  DELETED: 'deleted'
};

const PRODUCT_STATUS_META = {
  [PRODUCT_STATUS.DRAFT]: {
    text: '草稿',
    className: 'draft'
  },
  [PRODUCT_STATUS.AVAILABLE]: {
    text: '在售',
    className: 'available'
  },
  [PRODUCT_STATUS.RESERVED]: {
    text: '已预订',
    className: 'reserved'
  },
  [PRODUCT_STATUS.SOLD]: {
    text: '已出',
    className: 'sold'
  },
  [PRODUCT_STATUS.OFFLINE]: {
    text: '已下架',
    className: 'offline'
  },
  [PRODUCT_STATUS.DELETED]: {
    text: '已删除',
    className: 'deleted'
  }
};

const PUBLIC_PRODUCT_STATUSES = [
  PRODUCT_STATUS.AVAILABLE,
  PRODUCT_STATUS.RESERVED,
  PRODUCT_STATUS.SOLD
];

const PRODUCT_SORT = {
  DEFAULT: 'default',
  NEWEST: 'newest',
  PRICE_ASC: 'priceAsc',
  PRICE_DESC: 'priceDesc'
};

const PRODUCT_SORT_OPTIONS = [
  { value: PRODUCT_SORT.DEFAULT, label: '综合' },
  { value: PRODUCT_SORT.NEWEST, label: '最新' },
  { value: PRODUCT_SORT.PRICE_ASC, label: '价格升序' },
  { value: PRODUCT_SORT.PRICE_DESC, label: '价格降序' }
];

module.exports = {
  PRODUCT_STATUS,
  PRODUCT_STATUS_META,
  PUBLIC_PRODUCT_STATUSES,
  PRODUCT_SORT,
  PRODUCT_SORT_OPTIONS
};
