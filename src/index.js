// Mirage — server entry: static SPA, REST/automation API, WebSocket hub, boot.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { createApi } from './api.js';
import { Hub, attachWebSocket } from './ws.js';
import { BrowserManager } from './browser/manager.js';
import { generateFingerprint, randomSeed } from './fingerprint/generate.js';
import { createRotator } from './browser/rotation.js';
import { readBody, log, ok, warn, err, uid, sha256, now } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.MIRAGE_DATA || path.join(ROOT, 'data');

// Routes reachable WITHOUT a session/API key (pre-login bootstrap only).
const PUBLIC_API = new Set(['POST /api/auth/login', 'GET /api/auth/me']);

// Security response headers (must-fix M2). CSP keeps 'unsafe-inline' for script/style so the SPA's
// inline handlers keep working, but blocks external script/object/base, framing by others, and caps
// connect/img to self+data (screenshots are data: URLs) + ws. Tighten further once inline handlers go.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'";
const CORS_ALLOW = (process.env.MIRAGE_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
// Only reflect an Origin that is same-host or explicitly allow-listed — never wildcard (M3/CWE-942).
function safeCorsOrigin(req) {
  const o = req.headers.origin; if (!o) return null;
  try { const u = new URL(o); if (u.host === (req.headers.host || '')) return o; if (CORS_ALLOW.includes(o)) return o; } catch (e) { }
  return null;
}

const DEFAULT_SETTINGS = {
  maxSessions: 3, chromiumPath: '', forceXvfb: false, shotQuality: 55, liveFps: 6,
  doh: 'https://cloudflare-dns.com/dns-query', homepage: 'https://www.google.com',
  xdisplay: '', autoSaveSnapshot: true,
};

async function main() {
  db.initDb(DATA);
  const hub = new Hub();
  const bm = new BrowserManager({ dataDir: DATA, hub, getProfile: (id) => db.getProfile(id), db });
  const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...(db.kvGet('settings', {})) });
  const persistSettings = (s) => { db.kvSet('settings', s); bm.setSettings(s); return s; };
  bm.setSettings(loadSettings());

  const rotator = createRotator({ db, bm, generateFingerprint, randomSeed });
  rotator.start();

  const api = createApi({ db, bm, hub, getSettings: loadSettings, setSettings: persistSettings, secret: db.kvGet('secret', null) || (() => { const s = uid(32); db.kvSet('secret', s); return s; })(), rotator });
  seedDemo();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad path'); }
      // Apply security headers to every response (API + static). setHeader values merge with any
      // writeHead header objects used downstream, so this single injection point is enough.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', CSP);
      const _cors = safeCorsOrigin(req);
      if (_cors) { res.setHeader('Access-Control-Allow-Origin', _cors); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin'); }
      if (pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Max-Age': '600' }); return res.end(); }
        // Global auth gate (must-fix #2): every /api/* endpoint requires a session member OR an API
        // key, except the public bootstrap routes. Handlers still do finer RBAC (canWrite/need/canOperate).
        if (!api.authOk(req) && !PUBLIC_API.has(req.method + ' ' + pathname)) return api.err(res, 401, 'auth required');
        let body = {};
        if (req.method === 'POST' || req.method === 'PUT') { const raw = await readBody(req); if (raw) { try { body = JSON.parse(raw); } catch { return api.err(res, 400, 'invalid JSON body'); } } }
        const route = matchRoute(api.H, req.method, pathname);
        if (!route) return api.err(res, 404, 'no such endpoint');
        await route.h(req, res, route.params, body);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      api.err(res, 405, 'method not allowed');
    } catch (e) {
      err('http', e.message);
      if (!res.headersSent) api.err(res, 500, 'internal error');   // never leak internals to the client (M5)
    }
  });

  // ---------------- WebSocket ----------------
  attachWebSocket(server, '/ws', (conn) => {
    conn._channels = new Set();
    const member = api.memberFor(conn.req);            // session member (upgrade carried the cookie)
    const byKey = !!api.apiKeyFor(conn.req);           // API-key client (e.g. ?key= in ws url)
    const canOperateWs = (byKey || (member && member.role !== 'viewer'));
    conn.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.type === 'ping') return conn.sendJSON({ type: 'pong', t: Date.now() });
      if (msg.type === 'subscribe' && msg.channel) {
        hub.join(msg.channel, conn); conn._channels.add(msg.channel);
        if (msg.channel.startsWith('live:')) startLive(msg.channel.slice(5));
        return conn.sendJSON({ type: 'subscribed', channel: msg.channel });
      }
      if (msg.type === 'unsubscribe' && msg.channel) { hub.leave(msg.channel, conn); conn._channels.delete(msg.channel); return; }
      if (msg.type === 'input' && msg.channel?.startsWith?.('live:')) {
        if (!canOperateWs) return conn.sendJSON({ type: 'error', error: 'viewer cannot control kernels' });
        const pid = msg.channel.slice(5); const ev = msg.ev || {};
        try {
          if (ev.kind === 'mouse') bm.inputMouse(pid, ev).catch(() => { });
          else if (ev.kind === 'key') bm.inputKey(pid, ev).catch(() => { });
          else if (ev.kind === 'wheel') bm.inputMouse(pid, { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0 }).catch(() => { });
        } catch (e) { }
        return;
      }
      if (msg.type === 'rpc') { // ws-based RPC for live toolbar
        (async () => {
          try {
            const r = await api.invokeRpc(conn, msg);
            conn.sendJSON({ type: 'rpc', id: msg.id, result: r });
          } catch (e) { conn.sendJSON({ type: 'rpc', id: msg.id, error: e.message }); }
        })();
      }
    });
    conn.on('close', () => { for (const c of conn._channels) hub.leave(c, conn); });
  }, (req) => api.authOk(req));
  function startLive(pid) { try { if (bm.isRunning(pid)) bm.startLive(pid, { fps: loadSettings().liveFps || 6 }); } catch (e) { } }
  hub.onLeave((channel) => { if (channel.startsWith('live:') && hub.count(channel) === 0) bm.stopLive(channel.slice(5)); });

  const PORT = +(process.env.PORT || 7788);
  const HOST = process.env.HOST || '0.0.0.0';
  server.listen(PORT, HOST, () => {
    ok('mirage', 'control plane on  http://localhost:' + PORT);
    ok('mirage', 'automation API     http://localhost:' + PORT + '/api/v1 (X-Api-Key)');
    const bin = bm.findBinary();
    log('mirage', 'kernel: ' + (bin || 'NOT FOUND — set path in Settings'));
    log('mirage', 'display: ' + (process.env.DISPLAY || (fs.existsSync('/tmp/.X11-unix/X0') ? ':0 (detected)' : 'none → Xvfb')) + (fs.existsSync('/usr/bin/Xvfb') ? ' | Xvfb ok' : ' | no Xvfb'));
  });
  const shutdown = () => { warn('mirage', 'closing kernels…'); bm.stopAll().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

// route table with :params
function matchRoute(H, method, pathname) {
  for (const key of Object.keys(H)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pp = pattern.split('/'), sp = pathname.split('/');
    if (pp.length !== sp.length) continue;
    const params = {}; let good = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = sp[i];
      else if (pp[i] !== sp[i]) { good = false; break; }
    }
    if (good) return { h: H[key], params };
  }
  return null;
}

