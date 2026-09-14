// Mirage — BrowserManager: launches Chromium per-profile with anti-detect CDP setup,
// injects the stealth bundle, streams a live view (screenshots) and relays input.
// Design note: we deliberately avoid Runtime.enable on page sessions during normal
// operation (CDP-detection sites look for its side effects); stealth is delivered via
// Page.addScriptToEvaluateOnNewDocument which requires no Runtime domain.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import { CDP, browserWsEndpoint } from './cdp.js';
import { buildStealthBundle } from '../fingerprint/stealth.js';
import { startRelay } from './proxyrelay.js';
import { pointerPath, keystrokePlan, scrollPlan, clickHold, gauss } from './humanize.js';
import { rngFor, clamp } from '../util.js';
import { log, warn, err, ok, uid, sleep, jparse, offsetFromTz } from '../util.js';

const exec = promisify(execFile);

export class BrowserManager {
  constructor({ dataDir, hub, getProfile, db }) {
    this.dataDir = dataDir; this.hub = hub; this.getProfile = getProfile; this.db = db;
    this.sessions = new Map();
    this.global = {};
    this._portCursor = 9333;
  }
  setSettings(s) { this.global = s || {}; }
  findBinary() {
    const cands = [this.global.chromiumPath, process.env.MIRAGE_CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean);
    return cands.find(p => fs.existsSync(p)) || null;
  }
  userDir(profileId, fresh) { const d = path.join(this.dataDir, 'browsers', profileId + (fresh ? '-fresh' : '')); fs.mkdirSync(d, { recursive: true }); return d; }

  async status() {
    const bin = this.findBinary();
    let version = null;
    if (bin) { try { version = (await exec(bin, ['--version'], { timeout: 8000 })).stdout.trim(); } catch (e) { } }
    const hasX = fs.existsSync('/tmp/.X11-unix/X0') || !!process.env.DISPLAY;
    return { binary: bin, version, xAvailable: hasX, xvfb: fs.existsSync('/usr/bin/Xvfb'), dataDir: this.dataDir };
  }

