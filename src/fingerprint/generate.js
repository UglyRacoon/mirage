// Mirage — consistent fingerprint generator.
// Produces a fully cross-consistent fingerprint for a chosen (os, browser, country)
// or a weighted-random identity. All randomness is seeded so a profile is stable.
import {
  OSES, BROWSERS, GPUS, WEBGL_BASE_EXT, WEBGL_VENDOR_EXT, SCREENS, REGIONS, FONTS, FONTS_CJK,
  HARDWARE, MEDIA_DEVICES, VOICES, CODECS, TLS_PROFILES, HTTP2_PROFILES, CHROME_MAJORS, CHROME_FULLS, FIREFOX_VERSIONS, SAFARI_VERSIONS, SAFARI_BY_OS, IOS_TOKEN, SAFARI_MAC_GPU, SAFARI_WEBGL_EXT
} from './pools.js';
import { modelsFor, modelById, expandModel, MODEL_MEDIA } from './models.js';
import { rngFor, hashStr, uid, offsetFromTz, clamp } from '../util.js';

const OS_WEIGHTS = [['windows-11', 26], ['windows-10', 18], ['macos-sonoma', 9], ['macos-sequoia', 8], ['macos-ventura', 3], ['ubuntu-2404', 6], ['android-14', 11], ['android-13', 4], ['ios-17', 6], ['ios-18', 9]];
const COUNTRY_WEIGHTS = Object.entries(REGIONS).map(([k, v]) => [k, v.wgt]);

function pickWeighted(rng, arr) {
  const total = arr.reduce((s, x) => s + x[1], 0);
  let r = rng.next() * total;
  for (const x of arr) { r -= x[1]; if (r <= 0) return x[0]; }
  return arr[arr.length - 1][0];
}
function browserForOs(rng, osId) {
  const f = OSES[osId].family;
  let pool;
  if (f === 'windows') pool = [['chrome', 78], ['edge', 13], ['firefox', 9]];
  else if (f === 'mac') pool = [['chrome', 52], ['safari', 35], ['firefox', 13]];
  else if (f === 'linux') pool = [['chrome', 68], ['firefox', 32]];
  else if (f === 'android') pool = [['chrome', 95], ['firefox', 5]];
  else pool = [['safari', 94], ['chrome', 6]]; // ios
  return pickWeighted(rng, pool);
}
const androidModels = ['Pixel 8 Pro', 'Pixel 8', 'Pixel 7', 'Pixel 7a', 'Samsung Galaxy S24 Ultra', 'Samsung Galaxy S23', 'Samsung Galaxy S21 FE', 'OnePlus 12', 'Xiaomi 14'];
const iosModels = ['iPhone 15 Pro Max', 'iPhone 15', 'iPhone 14 Pro', 'iPhone 13', 'iPhone 12 Pro'];

function buildUA(osId, browser, ffVer, chromeFull, safVer, model) {
  const o = OSES[osId];
  if (browser === 'firefox') {
    if (o.family === 'windows') return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${ffVer}) Gecko/20100101 Firefox/${ffVer}`;
    if (o.family === 'mac') return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${ffVer}) Gecko/20100101 Firefox/${ffVer}`;
    if (o.family === 'linux') return `Mozilla/5.0 (X11; Linux x86_64; rv:${ffVer}) Gecko/20100101 Firefox/${ffVer}`;
    return `Mozilla/5.0 (Android 14; Mobile; rv:${ffVer}) Gecko/20100101 Firefox/${ffVer}`;
  }
  if (browser === 'safari') {
    if (o.family === 'ios') return `Mozilla/5.0 (iPhone; CPU iPhone OS ${IOS_TOKEN[safVer] || '17_0'} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safVer} Mobile/15E148 Safari/604.1`;
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safVer} Safari/605.1.15`;
  }
  // chrome / edge
  let base;
  if (o.family === 'windows') base = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFull} Safari/537.36`;
  else if (o.family === 'mac') base = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFull} Safari/537.36`;
  else if (o.family === 'linux') base = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFull} Safari/537.36`;
  else if (o.family === 'ios') return `Mozilla/5.0 (iPhone; CPU iPhone OS ${IOS_TOKEN[safVer] || '17_0'} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeFull} Mobile/15E148 Safari/604.1`;
  else base = `Mozilla/5.0 (Linux; Android 14; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFull} Mobile Safari/537.36`;
  if (browser === 'edge') {
    // Edge UA: Chrome token is prefixed, Edg token carries same version (chromium edge)
    return base + ` Edg/${chromeFull}`;
  }
  return base;
}

