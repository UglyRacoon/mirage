// Mirage — local proxy relay.
// Chromium's --proxy-server cannot carry credentials, and plain HTTP proxies leak DNS.
// We run a per-session localhost relay that speaks CONNECT/SOCKS5 upstream and adds
// Proxy-Authorization transparently. Chrome then points at http://127.0.0.1:<port>.
import net from 'node:net';
import { log, warn } from '../util.js';

/**
 * @param {object} proxy {scheme:http|https|socks5, host, port, user, pass}
 * @returns {Promise<{url:string, port:number, close:()=>void}>}
 */
export function startRelay(proxy, { ownLoopbackPorts = new Set() } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => handleClient(client, proxy, reject, ownLoopbackPorts));
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => { try { server.close(); } catch (e) { } } });
    });
  });
}

// Direct dial for Mirage's own loopback services (control plane, JA3 capture listener).
// `extra` = bytes to flush into the local socket right after connect: for plain-HTTP that is
// the origin-form request head and body, for CONNECT it is any payload already sent.
function pipeLocal(client, port, extra, connect = false) {
  let connected = false;
  const up = net.connect({ host: '127.0.0.1', port: +port }, () => {
    if (client.destroyed) { up.destroy(); return; }
    connected = true;
    up.setTimeout(0);
    if (connect) client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: MirageRelay\r\n\r\n');
    if (extra.length) up.write(extra);
    pipe(client, up);
  });
  client.once('close', () => up.destroy());
  up.setTimeout(4000, () => up.destroy(new Error('local service timeout')));
  up.on('error', () => {
    if (connected) client.destroy();
    else failLocal(client, 'local service unreachable');
  });
}

function failLocal(client, message) {
  client.end('HTTP/1.1 502 Bad Gateway\r\nX-Mirage-Error: ' + message + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
}

// Keep the shared Set live: capture listeners are added/removed after relay startup.
// Only aliases for the actual 127.0.0.1 listener may use an allowlisted port.
function isOwnService(host, port, ports) {
  return ['127.0.0.1', 'localhost', '::1', '::ffff:7f00:1'].includes(host)
    && (ports instanceof Set ? ports.has(+port) : ports?.includes(+port));
}

function canonicalHost(host) {
  return new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

// Loopback destinations must never tunnel through the upstream proxy: "127.0.0.1" would
// resolve at the PROXY's side, so control-plane pages (the built-in checker at
// http://127.0.0.1:<port>/checker, JA3 capture) break with ERR_EMPTY_RESPONSE. Mirage's own
// local services (control-plane port + ephemeral capture ports) are dialed DIRECTLY here;
// any OTHER loopback target is refused fast with a logged 502 (a page asking the kernel to
// probe the host's local services is an SSRF probe — it must not succeed through us).
function isLoopbackTarget(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (/^127\./.test(h)) return true;
  if (/^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(h)) return true;
  return false;
}

function handleClient(client, proxy, reject, ownLoopbackPorts) {
  client.setNoDelay(true);
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) { if (buf.length > 65536) client.destroy(); return; }
    client.pause(); // retain body/tunnel bytes arriving while the destination connects
    client.removeListener('data', onData);
    const head = buf.subarray(0, end).toString('latin1');
    const rest = buf.subarray(end + 4);
    const [line] = head.split('\r\n');
    const [method, target] = line.split(/\s+/);
    if (method === 'CONNECT') handleConnect(client, proxy, target, head, rest, ownLoopbackPorts);
    else forwardHttp(client, proxy, head, rest, ownLoopbackPorts);
  };
  client.on('data', onData);
  client.on('error', () => client.destroy());
}

function upstreamConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    if (proxy.scheme === 'socks5') return socks5Connect(proxy, host, +port).then(resolve, reject);
    const up = net.connect({ host: proxy.host, port: +proxy.port, timeout: 12000 }, () => {
      const authority = `${net.isIPv6(host) ? '[' + host + ']' : host}:${port}`;
      let hdr = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
      if (proxy.user) hdr += `Proxy-Authorization: Basic ${Buffer.from(proxy.user + ':' + (proxy.pass || '')).toString('base64')}\r\n`;
      hdr += '\r\n';
      up.write(hdr);
    });
    up.setTimeout(12000, () => { up.destroy(); reject(new Error('upstream timeout')); });
    let b = Buffer.alloc(0);
    const onData = (c) => {
      b = Buffer.concat([b, c]);
      const i = b.indexOf('\r\n\r\n');
      if (i < 0) { if (b.length > 1e6) { up.destroy(); reject(new Error('bad upstream')); } return; }
      up.removeListener('data', onData);
      const status = b.subarray(0, i).toString('latin1').split('\r\n')[0];
      if (/ 200 /.test(status)) { up.setNoDelay(true); resolve({ sock: up, head: b.subarray(i + 4) }); }
      else { up.destroy(); reject(new Error('upstream CONNECT refused: ' + status.trim())); }
    };
    up.on('data', onData);
    up.on('error', reject);
  });
}

