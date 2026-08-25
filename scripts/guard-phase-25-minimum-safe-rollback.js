const fs = require('fs');
const path = require('path');
const {
  MINIMUM_SAFE_ROLLBACK_BASELINE,
  BREAK_GLASS_AUTHORIZATION,
  evaluateProductionMessageQueryCandidate
} = require('./phase-25-minimum-safe-rollback-core');

const ROOT = path.resolve(__dirname, '..');

function parseArguments(argv) {
  const options = {
    candidate: path.join('cloudfunctions', 'messageQuery', 'index.js'),
    lifecycleDataState: 'present',
    breakGlass: false,
    ownerAuthorization: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--candidate') {
      options.candidate = String(argv[++index] || '').trim();
    } else if (value === '--lifecycle-data') {
      options.lifecycleDataState = String(argv[++index] || '').trim();
    } else if (value === '--break-glass') {
      options.breakGlass = true;
    } else if (value === '--owner-authorization') {
      options.ownerAuthorization = String(argv[++index] || '').trim();
    } else {
      const error = new Error(`unsupported argument: ${value}`);
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
  }
  return options;
}

function resolveCandidate(candidate) {
  const resolved = path.resolve(ROOT, candidate);
  if (!resolved.startsWith(`${ROOT}${path.sep}`)) {
    const error = new Error('candidate must stay inside the project workspace');
    error.code = 'UNSAFE_CANDIDATE_PATH';
    throw error;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const error = new Error('candidate source file is unavailable');
    error.code = 'CANDIDATE_SOURCE_MISSING';
    throw error;
  }
  return resolved;
}

function run(options) {
  const candidatePath = resolveCandidate(options.candidate);
  const source = fs.readFileSync(candidatePath, 'utf8');
  const result = evaluateProductionMessageQueryCandidate(source, options);
  return {
    schemaVersion: 1,
    mode: 'phase-25-minimum-safe-rollback-guard',
    candidate: path.relative(ROOT, candidatePath).replace(/\\/g, '/'),
    baseline: MINIMUM_SAFE_ROLLBACK_BASELINE,
    breakGlassAuthorizationRequired: BREAK_GLASS_AUTHORIZATION,
    ...result
  };
}

if (require.main === module) {
  try {
    const result = run(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.allowed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error.code || 'MINIMUM_SAFE_ROLLBACK_GUARD_FAILED'}: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  ROOT,
  parseArguments,
  resolveCandidate,
  run
};