function clientHints(osId, browser, chromeMajor, chromeFull, ffVer, safVer) {
  const o = OSES[osId];
  // Firefox and all iOS browsers (WebKit restriction) do not send Sec-CH-UA Client Hints
  if (browser === 'firefox' || browser === 'safari' || o.family === 'ios') return { supported: false, mobile: !!o.mobile };
  const brands = browser === 'edge'
    ? [{ brand: 'Not A(Brand', version: '99' }, { brand: 'Microsoft Edge', version: String(chromeMajor) }, { brand: 'Chromium', version: String(chromeMajor) }]
    : [{ brand: 'Not A(Brand', version: '99' }, { brand: 'Google Chrome', version: String(chromeMajor) }, { brand: 'Chromium', version: String(chromeMajor) }];
  const fullVersionList = browser === 'edge'
    ? [{ brand: 'Not A(Brand', version: '99.0.0.0' }, { brand: 'Microsoft Edge', version: chromeFull }, { brand: 'Chromium', version: chromeFull }]
    : [{ brand: 'Not A(Brand', version: '99.0.0.0' }, { brand: 'Google Chrome', version: chromeFull }, { brand: 'Chromium', version: chromeFull }];
  let platformVersion = '10.0.0';
  if (o.family === 'mac') platformVersion = osId === 'macos-sequoia' ? '15.0.0' : osId === 'macos-ventura' ? '13.6.0' : '14.6.1';
  else if (o.family === 'linux') platformVersion = '6.8.0';
  else if (o.family === 'android') platformVersion = '14.0.0';
  else if (o.family === 'ios') platformVersion = safVer.replace(/\./g, '_');
  return {
    supported: true, brands, fullVersionList, mobile: !!o.mobile,
    platform: o.hintPlatform, platformVersion,
    architecture: 'x86', bitness: '64', wow64: false, model: '', formFactors: [o.mobile ? 'phone' : 'desktop'],
  };
}

function pickScreen(rng, os, family) {
  const pool = SCREENS[family] || SCREENS.windows;
  const total = pool.reduce((s, x) => s + (x.wgt || 1), 0);
  let r = rng.next() * total; let chosen = pool[0];
  for (const x of pool) { r -= (x.wgt || 1); if (r <= 0) { chosen = x; break; } }
  // desktop win/linux scale factor comes from OS-level options; mac = retina (unless external); mobile from pool
  let dpr = chosen.dpr;
  if ((family === 'windows' || family === 'linux') && os.dprOptions && os.dprOptions.length) dpr = os.dprOptions[rng.int(0, os.dprOptions.length - 1)];
  let availH = chosen.h, availW = chosen.w;
  if (family === 'windows') availH = chosen.h - 40;
  else if (family === 'mac') availH = chosen.h - 25;
  else if (family === 'linux') availH = chosen.h - 35;
  else if (family === 'android') availH = chosen.h - 56;
  else if (family === 'ios') availH = chosen.h - 43;
  return { width: chosen.w, height: chosen.h, availWidth: availW, availHeight: availH, dpr, colorDepth: 24, pixelDepth: 24, orientationType: chosen.w >= chosen.h ? 'landscape-primary' : 'portrait-primary', orientationAngle: 0 };
}

