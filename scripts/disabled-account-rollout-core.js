'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  ROOT,
  assert,
  maskIdentifier
} = require('./environment-preflight');

const PRIVATE_ROOT = path.join(ROOT, 'tmp');
const HOTFIX_FUNCTION_CANDIDATES = Object.freeze([
  'authUser',
  'productQuery',
  'userQuery',
  'manageProduct',
  'favoriteProduct',
  'productViewAction',
  'messageQuery',
  'messageAction',
  'appointmentQuery',
  'appointmentAction',
  'feedbackAction'
]);
const PRODUCTION_FUNCTION_NAMES = Object.freeze([
  'authUser',
  'productQuery',
  'createProduct',
  'manageProduct',
  'favoriteProduct',
  'userQuery',
  'productViewAction',
  'messageQuery',
  'messageAction',
  'appointmentQuery',
  'appointmentAction',
  'schoolQuery',
  'feedbackAction'
]);
const PRODUCTION_COLLECTION_NAMES = Object.freeze([
  'users',
  'products',
  'favorites',
  'conversations',
  'messages',
  'appointments',
  'schools',
  'productViews',
  'feedbacks'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isPathInside(parent, candidate) {
  const parentPath = path.resolve(parent);
  const candidatePath = path.resolve(candidate);
  return candidatePath === parentPath
    || candidatePath.startsWith(`${parentPath}${path.sep}`);
}

function resolvePrivatePath(value, fallback, extension = '.json') {
  const resolved = path.resolve(ROOT, String(value || fallback || ''));
  assert(isPathInside(PRIVATE_ROOT, resolved), 'private artifact must stay under tmp/', 'PRIVATE_PATH_OUTSIDE_TMP');
  if (extension) {
    assert(path.extname(resolved).toLowerCase() === extension, `private artifact must be ${extension}`, 'PRIVATE_PATH_EXTENSION_INVALID');
  }
  return resolved;
}

function assertPrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  assert(isPathInside(PRIVATE_ROOT, resolved), 'private directory escaped tmp/', 'PRIVATE_PATH_OUTSIDE_TMP');
  if (!fs.existsSync(resolved)) return resolved;
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'private directory is unsafe', 'PRIVATE_DIRECTORY_UNSAFE');
  return resolved;
}

function assertSafeTemporaryDirectory(directory, prefix) {
  const resolved = path.resolve(directory);
  assert(isPathInside(os.tmpdir(), resolved) && resolved !== path.resolve(os.tmpdir()), 'temporary directory escaped OS temp', 'TEMP_DIRECTORY_UNSAFE');
  assert(path.basename(resolved).startsWith(prefix), 'temporary directory prefix mismatch', 'TEMP_DIRECTORY_UNSAFE');
  const stat = fs.lstatSync(resolved);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'temporary directory is unsafe', 'TEMP_DIRECTORY_UNSAFE');
  return resolved;
}

function removeSafeTemporaryDirectory(directory, prefix) {
  if (!fs.existsSync(directory)) return;
  assertSafeTemporaryDirectory(directory, prefix);
  fs.rmSync(directory, { recursive: true, force: false });
}

function writePrivateJson(filePath, value) {
  const resolved = resolvePrivatePath(filePath, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return resolved;
}

function readJson(filePath, code = 'PRIVATE_ARTIFACT_MISSING') {
  const resolved = path.resolve(filePath);
  assert(fs.existsSync(resolved), `${path.basename(resolved)} is unavailable`, code);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function environmentVariables(detail) {
  const variables = detail && detail.Environment && detail.Environment.Variables;
  return Object.fromEntries((Array.isArray(variables) ? variables : [])
    .map((item) => [String(item.Key || item.key || ''), String(item.Value || item.value || '')])
    .filter(([key]) => Boolean(key)));
}

function environmentFingerprint(detail) {
  const normalized = Object.entries(environmentVariables(detail))
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return sha256(JSON.stringify(normalized));
}

function triggerFingerprint(detail) {
  const triggers = (Array.isArray(detail && detail.Triggers) ? detail.Triggers : [])
    .map((item) => ({
      name: String(item.TriggerName || item.Name || ''),
      type: String(item.Type || ''),
      enable: String(item.Enable || item.EnableStatus || '')
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  return sha256(stableStringify(triggers));
}

function summarizeFunction(detail) {
  const code = Buffer.from(String(detail && detail.CodeInfo || ''), 'utf8');
  const variables = environmentVariables(detail);
  return {
    status: String(detail && detail.Status || ''),
    availableStatus: String(detail && detail.AvailableStatus || ''),
    runtime: String(detail && detail.Runtime || ''),
    handler: String(detail && detail.Handler || ''),
    timeout: Number(detail && detail.Timeout || 0),
    memorySize: Number(detail && detail.MemorySize || 0),
    installDependency: String(detail && detail.InstallDependency || ''),
    sourceSha256: code.length > 0 ? sha256(code) : '',
    environmentKeys: Object.keys(variables).sort(),
    environmentFingerprint: environmentFingerprint(detail),
    triggerCount: Array.isArray(detail && detail.Triggers) ? detail.Triggers.length : 0,
    triggerFingerprint: triggerFingerprint(detail)
  };
}

function assertFunctionAvailable(summary, functionName) {
  assert(summary.status === 'Active', `${functionName} is not Active`, 'FUNCTION_NOT_ACTIVE');
  assert(summary.availableStatus === 'Available', `${functionName} is not Available`, 'FUNCTION_NOT_AVAILABLE');
  assert(summary.runtime, `${functionName} runtime is unavailable`, 'FUNCTION_CONFIG_UNAVAILABLE');
  assert(summary.handler === 'index.main', `${functionName} handler drifted`, 'FUNCTION_CONFIG_DRIFT');
  assert(summary.timeout > 0 && summary.memorySize > 0, `${functionName} resources are unavailable`, 'FUNCTION_CONFIG_UNAVAILABLE');
}

function functionConfigurationFingerprint(summary) {
  return sha256(stableStringify({
    runtime: summary.runtime,
    handler: summary.handler,
    timeout: summary.timeout,
    memorySize: summary.memorySize,
    installDependency: summary.installDependency,
    environmentKeys: summary.environmentKeys,
    environmentFingerprint: summary.environmentFingerprint,
    triggerCount: summary.triggerCount,
    triggerFingerprint: summary.triggerFingerprint
  }));
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  }).trim();
}

function gitHead() {
  return git(['rev-parse', 'HEAD']);
}

function trackedFunctionFiles(functionName) {
  assert(PRODUCTION_FUNCTION_NAMES.includes(functionName), `unknown function: ${functionName}`, 'FUNCTION_NOT_ALLOWED');
  const prefix = `cloudfunctions/${functionName}/`;
  const output = git(['ls-files', '--', `cloudfunctions/${functionName}`]);
  const files = output ? output.split(/\r?\n/).map(normalizeRelativePath) : [];
  const relative = files
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .sort();
  assert(relative.includes('index.js') && relative.includes('package.json') && relative.includes('package-lock.json'), `${functionName} tracked package is incomplete`, 'FUNCTION_PACKAGE_INCOMPLETE');
  return relative;
}

function enumeratePackageFiles(directory) {
  const result = [];
  function visit(current, relativeBase) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.join(relativeBase, entry.name));
      const stat = fs.lstatSync(absolute);
      assert(!stat.isSymbolicLink(), `symlink is forbidden in function package: ${relative}`, 'FUNCTION_PACKAGE_SYMLINK');
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) result.push(relative);
    }
  }
  visit(directory, '');
  return result.sort();
}

