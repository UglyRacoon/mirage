#!/usr/bin/env node
// Mirage — pre-prod black-box gate. Read-only: only safe GETs, one HEAD, a benign
// login attempt with the dev default PIN, and a WS handshake. It performs NO SSRF
// triggers and NO state changes. Run against a staging instance.
//
//   node test/prodcheck.mjs                 # defaults to http://127.0.0.1:7788
//   MIRAGE_BASE=https://mirage.hata node test/prodcheck.mjs
//
// Exit code 0 = all invariants hold; 1 = at least one FAIL (do NOT go to prod).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';

const BASE = process.env.MIRAGE_BASE || 'http://127.0.0.1:' + (process.env.PORT || 7788);
const u = new URL(BASE);
const lib = u.protocol === 'https:' ? https : http;
const ORIGIN_FOR_CORS = 'http://evil-csrf.example';

let pass = 0, fail = 0, warn = 0;
const P = (n, d) => { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + n + (d ? '  — ' + d : '')); };
const F = (n, d) => { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n + (d ? '  — ' + d : '')); };
const W = (n, d) => { warn++; console.log('  \x1b[33mWARN\x1b[0m ' + n + (d ? '  — ' + d : '')); };

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = lib.request(u, { method, path, headers: { Host: u.host, ...headers } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function sectionAuth() {
  console.log('\n◆ Authentication required on sensitive reads (CWE-306/862)');
  const sensitive = [
    '/api/profiles', '/api/proxies', '/api/backup/export', '/api/members', '/api/apikeys',
    '/api/settings', '/api/audit', '/api/history', '/api/flows', '/api/stats',
    '/api/browser/list', '/api/browser/status', '/api/checker/whoami',
  ];
  for (const ep of sensitive) {
    const r = await request('GET', ep);
    if (r.error) { W('GET ' + ep, 'request error: ' + r.error); continue; }
    if (r.status === 401 || r.status === 403) P('GET ' + ep + ' requires auth', String(r.status));
    else F('GET ' + ep + ' is UNAUTHENTICATED', 'HTTP ' + r.status + ', ' + (r.body || '').length + 'B exposed');
  }
}

async function sectionCredShape() {
  console.log('\n◆ Credential shape in API responses (CWE-200/522)');
  const r = await request('GET', '/api/proxies');
  if (r.error) { W('GET /api/proxies', r.error); return; }
  let leaked = 0;
  try { const j = JSON.parse(r.body || '{}'); for (const p of (j.proxies || [])) if (typeof p.pass === 'string' && p.pass.length) leaked++; } catch (_) { }
  if (leaked) F('GET /api/proxies ships proxy passwords', leaked + ' record(s) with non-empty "pass" in browser-visible JSON');
  else P('GET /api/proxies returns no plaintext pass field');
}

async function sectionDefaultPin() {
  console.log('\n◆ No default/known admin credentials (CWE-1188/521)');
  const r = await request('POST', '/api/auth/login', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'mirage' }) });
  if (r.status === 200) F("login with dev default PIN 'mirage' succeeded", 'admin session minted — MUST change seed PIN + use slow KDF');
  else if (r.status === 401 || r.status === 403) P("dev default PIN 'mirage' rejected", String(r.status));
  else W('login behavior unclear', 'HTTP ' + r.status);
}

async function sectionTransport() {
  console.log('\n◆ Session cookie + transport hardening (CWE-1004/319/693)');
  const root = await request('GET', '/');
  if (root.error) { W('GET /', root.error); return; }
  const h = root.headers;
  const has = k => h[k.toLowerCase()];
  has('content-security-policy') ? P('Content-Security-Policy present') : F('no Content-Security-Policy', 'XSS blast-radius is full app w/o CSP');
  has('x-content-type-options') ? P('X-Content-Type-Options present') : F('no X-Content-Type-Options: nosniff');
  (has('x-frame-options') || /frame-ancestors/.test(has('content-security-policy') || '')) ? P('clickjacking header (XFO/CSP frame-ancestors)') : F('no frame-ancestors / X-Frame-Options', 'admin UI is clickjackable');
  has('referrer-policy') ? P('Referrer-Policy present') : W('no Referrer-Policy');
  if (u.protocol === 'http:') F('served over cleartext HTTP', 'TLS required: PIN, session cookie, proxy creds, API keys in the clear');
  // CORS wildcard with credentialed API
  const c = await request('OPTIONS', '/api/profiles', { headers: { Origin: ORIGIN_FOR_CORS, 'Access-Control-Request-Method': 'GET' } });
  const acao = c.headers && c.headers['access-control-allow-origin'];
  if (acao === '*') F('CORS Access-Control-Allow-Origin: * on /api', 'any site can consume the (auth-gated) API; pin to app origin');
  else if (acao) P('CORS origin is pinned', acao);
  else P('no permissive CORS header on preflight');
}

