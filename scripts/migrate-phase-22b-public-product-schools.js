const path = require('path');
const core = require('./phase-18-data-migration-core');

function exactIdsEqual(left, right) {
  return left.length === right.length
    && [...left].sort().every((id, index) => id === [...right].sort()[index]);
}

function verifyAlreadyApplied(context, section) {
  if (!section || !Array.isArray(section.candidates) || section.candidates.length !== core.EXPECTED_PUBLIC_PRODUCTS) return null;
  const records = core.queryExact(
    context.environmentId,
    'products',
    section.candidates.map((item) => item.productId),
    core.PRODUCT_PROJECTION
  );
  if (records.length !== core.EXPECTED_PUBLIC_PRODUCTS) return null;
  const beforeById = new Map(section.candidates.map((item) => [item.productId, item.before]));
  const allApplied = records.every((product) => {
    const before = beforeById.get(product._id);
    return before
      && product.schoolId === context.targetSchool._id
      && product.schoolName === context.targetSchool.name
      && core.productProtectedFingerprint(product) === before.protectedFingerprint;
  });
  return allApplied ? records : null;
}

function run(options) {
  const context = core.prepareContext(options);
  const existing = core.loadPrivateResult(options.output);
  const appliedRecords = verifyAlreadyApplied(context, existing && existing.products);
  if (appliedRecords) {
    core.updatePrivateResult(options.output, {
      readinessAfter: core.readinessSummary(context.report),
      products: Object.assign({}, existing.products, {
        idempotentRerunAt: new Date().toISOString(),
        idempotentChangedCount: 0
      })
    });
    return {
      mode: 'already-applied',
      target: `cloud:${context.targetMasked}`,
      targetSchool: core.publicTargetSchool(context.targetSchool),
      expectedProducts: core.EXPECTED_PUBLIC_PRODUCTS,
      actualNotReadyProducts: context.report.businessProductsExcludingFixtures.publicNotStrictReady,
      changed: 0,
      skipped: appliedRecords.length,
      failed: 0,
      writesExecuted: false
    };
  }

  const plan = core.buildProductPlan(context);
  const publicPlan = plan.map((item) => ({
    productId: core.maskId(item.productId),
    title: item.before.title,
    sellerId: core.maskId(item.before.sellerId),
    status: item.before.status,
    currentSchoolId: item.before.schoolId ? core.maskId(item.before.schoolId) : '',
    currentSchoolName: item.before.schoolName,
    targetSchool: context.targetSchool.name,
    reason: 'owner-authorized-public-history-backfill'
  }));

  if (!options.apply) {
    core.updatePrivateResult(options.output, {
      target: `cloud:${context.targetMasked}`,
      targetSchool: core.privateTargetSchool(context.targetSchool),
      readinessBefore: existing && existing.readinessBefore
        ? existing.readinessBefore
        : core.readinessSummary(context.report),
      products: {
        dryRunAt: new Date().toISOString(),
        expectedCount: core.EXPECTED_PUBLIC_PRODUCTS,
        actualCount: plan.length,
        candidates: plan,
        applyAt: null,
        changedCount: 0,
        skippedCount: 0,
        failedCount: 0
      }
    });
    return {
      mode: 'dry-run',
      target: `cloud:${context.targetMasked}`,
      targetSchool: core.publicTargetSchool(context.targetSchool),
      expectedProducts: core.EXPECTED_PUBLIC_PRODUCTS,
      actualProducts: plan.length,
      writesPlanned: plan.length,
      writesExecuted: false,
      products: publicPlan,
      privateOutput: path.relative(core.ROOT, options.output).replace(/\\/g, '/')
    };
  }

  core.assert(existing && existing.products, 'run product migration dry-run before apply');
  core.assert(
    exactIdsEqual(plan.map((item) => item.productId), existing.products.candidates.map((item) => item.productId)),
    'product migration plan changed after dry-run'
  );
  const storedBefore = new Map(existing.products.candidates.map((item) => [item.productId, item.before]));
  plan.forEach((item) => {
    core.assert(
      item.before.protectedFingerprint === storedBefore.get(item.productId).protectedFingerprint,
      'product protected fields changed after dry-run'
    );
  });
  const current = core.queryExact(context.environmentId, 'products', plan.map((item) => item.productId), core.PRODUCT_PROJECTION);
  const currentById = new Map(current.map((item) => [item._id, item]));
  const updates = plan.map((item) => {
    const product = currentById.get(item.productId);
    core.assert(product && ['available', 'reserved'].includes(product.status), 'product is no longer public');
    core.assert(!String(product.title || '').startsWith('阶段18同校灰度-'), 'fixture entered product migration apply');
    core.assert(!String(product.schoolId || '').trim(), 'product no longer satisfies apply condition');
    return {
      q: {
        _id: product._id,
        title: product.title,
        sellerId: product.sellerId,
        status: product.status,
        price: product.price,
        schoolId: core.missingFieldCondition(product, 'schoolId'),
        schoolName: core.missingFieldCondition(product, 'schoolName')
      },
      u: {
        $set: {
          schoolId: context.targetSchool._id,
          schoolName: context.targetSchool.name
        },
        $currentDate: { updatedAt: true }
      },
      multi: false,
      upsert: false
    };
  });
  core.applyUpdates(context.environmentId, 'products', updates);
  const after = core.queryExact(context.environmentId, 'products', plan.map((item) => item.productId), core.PRODUCT_PROJECTION);
  const beforeById = new Map(plan.map((item) => [item.productId, item.before]));
  after.forEach((product) => {
    const before = beforeById.get(product._id);
    core.assert(product.schoolId === context.targetSchool._id && product.schoolName === context.targetSchool.name, 'product school readback failed');
    core.assert(core.productProtectedFingerprint(product) === before.protectedFingerprint, 'product protected fields changed');
  });
  const afterContext = core.prepareContext(options);
  core.updatePrivateResult(options.output, {
    readinessAfter: core.readinessSummary(afterContext.report),
    products: Object.assign({}, existing.products, {
      applyAt: new Date().toISOString(),
      changedCount: after.length,
      skippedCount: 0,
      failedCount: 0,
      after: after.map((product) => ({
        productId: product._id,
        schoolId: product.schoolId,
        schoolName: product.schoolName,
        status: product.status,
        sellerId: product.sellerId,
        price: product.price,
        createdAt: product.createdAt || null,
        protectedFingerprint: core.productProtectedFingerprint(product)
      }))
    })
  });
  return {
    mode: 'applied',
    target: `cloud:${context.targetMasked}`,
    targetSchool: core.publicTargetSchool(context.targetSchool),
    expectedProducts: core.EXPECTED_PUBLIC_PRODUCTS,
    actualProducts: plan.length,
    changed: after.length,
    skipped: 0,
    failed: 0,
    statusPreserved: true,
    sellerPreserved: true,
    pricePreserved: true,
    createdAtPreserved: true,
    products: after.map((product) => core.maskId(product._id)),
    readinessAfter: core.readinessSummary(afterContext.report),
    privateOutput: path.relative(core.ROOT, options.output).replace(/\\/g, '/')
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(core.parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE22B_PRODUCT_SCHOOL_MIGRATION_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run, verifyAlreadyApplied, exactIdsEqual };
