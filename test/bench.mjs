// Standalone micro-benchmark for the SQLite persistence layer. Uses a throwaway DB dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirage-bench-'));
db.initDb(dir);
// seed a working set
for (let i = 0; i < 200; i++) db.saveProfile({ id: 'p' + i, name: 'P' + i, fingerprint: { osId: 'windows-11' }, tags: [] });
for (let i = 0; i < 200; i++) db.saveProxy({ id: 'x' + i, label: 'X' + i, scheme: 'http', host: '1.2.3.' + (i % 250), port: 8080, user: 'u', pass: 'p' });

function time(label, fn, iters) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(i);
  const t1 = process.hrtime.bigint();
  const us = Number(t1 - t0) / 1000;
  console.log(`  ${label.padEnd(26)} ${iters} iters  total ${(us / 1000).toFixed(1)}ms  avg ${(us / iters).toFixed(2)}µs`);
  return us / iters;
}

console.log('db micro-benchmark (temp dir ' + dir + '):');
const r1 = time('listProxies()', () => db.listProxies(), 2000);
const r2 = time('listProfiles()', () => db.listProfiles(), 2000);
const r3 = time('getProfile(p123)', () => db.getProfile('p123'), 2000);
const w1 = time('saveProxy write', (i) => db.saveProxy({ id: 'x1', label: 'X1', scheme: 'http', host: 'h' + i, port: 1, user: 'u', pass: 'p' }), 300);
const w2 = time('logEvent write', (i) => db.logEvent('bench', { profileId: 'p' + (i % 200), meta: { i } }), 300);

// summary metric: ops/sec for the hot read + a write
console.log(`\n  hot-read proxy list:  ${(1e6 / r1).toFixed(0)} ops/s`);
console.log(`  profile list:         ${(1e6 / r2).toFixed(0)} ops/s`);
console.log(`  single getProfile:    ${(1e6 / r3).toFixed(0)} ops/s`);
console.log(`  saveProxy (fsync):    ${(1e6 / w1).toFixed(0)} writes/s`);
console.log(`  logEvent (fsync):     ${(1e6 / w2).toFixed(0)} writes/s`);
fs.rmSync(dir, { recursive: true, force: true });
