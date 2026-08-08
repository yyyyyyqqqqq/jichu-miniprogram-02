const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('./phase-18-data-migration-core');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function check(value, message) {
  assert(value, message);
  checks += 1;
}

const baseProduct = {
  title: '历史商品',
  description: '历史商品描述',
  sellerId: 'u_owner',
  status: 'available',
  price: 10,
  categoryId: 'books',
  categoryName: '书籍',
  condition: '九成新',
  images: ['cloud://image'],
  favoriteCount: 2,
  viewCount: 3,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  schoolId: '',
  schoolName: ''
};
const fingerprint = core.productProtectedFingerprint(baseProduct);
check(
  fingerprint === core.productProtectedFingerprint({
    ...baseProduct,
    schoolId: 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    schoolName: '上海工程技术大学',
    updatedAt: '2026-08-07T00:00:00.000Z'
  }),
  'allowed school backfill affects protected product fingerprint'
);
['status', 'sellerId', 'price', 'createdAt', 'title'].forEach((field) => {
  const changed = { ...baseProduct, [field]: `${baseProduct[field]}-changed` };
  if (field === 'price') changed[field] = 99;
  check(fingerprint !== core.productProtectedFingerprint(changed), `${field} is not protected`);
});

const coreSource = fs.readFileSync(path.join(ROOT, 'scripts', 'phase-18-data-migration-core.js'), 'utf8');
const productSource = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate-phase-22b-public-product-schools.js'), 'utf8');
check(/EXPECTED_PUBLIC_PRODUCTS = 20/.test(coreSource), 'Phase 22B expected-count is not 20');
check(/PUBLIC_STATUSES\.has\(product\.status\)/.test(coreSource), 'public status filter is missing');
check(/!normalizeText\(product\.title\)\.startsWith\(FIXTURE_PREFIX\)/.test(coreSource), 'fixture exclusion is missing');
check(/state === 'missing'/.test(coreSource), 'migration does not reject invalid non-missing school states');
check(/run product migration dry-run before apply/.test(productSource), 'product apply does not require dry-run');
check(/multi:\s*false/.test(productSource) && /upsert:\s*false/.test(productSource), 'product migration write is multi or upsert');
check(!/updateMany|multi:\s*true|upsert:\s*true/.test(productSource), 'product migration contains a broad write');
check(/statusPreserved:\s*true/.test(productSource), 'status preservation evidence is missing');
check(/sellerPreserved:\s*true/.test(productSource), 'seller preservation evidence is missing');
check(/pricePreserved:\s*true/.test(productSource), 'price preservation evidence is missing');
check(/createdAtPreserved:\s*true/.test(productSource), 'createdAt preservation evidence is missing');
check(/idempotentChangedCount:\s*0/.test(productSource), 'product idempotency result is missing');
check(!/\$set:[\s\S]{0,180}(?:status|sellerId|price|createdAt)\s*:/.test(productSource), 'product migration writes a protected field');

process.stdout.write(`Phase 22B public product migration verification succeeded: ${checks} checks passed.\n`);