const TEXT_EXT = new Set(['.html', '.js', '.css', '.json', '.svg']);
const _staticCache = new Map();   // full path -> { etag, buf, gz }
function sendStatic(req, res, full, st, forceHtml) {
  const ext = path.extname(full);
  const ct = forceHtml ? 'text/html; charset=utf-8'
    : ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream');
  // Weak ETag from size+mtime → cheap revalidation (304) without serving stale after a redeploy.
  const etag = 'W/"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
  const headers = { 'Content-Type': ct, 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag };
  if (req.method === 'HEAD') { headers['Content-Length'] = st.size; res.writeHead(200, headers); return res.end(); }
  let entry = _staticCache.get(full);
  if (!entry || entry.etag !== etag) {
    const buf = fs.readFileSync(full);
    entry = { etag, buf, gz: TEXT_EXT.has(ext) ? zlib.gzipSync(buf, { level: 6 }) : null };
    _staticCache.set(full, entry);
  }
  if (entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip'; headers['Content-Length'] = entry.gz.length;
    res.writeHead(200, headers); return res.end(entry.gz);
  }
  headers['Content-Length'] = entry.buf.length;
  res.writeHead(200, headers); return res.end(entry.buf);
}
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/checker') rel = '/checker.html';
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, safe);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(full, (e, st) => {
    if (!e && st.isFile()) return sendStatic(req, res, full, st, false);
    if (/^\/(profiles|proxies|settings|members|automation|dashboard|logs|flows|checker-view)/.test(pathname) || !path.extname(pathname)) {
      const idx = path.join(PUBLIC, 'index.html');
      return fs.stat(idx, (e2, st2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        sendStatic(req, res, idx, st2, true);   // SPA fallback served as HTML with the same caching/gzip
      });
    }
    res.writeHead(404); res.end('not found');
  });
}

