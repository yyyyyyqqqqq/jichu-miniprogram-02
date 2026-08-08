const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tool = require('./manage-phase-18-canary-fixtures');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function check(condition, message) { assert(condition, message); checks += 1; }

check(tool.OPERATION_ID === 'phase18-fifth-round-offline-fixtures-v1', 'operation ID changed');
check(tool.parseArguments([]).applyOffline === false, 'tool is not dry-run by default');
check(tool.parseArguments(['--apply-offline']).applyOffline === true, 'apply flag parsing failed');
check(tool.parseArguments(['--confirm-target', 'cloud***']).confirmTarget === 'cloud***', 'target parsing failed');
check(tool.aggregateStatuses([{ status: 'offline' }, { status: 'offline' }, { status: 'available' }]).offline === 2, 'status aggregation failed');

const source = fs.readFileSync(path.join(ROOT, 'scripts', 'manage-phase-18-canary-fixtures.js'), 'utf8');
check(/expected\.length === 20/.test(source), 'exact fixture count gate is missing');
check(/title\.startsWith\(FIXTURE_PREFIX\)/.test(source), 'fixture title prefix gate is missing');
check(/sellerId === privateData\.userId/.test(source), 'fixture owner gate is missing');
check(/activeAppointments\.length === 0/.test(source), 'active appointment gate is missing');
check(/multi: false/.test(source) && /upsert: false/.test(source), 'bounded update flags are missing');
check(/updates: updates\.slice/.test(source), 'bounded update batching is missing');
check(!/CommandType:\s*['"]DELETE['"]/.test(source), 'fixture tool contains delete command');
check(/product\.schoolId === previous\.schoolId/.test(source), 'schoolId preservation check is missing');
check(/product\.schoolName === previous\.schoolName/.test(source), 'schoolName preservation check is missing');
check(/writePrivateJson/.test(source), 'private evidence write is missing');

process.stdout.write(`Phase 18 fixture closure verification succeeded: ${checks} checks passed.\n`);