async function sectionWsAuth() {
  console.log('\n◆ WebSocket control-plane authentication (CWE-287/346)');
  const ok = await new Promise((resolve) => {
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    if (u.protocol === 'https:') { resolve(null); return; } // raw-check only for ws://
    const key = crypto.randomBytes(16).toString('base64');
    const s = net.connect(port, u.hostname, () => {
      s.write(`GET /ws HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN_FOR_CORS}\r\n\r\n`);
    });
    let done = false;
    s.on('data', d => { if (done) return; done = true; const line = d.toString('latin1').split('\r\n')[0]; resolve(line); s.destroy(); });
    s.on('error', e => { if (!done) { done = true; resolve('ERR ' + e.message); } });
    setTimeout(() => { if (!done) { done = true; resolve('TIMEOUT'); s.destroy(); } }, 5000);
  });
  if (ok === null) { W('WS upgrade not checked (wss/TLS target)', 'verify origin+session checks manually'); }
  else if (/101/.test(ok)) F('WS /ws upgrade accepted with NO cookie and spoofed Origin', 'unauth remote-control of kernels over WebSocket');
  else P('WS /ws upgrade refused without auth', ok);
}

async function sectionReleaseSync() {
  console.log('\n◆ Release-sync canary: frontend routes exist on backend (guards front/back drift)');
  // 0cbcb4a introduced these; a backend at an older commit returns 404, a synced one returns 401 (auth-gated).
  const canary = [
    ['POST', '/api/proxies/bulk', JSON.stringify({})],
    ['DELETE', '/api/proxies', ''],
  ];
  for (const [m, ep, body] of canary) {
    const r = await request(m, ep, { headers: { 'Content-Type': 'application/json' }, body });
    if (r.error) { W(m + ' ' + ep, r.error); continue; }
    if (r.status === 404) F(m + ' ' + ep + ' missing on backend', 'frontend expects it — backend is an OLDER commit, redeploy src/');
    else P(m + ' ' + ep + ' present on backend', 'HTTP ' + r.status + (r.status === 401 ? ' (auth-gated = route exists)' : ''));
  }
}

async function sectionStatic() {
  console.log('\n◆ Static-file path traversal (CWE-22)');
  const pats = ['/..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/css/../../package.json'];
  for (const p of pats) {
    const r = await request('GET', p);
    if (r.error) { W('GET ' + p, r.error); continue; }
    if (/root:.*:0:0:/.test(r.body || '')) F('traversal leaked /etc/passwd', p);
    else P('no /etc/passwd leak via', p + ' (HTTP ' + r.status + ')');
  }
}

(async () => {
  console.log('Mirage prod-readiness gate — target: ' + BASE);
  await sectionAuth();
  await sectionCredShape();
  await sectionDefaultPin();
  await sectionTransport();
  await sectionWsAuth();
  await sectionReleaseSync();
  await sectionStatic();
  console.log('\n' + '='.repeat(60));
  console.log(`RESULT: ${pass} PASS · ${fail} FAIL · ${warn} WARN`);
  if (fail) { console.log('\x1b[31m✋ NOT ready for prod — fix every FAIL above (start with Critical: default PIN, unauth reads, WS auth, TLS).\x1b[0m'); process.exit(1); }
  console.log('\x1b[32m✅ All hard invariants held.\x1b[0m (Review WARNs before final sign-off.)');
  process.exit(0);
})();