function seedDemo() {
  if (db.listProfiles().length > 0) return;
  const groups = globalThis.__mirageSeedGroups || {};
  const demos = [
    { os: 'windows-11', browser: 'chrome', country: 'US', group: groups.Affiliate, name: 'FB US 01', tags: ['facebook', 'warm'], color: '#22d3ee', fav: true },
    { os: 'macos-sonoma', browser: 'safari', country: 'DE', group: groups['E-commerce'], name: 'Shop DE', tags: ['shopify'], color: '#a78bfa' },
    { os: 'windows-10', browser: 'edge', country: 'GB', group: groups.SMM, name: 'X/Twitter UK', tags: ['twitter'], color: '#f59e0b' },
    { os: 'android-14', browser: 'chrome', country: 'BR', group: groups.Affiliate, name: 'IG BR Mobile', tags: ['instagram', 'mobile'], color: '#ec4899' },
    { os: 'ubuntu-2404', browser: 'chrome', country: 'NL', group: groups['E-commerce'], name: 'Ecom NL Dev', tags: ['dev'], color: '#34d399' },
    { os: 'macos-sequoia', browser: 'chrome', country: 'CA', group: groups.SMM, name: 'LinkedIn CA', tags: ['b2b'], color: '#60a5fa' },
  ];
  for (const d of demos) {
    const id = uid(10);
    const fp = generateFingerprint({ os: d.os, browser: d.browser, country: d.country, seed: uid(8) });
    db.saveProfile({ id, name: d.name, group_id: d.group || '', color: d.color, favorite: !!d.fav, tags: d.tags, memo: '', proxy_id: '', inline_proxy: '', fingerprint: fp,
      settings: { mode: 'headed', startUrl: '', cookiesMode: 'persist', blockWebBluetooth: true, quic: 'off' }, created_at: now(), updated_at: now(), last_open: 0, open_count: 0, owner: 'me' });
  }
  // demo proxy records (placeholders — edit with real endpoints; not attached to profiles)
  db.saveProxy({ label: 'ISP demo · Rotterdam', scheme: 'http', host: 'gate.demo.example', port: 8080, user: 'demo', pass: 'demo', country: 'NL', city: 'Rotterdam' });
  db.saveProxy({ label: 'SOCKS5 demo · Frankfurt', scheme: 'socks5', host: 'proxy.demo.example', port: 1080, country: 'DE', city: 'Frankfurt' });
  db.logEvent('system.seed', { meta: { profiles: demos.length } });
  log('mirage', 'seeded demo profiles');
}

main().catch(e => { err('mirage', 'fatal', e.stack || e.message); process.exit(1); });
