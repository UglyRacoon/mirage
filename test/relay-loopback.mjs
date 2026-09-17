// Isolated relay regression: every listener is ephemeral and bound to 127.0.0.1.
// The upstream is a dummy; no browser, production service or external network is used.
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { startRelay } from '../src/browser/proxyrelay.js';
import { BrowserManager } from '../src/browser/manager.js';

const servers = [], relays = [], sockets = new Set();
async function listen(server) {
  servers.push(server);
  server.on('connection', s => {
    sockets.add(s);
    s.on('error', () => {});
    s.once('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
const binary = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256));
function request(port, head, body = Buffer.alloc(0), tunnel = false, split = false) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0), sent = false;
    const timer = setTimeout(() => finish(new Error('relay request timeout')), 4000);
    function finish(error) {
      clearTimeout(timer); s.destroy();
      if (error) reject(error); else resolve(data);
    }
    s.on('connect', () => {
      const first = split ? body.subarray(0, 17) : body;
      s.write(Buffer.concat([Buffer.from(head, 'latin1'), first]));
      if (split && !tunnel) setImmediate(() => s.write(body.subarray(17)));
    });
    s.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (!tunnel) return;
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      if (!data.subarray(0, end).toString().startsWith('HTTP/1.1 200 ')) { finish(); return; }
      if (split && !sent) { sent = true; s.write(body.subarray(17)); }
      if (data.length >= end + 4 + body.length) finish();
    });
    s.on('error', finish);
    s.on('close', () => { clearTimeout(timer); resolve(data); });
  });
}
function httpRequest(port, host, destinationPort, body = binary, split = false) {
  return request(port, `POST http://${host}:${destinationPort}/checker?embed=1 HTTP/1.1\r\nHost: ${host}:${destinationPort}\r\nProxy-Authorization: Basic do-not-forward\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`, body, false, split);
}
function connect(port, target, body = binary, split = false) {
  return request(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, body, true, split);
}
function assertResponse(data, status, body) {
  const end = data.indexOf('\r\n\r\n');
  assert.ok(end >= 0, 'complete response headers');
  assert.match(data.subarray(0, end).toString(), new RegExp(`^HTTP/1\\.1 ${status} `));
  if (body) assert.deepEqual(data.subarray(end + 4), body, 'binary bytes preserved exactly');
}

try {
  let httpHits = 0, echoHits = 0;
  const ctrlPort = await listen(http.createServer((req, res) => {
    httpHits++;
    assert.equal(req.url, '/checker?embed=1', 'local service receives origin-form');
    assert.equal(req.headers['proxy-authorization'], undefined, 'proxy credentials stay out of local service');
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
    });
  }));
  const echoPort = await listen(net.createServer(s => { echoHits++; s.pipe(s); }));
  const dials = [];
  const upPort = await listen(net.createServer(sock => {
    let stage = 0, buf = Buffer.alloc(0);
    sock.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        buf = buf.subarray(2 + buf[1]); stage = 1;
        sock.write(Buffer.from([5, 0]));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        assert.equal(buf[3], 3);
        const need = 7 + buf[4];
        if (buf.length < need) return;
        dials.push(`${buf.subarray(5, 5 + buf[4])}:${buf.readUInt16BE(need - 2)}`);
        sock.removeListener('data', onData);
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (buf.length > need) sock.write(buf.subarray(need));
        sock.pipe(sock);
      }
    });
  }));
  const bm = new BrowserManager({});
  bm.ownLoopbackPorts.clear(); // never authorize the configured production control-plane port
  for (const p of [0, -1, 65536, 1.5, 'invalid']) bm.addOwnLoopbackPort(p);
  assert.equal(bm.ownLoopbackPorts.size, 0, 'invalid allowlist ports ignored');
  const relay = await startRelay({ scheme: 'socks5', host: '127.0.0.1', port: upPort }, { ownLoopbackPorts: bm.ownLoopbackPorts });
  relays.push(relay);

  // A listener must remain unreachable until explicitly registered, including on an existing relay.
  assertResponse(await httpRequest(relay.port, '127.0.0.1', ctrlPort), 502);
  assertResponse(await connect(relay.port, `[::1]:${echoPort}`), 502);
  assert.equal(httpHits + echoHits, 0);
  bm.addOwnLoopbackPort(ctrlPort); bm.addOwnLoopbackPort(echoPort);
  for (const host of ['127.0.0.1', 'localhost', '[::1]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]']) {
    assertResponse(await httpRequest(relay.port, host, ctrlPort), 200, binary);
    assertResponse(await connect(relay.port, `${host}:${echoPort}`), 200, binary);
  }
  assertResponse(await httpRequest(relay.port, '127.0.0.1', ctrlPort, binary, true), 200, binary);
  assertResponse(await connect(relay.port, `127.0.0.1:${echoPort}`, binary, true), 200, binary);

  // A port match does not grant access to other loopback addresses/services.
  for (const host of ['127.0.0.2', 'unowned.localhost', '[::ffff:127.0.0.2]']) {
    assertResponse(await httpRequest(relay.port, host, ctrlPort), 502);
    assertResponse(await connect(relay.port, `${host}:${echoPort}`), 502);
  }
  for (const target of ['[::1]:0', '[::1]:65536', '::1:443', 'localhost:nope', 'localhost:443/path']) {
    assertResponse(await connect(relay.port, target), 502);
  }
  const beforeDelete = httpHits + echoHits;
  bm.removeOwnLoopbackPort(ctrlPort); bm.removeOwnLoopbackPort(echoPort);
  assertResponse(await httpRequest(relay.port, '127.0.0.1', ctrlPort), 502);
  assertResponse(await connect(relay.port, `[::1]:${echoPort}`), 502);
  assert.equal(httpHits + echoHits, beforeDelete, 'deleted ports receive no connections');

  // Failed dial must not emit a premature CONNECT 200.
  const closed = net.createServer();
  const closedPort = await listen(closed);
  await new Promise(resolve => closed.close(resolve));
  bm.addOwnLoopbackPort(closedPort);
  assertResponse(await connect(relay.port, `127.0.0.1:${closedPort}`), 502);
  bm.removeOwnLoopbackPort(closedPort);
  assert.deepEqual(dials, [], 'no local or invalid target reached upstream');

  assertResponse(await connect(relay.port, 'example.org:443', binary, true), 200, binary);
  assert.deepEqual(dials, ['example.org:443'], 'external CONNECT retains upstream routing');
  // SOCKS HTTP forwarding stays upstream too; dummy echoes request rather than dialing out.
  const externalHead = 'POST http://example.org/check HTTP/1.1\r\nHost: example.org\r\nContent-Length: 0\r\n\r\n';
  // Use the tunnel reader to stop after the echoed HTTP request head (no real HTTP response).
  const external = await request(relay.port, externalHead, Buffer.alloc(0), true);
  assert.match(external.toString(), /^POST \/check HTTP\/1\.1\r\n/);
  assert.deepEqual(dials, ['example.org:443', 'example.org:80']);
  console.log('PASS relay loopback: binary HTTP/CONNECT, IPv6, denial, live add/delete, failed dial, external upstream');
} finally {
  for (const relay of relays) relay.close();
  for (const sock of sockets) sock.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
