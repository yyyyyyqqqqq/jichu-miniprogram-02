const crypto = require('crypto');
const {
  callTcb
} = require('./phase-18-final-cutover-core');
const {
  runCloudBase,
  runNoSql,
  extractCommandResults,
  extractDocuments,
  decodeExtendedJson
} = require('./schools/cloud-cli');

const COLLECTION_NAMES = Object.freeze(['users', 'schools', 'products']);
const INDEX_DEFINITIONS = Object.freeze({
  schools: Object.freeze([
    Object.freeze({
      name: 'idx_officialCode_unique',
      unique: true,
      keys: Object.freeze([['officialCode', 1]])
    }),
    Object.freeze({
      name: 'idx_platformStatus_nameNormalized_id',
      unique: false,
      keys: Object.freeze([
        ['platformStatus', 1],
        ['nameNormalized', 1],
        ['_id', 1]
      ])
    }),
    Object.freeze({
      name: 'idx_school_active_name_id',
      unique: false,
      keys: Object.freeze([
        ['platformStatus', 1],
        ['officialStatus', 1],
        ['nameNormalized', 1],
        ['_id', 1]
      ])
    }),
    Object.freeze({
      name: 'idx_school_active_province_name_id',
      unique: false,
      keys: Object.freeze([
        ['platformStatus', 1],
        ['officialStatus', 1],
        ['province', 1],
        ['nameNormalized', 1],
        ['_id', 1]
      ])
    })
  ]),
  products: Object.freeze([
    Object.freeze({
      name: 'idx_school_status_favorite_view_createdAt_id',
      unique: false,
      keys: Object.freeze([
        ['schoolId', 1],
        ['status', 1],
        ['favoriteCount', -1],
        ['viewCount', -1],
        ['createdAt', -1],
        ['_id', 1]
      ])
    }),
    Object.freeze({
      name: 'idx_seller_school_status_createdAt_id',
      unique: false,
      keys: Object.freeze([
        ['sellerOpenid', 1],
        ['schoolId', 1],
        ['status', 1],
        ['createdAt', -1],
        ['_id', 1]
      ])
    })
  ])
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeIndex(index) {
  return {
    name: String(index.Name || index.name || ''),
    unique: index.Unique === true || index.unique === true || String(index.Name || index.name) === '_id_',
    sparse: index.Sparse === true
      || index.sparse === true
      || index.MgoIsSparse === true,
    keys: (index.Keys || Object.entries(index.key || {}).map(([Name, Direction]) => ({ Name, Direction })))
      .map((item) => [String(item.Name || ''), Number(item.Direction)])
  };
}

function indexMatches(actual, expected) {
  return actual.name === expected.name
    && actual.unique === expected.unique
    && (expected.sparse === undefined || actual.sparse === expected.sparse)
    && JSON.stringify(actual.keys) === JSON.stringify(expected.keys);
}

async function readTables(environmentId) {
  const result = await callTcb('DescribeTables', {
    EnvId: environmentId,
    MgoLimit: 100,
    MgoOffset: 0
  });
  return (result.Tables || []).map((item) => ({
    name: item.TableName || '',
    count: Number(item.Count || 0),
    indexCount: Number(item.IndexCount || 0)
  })).sort((left, right) => left.name.localeCompare(right.name));
}

async function readCollectionAcl(environmentId, collectionName) {
  const result = await callTcb('DescribeSafeRule', {
    EnvId: environmentId,
    CollectionName: collectionName
  });
  return result.AclTag || '';
}

async function readIndexes(environmentId, collectionName) {
  const result = await callTcb('DescribeTable', {
    EnvId: environmentId,
    TableName: collectionName
  });
  return (result.Indexes || []).map(normalizeIndex).sort((left, right) => left.name.localeCompare(right.name));
}

async function readStorage(environmentId) {
  const environments = await callTcb('DescribeEnvs', { EnvId: environmentId });
  const current = (environments.EnvList || []).find((item) => item.EnvId === environmentId);
  if (!current) throw Object.assign(new Error('environment was not returned by DescribeEnvs'), { code: 'ENVIRONMENT_NOT_FOUND' });
  const storage = Array.isArray(current.Storages) ? current.Storages[0] : null;
  if (!storage || !storage.Bucket) throw Object.assign(new Error('staging storage is unavailable'), { code: 'STORAGE_UNAVAILABLE' });
  const rule = await callTcb('DescribeStorageSafeRule', {
    EnvId: environmentId,
    Bucket: storage.Bucket
  });
  return {
    acl: rule.AclTag || '',
    customRule: Boolean(String(rule.Rule || '').trim()),
    bucketFingerprint: sha256(storage.Bucket).slice(0, 16)
  };
}

async function readResourceSnapshot(environmentId) {
  const tables = await readTables(environmentId);
  const tableNames = new Set(tables.map((item) => item.name));
  const acl = {};
  const indexes = {};
  for (const name of COLLECTION_NAMES) {
    if (!tableNames.has(name)) continue;
    acl[name] = await readCollectionAcl(environmentId, name);
    indexes[name] = await readIndexes(environmentId, name);
  }
  return { tables, acl, indexes, storage: await readStorage(environmentId) };
}

async function createCollection(environmentId, name) {
  return callTcb('CreateTable', {
    EnvId: environmentId,
    TableName: name,
    PermissionInfo: {
      AclTag: 'ADMINONLY',
      EnvId: environmentId
    }
  });
}

async function setCollectionAcl(environmentId, name) {
  return callTcb('ModifyDatabaseACL', {
    EnvId: environmentId,
    CollectionName: name,
    AclTag: 'ADMINONLY'
  });
}

async function createIndexes(environmentId, collectionName, definitions) {
  return callTcb('UpdateTable', {
    EnvId: environmentId,
    TableName: collectionName,
    CreateIndexes: definitions.map((definition) => ({
      IndexName: definition.name,
      MgoKeySchema: {
        MgoIndexKeys: definition.keys.map(([Name, Direction]) => ({
          Name,
          Direction: String(Direction)
        })),
        MgoIsUnique: definition.unique,
        MgoIsSparse: false
      }
    }))
  });
}

function setStorageReadonly(environmentId) {
  return runCloudBase([
    '--env-id', environmentId,
    'storage', 'set-acl',
    '--acl', 'READONLY',
    '--json'
  ]);
}

function queryCollection(environmentId, collectionName, filter = {}, limit = 100) {
  const response = runNoSql(environmentId, [{
    TableName: collectionName,
    CommandType: 'QUERY',
    Command: JSON.stringify({
      find: collectionName,
      filter,
      sort: { _id: 1 },
      limit
    })
  }]);
  const results = extractCommandResults(response);
  if (results.length === 0) return extractDocuments(response);
  return results.flatMap((item) => extractDocuments(item)).map(decodeExtendedJson);
}

function insertDocuments(environmentId, collectionName, documents) {
  return runNoSql(environmentId, [{
    TableName: collectionName,
    CommandType: 'INSERT',
    Command: JSON.stringify({
      insert: collectionName,
      documents,
      ordered: true
    })
  }]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  COLLECTION_NAMES,
  INDEX_DEFINITIONS,
  sha256,
  normalizeIndex,
  indexMatches,
  readTables,
  readCollectionAcl,
  readIndexes,
  readStorage,
  readResourceSnapshot,
  createCollection,
  setCollectionAcl,
  createIndexes,
  setStorageReadonly,
  queryCollection,
  insertDocuments,
  delay
};
