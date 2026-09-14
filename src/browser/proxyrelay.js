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
export function startRelay(proxy) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => handleClient(client, proxy, reject));
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => { try { server.close(); } catch (e) { } } });
    });
  });
}

function handleClient(client, proxy) {
  client.setNoDelay(true);
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) { if (buf.length > 65536) client.destroy(); return; }
    client.removeListener('data', onData);
    const head = buf.subarray(0, end).toString('latin1');
    const rest = buf.subarray(end + 4);
    const [line] = head.split('\r\n');
    const [method, target] = line.split(/\s+/);
    if (method === 'CONNECT') handleConnect(client, proxy, target, head, rest);
    else forwardHttp(client, proxy, head, rest);
  };
  client.on('data', onData);
  client.on('error', () => client.destroy());
}

function upstreamConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    if (proxy.scheme === 'socks5') return socks5Connect(proxy, host, +port).then(resolve, reject);
    const up = net.connect({ host: proxy.host, port: +proxy.port, timeout: 12000 }, () => {
      let hdr = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
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
          b = Buffer.alloc(0); stage = 1; return;
        }
        if (chosen !== 0x00) { up.destroy(); reject(new Error('socks5 no acceptable method')); return; }
        b = Buffer.alloc(0); stage = 2; sendReq(); return;
      }
      if (stage === 1) {
        if (b.length < 2) return;
        if (b[1] !== 0x00) { up.destroy(); reject(new Error('socks5 auth failed')); return; }
        b = Buffer.alloc(0); stage = 2; sendReq(); return;
      }
      if (stage === 2) {
        if (b.length < 5) return;
        const atyp = b[3];
        let need = 5 + (atyp === 1 ? 4 : atyp === 3 ? 1 + b[4] : 16) + 2;
        if (b.length < need) return;
        if (b[1] !== 0x00) { up.destroy(); reject(new Error('socks5 connect refused: 0x' + b[1].toString(16))); return; }
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

async function handleConnect(client, proxy, target, head, rest) {
  const [host, port] = target.split(':');
  try {
    const { sock, head: leftover } = await upstreamConnect(proxy, host, port || 443);
    client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: MirageRelay\r\n\r\n');
    if (leftover && leftover.length) sock.write(leftover);
    if (rest && rest.length) sock.write(rest);
    pipe(client, sock);
  } catch (e) {
    client.write('HTTP/1.1 502 Bad Gateway\r\nX-Mirage-Error: ' + String(e.message).replace(/\r?\n/g, ' ') + '\r\nContent-Length: 0\r\n\r\n');
    client.destroy();
  }
}

async function forwardHttp(client, proxy, head, rest) {
  // plain http:// forwarding (for non-TLS requests)
  const lines = head.split('\r\n');
  const hostLine = lines[0].split(/\s+/);
  let u; try { u = new URL(hostLine[1]); } catch { client.destroy(); return; }
  const port = u.port || (u.protocol === 'https:' ? 443 : 80);
  const originForm = `${hostLine[0]} ${u.pathname + u.search} ${hostLine[2] || 'HTTP/1.1'}`;
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
    } catch (e) { client.destroy(); }
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