function buildGpu(rng, family, browser) {
  // Safari never reports ANGLE(...) and has its own extension list
  if (browser === 'safari') {
    const raw = family === 'ios' ? (GPUS.ios.find(x => true).renderer) : rng.pick(SAFARI_MAC_GPU);
    const exts = SAFARI_WEBGL_EXT.slice();
    return {
      vendor: 'Apple Inc.', unmaskedVendor: 'Apple Inc.', renderer: raw, unmaskedRenderer: raw,
      webglVersion: 'WebGL 2.0', shadingLanguageVersion: 'WebGL GLSL ES 1.0', webgl2: false,
      extensions: exts, webgpu: null,
    };
  }
  const pool = GPUS[family] || GPUS.windows;
  const g = rng.weighted(pool);
  const vkey = g.unmaskedVendor;
  const exts = Array.from(new Set([...WEBGL_BASE_EXT, ...(WEBGL_VENDOR_EXT[vkey] || [])])).sort();
  let webgpu = null;
  if ((browser === 'chrome' || browser === 'edge') && family !== 'ios' && family !== 'android') {
    const gpus = { 'NVIDIA': ['NVIDIA GeForce RTX 4060 Laptop GPU', 'NVIDIA GeForce RTX 3060', 'NVIDIA GeForce RTX 4070'], 'Intel Inc.': ['Intel(R) Arc(TM) A770 Graphics', 'Intel(R) Iris(R) Xe Graphics'], 'AMD': ['AMD Radeon RX 6600', 'AMD Radeon RX 7600'], 'Apple': ['Apple M2', 'Apple M3', 'Apple M3 Pro', 'Apple M4'] };
    const vk = g.unmaskedVendor || 'NVIDIA';
    const wv = vk.includes('Apple') ? 'apple' : vk.includes('AMD') ? 'amd' : vk.includes('Intel') ? 'intel' : 'nvidia';
    const pool = wv === 'apple' ? (family === 'mac' ? gpus.Apple : null) : wv === 'nvidia' ? gpus.NVIDIA : wv === 'intel' ? gpus['Intel Inc.'] : gpus.AMD;
    if (!pool) return null;
    webgpu = { vendor: wv, device: wv === 'apple' ? rng.pick(gpus.Apple) : rng.pick(pool), architecture: 'unknown' };
  }
  return {
    vendor: g.vendor, unmaskedVendor: g.unmaskedVendor, renderer: g.renderer,
    webglVersion: 'WebGL 2.0 (OpenGL ES 3.0)', shadingLanguageVersion: 'WebGL GLSL ES 3.00',
    webgl2: true, unmaskedRenderer: g.renderer, extensions: exts, webgpu,
  };
}

function buildMedia(rng, family, isMobile, archetype) {
  const ms = archetype && MODEL_MEDIA[archetype];
  const def = ms || MEDIA_DEVICES[family] || MEDIA_DEVICES.windows;
  const devs = [];
  const mk = (kind, labels, n) => { for (let i = 0; i < n && i < labels.length; i++) devs.push({ kind, label: labels[i], deviceId: rng.hex(32), groupId: rng.hex(32) }); };
  const nIn = isMobile ? (rng.bool(0.7) ? 1 : 2) : rng.int(1, 3);
  const nOut = isMobile ? 1 : rng.int(1, 2);
  const nVid = isMobile ? (rng.bool(0.6) ? 1 : 2) : rng.int(1, 3);
  mk('audioinput', def.audioinput, nIn); mk('audiooutput', def.audiooutput, nOut); mk('videoinput', def.videoinput, nVid);
  return devs;
}