  async launch(profileId, opts = {}) {
    if (this.isRunning(profileId)) return this.sessions.get(profileId).public();
    if (this.sessions.size >= (this.global.maxSessions || 3)) throw new Error('Max concurrent sessions reached (' + this.global.maxSessions + ')');
    const profile = this.getProfile(profileId);
    if (!profile) throw new Error('Profile not found');
    const bin = this.findBinary();
    if (!bin) throw new Error('Chromium binary not found — set kernel path in Settings');

    const fp = profile.fingerprint || {};
    const settings = profile.settings || {};
    const fresh = !!opts.fresh || settings.cookiesMode === 'fresh';
    const cloud = !!opts.cloud || !!settings.cloud;
    const mode = opts.mode || (process.env.DISPLAY || cloud || this.global.forceXvfb ? (this.global.forceXvfb ? 'xvfb' : 'headed') : 'xvfb');

    const sess = {
      profileId, profile, fp, settings, mode, fresh, child: null, cdp: null, relay: null, display: null, xvfb: null,
      targets: new Map(), screenshots: 0, _start: Date.now(), status: 'starting', stealth: '', screencastOn: false,
      _fps: 0, _fpsCount: 0, _lastInput: Date.now(), listenersOff: [], dbgPort: 0, proxyUsed: null, _cleaned: false,
    };
    sess.public = () => this._info(sess);
    this.sessions.set(profileId, sess);
    this.db.logEvent('launch', { profileId, meta: { mode, proxy: !!sess.proxyUsed } });

    try {
      // 1) proxy relay (credentials + DNS leak protection)
      const proxy = resolveProxy(profile, this.db);
      if (proxy) { sess.relay = await startRelay(proxy); sess.proxyUsed = proxy; }

      // 2.5) GEOfollow: snap GPS + timezone to the proxy's egress location. A profile whose HTTP exit
      //       is in DE but whose GPS says RU (or whose timezone is off) is trivially caught — so the
      //       advertised geo must equal the real egress. Only applied when the proxy probe resolved a geo.
      if (proxy && proxy.last_check) {
        try {
          const lc = JSON.parse(proxy.last_check);
          if (lc.geo && lc.geo.lat && lc.geo.lon) {
            fp.geolocation = { mode: 'custom', lat: +lc.geo.lat, lon: +lc.geo.lon, accuracy: 65, altitude: 0, altitudeAccuracy: 0, heading: null, speed: null, timestamp: null };
            if (lc.geo.timezone) fp.timezone = { id: lc.geo.timezone, offsetMinutes: offsetFromTz(lc.geo.timezone) };
          }
        } catch (e) { }
      }

      // 2) display
      const env = { ...process.env };
      const wantXvfb = mode === 'xvfb' || (!process.env.DISPLAY && fs.existsSync('/usr/bin/Xvfb'));
      if (wantXvfb) {
        const disp = await this._allocXvfb(sess);
        if (disp) env.DISPLAY = disp;
        else throw new Error('No X display available (Xvfb missing and :0 unreachable)');
      } else {
        sess.display = process.env.DISPLAY || ':0'; env.DISPLAY = sess.display;
      }

      // 3) stealth bundle (deterministic per profile + session salt)
      //     bind WebRTC public candidate to the real egress IP so HTTP-IP == WebRTC-IP (key anti-bot check)
      if (proxy && proxy.last_check) {
        try { const exitIp = JSON.parse(proxy.last_check).exitIp; if (exitIp && fp.webrtc) fp.webrtc.egressPublicIp = exitIp; } catch (e) { }
      }
      sess.stealth = buildStealthBundle(fp, { sessionSalt: uid(6) });

      // 4) spawn
      const dir = this.userDir(profileId, fresh);
      sess.dir = dir;
      sess.dbgPort = await this._freePort();
      const args = this._buildArgs(profile, fp, sess, dir);
      log('browser', `launching ${profileId} (${sess.mode}) port=${sess.dbgPort} proxy=${proxy ? proxy.scheme + '://' + proxy.host : 'direct'}`);
      sess.child = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      // benign chromium noise on a headless service box — keep the journal readable for real problems
    const NOISE = /dbus|D-Bus|object_proxy|org\.freedesktop|GCM|google_apis|Registration response|DEPRECATED_ENDPOINT|cert_issuer_source_aia|Failed parsing Certificate|network_change_notifier|udev_|bluetooth|upower|bluez|GL: (error context|ESWARN|GLES|Error|QuerySupportedExtensions)|ContextResult::kFatalFailure: Failed to create|swiftshader|Failed to connect to the bus/i;
    sess.child.stderr.on('data', d => { const s = d.toString(); if (/ERROR|FATAL|Check failed|assert/i.test(s) && !NOISE.test(s)) warn('chromium', s.trim().slice(0, 300)); });
      sess.child.on('exit', (code) => { if (!sess._cleaned) { err('browser', profileId, 'kernel exited code=' + code); this._cleanup(sess, 'exited'); } });

      // 5) CDP connect
      await this._waitForDevTools(sess, 25000);
      const ws = await browserWsEndpoint(sess.dbgPort);
      sess.cdp = await CDP.connect(ws, 10000);
      await sess.cdp.send('Target.setDiscoverTargets', { discover: true });
      await sess.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      sess.listenersOff.push(
        sess.cdp.on('Target.attachedToTarget', p => this._onAttached(sess, p)),
        sess.cdp.on('Target.detachedFromTarget', p => { sess.targets.delete(p.targetId); this._broadcastTargets(sess); }),
        sess.cdp.on('Target.targetInfoChanged', p => this._onTargetInfo(sess, p)),
        sess.cdp.on('disconnected', () => this._cleanup(sess, 'disconnected')),
      );

      // 6) initial page
      const startUrl = opts.url || settings.startUrl || settings.startUrls?.[0] || '';
      const { targetId } = await sess.cdp.send('Target.createTarget', { url: 'about:blank' });
      sess.firstTargetId = targetId;
      await this._waitPageReady(sess, 8000);
      if (startUrl && /^https?:\/\//i.test(startUrl)) await this.navigate(profileId, startUrl);

      // 7) restore cookies snapshot
      if (!fresh) await this._restoreSnapshot(sess).catch(e => warn('browser', 'restore', e.message));

      sess.status = 'running';
      this._emitApp();
      ok('browser', profileId, 'running', sess.display);
      return sess.public();
    } catch (e) {
      err('browser', 'launch failed:', e.message);
      await this._cleanup(sess, 'error:' + e.message);
      throw e;
    }
  }

  // ---------------- internals ----------------
  _buildArgs(profile, fp, sess, dir) {
    const s = profile.settings || {};
    const w = Math.min(fp.screen?.width || 1440, sess.mode === 'xvfb' ? 1600 : 1920);
    const h = Math.min((fp.screen?.height || 900) + 90, sess.mode === 'xvfb' ? 1000 : 1080);
    const args = [
      `--remote-debugging-port=${sess.dbgPort}`,
      `--user-data-dir=${dir}`,
      '--no-startup-window', '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-sync',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
      // keep WebGL contexts alive under Xvfb/software GL (SwiftShader) — pages must always get a canvas GL
      '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
      '--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,DesktopPWAsAdditionalWindowingControls',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--password-store=basic', '--use-mock-keychain',
      `--window-size=${w},${h}`, '--window-position=0,0',
    ];
    // kernel-level defaults so popups/new sessions never leak the true identity
    if (fp.ua) args.push(`--user-agent=${fp.ua}`);
    if (fp.locale?.acceptLanguage) args.push(`--accept-lang=${fp.locale.acceptLanguage}`);
    if (fp.timezone?.id) { /* CDP handles tz per-session; no reliable launch flag */ }
    if (sess.relay) { args.push(`--proxy-server=${sess.relay.url}`); args.push('--proxy-bypass-list=<-loopback>'); }
    // kernel-level WebRTC leak control (defense-in-depth alongside the JS candidate rewrite):
    // behind a proxy, forbid non-proxied UDP (blocks a direct STUN that would expose the true IP);
    // direct connections still hide private LAN interfaces.
    args.push('--force-webrtc-ip-handling-policy=' + (sess.relay ? 'disable_non_proxied_udp' : 'default_public_interface_only'));
    if (fp.network?.quic !== 'on') args.push('--disable-quic');
    if (s.blockWebBluetooth !== false) args.push('--disable-web-bluetooth');
    if (s.disable3dGpu) args.push('--disable-gpu'); // note: hurts WebGL realism — opt-in only
    if (s.extraArgs) for (const a of String(s.extraArgs).split(/\s+/).filter(Boolean)) args.push(a);
    if (fp.locale?.languages?.[0]) args.push('--lang=' + fp.locale.languages[0].toLowerCase());
    return args;
  }
  async _freePort() {
    for (let i = 0; i < 50; i++) {
      const p = this._portCursor++;
      if (this._portCursor > 9900) this._portCursor = 9333;
      const okp = await new Promise(res => { const sv = net.createServer(); sv.once('error', () => res(false)); sv.once('listening', () => sv.close(() => res(true))); sv.listen(p, '127.0.0.1'); });
      if (okp) return p;
    }
    throw new Error('no free debug port');
  }
  async _waitForDevTools(sess, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const r = await fetch(`http://127.0.0.1:${sess.dbgPort}/json/version`, { signal: AbortSignal.timeout(1200) }); if (r.ok) return; } catch (e) { }
      if (sess.child && sess.child.exitCode !== null) throw new Error('kernel exited before DevTools ready');
      await sleep(300);
    }
    throw new Error('DevTools endpoint timeout');
  }
  async _allocXvfb(sess) {
    if (fs.existsSync('/tmp/.X11-unix/X0') && !sess.forceXvfb && !this.global.forceXvfb) { sess.display = ':0'; return ':0'; }
    if (!fs.existsSync('/usr/bin/Xvfb')) return null;
    this._xvfbN = (this._xvfbN || 98) + 1;
    const disp = ':' + this._xvfbN;
    const w = sess.fp.screen?.width || 1440, h = (sess.fp.screen?.height || 900) + 90;
    sess.xvfb = spawn('/usr/bin/Xvfb', [disp, '-screen', '0', `${Math.min(w, 1600)}x${Math.min(h, 1000)}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
    await sleep(900);
    sess.display = disp;
    return disp;
  }
  async _waitPageReady(sess, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const p = Array.from(sess.targets.values()).find(t => t.type === 'page' && t.ready);
      if (p) return p;
      await sleep(200);
    }
    warn('browser', 'page attach timeout (continuing)');
    return null;
  }
  _onAttached(sess, p) {
    const { sessionId, targetInfo } = p;
    const release = () => { try { sess.cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => { }); } catch (e) { } };
    if (targetInfo.type !== 'page') { if (targetInfo.type === 'other' || targetInfo.type === 'shared_worker' || targetInfo.type === 'service_worker') release(); return; }
    sess.targets.set(targetInfo.targetId, { sessionId, type: targetInfo.type, url: targetInfo.url, title: targetInfo.title, ready: false, _ov: false });
    this._applyOverrides(sess, sess.targets.get(targetInfo.targetId))
      .then(() => { const t = sess.targets.get(targetInfo.targetId); if (t) { t.ready = true; } this._broadcastTargets(sess); })
      .catch(e => warn('browser', 'override failed:', e.message))
      .finally(() => release()); // never leave a page frozen
  }
  _onTargetInfo(sess, p) {
    const t = sess.targets.get(p.targetInfo.targetId);
    if (!t || t.type !== 'page') return;
    const changed = t.url !== p.targetInfo.url;
    t.url = p.targetInfo.url; t.title = p.targetInfo.title;
    this._broadcastTargets(sess);
    if (changed && /^https?:/.test(t.url)) {
      this.db.logHistory(sess.profileId, t.url, t.title || '');
      this.hub.broadcast('live:' + sess.profileId, { type: 'nav', url: t.url, title: t.title });
    }
  }
  _broadcastTargets(sess) {
    const list = Array.from(sess.targets.entries()).filter(([, v]) => v.type === 'page').map(([id, v]) => ({ id, url: v.url, title: v.title, active: id === sess.firstTargetId }));
    this.hub.broadcast('live:' + sess.profileId, { type: 'targets', targets: list });
  }

  async _applyOverrides(sess, t) {
    if (!t || t._ov) return; t._ov = true;
    const sid = t.sessionId, fp = sess.fp, c = sess.cdp;
    try {
      await c.send('Page.enable', {}, sid);
      await c.send('Network.enable', {}, sid);
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: sess.stealth, runImmediately: true }, sid);
      const ch = fp.clientHints;
      const meta = (ch && ch.supported) ? {
        brands: ch.brands, fullVersionList: ch.fullVersionList, mobile: !!ch.mobile, platform: ch.platform,
        platformVersion: ch.platformVersion, architecture: ch.architecture, bitness: ch.bitness || '64', model: ch.model || '', wow64: !!ch.wow64,
      } : undefined;
      await c.send('Network.setUserAgentOverride', { userAgent: fp.ua, acceptLanguage: fp.locale?.acceptLanguage, platform: fp.platform, userAgentMetadata: meta }, sid);
      const extra = {};
      if (fp.headers?.dnt === '1') extra['DNT'] = '1';
      if (Object.keys(extra).length) await c.send('Network.setExtraHTTPHeaders', { headers: extra }, sid);
      if (fp.timezone?.id) { try { await c.send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone.id }, sid); } catch (e) { } }
      if (fp.geolocation?.mode === 'custom') { try { await c.send('Emulation.setGeolocationOverride', { latitude: fp.geolocation.lat, longitude: fp.geolocation.lon, accuracy: fp.geolocation.accuracy || 60 }, sid); } catch (e) { } }
      if (fp.isMobile && fp.screen) {
        await c.send('Emulation.setDeviceMetricsOverride', { width: fp.screen.width, height: fp.screen.height, deviceScaleFactor: fp.screen.dpr || 1, mobile: true }, sid).catch(() => { });
      }
      if (fp.hardware?.maxTouchPoints) { await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: fp.hardware.maxTouchPoints }, sid).catch(() => { }); }
      // geolocation permission auto-decision
      try { await c.send('Emulation.setPermission', { descriptor: { name: 'geolocation' }, setting: fp.permissions?.geolocation === 'allow' ? 'granted' : fp.permissions?.geolocation === 'ask' ? 'prompt' : 'denied' }, sid); } catch (e) { }
      try { await c.send('Emulation.setPermission', { descriptor: { name: 'notifications' }, setting: fp.permissions?.notifications === 'allow' ? 'granted' : 'prompt' }, sid); } catch (e) { }
    } catch (e) { t._ov = false; throw e; }
  }

  async _restoreSnapshot(sess) {
    const snaps = this.db.listSnapshots(sess.profileId);
    if (!snaps.length) return;
    const full = this.db.getSnapshot(snaps[0].id); if (!full || !full.cookies.length) return;
    const t = this._pick(sess);
    try {
      await sess.cdp.send('Network.setCookies', { cookies: full.cookies.map(c => ({ ...c, session: undefined, expires: c.expires || -1 })) }, t.sessionId);
    } catch (e) { warn('browser', 'cookie restore: ' + e.message); }
  }

  _pick(sess) {
    const pages = Array.from(sess.targets.values()).filter(t => t.type === 'page' && t._ov);
    const t = sess.activeTargetId && pages.find(p => p.sessionId === sess.activeTargetId) || pages[pages.length - 1];
    if (!t) throw new Error('No ready page target');
    return t;
  }

  // ---------------- public ops ----------------
  async navigate(profileId, url) { const s = this._need(profileId); const t = this._pick(s); await s.cdp.send('Page.navigate', { url: normalizeUrl(url) }, t.sessionId); s._lastInput = Date.now(); }
  async reload(profileId) { const s = this._need(profileId); const t = this._pick(s); await s.cdp.send('Page.reload', {}, t.sessionId); }
  async goBack(profileId) { const s = this._need(profileId); const t = this._pick(s); await this._keyCombo(s, t, 'AltLeft', 'Alt', 'ArrowLeft'); }
  async goForward(profileId) { const s = this._need(profileId); const t = this._pick(s); await this._keyCombo(s, t, 'AltRight', 'Alt', 'ArrowRight'); }
  async _keyCombo(s, t, code, key, key2) {
    const sid = t.sessionId;
    const vk = key2 === 'ArrowLeft' ? 37 : 39;
    const code2 = key2 === 'ArrowLeft' ? 'ArrowLeft' : 'ArrowRight';
    await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 1, key, code, windowsVirtualKeyCode: 18 }, sid).catch(() => { });
    await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 1, key: key2, code: code2, windowsVirtualKeyCode: vk }, sid).catch(() => { });
    await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: key2, code: code2, windowsVirtualKeyCode: vk }, sid).catch(() => { });
    await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key, code, windowsVirtualKeyCode: 18 }, sid).catch(() => { });
  }
  async newTab(profileId, url) {
    const s = this._need(profileId);
    // open blank first → wait for attach+overrides → then navigate (stealth guaranteed pre-script)
    const { targetId } = await s.cdp.send('Target.createTarget', { url: 'about:blank' });
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const t = s.targets.get(targetId);
      if (t && t.ready) { try { await s.cdp.send('Page.navigate', { url: normalizeUrl(url) }, t.sessionId); } catch (e) { } break; }
      await sleep(150);
    }
    return targetId;
  }
  async closeTab(profileId, targetId) { const s = this._need(profileId); await s.cdp.send('Target.closeTarget', { targetId }).catch(() => { }); }
  async activateTab(profileId, targetId) {
    const s = this._need(profileId);
    s.activeTargetId = Array.from(s.targets.entries()).find(([id]) => id === targetId)?.[1]?.sessionId || s.activeTargetId;
    await s.cdp.send('Target.activateTarget', { targetId }).catch(() => { });
    if (s.screencastOn && s._nativeScreencast) { await this.stopLive(profileId); this.startLive(profileId, { fps: this.global.liveFps || 6 }); }
  }
  tabs(profileId) { const s = this._need(profileId); return Array.from(s.targets.entries()).filter(([, v]) => v.type === 'page').map(([id, v]) => ({ id, url: v.url, title: v.title })); }

  async screenshot(profileId) {
    const s = this._need(profileId); const t = this._pick(s);
    const r = await s.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.global.shotQuality || 55 }, t.sessionId);
    s.screenshots++; s._fpsCount++; return r.data;
  }
  async layoutMetrics(profileId) {
    const s = this._need(profileId); const t = this._pick(s);
    try { const m = await s.cdp.send('Page.getLayoutMetrics', {}, t.sessionId); return { w: m.cssVisualViewport?.width || 1280, h: m.cssVisualViewport?.height || 720 }; } catch (e) { return { w: 1280, h: 720 }; }
  }
  async evaluate(profileId, expression, targetId = null) {
    const s = this._need(profileId); const t = (targetId && s.targets.get(targetId)) || this._pick(s);
    try { await s.cdp.send('Runtime.enable', {}, t.sessionId); } catch (e) { }
    const r = await s.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, t.sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }

  async inputMouse(profileId, ev) {
    const s = this._need(profileId); const t = this._pick(s); s._lastInput = Date.now();
    await s.cdp.send('Input.dispatchMouseEvent', {
      type: ev.type, x: Math.round(ev.x), y: Math.round(ev.y),
      button: ev.button || 'left', clickCount: ev.clickCount || (ev.type === 'mousePressed' ? 1 : 0),
      buttons: ev.buttons ?? (ev.type === 'mousePressed' ? 1 : ev.type === 'mouseReleased' ? 0 : -1),
      deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0, pointerType: ev.pointerType || 'mouse',
    }, t.sessionId);
  }
  async inputKey(profileId, ev) {
    const s = this._need(profileId); const t = this._pick(s); s._lastInput = Date.now();
    if (ev.type === 'char' || (ev.type === 'keyDown' && ev.text && ev.key && ev.key.length === 1)) {
      await s.cdp.send('Input.insertText', { text: ev.text || ev.key }, t.sessionId).catch(() => { });
      if (ev.type === 'char') return;
    }
    await s.cdp.send('Input.dispatchKeyEvent', { type: ev.type, key: ev.key, code: ev.code, text: ev.text, modifiers: ev.modifiers || 0, windowsVirtualKeyCode: vkc(ev.key), nativeVirtualKeyCode: vkc(ev.key) }, t.sessionId);
  }

  // ---- behavioral humanization (fluent, curved, variable-speed input) ----
  _hrng(s) { s._hcount = (s._hcount || 0) + 1; return rngFor(`${s.profileId}|${s.canvasSeed || s.seed || ''}|h${s._hcount}|${process.hrtime.bigint() % 100000n}`); }
  async _mouse(s, params) { const t = this._pick(s); await s.cdp.send('Input.dispatchMouseEvent', { pointerType: 'mouse', buttons: -1, clickCount: 0, button: 'none', ...params }, t.sessionId); }
  // Move the pointer to (x,y) along a curved path from wherever it last was.
  async humanMove(profileId, x, y, opts = {}) {
    const s = this._need(profileId); const rng = this._hrng(s);
    const from = { x: s._px ?? Math.round((opts.w || 800) / 2), y: s._py ?? Math.round((opts.h || 600) / 2) };
    const path = pointerPath(rng, from.x, from.y, x, y, opts);
    for (const p of path) { await sleep(p.delay); await this._mouse(s, { type: 'mouseMoved', x: p.x, y: p.y }); s._px = p.x; s._py = p.y; }
    s._lastInput = Date.now();
  }
  // Aim + click with pre/post dwell and a micro-overshoot settle.
  async humanClick(profileId, x, y, opts = {}) {
    const s = this._need(profileId); const rng = this._hrng(s);
    await this.humanMove(profileId, x, y, opts);
    const h = clickHold(rng);
    await sleep(h.pre);
    const t = this._pick(s);
    await s.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: opts.button || 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' }, t.sessionId);
    await sleep(Math.round(clamp(gauss(rng, 55, 22), 30, 130)));      // button-down duration
    await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: opts.button || 'left', clickCount: 1, buttons: 0, pointerType: 'mouse' }, t.sessionId);
    await sleep(h.post); s._lastInput = Date.now(); s._px = x; s._py = y;
  }
  // Type a string one keystroke at a time with human dwell/hold and rare self-correcting typos.
  async humanType(profileId, text, opts = {}) {
    const s = this._need(profileId); const rng = this._hrng(s); const t = this._pick(s);
    for (const e of keystrokePlan(rng, String(text), opts)) {
      await sleep(e.down);
      if (e.type === 'backspace') {
        await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, t.sessionId);
        await sleep(e.hold);
        await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, t.sessionId);
        continue;
      }
      const ch = e.ch, up = ch.toUpperCase();
      await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + (/[a-z]/i.test(ch) ? up : ''), text: ch, unmodifiedText: ch, windowsVirtualKeyCode: up.charCodeAt(0) || ch.charCodeAt(0), nativeVirtualKeyCode: up.charCodeAt(0) || ch.charCodeAt(0) }, t.sessionId);
      await sleep(e.hold);
      await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + (/[a-z]/i.test(ch) ? up : ''), windowsVirtualKeyCode: up.charCodeAt(0) || ch.charCodeAt(0), nativeVirtualKeyCode: up.charCodeAt(0) || ch.charCodeAt(0) }, t.sessionId);
    }
    s._lastInput = Date.now();
  }
  // Scroll a page by deltaY across several decelerating wheel ticks.
  async humanScroll(profileId, deltaY, opts = {}) {
    const s = this._need(profileId); const rng = this._hrng(s);
    const x = opts.x ?? s._px ?? 400, y = opts.y ?? s._py ?? 300;
    for (const tick of scrollPlan(rng, deltaY, opts)) { await sleep(tick.delay); await this._mouse(s, { type: 'mouseWheel', x, y, deltaX: 0, deltaY: tick.deltaY }); }
    s._lastInput = Date.now();
  }

  // Continuous screencast loop bound to the hub channel 'live:<pid>'
  async startLive(profileId, { fps = 6 } = {}) {
    const s = this._need(profileId);
    if (s.screencastOn) return;
    s.screencastOn = true; s._fpsCount = 0; this._emitApp();
    let t; try { t = this._pick(s); } catch (e) { s.screencastOn = false; return; }
    const sid = t.sessionId;
    const emit = (b64, meta) => {
      s.lastShot = b64; s.screenshots++; s._fpsCount++;
      this.hub.broadcast('live:' + profileId, Buffer.from(b64, 'base64'), { binary: true });
      this.hub.broadcast('live:' + profileId, { type: 'meta', ...meta });
    };
    let done = false;
    const offEvt = s.cdp.on('Page.screencastFrame', (p, evSid) => {
      if (!s.screencastOn || s._cleaned) return;
      s.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, evSid).catch(() => { });
      emit(p.data, p.metadata || {});
    }, sid);
    s.listenersOff.push(offEvt);
    const stopEvt = () => { if (done) return; done = true; offEvt(); };
    // native path: event-driven frames; fallback: captureScreenshot poll at requested fps
    try {
      await s.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.global.shotQuality || 55, everyNthFrame: 1 }, sid);
      s._nativeScreencast = true;
      // watchdog: if no frame within 4s, degrade to polling
      setTimeout(() => { if (s.screencastOn && s.screenshots === 0) this._pollLive(profileId, fps, stopEvt).catch(() => { }); }, 4000);
      return;
    } catch (e) { s._nativeScreencast = false; }
    this._pollLive(profileId, fps, stopEvt).catch(() => { });
  }
  async _pollLive(profileId, fps, stopEvt) {
    const s = this.sessions.get(profileId);
    if (!s || !s.screencastOn) { stopEvt(); return; }
    let lastT = 0;
    const loop = async () => {
      if (!s.screencastOn || s._cleaned) { stopEvt(); return; }
      const t0 = Date.now();
      try {
        const b64 = await this.screenshot(profileId);
        const lm = await this.layoutMetrics(profileId);
        if (t0 - lastT >= 1000 / fps - 15) { lastT = t0; emitPoll(b64, lm); }
      } catch (e) { s.screencastOn = false; stopEvt(); return; }
      if (s.screencastOn) setTimeout(loop, Math.max(40, 1000 / fps - (Date.now() - t0)));
    };
    const emitPoll = (b64, lm) => {
      s.lastShot = b64; s.screenshots++; s._fpsCount++;
      this.hub.broadcast('live:' + profileId, Buffer.from(b64, 'base64'), { binary: true });
      this.hub.broadcast('live:' + profileId, { type: 'meta', screenWidth: lm.w, screenHeight: lm.h, screenshotWidth: lm.w, screenshotHeight: lm.h, deviceScaleFactor: 1 });
    };
    loop();
  }
  async stopLive(profileId) {
    const s = this.sessions.get(profileId);
    if (!s) return;
    s.screencastOn = false;
    if (s._nativeScreencast) { try { const t = this._pick(s); await s.cdp.send('Page.stopScreencast', {}, t.sessionId); } catch (e) { } s._nativeScreencast = false; }
    this._emitApp();
  }

  async cookies(profileId) { const s = this._need(profileId); const t = this._pick(s); const { cookies } = await s.cdp.send('Network.getAllCookies', {}, t.sessionId).catch(() => ({ cookies: [] })); return cookies; }
  async setCookies(profileId, cookies) { const s = this._need(profileId); const t = this._pick(s); await s.cdp.send('Network.setCookies', { cookies }, t.sessionId); }
  async clearAll(profileId) { const s = this._need(profileId); const t = this._pick(s); await s.cdp.send('Network.clearBrowserCookies', {}, t.sessionId); await s.cdp.send('Network.clearBrowserCache', {}, t.sessionId).catch(() => { }); }

  async snapshot(profileId) {
    const s = this._need(profileId); const t = this._pick(s);
    const { cookies } = await s.cdp.send('Network.getAllCookies', {}, t.sessionId).catch(() => ({ cookies: [] }));
    let ls = { origin: '', data: {} };
    try {
      const r = await s.cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({u:location.origin,d:{...localStorage}})', returnByValue: true }, t.sessionId);
      ls = jparse(r.result?.value, ls);
    } catch (e) { }
    const id = this.db.saveSnapshot(profileId, cookies, ls, ls.origin || '');
    this.db.logEvent('snapshot', { profileId, meta: { cookies: cookies.length } });
    return { id, cookies: cookies.length, origin: ls.origin };
  }
  async restoreSnapshot(profileId, snapshotId, { launchIfNeeded = true } = {}) {
    const full = this.db.getSnapshot(snapshotId);
    if (!full) throw new Error('snapshot not found');
    if (!this.isRunning(profileId)) { if (!launchIfNeeded) return { restored: full.cookies.length, offline: true }; await this.launch(profileId, {}); }
    const s = this._need(profileId); const t = this._pick(s);
    await s.cdp.send('Network.setCookies', { cookies: full.cookies.map(c => ({ ...c, session: undefined, expires: c.expires || -1 })) }, t.sessionId);
    this.db.logEvent('snapshot.restore', { profileId, meta: { snapshotId, cookies: full.cookies.length } });
    return { restored: full.cookies.length };
  }
  deleteSnapshot(id) { this.db.deleteSnapshot(id); }
  snapshots(profileId) { return this.db.listSnapshots(profileId); }

  async stop(profileId, { save = true } = {}) {
    const s = this.sessions.get(profileId); if (!s || s._cleaned) return;
    if (save && s.status === 'running') { try { await this.snapshot(profileId); } catch (e) { warn('browser', 'final snapshot failed: ' + e.message); } }
    try { if (s.cdp?.connected) await s.cdp.send('Browser.close'); } catch (e) { }
    await sleep(300);
    if (s.fresh && s.dir) { try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) { } }
    this._cleanup(s, 'stopped');
  }
  stopAll() { return Promise.all(Array.from(this.sessions.keys()).map(id => this.stop(id).catch(() => { }))); }

  public(profileId) { const s = this.sessions.get(profileId); return s ? s.public() : null; }
  list() { return Array.from(this.sessions.values()).map(s => s.public()); }
  isRunning(profileId) { const s = this.sessions.get(profileId); return !!(s && s.child && s.child.exitCode === null && !s._cleaned); }
  _need(profileId) { const s = this.sessions.get(profileId); if (!s || !s.cdp || s._cleaned) throw new Error('Browser not running for profile ' + profileId); return s; }

  _cleanup(sess, reason) {
    if (sess._cleaned) return; sess._cleaned = true;
    sess.screencastOn = false; sess.status = 'stopped';
    for (const off of sess.listenersOff) { try { off(); } catch (e) { } }
    if (sess.cdp) { try { sess.cdp.close(); } catch (e) { } }
    if (sess.child) { try { sess.child.kill('SIGTERM'); const ch = sess.child; setTimeout(() => { try { if (ch.exitCode === null) ch.kill('SIGKILL'); } catch (e) { } }, 2500); } catch (e) { } }
    if (sess.xvfb) { try { sess.xvfb.kill('SIGTERM'); } catch (e) { } }
    if (sess.relay) { try { sess.relay.close(); } catch (e) { } }
    this.sessions.delete(sess.profileId);
    this.db.logEvent('close', { profileId: sess.profileId, meta: { reason } });
    this.hub.broadcast('live:' + sess.profileId, { type: 'closed' });
    this._emitApp();
  }
  _info(s) {
    return {
      profileId: s.profileId, status: s._cleaned ? 'stopped' : (s.child && s.child.exitCode === null ? s.status : 'stopping'),
      mode: s.mode, display: s.display, endpoint: s.dbgPort ? `ws://127.0.0.1:${s.dbgPort}` : null, port: s.dbgPort || null,
      screencastOn: !!s.screencastOn, screenshots: s.screenshots || 0, fresh: !!s.fresh,
      proxy: s.proxyUsed ? `${s.proxyUsed.scheme}://${s.proxyUsed.host}:${s.proxyUsed.port}` : 'direct',
      up: Math.round((Date.now() - s._start) / 1000),
      tabs: Array.from(s.targets.values()).filter(t => t.type === 'page').map(t => ({ url: t.url, title: t.title })),
    };
  }
  _emitApp() { this.hub.broadcast('app', { type: 'browsers', running: this.list().map(s => ({ profileId: s.profileId, status: s.status, screencast: s.screencastOn, mode: s.mode, proxy: s.proxy })) }); }
}

function normalizeUrl(u) { if (!u) return 'about:blank'; if (/^(https?|about|file):\/\//i.test(u) || u === 'about:blank') return u; return 'https://' + u; }
function vkc(key) { const m = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }; if (m[key]) return m[key]; if (key && key.length === 1) return key.toUpperCase().charCodeAt(0); return 0; }
function resolveProxy(profile, db) {
  if (profile.proxy_id) { const p = db.getProxy(profile.proxy_id); if (p) return p; }
  const inline = profile.inline_proxy;
  if (inline && /\w+:\/\/.+:\d+/.test(inline)) {
    try { const u = new URL(inline); return { scheme: u.protocol.replace(':', ''), host: u.hostname, port: +u.port || 1080, user: decodeURIComponent(u.username || ''), pass: decodeURIComponent(u.password || '') }; } catch (e) { }
  }
  return null;
}
