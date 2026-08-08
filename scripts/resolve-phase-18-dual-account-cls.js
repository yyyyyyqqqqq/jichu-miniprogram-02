const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  PRIVATE_CANARY_PATH,
  USER_ID_PATTERN,
  SCHOOL_ID_PATTERN,
  loadJson,
  loadEnvironmentId,
  queryCollection
} = require('./phase-18-canary-core');
const {
  PRIVATE_DUAL_ACCOUNT_PATH,
  maskId,
  assert,
  writePrivateJson
} = require('./phase-18-dual-account-core');

const CLI_VERSION = '3.7.2';
const CHALLENGE_PATTERN = /^P18B-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const PRIVATE_PROOF_KEY_PATH = path.join(ROOT, 'tmp', 'phase-18-identity-proof-private.pem');

function parseArguments(argv) {
  const options = { challenge: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--challenge') options.challenge = String(argv[++index] || '').trim();
    else throw new Error(`unsupported argument: ${value}`);
  }
  assert(CHALLENGE_PATTERN.test(options.challenge), 'a valid one-time challenge is required');
  return options;
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  assert(start >= 0 && end > start, 'CLS did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

function searchChallengeLogs(environmentId, challenge, queryString = 'function_name:"productQuery"') {
  const windowsNpxCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npx-cli.js'
  );
  assert(fs.existsSync(windowsNpxCli), 'npm runner is unavailable');
  const result = spawnSync(process.execPath, [
    windowsNpxCli,
    '-y',
    '-p',
    `@cloudbase/cli@${CLI_VERSION}`,
    'cloudbase',
    'logs',
    'search',
    '--env-id',
    environmentId,
    '--query',
    queryString,
    '--timeRange',
    '30m',
    '--limit',
    '100',
    '--sort',
    'desc',
    '--json'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
  assert(!result.error, 'CLS log query failed to start');
  assert(result.status === 0, 'CLS log query failed');
  const parsed = parseCliJson(result.stdout);
  const results = parsed && parsed.data && parsed.data.results;
  assert(Array.isArray(results), 'CLS result list is invalid');
  return results;
}

function decryptIdentityProof(entries, challenge) {
  assert(fs.existsSync(PRIVATE_PROOF_KEY_PATH), 'private identity-proof key is missing');
  const ciphertexts = [];
  for (const entry of entries) {
    const serialized = JSON.stringify(entry && entry.content || {});
    if (!serialized.includes('[phase18-identity-proof]') || !serialized.includes(challenge)) continue;
    const candidates = serialized.match(/[A-Za-z0-9+/]{300,}={0,2}/g) || [];
    ciphertexts.push(...candidates);
  }
  const unique = [...new Set(ciphertexts)];
  const privateKey = fs.readFileSync(PRIVATE_PROOF_KEY_PATH, 'utf8');
  const proofs = [];
  for (const ciphertext of unique) {
    try {
      const plain = crypto.privateDecrypt({
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      }, Buffer.from(ciphertext, 'base64')).toString('utf8');
      const proof = JSON.parse(plain);
      if (
        proof.challenge === challenge
        && USER_ID_PATTERN.test(String(proof.userId || ''))
      ) {
        proofs.push(proof);
      }
    } catch (error) {
      // Other long Base64 log fields are not identity proofs.
    }
  }
  const userIds = [...new Set(proofs.map((proof) => proof.userId))];
  assert(userIds.length === 1, `the decrypted identity proof did not resolve uniquely (${userIds.length})`);
  return userIds[0];
}

function extractPlatformIdentity(entries, challenge) {
  const matches = entries.filter((entry) => {
    const content = entry && entry.content;
    const request = content && content.request;
    if (typeof request === 'string') return request.includes(challenge);
    return request && JSON.stringify(request).includes(challenge);
  });
  assert(matches.length > 0, 'the one-time challenge request was not found');
  const identities = matches
    .map((entry) => entry && entry.content && entry.content.user)
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  const unique = [...new Set(identities)];
  assert(unique.length === 1, 'the challenge did not resolve to exactly one platform identity');
  return unique[0];
}

function safeAccount(user) {
  return {
    userId: user._id,
    status: user.status,
    profileCompleted: user.profileCompleted === true,
    schoolId: user.schoolId,
    schoolName: user.schoolName,
    schoolVersion: Number(user.schoolVersion || 0)
  };
}

function validateAccount(account, label) {
  assert(account && USER_ID_PATTERN.test(String(account.userId || '')), `${label} internal userId is invalid`);
  assert(account.status === 'active', `${label} is not active`);
  assert(account.profileCompleted === true, `${label} profile is incomplete`);
  assert(SCHOOL_ID_PATTERN.test(String(account.schoolId || '')), `${label} schoolId is invalid`);
  assert(typeof account.schoolName === 'string' && account.schoolName.trim(), `${label} schoolName is missing`);
}

function run(options) {
  assert(fs.existsSync(PRIVATE_CANARY_PATH), 'private primary canary result is missing');
  const ignored = spawnSync('git', [
    'check-ignore',
    '--quiet',
    '--',
    path.relative(ROOT, PRIVATE_DUAL_ACCOUNT_PATH)
  ], { cwd: ROOT, windowsHide: true });
  assert(ignored.status === 0, 'private dual-account path is not protected by .gitignore');
  const proofKeyIgnored = spawnSync('git', [
    'check-ignore',
    '--quiet',
    '--',
    path.relative(ROOT, PRIVATE_PROOF_KEY_PATH)
  ], { cwd: ROOT, windowsHide: true });
  assert(proofKeyIgnored.status === 0, 'private identity-proof key is not protected by .gitignore');
  const primaryPrivate = loadJson(PRIVATE_CANARY_PATH);
  assert(USER_ID_PATTERN.test(String(primaryPrivate.userId || '')), 'primary private userId is invalid');
  const environmentId = loadEnvironmentId();
  const logs = searchChallengeLogs(
    environmentId,
    options.challenge,
    `function_name:"productQuery" AND "phase18-identity-proof"`
  );
  const accountBId = decryptIdentityProof(logs, options.challenge);
  assert(USER_ID_PATTERN.test(accountBId), 'derived account B internal userId is invalid');
  assert(accountBId !== primaryPrivate.userId, 'challenge request came from the primary account');

  const users = queryCollection(environmentId, 'users', {
    filter: { _id: { $in: [primaryPrivate.userId, accountBId] } },
    projection: {
      _id: 1,
      status: 1,
      profileCompleted: 1,
      schoolId: 1,
      schoolName: 1,
      schoolVersion: 1
    },
    limit: 4
  });
  assert(users.length === 2, 'accounts A and B did not both resolve authoritatively');
  const accountA = safeAccount(users.find((user) => user._id === primaryPrivate.userId));
  const accountB = safeAccount(users.find((user) => user._id === accountBId));
  validateAccount(accountA, 'account A');
  validateAccount(accountB, 'account B');

  for (const account of [accountA, accountB]) {
    const schools = queryCollection(environmentId, 'schools', {
      filter: { _id: account.schoolId },
      projection: { _id: 1, name: 1, platformStatus: 1, officialStatus: 1 },
      limit: 2
    });
    assert(schools.length === 1, 'account school did not resolve uniquely');
    assert(schools[0].name === account.schoolName, 'account school name is not authoritative');
    assert(
      schools[0].platformStatus === 'active' && schools[0].officialStatus === 'valid',
      'account school is not active/valid'
    );
  }

  const result = {
    schemaVersion: 1,
    resolvedAt: new Date().toISOString(),
    accountA,
    accountB,
    schoolsDiffer: accountA.schoolId !== accountB.schoolId,
    source: 'one-time productQuery challenge + RSA-encrypted internal identity proof',
    challengeSha256: crypto.createHash('sha256').update(options.challenge).digest('hex'),
    openidStored: false,
    rawLogsStored: false
  };
  writePrivateJson(PRIVATE_DUAL_ACCOUNT_PATH, result);
  return {
    passed: true,
    accountA: {
      userId: maskId(accountA.userId),
      schoolId: maskId(accountA.schoolId),
      schoolName: accountA.schoolName,
      status: accountA.status,
      profileCompleted: accountA.profileCompleted
    },
    accountB: {
      userId: maskId(accountB.userId),
      schoolId: maskId(accountB.schoolId),
      schoolName: accountB.schoolName,
      status: accountB.status,
      profileCompleted: accountB.profileCompleted
    },
    schoolsDiffer: result.schoolsDiffer,
    privatePathIgnored: true,
    openidStored: false,
    rawLogsStored: false
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'PHASE18_DUAL_ACCOUNT_CLS_RESOLVE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CLI_VERSION,
  CHALLENGE_PATTERN,
  parseArguments,
  parseCliJson,
  searchChallengeLogs,
  decryptIdentityProof,
  extractPlatformIdentity,
  run
};