export function generateFingerprint(opts = {}) {
  const seed = opts.seed || uid(12);
  const rng = rngFor(seed + (opts.variant || ''));
  const osId = opts.os || pickWeighted(rng, OS_WEIGHTS);
  const os = OSES[osId];
  const family = os.family;
  let browser = opts.browser || browserForOs(rng, osId);
  if (family === 'android' && browser === 'safari') browser = 'chrome';   // Safari does not run on Android
  if (family === 'ios' && browser === 'edge') browser = 'safari';          // keep iOS webkit variants coherent
  const country = opts.country || pickWeighted(rng, COUNTRY_WEIGHTS);
  const region = REGIONS[country];

  const chromeMajor = rng.pick(CHROME_MAJORS);
  const chromeFull = CHROME_FULLS[chromeMajor] || CHROME_FULLS[140];
  const ffVer = rng.pick(FIREFOX_VERSIONS);
  const safPool = SAFARI_BY_OS[osId] || (family === 'mac' ? SAFARI_BY_OS['macos-sonoma'] : SAFARI_VERSIONS);
  const safVer = rng.pick(safPool);
  const model = family === 'android' ? rng.pick(androidModels) : family === 'ios' ? rng.pick(iosModels) : '';
  const ua = buildUA(osId, browser, ffVer, chromeFull, safVer, model);

  // ---- device-model coherence: pick ONE physical device and bind GPU/screen/RAM/audio/media ----
  let hwModel = null, hwExp = null;
  if (opts.modelId && modelById(opts.modelId)) { hwModel = modelById(opts.modelId); }
  else if (opts.model === false) { /* explicit opt-out: legacy independent generation */ }
  else { const pool = modelsFor(family); if (pool.length) hwModel = pickWeighted(rng, pool.map(m => [m, m.wgt])); }
  if (hwModel) hwExp = expandModel(hwModel, rng, browser);

  let screen = pickScreen(rng, os, family);
  if (hwExp) {
    const sb = hwExp.screenBox;
    let availH = sb.height, availW = sb.width;
    if (family === 'windows') availH = sb.height - 40;
    else if (family === 'mac') availH = sb.height - 25;
    else if (family === 'linux') availH = sb.height - 35;
    else if (family === 'android') availH = sb.height - 56;
    else if (family === 'ios') availH = sb.height - 43;
    screen = { width: sb.width, height: sb.height, availWidth: availW, availHeight: availH, dpr: sb.dpr, colorDepth: 24, pixelDepth: 24, orientationType: sb.width >= sb.height ? 'landscape-primary' : 'portrait-primary', orientationAngle: 0 };
  }
  let cores = rng.pick(HARDWARE.cores[family] || HARDWARE.cores.windows);
  // navigator.deviceMemory is Chromium-only (undefined in Safari/Firefox), capped at 8
  let mem = null;
  if (['chrome', 'edge'].includes(browser)) mem = Math.min(rng.pick(HARDWARE.memory), HARDWARE.memCapChrome);
  let maxTouch = os.touchDefault || (family === 'windows' && rng.bool(0.02) ? 1 : 0);
  if (hwExp) {
    cores = hwExp.hardware.hardwareConcurrency;
    if (['chrome', 'edge'].includes(browser)) mem = Math.min(hwExp.hardware.deviceMemory ?? mem ?? 8, HARDWARE.memCapChrome);
    maxTouch = hwExp.hardware.maxTouchPoints || maxTouch;
  }


  const tzId = rng.pick(region.tzs);
  const geoSet = region.geo[tzId];
  const tzOffset = offsetFromTz(tzId);
  const geo = { mode: 'custom', lat: +(geoSet[0] + (rng.next() - 0.5) * 0.05).toFixed(5), lon: +(geoSet[1] + (rng.next() - 0.5) * 0.05).toFixed(5), accuracy: rng.int(10, 150), altitude: 0, altitudeAccuracy: 0, heading: rng.bool(0.5) ? null : rng.int(0, 360), speed: null, timestamp: null };

  const gpu = hwExp ? hwExp.gpu : buildGpu(rng, family, browser);
  const fontList = [...(FONTS[family] || FONTS.windows)];
  if (['JP', 'KR', 'CN', 'HK', 'TW', 'SG'].includes(country) && FONTS_CJK[family]) fontList.push(...FONTS_CJK[family]);

  const isMobile = !!os.mobile;
  const plugins = [];
  if (!isMobile && browser === 'chrome') plugins.push({ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }, { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' });
  else if (!isMobile && browser === 'edge') plugins.push({ name: 'Microsoft Edge PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }, { name: 'Microsoft Edge PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' });
  const mimeTypes = plugins.length ? [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }, { type: 'application/x-google-chrome-pdf', suffixes: '', description: 'Portable Document Format' }] : [];

  const voices = (VOICES[family] || VOICES.windows).filter(v => rng.bool(0.78)).map(v => ({ ...v }));
  // ensure at least the locale's voice present
  const primaryLang = region.lang.split('-')[0];
  if (!voices.some(v => v.lang.startsWith(primaryLang))) voices.push((VOICES[family] || VOICES.windows).find(v => v.lang.startsWith(primaryLang)) || VOICES.windows[0]);

  const codecs = CODECS[browser] || CODECS.chrome;
  const battery = { charging: rng.bool(0.62), level: +(0.32 + rng.next() * 0.68).toFixed(3), chargingTime: 0, dischargingTime: Math.floor(3600 + rng.next() * 20000) };
  // "already-alive" — this identity behaves like a browser that has been open and used a while
  const uptimeMin = isMobile ? rng.int(2, 180) : rng.int(4, 520);
  const alive = {
    historyLength: rng.int(isMobile ? 2 : 3, isMobile ? 9 : 14),
    uptimeMin,
    batteryDriftPerHr: +(0.4 + rng.next() * 1.4).toFixed(2),      // %/hr self-discharge while on battery
    storageEstimate: { usage: Math.floor((2 + rng.next() * 48) * 1e6), quota: Math.floor((5 + rng.next() * 45) * 1e9) },
    perfMemory: family === 'ios' || browser === 'safari' || browser === 'firefox' ? null : {
      usedJSHeapSize: Math.floor((60 + rng.next() * 220) * 1e6),
      totalJSHeapSize: Math.floor((200 + rng.next() * 300) * 1e6),
      jsHeapSizeLimit: Math.floor((2048 + rng.next() * 2048) * 1e6),
    },
    referrerPresent: rng.bool(0.4),
  };

  const ch = clientHints(osId, browser, chromeMajor, chromeFull, ffVer, safVer);
  const dnt = rng.bool(0.03) ? '1' : '0';

  const fp = {
    seed, osId, osName: os.name, browser, browserLabel: BROWSERS[browser].label, isMobile,
    deviceModel: hwModel ? hwModel.id : null,
    ua, vendor: BROWSERS[browser].vendor,
    platform: os.platform,
    clientHints: ch,
    locale: { languages: region.lang.split(',').map(s => s.split(';')[0].trim()), acceptLanguage: region.al, intlCalendar: 'gregory' },
    screen,
    timezone: { id: tzId, offsetMinutes: tzOffset, utcOffset: `UTC${tzOffset >= 0 ? '+' : '-'}${String(Math.abs(tzOffset / 60) | 0).padStart(2, '0')}:${String(Math.abs(tzOffset % 60)).padStart(2, '0')}` },
    geolocation: geo,
    hardware: { deviceMemory: mem, hardwareConcurrency: cores, maxTouchPoints: maxTouch },
    gpu,
    canvas: { mode: 'noise', noise: +(0.3 + rng.next() * 0.4).toFixed(2), seed: rng.hex(16) },
    audio: { mode: 'noise', noise: +(0.3 + rng.next() * 0.4).toFixed(2), seed: rng.hex(16), sampleRate: hwExp ? hwExp.audio.sampleRate : 48000, baseLatency: hwExp ? hwExp.audio.baseLatency : 0.01, outputLatency: hwExp ? hwExp.audio.outputLatency : 0.02 },
    webrtc: { mode: 'spoof', policy: 'auto', fakeLocalIp: `192.168.${rng.int(0, 2)}.${rng.int(2, 250)}`, fakePublicIp: `100.${rng.int(64, 110)}.${rng.int(0, 255)}.${rng.int(2, 254)}`, egressPublicIp: null, addRelay: true },
    fonts: { list: fontList, spoofEnumeration: true },
    media: { devices: buildMedia(rng, family, isMobile, hwExp && hwExp.mediaArchetype), codecs },
    speech: { voices },
    battery,
    alive,
    permissions: { geolocation: 'ask', notifications: 'ask', camera: 'ask', microphone: 'ask', clipboard: 'ask' },
    navigator: {
      doNotTrack: dnt === '1' ? '1' : null, pdfViewerEnabled: !(browser === 'safari' && isMobile),
      productSub: browser === 'safari' ? '' : '20030107', vendorSub: '', oscpu: browser === 'firefox' ? (family === 'windows' ? 'Windows NT 10.0; Win64; x64' : os.uaToken) : undefined,
      appVersion: ua.replace(/^Mozilla\/5\.0 /, ''), connection: { effectiveType: rng.pick(['4g', '3g', '4g', '4g']), rtt: rng.int(20, 120), downlink: +(rng.int(3, 40) + rng.next()).toFixed(1), saveData: false },
    },
    headers: { acceptLanguage: region.al, dnt, secFetchSite: 'same-site', secFetchMode: 'navigate', secFetchUser: '?1', secFetchDest: 'document', upgradeInsecureRequests: '1' },
    network: { tlsProfile: (TLS_PROFILES[browser] || TLS_PROFILES.chrome), http2Profile: (HTTP2_PROFILES[browser] || HTTP2_PROFILES.chrome), quic: 'off', doh: browser === 'firefox', country },
    plugins, mimeTypes,
    meta: { region: country },
  };
  return fp;
}

export function quickTemplates() {
  return [
    { id: 'win-chrome', label: 'Windows 11 · Chrome', os: 'windows-11', browser: 'chrome' },
    { id: 'win-edge', label: 'Windows 10 · Edge', os: 'windows-10', browser: 'edge' },
    { id: 'mac-chrome', label: 'macOS Sequoia · Chrome', os: 'macos-sequoia', browser: 'chrome' },
    { id: 'mac-safari', label: 'macOS Sonoma · Safari', os: 'macos-sonoma', browser: 'safari' },
    { id: 'linux-chrome', label: 'Ubuntu · Chrome', os: 'ubuntu-2404', browser: 'chrome' },
    { id: 'win-ff', label: 'Windows · Firefox', os: 'windows-11', browser: 'firefox' },
    { id: 'android', label: 'Android 14 · Chrome', os: 'android-14', browser: 'chrome' },
    { id: 'ios', label: 'iOS 17 · Safari', os: 'ios-17', browser: 'safari' },
  ];
}

export function randomSeed() { return uid(12); }
