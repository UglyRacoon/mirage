// Mirage — fingerprint consistency auditor.
// Runs cross-field rules (UA ↔ platform ↔ GPU ↔ fonts ↔ timezone ↔ proxy ↔ client hints …)
// and returns issues + a 0..100 score. Used by the editor UI, profile list badges,
// and the automation API.
import { offsetFromTz } from '../util.js';
import { OSES, REGIONS } from './pools.js';

const CRIT = 'critical', WARN = 'warn', INFO = 'info';

export function auditFingerprint(fp, ctx = {}) {
  const issues = [];
  const add = (sev, rule, msg, field) => issues.push({ sev, rule, msg, field });
  if (!fp || !fp.ua) { add(CRIT, 'no-fp', 'Fingerprint is empty', ''); return { issues, score: 0 }; }

  const os = OSES[fp.osId] || {};
  const fam = os.family || 'windows';
  const ua = fp.ua;

  // --- UA ↔ platform ↔ vendor ---
  if (os.platform && fp.platform && os.platform !== fp.platform) add(CRIT, 'platform-vs-ua', `navigator.platform "${fp.platform}" does not match UA OS ("${os.platform}")`, 'platform');
  const wantVendor = fp.browser === 'firefox' ? '' : fp.browser === 'safari' ? 'Apple Computer, Inc.' : 'Google Inc.';
  if ((fp.vendor || '') !== wantVendor) add(CRIT, 'vendor', `navigator.vendor "${fp.vendor}" mismatches ${fp.browserLabel} (expected "${wantVendor}")`, 'vendor');
  const isFirefoxUa = /Firefox\//.test(ua) && !/.Net CLR/i.test(ua);
  const isSafariUa = /Version\/\d+(\.\d+)* Safari\/\d/.test(ua) && !/Chrome\//.test(ua);
  const uaMajor = (ua.match(/(?:Chrome|Edg|EdgA|CriOS|FxiOS)\/(\d+)/) || (isSafariUa ? ua.match(/Version\/(\d+)/) : []) || (isFirefoxUa ? ua.match(/Firefox\/(\d+)/) : []))[1] || null;
  if (!uaMajor) add(WARN, 'ua-major', 'Cannot parse browser major version from UA', 'ua');
  if (/CriOS|iPhone|iPad/.test(ua) && fam.family !== 'ios' && fp.osId !== 'ios-17' && fp.osId !== 'ios-18') add(CRIT, 'ua-os', 'iOS UA on non-iOS OS', 'ua');
  if (fp.isMobile && !/Mobile|Android|iPhone/.test(ua)) add(CRIT, 'ua-mobile-flag', 'Profile marked mobile but UA lacks Mobile token', 'ua');
  if (!fp.isMobile && /Mobile(?!.*Windows)/.test(ua) && !/iPhone|iPad/.test(ua)) add(WARN, 'ua-mobile-flag', 'Desktop profile with mobile UA token', 'ua');

  // --- Edge version parity ---
  const edgeM = ua.match(/Edg\/([\d.]+)/); const chromeM = ua.match(/Chrome\/([\d.]+)/);
  if (edgeM && chromeM && edgeM[1].split('.')[0] !== chromeM[1].split('.')[0]) add(CRIT, 'edge-parity', `Edg/${edgeM[1]} major differs from Chrome/${chromeM[1]} major`, 'ua');

  // --- Client Hints ---
  const ch = fp.clientHints || {};
  if (ch.supported) {
    if (uaMajor) {
      const brandMajor = (ch.brands || []).map(b => b.version);
      if (!brandMajor.includes(String(uaMajor))) add(CRIT, 'ch-major', `Sec-CH-UA brands ${JSON.stringify(brandMajor)} do not include UA major ${uaMajor}`, 'clientHints');
    }
    if ((ch.mobile ? 1 : 0) !== (fp.isMobile ? 1 : 0)) add(CRIT, 'ch-mobile', 'Sec-CH-UA-Mobile mismatches UA mobility', 'clientHints');
    if (ch.platform && fam.hintPlatform && ch.platform !== fam.hintPlatform) add(CRIT, 'ch-platform', `Sec-CH-UA-Platform "${ch.platform}" ≠ "${fam.hintPlatform}"`, 'clientHints');
    if (fam.family === 'ios') add(CRIT, 'ch-ios', 'iOS browsers must not send Sec-CH-UA client hints', 'clientHints');
  } else if (fp.browser === 'chrome' || fp.browser === 'edge') {
    if (fam.family !== 'ios') add(INFO, 'ch-unsupported', 'Chromium desktop browser should expose Client Hints', 'clientHints');
  }

  // --- GPU ---
  const gpu = fp.gpu || {};
  const rend = (gpu.renderer || '').toLowerCase();
  if (fam === 'windows' && !/direct3d/.test(rend)) add(WARN, 'gpu-win', `Windows renderer should use Direct3D/ANGLE: "${gpu.renderer}"`, 'gpu');
  if (fam === 'mac' && /windows|direct3d/.test(rend)) add(CRIT, 'gpu-mac', `macOS renderer must not mention Windows/D3D: "${gpu.renderer}"`, 'gpu');
  if (fam === 'linux' && /direct3d/.test(rend)) add(CRIT, 'gpu-linux', `Linux renderer must not mention Direct3D: "${gpu.renderer}"`, 'gpu');
  if (fam === 'mac' && /intel iris|uhd graphics/.test(rend) && /apple/.test((gpu.unmaskedVendor || '').toLowerCase())) add(WARN, 'gpu-appleintel', 'Modern Macs with Apple Silicon should report Apple GPU, not Intel', 'gpu');
  if (/(nvidia|geforce|rtx|gtx)/.test(rend) && !/nvidia/i.test(gpu.vendor || '') && !/nvidia/i.test(gpu.unmaskedVendor || '')) add(CRIT, 'gpu-pair', 'Renderer GPU model and WebGL vendor mismatch (NVIDIA)', 'gpu');
  if (gpu.webgpu && gpu.webgpu.vendor) {
    const wv = gpu.webgpu.vendor.toLowerCase(); const rv = (gpu.unmaskedVendor || '').toLowerCase();
    const norm = s => s.includes('nvidia') ? 'nvidia' : s.includes('intel') ? 'intel' : s.includes('amd') ? 'amd' : s.includes('apple') ? 'apple' : s;
    if (norm(wv) !== norm(rv)) add(WARN, 'webgpu-vs-webgl', `WebGPU vendor "${gpu.webgpu.vendor}" vs WebGL "${gpu.unmaskedVendor}"`, 'gpu');
  }
  if (!(gpu.extensions || []).includes('WEBGL_debug_renderer_info')) add(WARN, 'webgl-ext', 'Missing WEBGL_debug_renderer_info extension (rare in real desktop browsers)', 'gpu');
  if (fp.browser === 'safari' && /ANGLE/.test(gpu.renderer || '')) add(WARN, 'safari-angle', 'Safari reports raw renderer, not ANGLE(...)', 'gpu');

  // --- Fonts vs OS ---
  const fonts = fp.fonts?.list || [];
  const marker = { windows: 'Segoe UI', mac: 'Helvetica Neue', linux: 'DejaVu Sans', android: 'Roboto', ios: '-apple-system' }[fam];
  if (marker && !fonts.includes(marker)) add(WARN, 'fonts-os', `Font list lacks "${marker}" typical for ${os.name || fam}`, 'fonts');
  if (fam === 'windows' && fonts.some(f => /Menlo|PingFang|DejaVu|Avenir/.test(f))) add(CRIT, 'fonts-win-mac', 'Windows identity but macOS/Linux fonts present', 'fonts');
  if (fam === 'mac' && fonts.some(f => /Segoe|Consolas|Tahoma|Cambria/.test(f))) add(CRIT, 'fonts-mac-win', 'macOS identity but Windows fonts present', 'fonts');
  if (fam === 'linux' && fonts.some(f => /Segoe|Menlo|PingFang/.test(f))) add(WARN, 'fonts-linux', 'Linux identity with Windows/mac fonts (possible but unusual)', 'fonts');

  // --- Hardware ---
  const hw = fp.hardware || {};
  if (hw.deviceMemory !== null && !['chrome', 'edge'].includes(fp.browser)) add(CRIT, 'devmem-support', `navigator.deviceMemory is not supported in ${fp.browserLabel} and must be undefined`, 'hardware');
  if (typeof hw.deviceMemory === 'number' && ![0.25, 0.5, 1, 2, 4, 8].includes(hw.deviceMemory)) add(WARN, 'devmem-values', `deviceMemory ${hw.deviceMemory} is not in the spec set {0.25,0.5,1,2,4,8}`, 'hardware');
  if (hw.hardwareConcurrency && (hw.hardwareConcurrency < 2 || hw.hardwareConcurrency > 32)) add(WARN, 'cores-range', `hardwareConcurrency ${hw.hardwareConcurrency} outside realistic 2..32`, 'hardware');
  if (hw.maxTouchPoints > 0 && !fp.isMobile && fam === 'windows') add(INFO, 'touch-win', 'Windows touch-capable screen (fine for 2-in-1 laptops)', 'hardware');
  if (fp.isMobile && !hw.maxTouchPoints) add(CRIT, 'touch-mobile', 'Mobile identity must expose maxTouchPoints > 0', 'hardware');

  // --- Screen ---
  const sc = fp.screen || {};
  if (sc.width && sc.availWidth > sc.width) add(CRIT, 'screen-avail', 'availWidth > width', 'screen');
  if (sc.dpr && fam === 'mac' && sc.dpr !== 1 && sc.dpr !== 2 && sc.dpr !== 3) add(INFO, 'screen-dpr', `Unusual Mac dpr ${sc.dpr}`, 'screen');
  if (sc.dpr && (fam === 'windows' || fam === 'linux') && ![1, 1.25, 1.5, 1.75, 2, 2.5].includes(sc.dpr)) add(WARN, 'screen-dpr', `Odd ${fam} devicePixelRatio ${sc.dpr} (real displays land on 1–2.5 fractional steps)`, 'screen');
  const commonRes = [[1920, 1080], [1366, 768], [1536, 864], [1440, 900], [1512, 982], [1728, 1117], [2560, 1440], [1680, 1050], [1600, 900], [1920, 1200], [1280, 720], [3840, 2160], [390, 844], [393, 852], [412, 915], [430, 932], [360, 800]];
  if (!fp.isMobile && !commonRes.some(([w, h]) => Math.abs(sc.width - w) <= 2 && Math.abs(sc.height - h) <= 2)) add(INFO, 'screen-entropy', `Resolution ${sc.width}x${sc.height} is not a common mode — statistically stand-out`, 'screen');

  // --- Timezone / locale / geolocation / proxy ---
  const tz = fp.timezone || {}; const geo = fp.geolocation || {};
  if (tz.id) {
    const calc = offsetFromTz(tz.id);
    if (typeof tz.offsetMinutes === 'number' && calc !== tz.offsetMinutes) add(CRIT, 'tz-offset', `timezone offset ${tz.offsetMinutes} ≠ Intl-derived ${calc} for ${tz.id}`, 'timezone');
  }
  const region = REGIONS[fp.meta?.region] || {};
  if (tz.id && region.tzs && !region.tzs.includes(tz.id)) add(WARN, 'tz-region', `Timezone ${tz.id} not used in region ${fp.meta?.region}`, 'timezone');
  const lang0 = (fp.locale?.languages || [''])[0];
  if (fp.meta?.region && region.lang && lang0.split('-')[0] !== region.lang.split('-')[0]) add(WARN, 'lang-region', `Language ${lang0} vs region ${fp.meta?.region} (expect ${region.lang})`, 'locale');
  if (geo.mode === 'custom' && region.geo?.[tz.id]) {
    const [gLat, gLon] = region.geo[tz.id];
    const dist = Math.hypot(geo.lat - gLat, geo.lon - gLon);
    if (dist > 5) add(WARN, 'geo-tz', `Geolocation (${geo.lat},${geo.lon}) far from timezone ${tz.id} center`, 'geolocation');
  }
  if (ctx.proxyCountry && fp.meta?.region && ctx.proxyCountry !== fp.meta.region && !ctx.proxyCountryMix) {
    add(WARN, 'proxy-country', `Proxy exit country "${ctx.proxyCountry}" differs from identity region "${fp.meta.region}" — timezone/geolocation/headers should follow proxy`, 'network');
  }

  // --- Leak surfaces ---
  if ((fp.canvas?.mode || 'noise') === 'off') add(WARN, 'canvas-off', 'Canvas protection disabled — real device canvas hash will leak', 'canvas');
  if ((fp.audio?.mode || 'noise') === 'off') add(WARN, 'audio-off', 'Audio protection disabled — real AudioContext hash will leak', 'audio');
  if (['default', 'off', 'real'].includes(fp.webrtc?.mode || 'spoof')) add(CRIT, 'webrtc-default', 'WebRTC not patched — local/private IPs will leak via ICE candidates', 'webrtc');
  if (ctx.proxy && ['default', 'off', 'real'].includes(fp.webrtc?.mode || 'spoof')) add(CRIT, 'webrtc-proxy', 'Proxy in use with WebRTC unpatched — WebRTC exposes the true public IP, defeating the proxy', 'webrtc');
  if (fp.browser === 'firefox' && !fp.oscpu) add(INFO, 'ff-oscpu', 'Firefox requires navigator.oscpu', 'navigator');

  // --- Battery / media ---
  const bat = fp.battery || {};
  if (typeof bat.level === 'number' && (bat.level < 0 || bat.level > 1)) add(CRIT, 'battery', 'Battery level must be 0..1', 'battery');
  const kinds = (fp.media?.devices || []).map(d => d.kind);
  if (!kinds.includes('audiooutput')) add(INFO, 'media-out', 'No audiooutput device in enumerateDevices()', 'media');

  // --- headers ---
  if (fp.headers?.acceptLanguage && lang0 && !fp.headers.acceptLanguage.startsWith(lang0.split(',')[0])) add(WARN, 'al-header', `Accept-Language header "${fp.headers.acceptLanguage}" inconsistent with navigator.languages ${lang0}`, 'headers');
  if (fp.quic === 'on' && fp.network?.quic === 'on' && ctx.proxy && /socks/i.test(ctx.proxy.scheme || '')) add(WARN, 'quic-socks', 'QUIC over SOCKS5 leaks real IP — disable QUIC', 'network');

  const penalties = { critical: 25, warn: 8, info: 2 };
  let score = 100;
  for (const i of issues) score -= penalties[i.sev] || 0;
  return { issues, score: Math.max(0, Math.min(100, score)), critCount: issues.filter(i => i.sev === CRIT).length };
}
