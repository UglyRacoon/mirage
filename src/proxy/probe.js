// Mirage — proxy probe: real reachability + exit-IP/geo detection.
// Supports http/https CONNECT and SOCKS5 (with optional auth). Detects the egress IP
// and geo via ip-api.com, and classifies proxy type. Pure stdlib.
import net from 'node:net';
import tls from 'node:tls';
import { log, warn } from '../util.js';

const API_HOST = 'ip-api.com';
const API_PATH = '/json/?fields=status,message,query,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,proxy,hosting';

function tcpConnect(host, port, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout });
    const t = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeout);
    sock.once('connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function socks5Connect(proxy, host, port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: +proxy.port, timeout }, () => {
      const auth = proxy.user ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      sock.write(auth);
    });
    sock.setTimeout(timeout, () => { sock.destroy(); reject(new Error('socks5 timeout')); });
    let stage = 0, buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === 0) {
        if (buf.length < 2) return;
        const m = buf[1];
        if (m === 0x02) { const u = Buffer.from(proxy.user || '', 'utf8'), p = Buffer.from(proxy.pass || '', 'utf8'); sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p])); buf = Buffer.alloc(0); stage = 1; return; }
        if (m !== 0x00) return reject(new Error('socks5 auth rejected'));
        buf = Buffer.alloc(0); stage = 1; sendReq();
      } else if (stage === 1) {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) return reject(new Error('socks5 connect failed: ' + buf[1]));
        const atyp = buf[3]; let need = 5 + (atyp === 1 ? 4 : atyp === 3 ? 1 + buf[4] : 16) + 2;
        if (buf.length < need) return;
        sock.removeListener('data', onData); sock.setTimeout(0); resolve(sock);
      }
    };
    function sendReq() {
      const hb = Buffer.from(host, 'utf8');
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, Buffer.from([(port >> 8) & 255, port & 255])]));
      stage = 1; buf = Buffer.alloc(0);
    }
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

// tunnel: returns a socket connected through the proxy to API_HOST:443
async function makeTunnel(proxy) {
  if (proxy.scheme === 'socks5') return socks5Connect(proxy, API_HOST, 443);
  const sock = await tcpConnect(proxy.host, +proxy.port, 8000);
  const auth = proxy.user ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.user + ':' + (proxy.pass || '')).toString('base64') + '\r\n' : '';
  const req = `CONNECT ${API_HOST}:443 HTTP/1.1\r\nHost: ${API_HOST}:443\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`;
  const r = await new Promise((resolve, reject) => {
    let b = Buffer.alloc(0); const onD = (c) => { b = Buffer.concat([b, c]); const i = b.indexOf('\r\n\r\n'); if (i < 0) return; if (/ 200 /.test(b.subarray(0, i).toString('latin1'))) resolve(); else { const s = b.subarray(0, i).toString('latin1').split('\r\n')[0]; reject(new Error('CONNECT refused: ' + s)); } };
    sock.on('data', onD); sock.on('error', reject);
    sock.write(req);
  });
  return sock;
}

function httpsGetThrough(tunnel, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({ socket: tunnel, servername: API_HOST, ALPNProtocols: ['http/1.1'] }, () => {
      tlsSock.write(`GET ${API_PATH} HTTP/1.1\r\nHost: ${API_HOST}\r\nUser-Agent: Mirage-Probe/1.0\r\nConnection: close\r\n\r\n`);
    });
    tlsSock.setTimeout(timeout, () => { tlsSock.destroy(); reject(new Error('api timeout')); });
    let buf = Buffer.alloc(0);
    tlsSock.on('data', d => { buf = Buffer.concat([buf, d]); });
    tlsSock.on('end', () => {
      const s = buf.toString('latin1'); const i = s.indexOf('\r\n\r\n'); const body = s.slice(i + 4);
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad api response')); }
    });
    tlsSock.on('error', reject);
  });
}

export async function probeProxy(proxy) {
  const p = { scheme: (proxy.scheme || 'http').toLowerCase(), host: proxy.host, port: +proxy.port, user: proxy.user || '', pass: proxy.pass || '' };
  const t0 = Date.now();
  let tunnel;
  try {
    tunnel = await makeTunnel(p);
  } catch (e) {
    return { ok: false, error: e.message, scheme: p.scheme, host: p.host, port: p.port };
  }
  const latencyMs = Date.now() - t0;
  let geo = null, exitIp = null;
  try {
    const data = await httpsGetThrough(tunnel);
    if (data && data.query) {
      exitIp = data.query;
      geo = { ok: data.status === 'success', country: data.country, countryCode: data.countryCode, region: data.regionName, city: data.city, lat: data.lat, lon: data.lon, timezone: data.timezone, isp: data.isp, org: data.org, as: data.as, asname: data.asname, proxy: !!data.proxy, hosting: !!data.hosting };
    }
  } catch (e) { warn('proxy', 'geo lookup failed for', p.host, e.message); }
  try { tunnel.destroy(); } catch (e) { }

  const detectedType = p.scheme === 'socks5' ? 'socks5' : (p.scheme === 'https' ? 'https' : 'http');
  return { ok: true, latencyMs, scheme: detectedType, host: p.host, port: p.port, exitIp, geo, message: geo ? `Egress ${exitIp} (${geo.countryCode})` : 'reachable, geo lookup skipped' };
}

// Quick readiness check used before launching (no geo)
export async function checkReachability(proxy) {
  try { const t0 = Date.now(); const s = await makeTunnel(proxy); s.destroy(); return { ok: true, latencyMs: Date.now() - t0 }; }
  catch (e) { return { ok: false, error: e.message }; }
}
