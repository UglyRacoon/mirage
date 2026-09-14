// Mirage — Chrome DevTools Protocol client over the stdlib global WebSocket.
// Supports flattened target sessions (sessionId routing) without ever calling
// Runtime.enable on page sessions (CDP-detection-safe by design).
import { EventEmitter } from 'node:events';

export class CDP extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
    this.connected = false;
    this._listeners = new Set(); // {method, sessionId, cb}
  }
  static async connect(wsUrl, timeoutMs = 8000) {
    const c = new CDP(wsUrl);
    await c._open(timeoutMs);
    return c;
  }
  _open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => { clearTimeout(to); this.connected = true; resolve(); };
      ws.onerror = (e) => { clearTimeout(to); reject(new Error('CDP ws error')); };
      ws.onmessage = (ev) => this._onMsg(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      ws.onclose = () => { this.connected = false; this.emit('disconnected'); for (const p of this.pending.values()) p.reject(new Error('CDP closed')); this.pending.clear(); };
    });
  }
  _onMsg(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error.message), { cdpCode: msg.error.code })); else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const l of this._listeners) if (l.method === msg.method && (!l.sessionId || l.sessionId === msg.sessionId)) { try { l.cb(msg.params, msg.sessionId); } catch (e) { } }
      this.emit('event', msg);
    }
  }
  send(method, params = {}, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('CDP not connected'));
      const id = this.nextId++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, 25000);
    });
  }
  on(method, cb, sessionId = undefined) {
    const l = { method, cb, sessionId }; this._listeners.add(l);
    return () => this._listeners.delete(l);
  }
  off(l) { this._listeners.delete(l); }
  close() { try { this.ws && this.ws.close(); } catch (e) { } this.connected = false; }
}

// Browser endpoint from a debugging port
export async function browserWsEndpoint(port, host = '127.0.0.1') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, { signal: ctrl.signal });
    const j = await res.json();
    return j.webSocketDebuggerUrl;
  } finally { clearTimeout(t); }
}
