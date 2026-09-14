// Mirage — shared utilities (stdlib-only)
import crypto from 'node:crypto';

export const uid = (n = 16) => crypto.randomBytes(n).toString('hex');
export const now = () => Math.floor(Date.now());

// ---------- seeded PRNG (deterministic fingerprints) ----------
export function hashStr(str) {
  // cyrb53 — good distribution, 53-bit
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function rngFor(seedStr) {
  const rnd = mulberry32(hashStr(String(seedStr)) >>> 0);
  const api = {
    next: rnd,
    int: (min, max) => Math.floor(rnd() * (max - min + 1)) + min,
    pick: (arr) => arr[Math.floor(rnd() * arr.length)],
    bool: (p = 0.5) => rnd() < p,
    weighted: (arr) => { // [{w, ...}]
      const total = arr.reduce((s, x) => s + (x.w || 1), 0);
      let r = rnd() * total;
      for (const x of arr) { r -= (x.w || 1); if (r <= 0) return x; }
      return arr[arr.length - 1];
    },
    shuffle: (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
    hex: (len) => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join(''),
  };
  return api;
}

// ---------- misc ----------
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export function jparse(s, fb = null) { try { return JSON.parse(s); } catch { return fb; } }
export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}
export function offsetFromTz(tzId, date = new Date()) {
  // minutes east of UTC for an IANA zone — pure stdlib Intl
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tzId, timeZoneName: 'longOffset' });
  const part = dtf.formatToParts(date).find(p => p.type === 'timeZoneName');
  if (!part) return 0;
  const m = part.value.match(/GMT([+-]\d{2}):(\d{2})|Z/);
  if (!m || part.value === 'GMT' || /Z$/.test(part.value)) return 0;
  return parseInt(m[1]) * 60 + parseInt(m[1][0] + m[2]);
}
export const fmtBytes = (b) => { if (!b) return '0'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0) + ' ' + u[i]; };
export function parseCookies(header) {
  const out = {};
  for (const p of (header || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
export function signToken(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verifyToken(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig !== expect) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); if (p.exp && p.exp < Date.now()) return null; return p; } catch { return null; }
}
export function basicAuthOk(header, user, passHash) {
  if (!header) return false;
  const b64 = header.replace(/^Basic\s+/i, '');
  const s = Buffer.from(b64, 'base64').toString();
  const i = s.indexOf(':');
  if (i < 0) return false;
  return s.slice(0, i) === user && sha256(s.slice(i + 1)) === passHash;
}
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// minimal logger
const C = { i: '\x1b[36m', w: '\x1b[33m', e: '\x1b[31m', g: '\x1b[32m', d: '\x1b[90m', r: '\x1b[0m' };
export function log(scope, ...args) { console.log(`${C.d}${new Date().toISOString().slice(11, 19)}${C.r} ${C.i}[${scope}]${C.r}`, ...args); }
export function warn(scope, ...args) { console.warn(`${C.d}${new Date().toISOString().slice(11, 19)}${C.r} ${C.w}[${scope}]${C.r}`, ...args); }
export function ok(scope, ...args) { console.log(`${C.d}${new Date().toISOString().slice(11, 19)}${C.r} ${C.g}[${scope}]${C.r}`, ...args); }
export function err(scope, ...args) { console.error(`${C.d}${new Date().toISOString().slice(11, 19)}${C.r} ${C.e}[${scope}]${C.r}`, ...args); }

// HTTP helpers
export function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}
export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || ''));
    req.on('error', reject);
  });
}