function socks5Connect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const up = net.connect({ host: proxy.host, port: +proxy.port, timeout: 12000 }, () => {
      const auth = proxy.user ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      up.write(auth);
    });
    up.setTimeout(12000, () => { up.destroy(); reject(new Error('socks timeout')); });
    let stage = 0, b = Buffer.alloc(0);
    const onData = (chunk) => {
      b = Buffer.concat([b, chunk]);
      if (stage === 0) {
        if (b.length < 2) return;
        const chosen = b[1];
        if (chosen === 0x02) { // username/password auth (RFC1929)
          const u = Buffer.from(proxy.user || '', 'utf8'), p = Buffer.from(proxy.pass || '', 'utf8');
          up.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          b = b.subarray(2); stage = 1; return;
        }
        if (chosen !== 0x00) { up.destroy(); reject(new Error('socks5 no acceptable method')); return; }
        b = b.subarray(2); stage = 2; sendReq(); return;
      }
      if (stage === 1) {
        if (b.length < 2) return;
        if (b[1] !== 0x00) { up.destroy(); reject(new Error('socks5 auth failed')); return; }
        b = b.subarray(2); stage = 2; sendReq(); return;
      }
      if (stage === 2) {
        if (b.length < 4) return;
        if (b[1] !== 0x00) { up.destroy(); reject(new Error('socks5 connect refused: 0x' + b[1].toString(16))); return; }
        const atyp = b[3];
        const addrLen = atyp === 1 ? 4 : atyp === 3 ? 1 + b[4] : 16;
        const need = 4 + addrLen + 2; // ver,rep,rsv,atyp (4) + bound-addr + bound-port (2)
        if (b.length < need) return;
        up.removeListener('data', onData);
        up.setNoDelay(true);
        resolve({ sock: up, head: b.subarray(need) });
      }
    };
    function sendReq() {
      const hostBuf = Buffer.from(host, 'utf8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
        Buffer.from([(port >> 8) & 255, port & 255]),
      ]);
      up.write(req);
    }
    up.on('data', onData);
    up.on('error', reject);
  });
}

async function handleConnect(client, proxy, target, head, rest, ownLoopbackPorts) {
  // CONNECT uses authority-form: IPv6 must be bracketed, and the port explicit.
  const authority = /^(\[[0-9a-fA-F:.]+\]|[^\s:/?#@\\]+):(\d+)$/.exec(target || '');
  let host, port;
  try {
    if (!authority || +authority[2] < 1 || +authority[2] > 65535) throw new Error('invalid authority');
    host = canonicalHost(authority[1]); port = +authority[2];
  } catch { failLocal(client, 'invalid CONNECT target'); return; }
  if (isLoopbackTarget(host)) {   // never tunnel loopback (see isLoopbackTarget)
    if (isOwnService(host, port, ownLoopbackPorts)) {
      pipeLocal(client, port, rest, true);
      return;
    }
    warn('relay', 'refusing loopback CONNECT to ' + host + ':' + port + ' (SSRF probe)');
    failLocal(client, 'loopback is not proxied');
    return;
  }
  try {
    const { sock, head: leftover } = await upstreamConnect(proxy, host, port || 443);
    client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: MirageRelay\r\n\r\n');
    if (leftover && leftover.length) sock.write(leftover);
    if (rest && rest.length) sock.write(rest);
    pipe(client, sock);
  } catch (e) {
    warn('relay', 'CONNECT failed:', e.message);
    client.write('HTTP/1.1 502 Bad Gateway\r\nX-Mirage-Error: ' + String(e.message).replace(/\r?\n/g, ' ') + '\r\nContent-Length: 0\r\n\r\n');
    client.destroy();
  }
}

async function forwardHttp(client, proxy, head, rest, ownLoopbackPorts) {
  // plain http:// forwarding (for non-TLS requests)
  const lines = head.split('\r\n');
  const hostLine = lines[0].split(/\s+/);
  let u, host;
  try {
    u = new URL(hostLine[1]);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('invalid URL');
    host = canonicalHost(u.hostname);
  } catch { failLocal(client, 'invalid HTTP target'); return; }
  const port = u.port || (u.protocol === 'https:' ? 443 : 80);
  const originForm = `${hostLine[0]} ${u.pathname + u.search} ${hostLine[2] || 'HTTP/1.1'}`;
  if (isLoopbackTarget(host)) {   // never tunnel loopback (see isLoopbackTarget)
    if (u.protocol === 'http:' && isOwnService(host, port, ownLoopbackPorts)) {
      const headers = lines.slice(1).filter(l => !/^Proxy-(?:Authorization|Connection):/i.test(l));
      const extra = Buffer.concat([Buffer.from([originForm, ...headers, '', ''].join('\r\n'), 'latin1'), rest]);
      pipeLocal(client, port, extra);
      return;
    }
    warn('relay', 'refusing loopback request to ' + host + ':' + port + ' (SSRF probe)');
    failLocal(client, 'loopback is not proxied');
    return;
  }
  if (proxy.scheme === 'socks5') {
    // wrap request through the socks tunnel (origin-form)
    try {
      const { sock, head: leftover } = await upstreamConnect(proxy, u.hostname, port);
      let out = originForm + '\r\n';
      for (const l of lines.slice(1)) out += l + '\r\n';
      out += '\r\n';
      sock.write(out);
      if (leftover && leftover.length) sock.write(rest);
      if (rest && rest.length) sock.write(rest);
      pipe(client, sock);
    } catch (e) { warn('relay', 'upstream failed:', e.message); client.destroy(); }
    return;
  }
  let out = `${originForm}\r\n`;
  for (const l of lines.slice(1)) { if (!/^Proxy-Authorization:/i.test(l)) out += l + '\r\n'; }
  out += `Host: ${u.host}\r\n`;
  if (proxy.user) out += `Proxy-Authorization: Basic ${Buffer.from(proxy.user + ':' + (proxy.pass || '')).toString('base64')}\r\n`;
  out += '\r\n';
  const up = net.connect({ host: proxy.host, port: +proxy.port, timeout: 15000 }, () => {
    up.write(out);
    if (rest && rest.length) up.write(rest);
    pipe(client, up);
  });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
}

function pipe(a, b) {
  a.pipe(b); b.pipe(a);
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
}
