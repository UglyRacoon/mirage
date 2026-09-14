// Mirage — STEALTH bundle builder.
// Compiles a profile fingerprint into a single injectable IIFE that overrides
// every detectable browser API the way commercial anti-detect kernels do:
// canvas / WebGL / WebGPU / audio / fonts / media devices / speech / geolocation /
// permissions / battery / WebRTC ICE / navigator / screen / plugins / Client Hints /
// codecs / timezone / automation traces — with native toString() protection for all patched members.

/**
 * Build the stealth JS bundle for a fingerprint.
 * @param {object} fp fingerprint object (profile.fingerprint)
 * @param {object} opts { sessionSalt }
 */
export function buildStealthBundle(fp, opts = {}) {
  const fam = familyOf(fp?.osId);
  const salt = opts.sessionSalt || (fp?.canvas?.mode === 'per-session' ? String(Date.now()) : (fp?.canvas?.seed || fp?.seed || 'mirage'));
  const FP = {
    fam,
    ua: fp?.ua || null, platform: fp?.platform || null, vendor: fp?.vendor ?? null,
    languages: fp?.locale?.languages || ['en-US'], acceptLanguage: fp?.locale?.acceptLanguage,
    tz: fp?.timezone?.id || null, tzOffset: fp?.timezone?.offsetMinutes,
    cores: fp?.hardware?.hardwareConcurrency || 4,
    mem: fp?.hardware?.deviceMemory ?? null,
    touch: fp?.hardware?.maxTouchPoints ?? 0,
    dnt: fp?.navigator?.doNotTrack ?? null,
    productSub: fp?.navigator?.productSub, vendorSub: fp?.navigator?.vendorSub,
    oscpu: fp?.navigator?.oscpu, appVersion: fp?.navigator?.appVersion,
    pdfViewer: fp?.navigator?.pdfViewerEnabled !== false,
    conn: fp?.navigator?.connection || null,
    ch: (fp?.clientHints && fp.clientHints.supported) ? fp.clientHints : null,
    plugins: fp?.plugins || [], mimeTypes: fp?.mimeTypes || [],
    battery: fp?.battery || null,
    alive: fp?.alive || null,
    screen: fp?.screen || null, dpr: fp?.screen?.dpr || 1,
    canvas: fp?.canvas || { mode: 'off' }, audio: fp?.audio || { mode: 'off' },
    gl: { vendor: fp?.gpu?.vendor, renderer: fp?.gpu?.renderer, unmaskedVendor: fp?.gpu?.unmaskedVendor, unmaskedRenderer: fp?.gpu?.unmaskedRenderer || fp?.gpu?.renderer, version: fp?.gpu?.webglVersion, slv: fp?.gpu?.shadingLanguageVersion, extensions: fp?.gpu?.extensions || [], webgl2: !!fp?.gpu?.webgl2, limits: fp?.gpu?.limits || null, precision: fp?.gpu?.precision || null },
    webgpu: fp?.gpu?.webgpu || null,
    devices: fp?.media?.devices || [], codecs: fp?.media?.codecs || {},
    voices: fp?.speech?.voices || [],
    fonts: fp?.fonts?.list || [], fontSpoof: fp?.fonts?.spoofEnumeration !== false,
    geo: fp?.geolocation || null, webrtc: fp?.webrtc || { mode: 'disable' },
    permissions: fp?.permissions || {},
    mobile: !!fp?.isMobile, browser: fp?.browser || 'chrome',
    chromeObj: (fp?.browser || 'chrome') === 'chrome' || fp?.browser === 'edge',
    mode: fp?.mode || 'full', // 'full' | 'custom-only'
  };
  return `(function(){
"use strict";
if (window.__MIRAGE_STEALTH) return; window.__MIRAGE_STEALTH = 1;
const FP = ${JSON.stringify(FP)};
const SALT = ${JSON.stringify(String(salt))};
${JS_BODY}
})();`;
}

function familyOf(osId) {
  const s = String(osId);
  if (/windows/.test(s)) return 'windows';
  if (/macos/.test(s)) return 'mac';
  if (/ubuntu|linux/.test(s)) return 'linux';
  if (/android/.test(s)) return 'android';
  if (/ios/.test(s)) return 'ios';
  return 'windows';
}