function hashFiles(directory, relativeFiles) {
  return Object.fromEntries(relativeFiles.map((relative) => {
    const absolute = path.resolve(directory, relative);
    assert(isPathInside(directory, absolute) && fs.existsSync(absolute), `package file missing: ${relative}`, 'FUNCTION_PACKAGE_FILE_MISSING');
    const stat = fs.lstatSync(absolute);
    assert(stat.isFile() && !stat.isSymbolicLink(), `package file is unsafe: ${relative}`, 'FUNCTION_PACKAGE_FILE_UNSAFE');
    return [normalizeRelativePath(relative), sha256(fs.readFileSync(absolute))];
  }));
}

function localFunctionPackage(functionName) {
  const directory = path.join(ROOT, 'cloudfunctions', functionName);
  const tracked = trackedFunctionFiles(functionName);
  const actual = enumeratePackageFiles(directory);
  assert(stableStringify(actual) === stableStringify(tracked), `${functionName} contains untracked or missing deploy files`, 'FUNCTION_PACKAGE_TRACKING_DRIFT');
  const files = hashFiles(directory, tracked);
  return {
    directory,
    relativeFiles: tracked,
    files,
    indexSha256: files['index.js'],
    packageSha256: files['package.json'],
    lockSha256: files['package-lock.json'],
    aggregateSha256: sha256(stableStringify(files))
  };
}

function gitBaseFileHashes(commit, functionName, relativeFiles) {
  const hashes = {};
  for (const relative of relativeFiles) {
    const repositoryPath = `cloudfunctions/${functionName}/${normalizeRelativePath(relative)}`;
    const content = execFileSync('git', ['show', `${commit}:${repositoryPath}`], {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    });
    hashes[normalizeRelativePath(relative)] = sha256(content);
  }
  return hashes;
}

function sameObject(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function sanitizeErrorMessage(error) {
  let message = String(error && error.message || error || 'unknown failure');
  try {
    const targets = require('../config/cloud.targets.private');
    for (const id of Object.values(targets).filter(Boolean)) {
      message = message.split(String(id)).join(maskIdentifier(String(id)));
    }
  } catch (_) {
    // Missing private configuration is reported without attempting replacement.
  }
  return message;
}

module.exports = {
  ROOT,
  PRIVATE_ROOT,
  HOTFIX_FUNCTION_CANDIDATES,
  PRODUCTION_FUNCTION_NAMES,
  PRODUCTION_COLLECTION_NAMES,
  sha256,
  stableStringify,
  normalizeRelativePath,
  isPathInside,
  resolvePrivatePath,
  assertPrivateDirectory,
  assertSafeTemporaryDirectory,
  removeSafeTemporaryDirectory,
  writePrivateJson,
  readJson,
  environmentVariables,
  environmentFingerprint,
  triggerFingerprint,
  summarizeFunction,
  assertFunctionAvailable,
  functionConfigurationFingerprint,
  git,
  gitHead,
  trackedFunctionFiles,
  enumeratePackageFiles,
  hashFiles,
  localFunctionPackage,
  gitBaseFileHashes,
  sameObject,
  sanitizeErrorMessage
};
