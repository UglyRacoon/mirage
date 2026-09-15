// Mirage — proxy probe: real reachability + exit-IP/geo detection.
// Supports http/https CONNECT and SOCKS5 (with optional auth). Detects the egress IP
// and geo via ip-api.com, and classifies proxy type. Pure stdlib.
import net from 'node:net';
import tls from 'node:tls';
import { log, warn } from '../util.js';

const API_HOST = 'ip-api.com';
const API_PORT = 80; // free tier is HTTP-only — TLS to :443 returns {"status":"fail"}
const API_PATH = '/json/?fields=status,message,query,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,proxy,hosting';
// exit-IP-only fallback (HTTPS), used when the full geo API is unreachable
const FALLBACK_HOST = 'api.ipify.org';
const FALLBACK_PATH = '/?format=json';

function tcpConnect(host, port, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout });
    const t = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeout);
    sock.once('connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// SOCKS5 client (RFC1928 + RFC1929 username/password).
// Stages: 0 = greeting reply [ver, method]; 1 = auth reply [ver=0x01, status]; 2 = connect reply.
// The CONNECT-to-target request MUST be sent after auth succeeds — a common bug is to skip
// this and read the auth reply as if it were the connect reply, which hangs the probe.
function socks5Connect(proxy, host, port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: +proxy.port, timeout }, () => {
      // Offer no-auth always; additionally offer user/pass when we have credentials.
      const methods = proxy.user ? [0x00, 0x02] : [0x00];
      sock.write(Buffer.from([0x05, methods.length, ...methods]));
    });
    sock.setTimeout(timeout, () => { sock.destroy(); reject(new Error('socks5 timeout')); });
    let stage = 0, buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === 0) {
        if (buf.length < 2) return;
        const m = buf[1]; buf = buf.subarray(2);
        if (m === 0x02) {
          if (!proxy.user) { sock.destroy(); return reject(new Error('socks5 server requires auth but no credentials provided')); }
          const u = Buffer.from(proxy.user, 'utf8'), p = Buffer.from(proxy.pass || '', 'utf8');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          stage = 1; return;
        }
        if (m !== 0x00) { sock.destroy(); return reject(new Error('socks5 auth rejected (method 0x' + m.toString(16) + ')')); }
        stage = 2; sendReq(); return;
      } else if (stage === 1) {
        if (buf.length < 2) return;               // auth reply is exactly 2 bytes [ver, status]
        const status = buf[1]; buf = buf.subarray(2);
        if (status !== 0x00) { sock.destroy(); return reject(new Error('socks5 login failed (status 0x' + status.toString(16) + ')')); }
        stage = 2; sendReq(); return;
      } else if (stage === 2) {
        if (buf.length < 4) return;               // ver, rep, rsv, atyp
        if (buf[1] !== 0x00) { const code = buf[1]; sock.destroy(); return reject(new Error('socks5 connect failed: rep=0x' + code.toString(16))); }
        const atyp = buf[3]; const addrLen = atyp === 1 ? 4 : atyp === 3 ? 1 + buf[4] : 16;
        const need = 4 + addrLen + 2;             // hdr(4) + bound-addr + bound-port(2)
        if (buf.length < need) return;
        const leftover = buf.subarray(need);
        buf = Buffer.alloc(0);
        sock.removeListener('data', onData); sock.setTimeout(0);
        if (leftover && leftover.length) sock.unshift(leftover);  // preserve coalesced bytes
        resolve(sock);
      }
    };
    function sendReq() {
      const hb = Buffer.from(host, 'utf8');
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(port >> 8) & 255, port & 255])]));
    }
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