const JS = String.raw;
const JS_BODY = JS`
// ================= helpers =================
const nat = new WeakMap();
const _toString = Function.prototype.toString;
function _patchedToString() { return nat.has(this) ? _toString.call(nat.get(this)) : _toString.call(this); }
try { Object.defineProperty(_patchedToString, 'name', { value: 'toString', configurable: true }); } catch (e) {}
Function.prototype.toString = patch(_patchedToString, _toString);
try { Function.prototype.toString.toString = function () { return 'function toString() { [native code] }'; }; } catch (e) {}
function own(o, p) { try { return Object.getOwnPropertyDescriptor(o, p); } catch (e) { return null; } }
function def(o, p, get) { Object.defineProperty(o, p, { configurable: true, enumerable: true, get }); }
function defRW(o, p, get, set) { Object.defineProperty(o, p, { configurable: true, enumerable: true, get, set }); }
function patch(fn, orig) { if (orig && typeof orig === 'function') nat.set(fn, orig); return fn; }
function hash32(s) { s = String(s); let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function makeRng(seedStr) { let a = hash32(seedStr); return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function section(name, fn) { try { fn(); } catch (e) { (window.__MIRAGE_ERRORS = window.__MIRAGE_ERRORS || []).push(name + ': ' + (e && e.message)); } }
function mkObj(base, props) { const o = Object.create(base || null); for (const [k, v] of Object.entries(props)) { if (typeof v === 'function') def(o, k, patch(v)); else def(o, k, patch(function () { return v; })); } return o; }
const canvasErrors = [];

// ================= registry for checker =================
section('registry', function () {
  Object.defineProperty(window, '__MIRAGE', { configurable: true, value: {
    fp: FP, salt: SALT, version: 'mirage-stealth/1', errors: canvasErrors,
    expected: {
      userAgent: FP.ua, platform: FP.platform, vendor: FP.vendor, languages: FP.languages,
      hardwareConcurrency: FP.cores, deviceMemory: FP.mem, maxTouchPoints: FP.touch, timezone: FP.tz,
      screen: FP.screen, dpr: FP.dpr, webgl: FP.gl, webgpu: FP.webgpu, canvasMode: FP.canvas.mode,
      audioMode: FP.audio.mode, audioRate: FP.audio.sampleRate || null, webrtc: FP.webrtc, fonts: FP.fonts, mediaDevices: FP.devices,
      voices: FP.voices, battery: FP.battery, plugins: FP.plugins, geo: FP.geo, clientHints: FP.ch, codecs: FP.codecs, alive: FP.alive,
    },
  } });
});

// ================= navigator identity =================
section('navigator', function () {
  const N = Navigator.prototype;
  function setNat(prop, val) { const o = own(N, prop); def(N, prop, patch(function () { return val; }, o && o.get)); }
  if (FP.ua) setNat('userAgent', FP.ua);
  if (FP.appVersion) setNat('appVersion', FP.appVersion);
  if (FP.platform) setNat('platform', FP.platform);
  if (FP.vendor !== null) setNat('vendor', FP.vendor);
  if (FP.productSub) setNat('productSub', FP.productSub);
  if (FP.oscpu !== undefined) setNat('oscpu', FP.oscpu);
  setNat('hardwareConcurrency', FP.cores);
  setNat('maxTouchPoints', FP.touch);
  setNat('languages', Object.assign([], FP.languages));
  setNat('language', FP.languages[0]);
  setNat('pdfViewerEnabled', FP.pdfViewer);
  if (FP.dnt) setNat('doNotTrack', FP.dnt);
  // deviceMemory: chromium-only
  if (FP.mem === null || FP.mem === undefined) { try { delete Navigator.prototype.deviceMemory; } catch (e) { def(N, 'deviceMemory', patch(function () { return undefined; })); } }
  else setNat('deviceMemory', FP.mem);
  // connection
  if (FP.conn && window.NetworkInformation) {
    const o = own(N, 'connection');
    def(N, 'connection', patch(function () {
      return mkObj(NetworkInformation.prototype, { effectiveType: FP.conn.effectiveType, rtt: FP.conn.rtt, downlink: FP.conn.downlink, uplink: FP.conn.uplink || 10, saveData: !!FP.conn.saveData, addEventListener() { }, removeEventListener() { }, onchange: null, type: 'wifi' });
    }, o && o.get));
  }
  // webdriver
  const wd = own(N, 'webdriver'); def(N, 'webdriver', patch(function () { return false; }, wd && wd.get));
  // userAgentData (Client Hints) — only exists on Chromium-family personas; Safari/Firefox/iOS must NOT expose it
  if (FP.ch && FP.ch.supported !== false) {
    const uad = FP.ch;
    const hei = { architecture: uad.architecture || 'x86', bitness: uad.bitness || '64', model: uad.model || '', platformVersion: uad.platformVersion || '0.0.0',
      uaFullVersion: (uad.fullVersionList && uad.fullVersionList.find(b => /Chrome|Edge/.test(b.brand)) || {}).version || '', fullVersionList: uad.fullVersionList || uad.brands,
      wow64: !!uad.wow64, formFactors: uad.formFactors || ['desktop'] };
    const api = mkObj(Object.prototype, {
      brands: uad.brands, mobile: !!uad.mobile, platform: uad.platform, hasUAData: true,
      getBrands: function () { return uad.brands; }, isMobile: function () { return !!uad.mobile; },
      toJSON: function () { return { brands: uad.brands, mobile: !!uad.mobile, platform: uad.platform }; },
      toString: function () { return '[object NavigatorUAData]'; },
    });
    def(api, 'getHighEntropyValues', patch(async function (hints) {
      const out = { brands: uad.brands, mobile: !!uad.mobile, platform: uad.platform };
      for (const h of (hints || [])) if (h in hei) out[h] = hei[h];
      if (!hints || !hints.length) Object.assign(out, hei);
      return out;
    }));
    const ouad = own(N, 'userAgentData'); def(N, 'userAgentData', patch(function () { return api; }, ouad && ouad.get));
  } else {
    try { delete Navigator.prototype.userAgentData; } catch (e) { def(N, 'userAgentData', patch(function () { return undefined; })); }
  }
});

// ================= plugins & mimeTypes =================
section('plugins', function () {
  if (typeof Plugin === 'undefined' || typeof PluginArray === 'undefined') return; // removed kernels
  function makePlugin(p) {
    const o = Object.create(Plugin.prototype);
    def(o, 'name', patch(function () { return p.name; })); def(o, 'description', patch(function () { return p.description || ''; }));
    def(o, 'filename', patch(function () { return p.filename || ''; })); def(o, 'length', patch(function () { return 0; }));
    def(o, 'item', patch(function () { return null; })); def(o, 'namedItem', patch(function () { return null; }));
    def(o, 'refresh', patch(function () { }));
    return o;
  }
  function makeMime(m, plug) {
    const o = Object.create(typeof MimeType !== 'undefined' ? MimeType.prototype : Object.prototype);
    def(o, 'type', patch(function () { return m.type; })); def(o, 'description', patch(function () { return m.description || ''; }));
    def(o, 'suffixes', patch(function () { return m.suffixes || ''; })); def(o, 'enabledPlugin', patch(function () { return plug; }));
    return o;
  }
  function makeList(arr, Ctor) {
    const o = Object.create(Ctor.prototype);
    arr.forEach((x, i) => {
      Object.defineProperty(o, i, { configurable: true, enumerable: true, get: patch(function () { return x; }) });
      const key = x.name || x.type;
      if (key) Object.defineProperty(o, key, { configurable: true, enumerable: true, get: patch(function () { return x; }) });
    });
    def(o, 'length', patch(function () { return arr.length; }));
    def(o, 'item', patch(function (i) { return arr[i] || null; }));
    def(o, 'namedItem', patch(function (n) { return arr.find(x => (x.name || x.type) === n) || null; }));
    def(o, Symbol.iterator, patch(function* () { for (let i = 0; i < arr.length; i++) yield arr[i]; }));
    return o;
  }
  const plugs = (FP.plugins || []).map(makePlugin);
  const mimes = (FP.mimeTypes || []).map((m, i) => makeMime(m, plugs[0] || null));
  const pa = makeList(plugs, PluginArray), ma = typeof MimeTypeArray !== 'undefined' ? makeList(mimes, MimeTypeArray) : [];
  const P = Navigator.prototype;
  def(P, 'plugins', patch(function () { return pa; }, own(P, 'plugins') && own(P, 'plugins').get));
  if (typeof MimeTypeArray !== 'undefined') def(P, 'mimeTypes', patch(function () { return ma; }, own(P, 'mimeTypes') && own(P, 'mimeTypes').get));
});

// ================= screen & window metrics =================
section('screen', function () {
  const sc = FP.screen; if (!sc || !sc.width) return;
  const S = Screen.prototype;
  const set = (p, v) => { const o = own(S, p); if (o && o.get) def(S, p, patch(function () { return v; }, o.get)); };
  set('width', sc.width); set('availLeft', 0); set('availTop', 0);
  set('height', sc.height); set('availWidth', sc.availWidth); set('availHeight', sc.availHeight);
  set('colorDepth', sc.colorDepth || 24); set('pixelDepth', sc.pixelDepth || 24);
  if (sc.orientationType && screen.orientation) {
    const o = mkObj(Object.getPrototypeOf(screen.orientation), { type: sc.orientationType, angle: sc.orientationAngle || 0 });
    def(o, 'lock', patch(async function () { throw new TypeError('not allowed'); })); def(o, 'unlock', patch(function () { }));
    def(o, 'addEventListener', patch(function () { })); def(o, 'removeEventListener', patch(function () { }));
    const oo = own(S, 'orientation'); def(S, 'orientation', patch(function () { return o; }, oo && oo.get));
  }
  const dpr = FP.dpr || 1;
  const od = own(window, 'devicePixelRatio') || own(Object.getPrototypeOf(window), 'devicePixelRatio');
  def(window, 'devicePixelRatio', patch(function () { return dpr; }, od && od.get));
  // inner/outer consistency: hide window chrome differences
  if (!FP.mobile) {
    const AW = sc.availWidth || sc.width, AH = sc.availHeight || sc.height;
    const toolbarH = FP.fam === 'mac' ? 78 : 91;
    const sw = (p, v) => { const o = own(window, p) && own(window, p).get; def(window, p, patch(function () { return v; }, o)); };
    sw('innerWidth', AW); sw('innerHeight', Math.max(0, AH - toolbarH));
    sw('outerWidth', sc.width); sw('outerHeight', AH + toolbarH - (FP.fam === 'windows' ? 40 : FP.fam === 'mac' ? 25 : 0));
    try {
      const vv = window.visualViewport;
      if (vv) { def(vv, 'width', patch(function () { return AW; })); def(vv, 'height', patch(function () { return Math.max(0, AH - toolbarH); })); }
    } catch (e) { }
  }
});

// ================= canvas noise =================
section('canvas', function () {
  const cv = FP.canvas || {};
  if (!cv.mode || cv.mode === 'off') return;
  const seed = (cv.seed || 'mirage-canvas') + '|' + SALT;
  const _GetCtx = HTMLCanvasElement.prototype.getContext;
  const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
  const _toBlob = HTMLCanvasElement.prototype.toBlob;
  const _GID = CanvasRenderingContext2D.prototype.getImageData;
  const _PID = CanvasRenderingContext2D.prototype.putImageData;
  function noise(d, s) {
    const rng = makeRng(s);
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const r = rng();
      if (r < 0.08) { d[i] = (d[i] + 1 + ((r * 131) | 0)) & 255; d[i + 1] = (d[i + 1] + ((r * 211) | 0)) & 255; d[i + 2] = (d[i + 2] + ((r * 79) | 0)) & 255; }
    }
  }
  function toDataURLPatched() {
    try {
      const ctx = _GetCtx.call(this, '2d', { willReadFrequently: true });
      if (!ctx) return _toDataURL.apply(this, arguments);
      const img = _GID.call(ctx, 0, 0, this.width || 1, this.height || 1);
      noise(img.data, seed + '|du');
      const t = document.createElement('canvas'); t.width = this.width; t.height = this.height;
      const t2 = _GetCtx.call(t, '2d');
      t2.drawImage(this, 0, 0); _PID.call(t2, img, 0, 0);
      return _toDataURL.apply(t, arguments);
    } catch (e) { canvasErrors.push('toDataURL: ' + e.message); return _toDataURL.apply(this, arguments); }
  }
  HTMLCanvasElement.prototype.toDataURL = patch(toDataURLPatched, _toDataURL);
  HTMLCanvasElement.prototype.toBlob = patch(function (cb, type, q) {
    try {
      const url = this.toDataURL(type, q);
      const bin = atob(url.slice(url.indexOf(',') + 1));
      const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      setTimeout(() => cb(new Blob([arr], { type: type || 'image/png' })), 0);
      return;
    } catch (e) { }
    return _toBlob.apply(this, arguments);
  }, _toBlob);
  CanvasRenderingContext2D.prototype.getImageData = patch(function () {
    const img = _GID.apply(this, arguments);
    try { noise(img.data, seed + '|gi'); } catch (e) { }
    return img;
  }, _GID);
  // deterministic measureText jitter — breaks canvas-based font metrics enumeration
  if (FP.fontSpoof && FP.fonts && FP.fonts.length) {
    const _mt = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = patch(function (txt) {
      const m = _mt.apply(this, arguments);
      try {
        const rng = makeRng(seed + '|mt|' + (this && this.font || '') + '|' + txt);
        const d = (rng() - 0.5) * 0.6;
        const o = Object.create(TextMetrics.prototype);
        def(o, 'width', patch(function () { return m.width + d; }));
        for (const p of ['actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent', 'fontBoundingBoxAscent', 'fontBoundingBoxDescent']) {
          const v = m[p]; def(o, p, patch(function () { return typeof v === 'number' ? v + d / 2 : v; }));
        }
        return o;
      } catch (e) { return m; }
    }, _mt);
  }
});

// ================= WebGL =================
section('webgl', function () {
  const g = FP.gl || {};
  function isGL2(ctx) { return !!(window.WebGL2RenderingContext && ctx instanceof WebGL2RenderingContext); }
  // persona says WebGL2 does not exist (Safari pool) → the real context must be hidden below JS
  if (g.webgl2 === false) {
    const _gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = patch(function (type) {
      if (type === 'webgl2' || type === 'experimental-webgl2') return null;
      return _gc.apply(this, arguments);
    }, _gc);
  }
  function patchGL(Proto) {
    if (!Proto) return;
    const _gp = Proto.getParameter;
    Proto.getParameter = patch(function (p) {
      try {
        if (p === 0x1F00 && g.vendor) return g.vendor;                 // VENDOR
        if (p === 0x1F01 && g.renderer) return 'WebKit WebGL';          // RENDERER (glue string)
        if (p === 0x1F02 && g.version) return isGL2(this) ? g.version : g.version.replace('2.0', '1.0').replace('3.0', '2.0');
        if (p === 0x8B8C && g.slv) return isGL2(this) ? g.slv : g.slv.replace('3.00', '1.0');
        if (p === 0x9245 && g.unmaskedVendor) return g.unmaskedVendor;  // UNMASKED_VENDOR_WEBGL
        if (p === 0x9246 && g.unmaskedRenderer) return g.unmaskedRenderer;
        if (g.limits) {
          if (p === 0x0D33) return g.limits.maxTextureSize;              // MAX_TEXTURE_SIZE
          if (p === 0x851C) return g.limits.maxCubeMapSize;             // MAX_CUBE_MAP_TEXTURE_SIZE
          if (p === 0x0D3B) return g.limits.maxRenderBufferSize;        // MAX_RENDERBUFFER_SIZE
          if (p === 0x0D3A) return new Int32Array(g.limits.maxViewportDims); // MAX_VIEWPORT_DIMS
          if (p === 0x8869) return g.limits.maxVertexAttribs;          // MAX_VERTEX_ATTRIBS
          if (p === 0x8B4D) return g.limits.maxCombinedTexUnits;       // MAX_COMBINED_TEXTURE_IMAGE_UNITS
          if (p === 0x8872) return g.limits.maxTextureImageUnits;      // MAX_TEXTURE_IMAGE_UNITS
          if (p === 0x8821) return g.limits.maxDrawBuffers;            // MAX_DRAW_BUFFERS
        }
      } catch (e) { }
      return _gp.apply(this, arguments);
    }, _gp);
    const _gse = Proto.getSupportedExtensions;
    if (_gse) Proto.getSupportedExtensions = patch(function () { return (g.extensions || []).slice(); }, _gse);
    // per-device GLSL float precision (getShaderPrecisionFormat) — a genuine fingerprint surface
    if (g.precision && Proto.getShaderPrecisionFormat) {
      const _sp = Proto.getShaderPrecisionFormat;
      Proto.getShaderPrecisionFormat = patch(function (sh, p) {
        try {
          const pr = g.precision, isInt = (p === 0x8DF4 || p === 0x8DF5 || p === 0x8DF6); // INT_*
          const hi = p === 0x8DF2 || p === 0x8DF4, med = p === 0x8DF3 || p === 0x8DF5, lo = p === 0x8DF1 || p === 0x8DF6;
          const box = isInt ? (hi ? pr.intHigh : med ? pr.intMedium : lo ? pr.intLow : pr.intHigh) : (hi ? pr.high : med ? pr.medium : lo ? pr.low : pr.high);
          if (box) return mkObj(Object.getPrototypeOf(_sp.call(this, sh, p)) || Object.prototype, { rangeMin: box.range, rangeMax: box.range, precision: box.precision });
        } catch (e) { }
        return _sp.apply(this, arguments);
      }, _sp);
    }
    const _ge = Proto.getExtension;
    if (_ge) Proto.getExtension = patch(function (name) {
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
      const exs = g.extensions || [];
      if (exs.length && typeof name === 'string' && /^(WEBGL|EXT|OES|KHR|ANGLE)_/.test(name) && !exs.includes(name) && name !== 'WEBGL_lose_context') return null;
      return _ge.apply(this, arguments);
    }, _ge);
    if (Proto.isExtensionSupported) {
      const _ies = Proto.isExtensionSupported;
      Proto.isExtensionSupported = patch(function (n) { return (g.extensions || []).includes(n) || _ies.apply(this, arguments); }, _ies);
    }
  }
  patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  // WebGL readPixels noise (defeats WebGL render-hash fingerprinting)
  if (FP.canvas && FP.canvas.mode !== 'off' && window.WebGLRenderingContext) {
    const seed = (FP.canvas.seed || 'gl') + '|glpix|' + SALT;
    const _rp = WebGLRenderingContext.prototype.readPixels;
    WebGLRenderingContext.prototype.readPixels = patch(function (x, y, w, h, fmt, type, pixels) {
      _rp.apply(this, arguments);
      try {
        if (pixels && pixels.length) {
          const rng = makeRng(seed + '|' + w + 'x' + h + '|' + x + ',' + y);
          const n = Math.min(pixels.length, w * h * 4);
          for (let i = 0; i < n; i++) if (rng() < 0.05) pixels[i] = (pixels[i] + 1 + ((rng() * 2) | 0)) & 255;
        }
      } catch (e) { }
    }, _rp);
  }
  // WebGPU adapter info — or remove navigator.gpu for browsers that lack WebGPU (Safari/Firefox)
  if (!FP.webgpu && (FP.browser === 'safari' || FP.browser === 'firefox')) {
    try { delete Navigator.prototype.gpu; } catch (e) { }
  }
  if (FP.webgpu && window.GPU && GPU.prototype.requestAdapter) {
    const _ra = GPU.prototype.requestAdapter;
    GPU.prototype.requestAdapter = patch(async function (...a) {
      const ad = await _ra.apply(this, a); if (!ad) return null;
      const info = { vendor: FP.webgpu.vendor, device: FP.webgpu.device, architecture: FP.webgpu.architecture || 'generic', description: FP.webgpu.device };
      try {
        const o = Object.create(Object.getPrototypeOf(ad));
        for (const p of ['features', 'limits', 'isFallbackAdapter']) { try { def(o, p, patch(function () { return ad[p]; })); } catch (e) { } }
        def(o, 'info', patch(function () { return info; }));
        def(o, 'requestAdapterInfo', patch(async function () { return info; }));
        if (ad.requestDevice) def(o, 'requestDevice', patch(async function (...da) { return ad.requestDevice(...da); }));
        return o;
      } catch (e) { return ad; }
    }, _ra);
  }
});

// ================= AudioContext fingerprint noise =================
section('audio', function () {
  const au = FP.audio || {};
  if (!au.mode || au.mode === 'off') return;
  // device-model audio clock (a real RTX laptop and a Pixel report different hardware rates)
  if (au.sampleRate) {
    for (const Ctor of [window.AudioContext, window.OfflineAudioContext, window.webkitAudioContext]) {
      if (!Ctor || !Ctor.prototype) continue;
      const setG = (prop, val) => { const o = own(Ctor.prototype, prop); if (!o || !o.get) { try { def(Ctor.prototype, prop, patch(function () { return val; })); } catch (e) { } } else def(Ctor.prototype, prop, patch(function () { return val; }, o.get)); };
      setG('sampleRate', au.sampleRate);
      if (au.baseLatency != null) setG('baseLatency', au.baseLatency);
      if (au.outputLatency != null) setG('outputLatency', au.outputLatency);
    }
  }
  const seed = (au.seed || 'mirage-audio') + '|' + SALT;
  const amp = 0.00004 + (au.noise || 0.5) * 0.00016;
  if (window.AnalyserNode && AnalyserNode.prototype) {
    const _gf = AnalyserNode.prototype.getFloatFrequencyData;
    const _gb = AnalyserNode.prototype.getByteFrequencyData;
    const _gt = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatFrequencyData = patch(function (arr) { _gf.apply(this, arguments); try { const rng = makeRng(seed + '|gf|' + arr.length); for (let i = 0; i < arr.length; i++) arr[i] += (rng() - 0.5) * amp * 20; } catch (e) { } }, _gf);
    AnalyserNode.prototype.getByteFrequencyData = patch(function (arr) { _gb.apply(this, arguments); try { const rng = makeRng(seed + '|gb|' + arr.length); for (let i = 0; i < arr.length; i++) arr[i] = Math.max(0, Math.min(255, arr[i] + ((rng() * 3) | 0) - 1)); } catch (e) { } }, _gb);
    AnalyserNode.prototype.getFloatTimeDomainData = patch(function (arr) { _gt.apply(this, arguments); try { const rng = makeRng(seed + '|gt|' + arr.length); for (let i = 0; i < arr.length; i++) arr[i] += (rng() - 0.5) * amp; } catch (e) { } }, _gt);
  }
  if (window.OfflineAudioContext && OfflineAudioContext.prototype.startRendering) {
    const _sr = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = patch(async function (...a) {
      const buf = await _sr.apply(this, a);
      try {
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const data = buf.getChannelData(ch);
          const rng = makeRng(seed + '|ob|' + ch + '|' + data.length);
          for (let i = 0; i < data.length; i++) data[i] += (rng() - 0.5) * amp * (rng() < 0.6 ? 1 : 0);
        }
      } catch (e) { }
      return buf;
    }, _sr);
  }
});

// ================= MediaDevices enumeration =================
section('mediaDevices', function () {
  if (!window.InputDeviceInfo || !navigator.mediaDevices || !MediaDevices.prototype.enumerateDevices) return;
  const devs = (FP.devices || []).map((d, i) => mkObj(InputDeviceInfo.prototype, {
    kind: d.kind, label: d.label || '',
    deviceId: 'mirage:' + hash32((d.deviceId || 'x') + '|' + d.kind + '|' + d.label).toString(36),
    groupId: 'mirageg:' + hash32((d.groupId || 'x') + '|' + d.kind + '|' + d.label).toString(36),
    toJSON: function () { return { kind: this.kind, label: this.label, deviceId: this.deviceId, groupId: this.groupId }; },
  }));
  const _ed = MediaDevices.prototype.enumerateDevices;
  MediaDevices.prototype.enumerateDevices = patch(async function () { return devs.slice(); }, _ed);
});

// ================= SpeechSynthesis voices =================
section('speech', function () {
  if (!window.SpeechSynthesis || !window.SpeechSynthesisVoice || !speechSynthesis) return;
  const voices = (FP.voices || []).map(v => mkObj(SpeechSynthesisVoice.prototype, {
    name: v.name, lang: v.lang, voiceURI: v.name + ' (' + v.lang + ')', localService: !!v.local, default: false,
  }));
  const _gv = SpeechSynthesis.prototype.getVoices;
  SpeechSynthesis.prototype.getVoices = patch(function () { return voices.slice(); }, _gv);
});

// ================= fonts =================
section('fonts', function () {
  if (!FP.fontSpoof || !FP.fonts || !window.FontFaceSet) return;
  const list = FP.fonts;
  const _check = FontFaceSet.prototype.check;
  FontFaceSet.prototype.check = patch(function (font) {
    try {
      let fam = '';
      const q = (font || '').match(/['"]([^'"]+)['"]/);
      if (q) fam = q[1];
      else { const s = (font || '').replace(/^[^a-zA-Z]*/, '').split(',')[0]; fam = s.trim(); }
      if (!fam) return _check.apply(this, arguments);
      if (list.includes(fam)) return true;
      if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-monospace|emoji|math|fangsong)$/i.test(fam)) return _check.apply(this, arguments);
      return false;
    } catch (e) { return _check.apply(this, arguments); }
  }, _check);
  const _has = FontFaceSet.prototype.has;
  if (_has) FontFaceSet.prototype.has = patch(function (ff) { return _has.apply(this, arguments); }, _has);
});

// ================= Geolocation =================
section('geo', function () {
  const g = FP.geo || {};
  if (g.mode !== 'custom' || !window.Geolocation) return;
  const _gcp = Geolocation.prototype.getCurrentPosition;
  const _wcp = Geolocation.prototype.watchPosition;
  function pos() {
    const c = mkObj(Coordinates.prototype, {
      latitude: g.lat + (Math.random() - 0.5) * 0.0008, longitude: g.lon + (Math.random() - 0.5) * 0.0008,
      accuracy: g.accuracy || 60, altitude: g.altitude ?? null, altitudeAccuracy: g.altitudeAccuracy ?? null,
      heading: g.heading ?? null, speed: g.speed ?? null,
    });
    return mkObj(GeolocationPosition.prototype, { coords: c, timestamp: Date.now(), toJSON: function () { return { coords: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy }, timestamp: this.timestamp }; } });
  }
  Geolocation.prototype.getCurrentPosition = patch(function (ok, err) {
    if (g.mode === 'custom') { setTimeout(() => { try { ok && ok(pos()); } catch (e) { } }, 20 + Math.random() * 150); return 1; }
    return _gcp.apply(this, arguments);
  }, _gcp);
  Geolocation.prototype.watchPosition = patch(function (ok) {
    if (g.mode === 'custom') { const id = 9001; setTimeout(() => { try { ok && ok(pos()); } catch (e) { } }, 30); return id; }
    return _wcp.apply(this, arguments);
  }, _wcp);
});

// ================= Permissions =================
section('permissions', function () {
  if (!window.Permissions || !Permissions.prototype.query) return;
  const map = FP.permissions || {};
  const _q = Permissions.prototype.query;
  Permissions.prototype.query = patch(async function (d) {
    const name = d && d.name;
    const mapped = map[name];
    if (mapped) {
      const state = mapped === 'ask' ? 'prompt' : mapped;
      return mkObj(PermissionStatus.prototype, { state, name, onchange: null, addEventListener() { }, removeEventListener() { }, dispatchEvent: function () { return false; } });
    }
    return _q.apply(this, arguments);
  }, _q);
});

// ================= Battery =================
section('battery', function () {
  const b = FP.battery;
  if (!b || !Navigator.prototype.getBattery || !window.BatteryManager) return;
  const _gb = Navigator.prototype.getBattery;
  Navigator.prototype.getBattery = patch(async function () {
    try {
      return mkObj(BatteryManager.prototype, {
        charging: !!b.charging, chargingTime: b.charging ? (b.chargingTime || 0) : Infinity,
        dischargingTime: b.charging ? Infinity : (b.dischargingTime || 0), level: b.level,
        onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null,
        addEventListener() { }, removeEventListener() { },
      });
    } catch (e) { return _gb.apply(this, arguments); }
  }, _gb);
});

// ================= WebRTC ICE leak protection =================
section('webrtc', function () {
  const w = FP.webrtc || { mode: 'disable' };
  const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!PC || w.mode === 'real') return;
  function rewrite(cand) {
    if (!cand || typeof cand !== 'string') return cand;
    const parts = cand.trim().split(/\s+/);
    const ti = parts.indexOf('typ');
    if (ti < 0) return cand;
    const type = parts[ti + 1];
    if (type === 'host' || type === 'srflx') {
      if (w.mode === 'disable' || w.mode === 'proxy') return null; // no local / direct public exposure
      if (w.mode === 'spoof') { parts[ti + 4] = type === 'host' ? (w.fakeLocalIp || '192.168.1.10') : (w.egressPublicIp || w.fakePublicIp || parts[ti + 4]); return parts.join(' '); }
    }
    if (w.mode === 'disable') return null;
    return parts.join(' ');
  }
  function Wrap(config, options) {
    const pc = new PC(config, options);
    try {
      const origAdd = pc.addEventListener.bind(pc);
      const origRemove = pc.removeEventListener.bind(pc);
      const wrap = {};
      function filter(fnOrObj) {
        return function (ev) {
          try {
            if (ev && ev.candidate) {
              const r = rewrite(ev.candidate.candidate);
              if (r === null) { return; } // drop
              if (r && r !== ev.candidate.candidate) { try { Object.defineProperty(ev.candidate, 'candidate', { configurable: true, get: patch(function () { return r; }) }); } catch (e) { } }
            }
          } catch (e) { }
          try { typeof fnOrObj === 'function' ? fnOrObj.call(pc, ev) : fnOrObj.handleEvent(ev); } catch (e) { }
        };
      }
      pc.addEventListener = patch(function (t, l, o) {
        if (t === 'icecandidate' && (typeof l === 'function' || (l && l.handleEvent))) { const wf = wrap[l.__mid || (l.__mid = Math.random())] = filter(l); return origAdd(t, wf, o); }
        return origAdd.apply(null, arguments);
      }, origAdd);
      pc.removeEventListener = patch(function (t, l, o) {
        if (t === 'icecandidate' && l && l.__mid && wrap[l.__mid]) { const wf = wrap[l.__mid]; delete wrap[l.__mid]; return origRemove(t, wf, o); }
        return origRemove.apply(null, arguments);
      }, origRemove);
      let userCb = null; let hooked = false;
      const inner = function (ev) {
        try {
          if (ev && ev.candidate) { const r = rewrite(ev.candidate.candidate); if (r === null) return; if (r) { try { Object.defineProperty(ev.candidate, 'candidate', { configurable: true, get: patch(function () { return r; }) }); } catch (e) { } } }
        } catch (e) { }
        if (userCb) { try { userCb.call(pc, ev); } catch (e) { } }
      };
      defRW(pc, 'onicecandidate', function () { return userCb; }, function (v) { userCb = v; if (v && !hooked) { hooked = true; origAdd('icecandidate', inner); } });
    } catch (e) { }
    return pc;
  }
  Wrap.prototype = PC.prototype;
  window.RTCPeerConnection = patch(Wrap, PC);
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = patch(Wrap, window.webkitRTCPeerConnection);
});

// ================= Codecs =================
section('codecs', function () {
  const cmap = FP.codecs || {};
  const keys = Object.keys(cmap);
  if (!keys.length) return;
  const _cpt = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = patch(function (t) {
    if (t) { for (const k of keys) { if (k === t || t.startsWith(k) || k.startsWith(t)) return cmap[k]; } }
    return _cpt.apply(this, arguments);
  }, _cpt);
  if (window.MediaSource && MediaSource.isTypeSupported) {
    const _its = MediaSource.isTypeSupported;
    MediaSource.isTypeSupported = patch(function (t) {
      if (t && /video|audio/.test(t)) { for (const k of keys) if (k.startsWith('video') && (k === t || t.startsWith(k))) return cmap[k] !== ''; }
      return _its.apply(this, arguments);
    }, _its);
  }
});

// ================= Intl / timezone =================
section('timezone', function () {
  const tz = FP.tz; if (!tz) return;
  try {
    const DTF = Intl.DateTimeFormat;
    function Wrapped(locale, options) {
      if (!(this instanceof Wrapped)) return DTF(locale, options);
      const o = Object.assign({ }, options); if (!o.timeZone) o.timeZone = tz;
      return new DTF(locale, o);
    }
    Wrapped.prototype = DTF.prototype;
    Wrapped.supportedLocalesOf = DTF.supportedLocalesOf;
    Object.defineProperty(Wrapped, 'name', { value: 'DateTimeFormat' });
    nat.set(Wrapped, DTF);
    Intl.DateTimeFormat = Wrapped;
    const _ro = DTF.prototype.resolvedOptions;
    DTF.prototype.resolvedOptions = patch(function () { const r = _ro.apply(this, arguments); r.timeZone = tz; return r; }, _ro);
    if (typeof FP.tzOffset === 'number') {
      const _gto = Date.prototype.getTimezoneOffset;
      Date.prototype.getTimezoneOffset = patch(function () { return -FP.tzOffset; }, _gto);
    }
  } catch (e) { canvasErrors.push('tz: ' + e.message); }
});

// ================= window.chrome & automation traces =================
section('chrome-global', function () {
  if (!FP.chromeObj) { try { delete window.chrome; } catch (e) { } return; }
  if (window.chrome && window.chrome.loadTimes) return;
  const now = Date.now();
  const val = {
    loadTimes: patch(function () { return { commitLoadTime: (now - 3200) / 1000, connectionInfo: 'h2', sslStatus: 0, userAgent: FP.ua, resourceResponses: [], sugestedPrefetch: false, didRedirect: false, didIPLiteral: false, mainFromPrefetchCache: 0, startsCompressed: true, dataCompressed: 1460, dataEncoded: 1720, responseTime: 280, loadTime: 400, domLoadingTime: 160, domContetLoadedTime: 330, domCompleteTime: 480, type: 0 }; }),
    csi: patch(function () { return { start: now - 900, commitLoadEventStart: now - 800, onLoad: 0, onloadEventStart: now - 10, pageT: 900, documentURL: location.href, product: 'chrome', loadTime: 500, jsLaunch: 40, chunk: 'r' }; }),
    app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }, getDetails: patch(function () { return null; }), getIsInstalled: patch(function () { return false; }), runningState: patch(function () { return 'cannot_run'; }) },
    runtime: { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }, OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }, PlatformArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }, RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UNKNOWN: 'unknown' }, connect: undefined, sendMessage: undefined },
  };
  def(window, 'chrome', patch(function () { return val; }));
  // benign window.external (Chrome always exposes one; its absence is a headless tell)
  if (!window.external) try { Object.defineProperty(window, 'external', { configurable: true, value: { AddSearchProvider(){}, IsSearchProviderInstalled() { return 0; } } }); } catch (e) { }
});
// ================= anti-automation / anti-CDP tripwire (runs for every persona) =================
section('anti-automation', function () {
  // classic headless/automation globals
  try { ['_phantom', '__nightmare', 'callPhantom', 'phantom', '__webdriverScript', '__selenium_unwrapped', '__driver_evaluate', '__webdriver_evaluate', '__fxdriver_unwrapped', '__selenium_evaluate', 'domAutomation', 'domAutomationController', 'webdriver', '__playwright__', '__playwright_binding__', '__puppeteer_evaluation_script__'].forEach(k => { try { delete window[k]; } catch (e) { } }); } catch (e) { }
  // navigator.webdriver must be false even if something re-sets it later
  try { const N = Object.getPrototypeOf(navigator); def(N, 'webdriver', patch(function () { return false; }, own(N, 'webdriver') && own(N, 'webdriver').get)); } catch (e) { }
  // ---- CDP / DevTools binding scrubber ----
  // When a debugger attaches, Chromium injects window.$cdc_<rand> / $chrome_asyncCall — the giveaway
  // that a browser is being driven remotely. Actively strip them (kernel arg strips AutomationControlled).
  try {
    const BAD = /^\$?(_?)cdc_|asyncCall|selenium|webdriver|__driver|__fxdriver|puppeteer|playwright/i;
    const scrub = () => {
      try {
        const names = Object.getOwnPropertyNames(window);
        for (const k of names) {
          if (k === 'window' || k === 'location' || k === 'chrome' || k === 'external') continue;
          if (BAD.test(k)) { try { delete window[k]; } catch (e) { try { Object.defineProperty(window, k, { configurable: false, get() { return undefined; } }); } catch (_) { } } }
        }
      } catch (e) { }
    };
    scrub(); setInterval(scrub, 250);
  } catch (e) { }
});
section('css-media', function () {
  // keep matchMedia results consistent with spoofed values
  const mm = window.matchMedia;
  if (!mm) return;
  window.matchMedia = patch(function (q) {
    const r = mm.call(window, q);
    try {
      const s = String(q).toLowerCase();
      if (s.includes('prefers-reduced-motion') && !r.matches) { } // keep real
    } catch (e) { }
    return r;
  }, mm);
});
// ================= "already-alive" liveness =================
section('liveness', function () {
  const A = FP.alive; if (!A) return;
  // history: a used browser rarely has exactly one entry on a navigated tab
  if (typeof History !== 'undefined' && History.prototype) {
    const _hl = own(History.prototype, 'length');
    def(History.prototype, 'length', patch(function () { return Math.max((_hl && _hl.get ? _hl.get.call(this) : 1) || 1, A.historyLength); }, _hl && _hl.get));
  }
  // performance.memory (Chromium) — plausible, slowly growing heap
  if (A.perfMemory && window.performance && typeof Performance !== 'undefined') {
    const o = own(Performance.prototype, 'memory');
    def(Performance.prototype, 'memory', patch(function () {
      const base = A.perfMemory.usedJSHeapSize + (performance.now() | 0) * 1024;
      return { usedJSHeapSize: Math.min(base, A.perfMemory.totalJSHeapSize), totalJSHeapSize: A.perfMemory.totalJSHeapSize, jsHeapSizeLimit: A.perfMemory.jsHeapSizeLimit };
    }, o && o.get));
  }
  // navigator.storage.estimate — real quota/usage, not automation defaults
  if (A.storageEstimate && navigator.storage && navigator.storage.estimate) {
    const _se = navigator.storage.estimate.bind(navigator.storage);
    navigator.storage.estimate = patch(async function () {
      const grow = (performance.now() | 0) * 512;
      return { usage: Math.min(A.storageEstimate.usage + grow, A.storageEstimate.quota), quota: A.storageEstimate.quota, usageDetails: {} };
    });
  }
  // battery drift: real batteries lose charge over time, and level should not be a perfect constant
  if (FP.battery && Navigator.prototype.getBattery) {
    const b = FP.battery; const drift = A.batteryDriftPerHr || 1; const born = b.level;
    const _gb = Navigator.prototype.getBattery;
    Navigator.prototype.getBattery = patch(async function () {
      try {
        const hrs = performance.now() / 3600000;
        const level = b.charging ? born : Math.max(0.04, born - hrs * drift / 100);
        return mkObj(BatteryManager.prototype, {
          charging: !!b.charging, chargingTime: b.charging ? 0 : Infinity,
          dischargingTime: b.charging ? Infinity : (b.dischargingTime || 3600),
          level: Math.round(level * 1000) / 1000,
          onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null,
          addEventListener() { }, removeEventListener() { },
        });
      } catch (e) { return _gb.apply(this, arguments); }
    }, _gb);
  }
  // a warm tab is focused + visible (not a headless/background automation artifact)
  try { if ('visibilityState' in document && document.visibilityState !== 'visible') { Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } }); Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } }); } } catch (e) { }
});
`;
