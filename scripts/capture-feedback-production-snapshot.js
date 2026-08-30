'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, runPreflight, publicSummary, assert } = require('./environment-preflight');
const { queryAll } = require('./final-release-product-cleanup-dry-run');
const {
  EXPECTED_TOTAL,
  hashRecords,
  countBy,
  validateSource,
  compareProductionSchools,
  assertProductionIntegrity,
  readAllSchools,
  safeWriteJson,
  stableStringify
} = require('./final-release-step-3b-core');
const { readTables, readCollectionAcl, readIndexes, indexMatches } = require('./phase-24-staging-core');
const { readFunctionDetail } = require('./phase-18-canary-core');

const COLLECTIONS = Object.freeze([
  'users', 'products', 'favorites', 'conversations', 'messages',
  'appointments', 'schools', 'productViews'
]);
const APPROVED_SOURCE_SHA256 = '2f34e04a346bc554e1f15f660727f10281dddb0533880c34a5e3fc04812a7688';
const REQUIRED_INDEX = Object.freeze({
  name: 'idx_userOpenid_createdAt',
  unique: false,
  sparse: false,
  keys: Object.freeze([['userOpenid', 1], ['createdAt', -1]])
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = { environmentName: '', phase: '', baseline: '', output: '', allowLiveFeedback: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--env') options.environmentName = String(argv[++index] || '').trim();
    else if (value === '--phase') options.phase = String(argv[++index] || '').trim();
    else if (value === '--baseline') options.baseline = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--output') options.output = path.resolve(ROOT, String(argv[++index] || ''));
    else if (value === '--allow-live-feedback') options.allowLiveFeedback = true;
    else throw Object.assign(new Error(`unsupported argument: ${value}`), { code: 'INVALID_ARGUMENT' });
  }
  assert(options.environmentName === 'production', '--env production is required', 'PRODUCTION_TARGET_REQUIRED');
  assert(['pre', 'post'].includes(options.phase), '--phase pre|post is required', 'INVALID_PHASE');
  options.output = options.output || path.join(ROOT, 'tmp', `feedback-production-${options.phase}.json`);
  if (options.phase === 'post') {
    options.baseline = options.baseline || path.join(ROOT, 'tmp', 'feedback-production-pre.json');
  }
  return options;
}

function readFunction(environmentId) {
  try {
    const detail = readFunctionDetail(environmentId, 'feedbackAction');
    const variables = Object.fromEntries((detail.Environment && detail.Environment.Variables || [])
      .map((item) => [String(item.Key || item.key || ''), String(item.Value || item.value || '')])
      .filter(([key]) => key));
    return {
      exists: true,
      status: String(detail.Status || ''),
      availableStatus: String(detail.AvailableStatus || ''),
      runtime: String(detail.Runtime || ''),
      handler: String(detail.Handler || ''),
      timeout: Number(detail.Timeout || 0),
      memorySize: Number(detail.MemorySize || 0),
      sourceSha256: sha256(Buffer.from(String(detail.CodeInfo || ''), 'utf8')),
      environmentVariableKeys: Object.keys(variables).sort(),
      credentialConfigured: Boolean(variables.FEEDBACK_MAIL_USER && variables.FEEDBACK_MAIL_SECRET),
      productionMarker: variables.FEEDBACK_ENVIRONMENT === 'production'
    };
  } catch (error) {
    if (/RESOURCE_NOT_FOUND|Function does not exist|not found|not exist/i.test(String(error && error.message || error))) {
      return { exists: false };
    }
    throw error;
  }
}

async function run(options) {
  const preflight = runPreflight({ environmentName: 'production', action: 'audit' });
  const targets = require('../config/cloud.targets.private');
  assert(preflight.activeTargetMatches && preflight.environmentId === targets.production,
    'active target must be registered production', 'ACTIVE_ENVIRONMENT_MISMATCH');
  assert(preflight.environmentId !== targets.staging, 'production and staging targets overlap', 'ENVIRONMENT_COLLISION');

  const records = Object.fromEntries(COLLECTIONS.map((name) => [
    name,
    name === 'schools' ? readAllSchools(preflight.environmentId) : queryAll(preflight.environmentId, name, undefined)
  ]));
  const collections = Object.fromEntries(COLLECTIONS.map((name) => [name, {
    count: records[name].length,
    sha256: hashRecords(records[name])
  }]));
  const productStatusCounts = countBy(records.products, 'status');
  const publicVisible = records.products.filter((row) => ['available', 'reserved'].includes(row.status)).length;
  assert(publicVisible === 0, 'PUBLIC MARKET ZERO drifted', 'PUBLIC_MARKET_ZERO_FAILED');

  const { records: normalizedSchools } = validateSource();
  const schoolIntegrity = compareProductionSchools(normalizedSchools, records.schools);
  assertProductionIntegrity(schoolIntegrity);
  assert(records.schools.length === EXPECTED_TOTAL, 'school total drifted', 'SCHOOL_COUNT_DRIFT');

  const tables = await readTables(preflight.environmentId);
  const feedbackTable = tables.find((item) => item.name === 'feedbacks') || null;
  const feedbackFunction = readFunction(preflight.environmentId);
  let feedback = { exists: false, count: 0, acl: '', indexes: [] };
  if (feedbackTable) {
    feedback = {
      exists: true,
      count: feedbackTable.count,
      acl: await readCollectionAcl(preflight.environmentId, 'feedbacks'),
      indexes: await readIndexes(preflight.environmentId, 'feedbacks')
    };
  }

  if (options.phase === 'pre') {
    assert(!feedback.exists, 'production feedbacks already exists', 'PRODUCTION_FEEDBACK_BASELINE_DRIFT');
    assert(!feedbackFunction.exists, 'production feedbackAction already exists', 'PRODUCTION_FUNCTION_BASELINE_DRIFT');
  } else {
    assert(fs.existsSync(options.baseline), 'production PRE snapshot is missing', 'PRODUCTION_BASELINE_MISSING');
    const baseline = JSON.parse(fs.readFileSync(options.baseline, 'utf8'));
    const changedCollections = COLLECTIONS.filter((name) => (
      stableStringify(baseline.collections[name]) !== stableStringify(collections[name])
    ));
    assert(changedCollections.length === 0, `existing production collections changed: ${changedCollections.join(', ')}`,
      'UNEXPECTED_PRODUCTION_MUTATION');
    const required = feedback.indexes.find((item) => item.name === REQUIRED_INDEX.name);
    assert(feedback.exists && feedback.acl === 'ADMINONLY',
      'production feedback collection final state drifted', 'FEEDBACK_RESOURCE_DRIFT');
    assert(options.allowLiveFeedback || feedback.count === 0,
      'production feedback collection contains live records', 'LIVE_FEEDBACK_PRESENT');
    assert(required && indexMatches(required, REQUIRED_INDEX), 'production feedback index final state drifted', 'FEEDBACK_INDEX_DRIFT');
    assert(feedbackFunction.exists
      && feedbackFunction.status === 'Active'
      && feedbackFunction.availableStatus === 'Available'
      && feedbackFunction.runtime === 'Nodejs18.15'
      && feedbackFunction.handler === 'index.main'
      && feedbackFunction.timeout === 20
      && feedbackFunction.memorySize === 256
      && feedbackFunction.sourceSha256 === APPROVED_SOURCE_SHA256
      && feedbackFunction.credentialConfigured
      && feedbackFunction.productionMarker,
    'production feedbackAction final state drifted', 'FEEDBACK_FUNCTION_DRIFT');
  }

  const result = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    mode: `FEEDBACK_PRODUCTION_${options.phase.toUpperCase()}_SNAPSHOT`,
    environment: publicSummary(preflight),
    collections,
    products: { statusCounts: productStatusCounts, publicVisible, publicMarketZero: true },
    schools: {
      total: records.schools.length,
      active: Number(schoolIntegrity.statusCounts.active || 0),
      pending: Number(schoolIntegrity.statusCounts.pending || 0),
      officialDrift: schoolIntegrity.different,
      identityConflicts: schoolIntegrity.identityConflicts
    },
    feedback,
    feedbackFunction,
    liveFeedbackAllowed: options.allowLiveFeedback,
    existingCollectionsChanged: [],
    productionWrites: 0,
    passed: true
  };
  safeWriteJson(options.output, result);
  return result;
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify({
      mode: result.mode,
      environment: result.environment,
      collections: result.collections,
      products: result.products,
      schools: result.schools,
      feedback: result.feedback,
      feedbackFunction: result.feedbackFunction,
      productionWrites: result.productionWrites,
      passed: result.passed
    }, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || 'FEEDBACK_PRODUCTION_SNAPSHOT_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { COLLECTIONS, APPROVED_SOURCE_SHA256, REQUIRED_INDEX, parseArguments, run };
