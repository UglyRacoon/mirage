// Mirage — minimal RFC6455 WebSocket *server* (stdlib only).
// Handles Upgrade handshake, text/binary frames, masking, fragmentation, ping/pong, close.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.alive = true;
    this.binary = null; // fragmentation buffer
    this.opFrame = null;
    socket.on('data', (buf) => this._onData(buf));
    socket.on('close', () => this._die());
    socket.on('error', () => this._die());
    this._pingTimer = setInterval(() => { try { this._frame(0x9, Buffer.alloc(0)); } catch (e) { this._die(); } }, 30000);
    this._pingTimer.unref?.();
  }
  _die() { if (!this.alive) return; this.alive = false; clearInterval(this._pingTimer); this.emit('close'); try { this.socket.destroy(); } catch (e) { } }
  send(data, { binary = false } = {}) {
    if (!this.alive) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this._frame(binary ? 0x2 : 0x1, buf);
  }
  sendJSON(obj) { this.send(JSON.stringify(obj)); }
  close() { try { this._frame(0x8, Buffer.alloc(0)); } catch (e) { } setTimeout(() => this._die(), 100); }
  _frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.allocUnsafe(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.allocUnsafe(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode; // FIN + opcode
    this.socket.write(Buffer.concat([header, payload]));
  }
  _onData(buf) {
    this._pending = Buffer.concat([this._pending || Buffer.alloc(0), buf]);
    while (this._pending && this._pending.length >= 2) {
      const b0 = this._pending[0], b1 = this._pending[1];
      const fin = (b0 & 0x80) !== 0; const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0; let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (this._pending.length < off + 2) break; len = this._pending.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this._pending.length < off + 8) break; const big = this._pending.readBigUInt64BE(off); if (big > 32n * 1024n * 1024n) { this.close(); break; } len = Number(big); off += 8; }
      let maskKey;
      if (masked) { if (this._pending.length < off + 4) break; maskKey = this._pending.subarray(off, off + 4); off += 4; }
      if (this._pending.length < off + len) break;
      let payload = this._pending.subarray(off, off + len);
      if (masked) { const u = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ maskKey[i & 3]; payload = u; }
      this._pending = this._pending.subarray(off + len);
      if (opcode === 0x8) { this._frame(0x8, Buffer.alloc(0)); this._die(); return; }
      if (opcode === 0x9) { this._frame(0xA, payload); continue; }
      if (opcode === 0xA) { continue; }
      if (opcode === 0x0) { // continuation
        if (this.binary) { this.binary.chunks.push(Buffer.from(payload)); if (fin) { const data = Buffer.concat(this.binary.chunks); const op = this.binary.op; this.binary = null; this.emit(op === 0x2 ? 'message' : 'text', data, op === 0x2); } }
        continue;
      }
      if (!fin) { this.binary = { op: opcode, chunks: [Buffer.from(payload)] }; continue; }
      this.emit('message', Buffer.from(payload), opcode === 0x2);
    }
  }
}

export function attachWebSocket(server, pathPrefix, onConnection, authorize) {
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith(pathPrefix)) return; // let others handle
      const key = req.headers['sec-websocket-key'];
      if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return;
      // Reject unauthenticated / cross-origin upgrades BEFORE the 101 handshake (must-fix #2).
      // Same-origin check blocks Cross-Site WebSocket Hijacking; authorize() enforces session/API key.
      const origin = req.headers.origin;
      if (origin) { try { if (new URL(origin).host !== (req.headers.host || '')) throw 0; } catch { try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); } catch (e0) { } return; } }
      if (authorize && !authorize(req)) { try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); } catch (e0) { } return; }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const headers = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n');
      socket.write(headers);
      socket.setNoDelay(true);
      const conn = new WSConn(socket);
      conn.url = url;
      conn.req = req;
      onConnection(conn, url, req);
    } catch (e) {
      try { socket.destroy(); } catch (e2) { }
    }
  });
}

// simple hub with channels
export class Hub {
  constructor() { this.channels = new Map(); this._joinCbs = []; this._leaveCbs = []; }
  onJoin(cb) { this._joinCbs.push(cb); }
  onLeave(cb) { this._leaveCbs.push(cb); }
  join(channel, conn) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    const was = this.channels.get(channel).size;
    this.channels.get(channel).add(conn);
    if (!was) for (const cb of this._joinCbs) { try { cb(channel); } catch (e) { } }
    conn.on('close', () => this.leave(channel, conn));
  }
  leave(channel, conn) { const s = this.channels.get(channel); if (s) { s.delete(conn); if (!s.size) { this.channels.delete(channel); for (const cb of this._leaveCbs) { try { cb(channel); } catch (e) { } } } } }
  broadcast(channel, obj, { binary = false } = {}) {
    const s = this.channels.get(channel); if (!s) return;
    const data = binary && Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
    for (const c of s) { try { c.send(data, { binary }); } catch (e) { } }
  }
  count(channel) { return (this.channels.get(channel) || new Set()).size; }
}