// tunnel: returns a raw socket connected through the proxy to host:port
async function makeTunnel(proxy, host = API_HOST, port = API_PORT, timeout = 10000) {
  if (proxy.scheme === 'socks5') return socks5Connect(proxy, host, port);
  const sock = await tcpConnect(proxy.host, +proxy.port, 8000);
  const auth = proxy.user ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.user + ':' + (proxy.pass || '')).toString('base64') + '\r\n' : '';
  const req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`;
  await new Promise((resolve, reject) => {
    let b = Buffer.alloc(0), settled = false;
    // CRITICAL: a dead HTTP proxy may accept the TCP connection then never answer
    // CONNECT — without this timer the probe hangs forever.
    const t = setTimeout(() => { if (settled) return; settled = true; sock.destroy(); reject(new Error('CONNECT timeout')); }, timeout);
    const ok = (fn, a) => { if (settled) return; settled = true; clearTimeout(t); fn(a); };
    const onD = (c) => { b = Buffer.concat([b, c]); const i = b.indexOf('\r\n\r\n'); if (i < 0) return; if (/ 200 /.test(b.subarray(0, i).toString('latin1'))) ok(resolve); else { const s = b.subarray(0, i).toString('latin1').split('\r\n')[0]; ok(reject, new Error('CONNECT refused: ' + s)); } };
    sock.on('data', onD); sock.on('error', (e) => ok(reject, e)); sock.on('close', () => ok(reject, new Error('proxy closed before CONNECT reply')));
    sock.write(req);
  });
  sock.setTimeout(0);
  return sock;
}

// de-chunk a Transfer-Encoding: chunked body (latin1 string)
function dechunk(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const nl = s.indexOf('\r\n', i); if (nl < 0) break;
    const len = parseInt(s.slice(i, nl).trim(), 16);
    if (isNaN(len) || len === 0) break;
    out += s.slice(nl + 2, nl + 2 + len); i = nl + 2 + len + 2;
  }
  return out;
}

function parseHttp(buf) {
  const s = buf.toString('latin1'); const i = s.indexOf('\r\n\r\n');
  if (i < 0) throw new Error('bad http response');
  const head = s.slice(0, i); const status = head.split('\r\n')[0];
  if (!/ 200 /.test(status)) throw new Error('http ' + status);
  let raw = s.slice(i + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) raw = dechunk(raw);
  else { const cl = (head.match(/content-length:\s*(\d+)/i) || [])[1]; if (cl) raw = raw.slice(0, +cl); }
  return raw;
}

// plain HTTP/1.1 GET over an already-open tunnel socket (ip-api free = HTTP-only)
function httpGetThrough(tunnel, host, path, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false; const done = (fn, a) => { if (settled) return; settled = true; fn(a); };
    tunnel.setTimeout(timeout, () => { tunnel.destroy(); done(reject, new Error('api timeout')); });
    let buf = Buffer.alloc(0);
    tunnel.on('data', d => { buf = Buffer.concat([buf, d]); });
    tunnel.on('error', e => done(reject, e));
    tunnel.on('end', () => { try { done(resolve, parseHttp(buf)); } catch (e) { done(reject, e); } });
    tunnel.on('close', () => { if (!buf.length) return; try { done(resolve, parseHttp(buf)); } catch (e) { done(reject, e); } });
    tunnel.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mirage-Probe/1.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
  });
}

// TLS + HTTP/1.1 GET over an already-open tunnel socket
function httpsGetThrough(tunnel, host, path, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false; const done = (fn, a) => { if (settled) return; settled = true; fn(a); };
    const tlsSock = tls.connect({ socket: tunnel, servername: host, ALPNProtocols: ['http/1.1'] }, () => {
      tlsSock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mirage-Probe/1.0\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
    });
    tlsSock.setTimeout(timeout, () => { tlsSock.destroy(); done(reject, new Error('api timeout')); });
    let buf = Buffer.alloc(0);
    tlsSock.on('data', d => { buf = Buffer.concat([buf, d]); });
    tlsSock.on('error', e => done(reject, e));
    tlsSock.on('end', () => { try { done(resolve, parseHttp(buf)); } catch (e) { done(reject, e); } });
    tlsSock.on('close', () => { if (!buf.length) return; try { done(resolve, parseHttp(buf)); } catch (e) { done(reject, e); } });
  });
}

// full-geo via ip-api (HTTP); on failure fall back to ipify (HTTPS) for exit-IP only.
async function detectEgress(p, t0) {
  try {
    const t = await makeTunnel(p, API_HOST, API_PORT);
    const latencyMs = Date.now() - t0;
    let raw; try { raw = await httpGetThrough(t, API_HOST, API_PATH); } finally { try { t.destroy(); } catch (e) { } }
    const d = JSON.parse(raw);
    if (d && d.query) {
      return { ok: true, latencyMs, exitIp: d.query, geo: { ok: d.status === 'success', country: d.country, countryCode: d.countryCode, region: d.regionName, city: d.city, zip: d.zip, lat: d.lat, lon: d.lon, timezone: d.timezone, isp: d.isp, org: d.org, as: d.as, asname: d.asname, proxy: !!d.proxy, hosting: !!d.hosting } };
    }
    return { ok: true, latencyMs, exitIp: null, geo: null };
  } catch (e) { warn('proxy', 'ip-api lookup failed:', e.message); }
  try {
    const t = await makeTunnel(p, FALLBACK_HOST, 443);
    const latencyMs = Date.now() - t0;
    let raw; try { raw = await httpsGetThrough(t, FALLBACK_HOST, FALLBACK_PATH); } finally { try { t.destroy(); } catch (e) { } }
    const d = JSON.parse(raw);
    if (d && d.ip) return { ok: true, latencyMs, exitIp: d.ip, geo: null };
    return { ok: true, latencyMs, exitIp: null, geo: null };
  } catch (e) { warn('proxy', 'ipify fallback failed:', e.message); return { ok: false, error: e.message }; }
}

export async function probeProxy(proxy) {
  const p = { scheme: (proxy.scheme || 'http').toLowerCase(), host: proxy.host, port: +proxy.port, user: proxy.user || '', pass: proxy.pass || '' };
  const t0 = Date.now();
  const r = await detectEgress(p, t0);
  if (!r.ok) return { ok: false, error: r.error, scheme: p.scheme, host: p.host, port: p.port };
  const detectedType = p.scheme === 'socks5' ? 'socks5' : (p.scheme === 'https' ? 'https' : 'http');
  const message = r.geo
    ? `Egress ${r.exitIp} (${r.geo.countryCode})`
    : (r.exitIp ? `Egress ${r.exitIp}` : 'reachable, geo lookup skipped');
  return { ok: true, latencyMs: r.latencyMs, scheme: detectedType, host: p.host, port: p.port, exitIp: r.exitIp, geo: r.geo, message };
}

// Quick readiness check used before launching (no geo)
export async function checkReachability(proxy) {
  try { const t0 = Date.now(); const s = await makeTunnel(proxy); s.destroy(); return { ok: true, latencyMs: Date.now() - t0 }; }
  catch (e) { return { ok: false, error: e.message }; }
}
