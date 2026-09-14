/* ============ Mirage profile editor: fingerprint control + consistency audit ============ */
const Ed = { id: null, fp: null, prof: null, tab: 'general', dirty: false, auditTimer: null };

const TZ_LIST = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Mexico_City', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Prague', 'Europe/Vienna', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Helsinki', 'Europe/Lisbon', 'Europe/Athens', 'Europe/Bucharest', 'Europe/Kyiv', 'Europe/Moscow', 'Europe/Istanbul', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Jakarta', 'Asia/Manila', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Almaty', 'Asia/Tashkent', 'Asia/Tehran', 'Asia/Riyadh', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Nairobi', 'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Europe/Kaliningrad'];

function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => (a[k] = a[k] || {}), o); t[last] = v; }

ROUTES.profileEditor = async (view, params) => {
  const id = params[0];
  view.innerHTML = '<span class="spin"></span> loading profile…';
  let prof;
  try { prof = (await api('/api/profiles/' + id)).profile; } catch (e) { view.innerHTML = `<div class="empty">Profile not found. ${App.esc(e.message)}</div>`; return; }
  Object.assign(Ed, { id, prof, fp: prof.fingerprint || {}, dirty: false });
  document.getElementById('crumbs').innerHTML = `<span class="link" style="cursor:pointer;color:var(--mut)" onclick="go('#/profiles')">Profiles</span> <span>/</span> ${App.esc(prof.name)}`;

  const running = !!sessOf(id);
  view.innerHTML = `
  <div class="toolbar">
    <button class="btn primary" id="edLaunch">${running ? '◉ Open live view' : '▶ Launch'}</button>
    <button class="btn" id="edStop" ${running ? '' : 'disabled'}>■ Stop</button>
    <button class="btn ok" id="edSave">💾 Save</button>
    <div class="grow"></div>
    <button class="btn ghost" id="edApplyTmpl">⚗ New identity…</button>
    <button class="btn ghost" id="edCopyJson">⧉ Copy JSON</button>
    <button class="btn ghost" id="edPasteJson">⤒ Import JSON</button>
  </div>
  <div class="ed">
    <div>
      <div class="ed-tabs" id="edTabs"></div>
      <div id="edBody"></div>
    </div>
    <div class="side-panel">
      <div class="card" id="auditCard"><h3>Consistency audit</h3><div id="auditBody"><span class="spin"></span></div></div>
      <div class="card" id="leakCard"><h3>Live leak test</h3>
        <p class="dim" style="font-size:12px;margin:2px 0 10px">Launches the kernel, opens the built-in checker inside the real patched browser and reports every leak it finds.</p>
        <button class="btn" id="edChecker" style="width:100%;justify-content:center">⌕ Run leak audit in kernel</button>
        <div id="checkerOut" style="margin-top:10px"></div>
      </div>
    </div>
  </div>`;

  const TABS = [['general', 'General'], ['identity', 'Identity'], ['screen', 'Screen'], ['tz', 'Time · Geo'], ['hw', 'Hardware'], ['gpu', 'GPU · WebGL'], ['cv', 'Canvas · Audio'], ['rtc', 'WebRTC'], ['fonts', 'Fonts'], ['media', 'Media'], ['net', 'Network'], ['proxy', 'Proxy'], ['launch', 'Launch'], ['data', 'Data']];
  document.getElementById('edTabs').innerHTML = TABS.map(t => `<button data-tab="${t[0]}" class="${Ed.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('');
  document.getElementById('edTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (!b) return; Ed.tab = b.dataset.tab; document.querySelectorAll('#edTabs button').forEach(x => x.classList.toggle('on', x === b)); drawTab(); };

  document.getElementById('edLaunch').onclick = () => {
    if (running) return go('#/live/' + id);
    guard(async () => { toast('Launching kernel…'); await launchProfile(id); go('#/live/' + id); });
  };
  document.getElementById('edStop').onclick = () => guard(async () => { await stopProfile(id); toast('Stopped', 'ok'); rerender(); });
  document.getElementById('edSave').onclick = () => guard(async () => {
    const upd = { name: val('gName'), group_id: val('gGroup'), memo: val('gMemo'), tags: (val('gTags') || '').split(',').map(s => s.trim()).filter(Boolean), favorite: val('gFav'), color: val('gColor'), fingerprint: Ed.fp, settings: Ed.prof.settings };
    await api('/api/profiles/' + id, { method: 'PUT', body: upd });
    Ed.dirty = false; await refreshAll(); toast('Saved ✓', 'ok'); auditNow();
  });
  document.getElementById('edCopyJson').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(Ed.fp, null, 2)); toast('Fingerprint JSON copied', 'ok'); } catch (e) { modal({ title: 'Fingerprint JSON', body: `<pre class="code" style="max-height:400px">${App.esc(JSON.stringify(Ed.fp, null, 2))}</pre>`, actions: [{ label: 'Close' }] }); } };
  document.getElementById('edPasteJson').onclick = () => {
    modal({ title: 'Import fingerprint JSON', body: `<textarea id="jImp" rows="12" placeholder='{"ua": … } — paste a full fingerprint object'></textarea>`, actions: [{ label: 'Import', kind: 'primary', onClick: () => { const v = JSON.parse(document.getElementById('jImp').value); if (!v.ua) throw new Error('looks invalid (no .ua)'); Ed.fp = v; drawTab(); auditNow(); toast('Imported — press Save', 'ok'); } }] });
  };
  document.getElementById('edApplyTmpl').onclick = () => identityModal(id);
  document.getElementById('edChecker').onclick = () => guard(async () => {
    const out = document.getElementById('checkerOut'); out.innerHTML = '<span class="spin"></span> launching kernel + running 60 probes inside real browser…';
    const r = await api(`/api/checker/run/${id}`, { method: 'POST', body: {} });
    out.innerHTML = `<div class="issue ${r.leaks ? 'critical' : 'info'}"><b>in-browser result</b>${r.leaks ? `<span class="bad-c">${r.leaks} leak(s)</span>` : '<span class="ok-c">no leaks detected</span>'} · ${r.checks.filter(c => c.status === 'ok').length}/${r.total} probes verified</div>
      ${r.checks.filter(c => c.status === 'no').map(c => `<div class="issue critical">${App.esc(c.group)} → ${App.esc(c.key)}: ${App.esc(String(c.observed).slice(0, 60))}</div>`).join('')}
      <button class="btn sm ghost" onclick="document.getElementById('checkerOut').innerHTML=''">dismiss</button>`;
  });

  drawTab(); auditNow();
  window.addEventListener('beforeunload', edGuard);
};
function edGuard(e) { if (Ed.dirty) { e.preventDefault(); e.returnValue = ''; } }

function markDirty() { Ed.dirty = true; clearTimeout(Ed.auditTimer); Ed.auditTimer = setTimeout(auditNow, 500); }
function field(label, path, kind = 'text', opts = {}) {
  let v = getPath(Ed.fp, path);
  if (opts.derive) v = opts.derive(v);
  let input;
  if (kind === 'select') input = `<select data-p="${path}">${opts.options.map(o => { const [val_, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${App.esc(val_)}" ${String(v) === String(val_) ? 'selected' : ''}>${App.esc(lab)}</option>`; }).join('')}</select>`;
  else if (kind === 'bool') input = `<label class="switch"><input type="checkbox" data-p="${path}" ${v ? 'checked' : ''}><i></i></label>`;
  else if (kind === 'json') input = `<textarea data-p="${path}" data-json="1" rows="4" style="font-family:var(--mono);font-size:12px">${App.esc(JSON.stringify(v ?? [], null, 1))}</textarea>`;
  else if (kind === 'list') input = `<textarea data-p="${path}" data-list="1" rows="3" style="font-family:var(--mono);font-size:12px">${App.esc((Array.isArray(v) ? v : []).join(opts.sep || ', '))}</textarea>`;
  else input = `<input data-p="${path}" type="${kind}" ${kind === 'number' ? 'step="any"' : ''} value="${App.esc(v ?? '')}" ${opts.ph ? `placeholder="${App.esc(opts.ph)}"` : ''}>`;
  const btn = opts.dice ? `<button class="iconbtn" data-dice="${path}" title="randomize this field">⚄</button>` : '';
  return `<div class="frow"><span class="fname">${label}${opts.note ? `<div class="dim" style="font-size:10.5px">${opts.note}</div>` : ''}</span>${input}${btn}</div>`;
}
function acc(title, body, open = false) { return `<div class="acc ${open ? 'open' : ''}"><div class="acc-h"><span>${title}</span><span class="chev">▶</span></div><div class="acc-b">${body}</div></div>`; }

function drawTab() {
  const body = document.getElementById('edBody'); const fp = Ed.fp, p = Ed.prof;
  const f = Ed.tab;
  const TABHTML = {
    general: () => `<div class="card"><div class="form">
      <div class="row2"><div><label>Name</label><input id="gName" value="${App.esc(p.name)}"></div>
      <div><label>Group</label><select id="gGroup"><option value="">None</option>${App.state.groups.map(g => `<option value="${g.id}" ${p.group_id === g.id ? 'selected' : ''}>${App.esc(g.name)}</option>`).join('')}</select></div></div>
      <div class="row2"><div><label>Tags (comma separated)</label><input id="gTags" value="${App.esc((p.tags || []).join(', '))}"></div>
      <div><label>Accent color</label><input id="gColor" type="color" value="${App.esc(p.color || '#22d3ee')}" style="height:38px;padding:3px"></div></div>
      <div><label>Memo</label><textarea id="gMemo">${App.esc(p.memo || '')}</textarea></div>
      <label class="switch"><input type="checkbox" id="gFav" ${p.favorite ? 'checked' : ''}><i></i><span class="mut">Favorite profile</span></label>
      <div class="kv"><div class="r"><span class="k">id</span><span class="mono">${App.esc(p.id)}</span></div>
      <div class="r"><span class="k">opened</span><span>${p.open_count || 0} times · last ${fmtRel(p.last_open ? new Date(p.last_open).toISOString() : null)}</span></div>
      <div class="r"><span class="k">browser data</span><span class="mono">data/browsers/${App.esc(p.id)}</span></div></div>
    </div></div>`,
    identity: () => `
    ${acc('User-Agent & Navigator', `
      ${field('userAgent', 'ua', 'text')}
      ${field('platform', 'platform', 'select', { options: [['Win32', 'Win32'], ['MacIntel', 'MacIntel'], ['Linux x86_64', 'Linux x86_64'], ['iPhone', 'iPhone'], ['iPad', 'iPad']] })}
      ${field('vendor', 'vendor')} ${field('productSub', 'navigator.productSub')} ${field('appVersion (prefix)', 'navigator.appVersion')}
      ${field('languages', 'locale.languages', 'list')} ${field('accept-language', 'locale.acceptLanguage')}
      ${field('Do Not Track', 'navigator.doNotTrack', 'select', { options: [['1', '1 (DNT on)'], ['0', '0'], ['', 'unset'] ] })}
      ${field('pdfViewerEnabled', 'navigator.pdfViewerEnabled', 'bool')} ${field('oscpu (Firefox)', 'navigator.oscpu')}
      ${field('webdriver', 'navigator.webdriver', 'select', { options: [['false', 'false'], ['true', 'true'] ], note: 'bundle forces false' })}`, true)}
    ${acc('Client Hints (Sec-CH-UA)', `
      ${field('supported', 'clientHints.supported', 'bool', { note: 'Firefox/iOS-Safari do not support CH — keep off' })}
      ${field('platform', 'clientHints.platform')} ${field('platformVersion', 'clientHints.platformVersion')}
      ${field('architecture', 'clientHints.architecture', 'select', { options: ['x86', 'x86_64', 'arm', 'arm64'] })} ${field('bitness', 'clientHints.bitness', 'select', { options: ['32', '64'] })}
      ${field('mobile', 'clientHints.mobile', 'bool')} ${field('wow64', 'clientHints.wow64', 'bool')} ${field('model', 'clientHints.model')}
      <div class="dim" style="font-size:11.5px;margin-top:6px">Brands are derived from the browser family &amp; major version to stay consistent with the UA.</div>`, false)}
    ${acc('Plugins & MIME types', `
      ${field('plugins', 'plugins', 'json')}
      ${field('mimeTypes', 'mimeTypes', 'json')}`, false)}`,
    screen: () => `${acc('Display', `
      ${field('width', 'screen.width', 'number')} ${field('height', 'screen.height', 'number')}
      ${field('availWidth', 'screen.availWidth', 'number')} ${field('availHeight', 'screen.availHeight', 'number')}
      ${field('devicePixelRatio', 'screen.dpr', 'number', { dice: true })} ${field('colorDepth', 'screen.colorDepth', 'select', { options: ['24', '30'] })}
      ${field('colorGamut', 'screen.colorGamut', 'select', { options: ['srgb', 'display-p3', 'rec2020'] })}
      ${field('window inner size', 'screen.innerWidth', 'number')} × ${field('', 'screen.innerHeight', 'number')}
      <div class="hint">DPR=2 (retina) for most Mac configs; DPR=1 typical desktop; mobile profiles emulate via CDP device metrics.</div>`, true)}`,
    tz: () => `${acc('Timezone & locale', `
      ${field('timezone', 'timezone.id', 'select', { options: TZ_LIST.map(z => [z, z]) })}
      ${field('offset (minutes)', 'timezone.offsetMinutes', 'number', { note: 'auto-derived on save-time audit; edit if forcing' })}
      ${field('UTC string', 'timezone.utcOffset', 'text')}
      ${field('region (ISO)', 'meta.region')}`, true)}
    ${acc('Geolocation', `
      ${field('mode', 'geolocation.mode', 'select', { options: [['custom', 'custom position'], ['ask', 'prompt (real)'], ['block', 'deny'] ] })}
      ${field('latitude', 'geolocation.lat', 'number')} ${field('longitude', 'geolocation.lon', 'number')}
      ${field('accuracy (m)', 'geolocation.accuracy', 'number')}
      <div class="hint">Coordinates near a city center in the timezone region. Mismatches (tz vs geo vs proxy country) tank browser-leak scores.</div>`, false)}`,
    hw: () => `${acc('CPU / memory / touch', `
      ${field('hardwareConcurrency', 'hardware.hardwareConcurrency', 'select', { options: ['2', '4', '6', '8', '12', '16', '24'], dice: true })}
      ${field('deviceMemory (GiB)', 'hardware.deviceMemory', 'select', { options: [['null', 'unsupported (Firefox/Safari)'], ['1', '1'], ['2', '2'], ['4', '4'], ['8', '8 (cap)']], note: 'Chromium caps at 8' })}
      ${field('maxTouchPoints', 'hardware.maxTouchPoints', 'number', { note: '0 on desktop; ≥5 on mobile' })}
      ${field('keyboard layout', 'hardware.kbLayout', 'select', { options: ['US', 'UK', 'DE', 'FR', 'ES', 'IT', 'PT', 'RU', 'UA'] })}`, true)}
    ${acc('Battery', `
      ${field('charging', 'battery.charging', 'bool')} ${field('level (0–1)', 'battery.level', 'number')}
      ${field('chargingTime (s)', 'battery.chargingTime', 'number')} ${field('dischargingTime (s)', 'battery.dischargingTime', 'number')}`, false)}`,
    gpu: () => `${acc('GPU / WebGL', `
      ${field('vendor (masked)', 'gpu.vendor')} ${field('renderer (masked)', 'gpu.renderer')}
      ${field('UNMASKED_VENDOR', 'gpu.unmaskedVendor', 'select', { options: ['Google Inc. (NVIDIA)', 'Google Inc. (Intel)', 'Google Inc. (AMD)', 'Google Inc. (Intel Inc.)', 'Apple Inc.'], dice: true })}
      ${field('UNMASKED_RENDERER', 'gpu.unmaskedRenderer', 'text', { dice: true })}
      ${field('VERSION', 'gpu.webglVersion')} ${field('SHADING_LANGUAGE', 'gpu.shadingLanguageVersion')}
      ${field('WebGL2 available', 'gpu.webgl2', 'bool')}
      ${field('extensions', 'gpu.extensions', 'list')}`, true)}
    ${acc('WebGPU (Chromium only)', `
      ${field('enabled', 'gpu.webgpu', 'select', { options: [['null', 'off — hide navigator.gpu'], ['keep', 'spoof adapter info']], derive: v => v ? 'keep' : 'null' })}
      ${field('adapter vendor', 'gpu.webgpu.vendor', 'select', { options: ['nvidia', 'intel', 'amd', 'apple'] })}
      ${field('adapter device', 'gpu.webgpu.device', 'text')}
      <div class="hint">Safari/Firefox profiles: keep OFF — presence of navigator.gpu is itself a leak signal there.</div>`, false)}`,
    cv: () => `${acc('Canvas', `
      ${field('mode', 'canvas.mode', 'select', { options: [['noise', 'noise (recommended)'], ['block', 'blank canvas'], ['off', 'no patch (leak!)'] ] })}
      ${field('noise intensity', 'canvas.noise', 'number', { note: 'pixel LSB perturbations, 0.0001–0.001' })} ${field('canvas seed', 'canvas.seed')}
      ${field('getImageData noise', 'canvas.imageData', 'bool')} ${field('toBlob hook', 'canvas.toBlob', 'bool')}`, true)}
    ${acc('AudioContext', `
      ${field('mode', 'audio.mode', 'select', { options: [['noise', 'noise (recommended)'], ['off', 'no patch'] ] })}
      ${field('jitter', 'audio.noise', 'number')} ${field('sample-rate lock', 'audio.sampleRate', 'select', { options: [['null', '48000 (default)'], ['44100', '44100'] ] })}`, false)}`,
    rtc: () => `${acc('WebRTC leak protection', `
      ${field('mode', 'webrtc.mode', 'select', { options: [['disable', 'disable WebRTC (safest)'], ['proxy', 'keep but strip real IPs'], ['spoof', 'replace with fake local IPs'], ['off', 'no patch (LEAKS real IP!)'] ] })}
      ${field('fake local IP', 'webrtc.fakeLocalIp', 'text', { dice: true })} ${field('fake public IP', 'webrtc.fakePublicIp', 'text')}
      ${field('force TCP 443 (stun mask)', 'webrtc.forceTcp', 'bool')}
      <div class="hint">disable is what most teams want when behind a proxy: the checker verified 0 real candidates for this mode. spoof looks more natural on WebRTC-heavy sites.</div>`, true)}`,
    fonts: () => `${acc('Fonts', `
      ${field('spoof enumeration', 'fonts.spoofEnumeration', 'bool', { note: 'controls document.fonts + canvas measureText width set' })}
      ${field('font list', 'fonts.list', 'list', { sep: ', ' })}
      <div class="hint">OS-appropriate system font stacks. Fonts from another OS are the #1 desktop-vs-UA mismatch caught by Pixelscan-style checks.</div>
      <button class="btn sm" id="ftReset" style="margin-top:6px">Reset to OS defaults</button>`, true)}`,
    media: () => `${acc('Media devices', `
      ${field('enumerateDevices list', 'media.devices', 'json')}
      <div class="hint">one device per line: <span class="mono">audioinput|default microphone|Default</span></div>`, true)}
    ${acc('Speech voices', `${field('voices', 'speech.voices', 'json')}
      <div class="hint">format <span class="mono">name|lang|uri</span></div>`, false)}
    ${acc('Codecs', `
      ${field('canPlayType — supported', 'media.codecs', 'json')}
      ${field('mediaSource', 'media.mimeTypes', 'json')}`, false)}`,
    net: () => `${acc('HTTP headers', `
      ${field('upgrade-insecure-requests', 'headers.upgradeInsecureRequests', 'bool')}
      ${field('DNT', 'headers.dnt', 'select', { options: [['1', '1'], ['0', '0'], ['', 'none'] ] })}
      ${field('Sec-Fetch-Site', 'headers.secFetchSite', 'select', { options: ['same-origin', 'same-site', 'cross-site', 'none'] })}
      ${field('Sec-Fetch-Mode', 'headers.secFetchMode', 'select', { options: ['navigate', 'cors', 'no-cors', 'websocket'] })}
      ${field('Sec-Fetch-Dest', 'headers.secFetchDest', 'select', { options: ['document', 'empty', 'iframe', 'image', 'script', 'fetch'] })}
      ${field('Sec-Fetch-User', 'headers.secFetchUser', 'select', { options: [['?1', '?1 (real user nav)'], ['', 'omit'] ] })}
      <div class="hint" style="margin-top:6px">Accept-Encoding (<span class="mono">gzip, deflate, br, zstd</span>) and the header *order* are emitted by the kernel network stack and follow the real Chromium build — Sec-Fetch-* here are the values the stealth bundle reports via expected-map cross-checks.</div>`, true)}
    ${acc('TLS / QUIC (kernel-level — displayed honestly)', `
      ${field('TLS profile (label)', 'network.tlsProfile', 'text', { note: 'JA3 comes from Chromium binary; cannot be JS-faked' })}
      ${field('HTTP/2 (label)', 'network.http2Profile')}
      ${field('QUIC/HTTP3', 'network.quic', 'select', { options: [['off', 'disabled'], ['on', 'allow'] ], note: 'off recommended — QUIC bypasses proxy auth in most setups' })}
      ${field('DoH', 'network.doh', 'select', { options: [['off', 'off'], ['on', 'secure DNS'] ] })}
      <div class="hint">These are documented, not simulated — see Automation docs §5. A proxy-side TLS shim is the roadmap item.</div>
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn" id="tlsCapture">⌖ Capture REAL TLS / JA3 of this kernel</button>
        <span class="hint" style="margin:0">Points the live kernel at a local socket and reads the TLS ClientHello it sends (plaintext by design) — no MITM, works offline.</span>
      </div>
      <div id="tlsResult" class="kv" style="margin-top:8px"></div>`, false)}`,
    proxy: () => `<div class="card"><div class="form">
      <label>Proxy source</label>
      <div class="row2">
        <div><label>From library</label><select id="pxSel"><option value="">direct (no proxy)</option>${App.state.proxies.map(px => `<option value="${px.id}" ${(p.proxy_id || '') === px.id ? 'selected' : ''}>${App.esc(px.label || px.host + ':' + px.port)} (${App.esc(px.scheme)})</option>`).join('')}</select></div>
        <div><label>…or inline URL</label><input id="pxInline" value="${App.esc(p.inline_proxy || '')}" placeholder="socks5://user:pass@1.2.3.4:1080"></div>
      </div>
      <div id="pxInfo" class="kv"></div>
      <div style="display:flex;gap:10px">
        <button class="btn" id="pxProbe">⇅ Probe &amp; show exit IP</button>
        <button class="btn ok" id="pxAlign" disabled>⇗ Align identity to proxy geo</button>
      </div>
      <div class="hint">Identity alignment sets timezone + region to the real exit IP geo — one click removes the biggest DNS/geo/tz inconsistency class.</div>
    </div></div>`,
    launch: () => `<div class="card"><div class="form">
      <div class="row2"><div><label>Start URL(s) (comma separated)</label><input id="lUrls" value="${App.esc((p.settings?.startUrls || []).join(', '))}"></div>
      <div><label>Window size</label><input id="lSize" value="${App.esc(p.settings?.windowSize || 'auto')}" placeholder="auto or 1440x900"></div></div>
      <label class="switch"><input type="checkbox" id="lCloud" ${p.settings?.cloud ? 'checked' : ''}><i></i><span class="mut">Cloud mode (headless Xvfb — only live-view streaming)</span></label>
      <label class="switch"><input type="checkbox" id="lFresh" ${p.settings?.fresh ? 'checked' : ''}><i></i><span class="mut">Incognito mode (wipe data on every stop)</span></label>
      <label class="switch"><input type="checkbox" id="lOpenLive" ${p.settings?.openLive !== false ? 'checked' : ''}><i></i><span class="mut">Open live view automatically after launch</span></label>
      <label class="switch"><input type="checkbox" id="lSnap" ${p.settings?.autoSnapshot !== false ? 'checked' : ''}><i></i><span class="mut">Save cookies snapshot on stop</span></label>
      <div><label>Extra CLI args (appended after stealth baseline)</label><textarea id="lArgs" placeholder="--force-device-scale-factor=1 …">${App.esc(p.settings?.extraArgs || '')}</textarea></div>
      <div class="hint">Baseline args (automation-control removal, GPU flags, QUIC policy) are injected automatically — see browser/manager._buildArgs.</div>
    </div></div>`,
  };
  body.innerHTML = (TABHTML[f] || (() => '<div class="empty">—</div>'))();

  // data tab (async parts)
  if (f === 'data') drawDataTab(body, p);

  // wire fp inputs
  body.querySelectorAll('[data-p]').forEach(inp => {
    const path = inp.dataset.p;
    const readVal = () => {
      if (inp.type === 'checkbox') return inp.checked;
      if (inp.dataset.json) { try { return JSON.parse(inp.value); } catch (e) { return getPath(Ed.fp, path); } }
      if (inp.dataset.list) return inp.value.split(/\s*(?:,\s*|\n)\s*/).filter(Boolean);
      if (inp.type === 'number') return inp.value === '' ? null : +inp.value;
      if (inp.value === 'null') return null;
      if (inp.value === 'true') return true; if (inp.value === 'false') return false;
      return inp.value;
    };
    inp.oninput = inp.onchange = () => {
      let v = readVal();
      if (path === 'hardware.deviceMemory' && v === 'null') v = null;
      if (path === 'gpu.webgpu' && (v === 'null' || v === 'keep')) { /* handled below */ }
      setPath(Ed.fp, path, v);
      if (path === 'gpu.webgpu' && v === 'null') Ed.fp.gpu.webgpu = null;
      markDirty();
    };
  });
  const resetFonts = document.getElementById('ftReset');
  if (resetFonts) resetFonts.onclick = () => guard(async () => {
    const r = await api('/api/fingerprint/generate', { method: 'POST', body: { os: Ed.fp.osId || 'windows-11', browser: Ed.fp.browser, country: Ed.fp.meta?.region, seed: 'fonts-' + Ed.fp.seed, modelId: Ed.fp.deviceModel || undefined } });
    Ed.fp.fonts = r.fingerprint.fonts; drawTab(); markDirty(); toast('Fonts reset to OS profile');
  });
  // device-model selector: bind the whole identity to one physical device (keeps seed/os/browser/country)
  const modelSel = document.getElementById('gModel');
  if (modelSel) {
    const FAM = (Ed.fp.osId || '').includes('win') ? 'windows' : (Ed.fp.osId || '').includes('mac') ? 'mac' : (Ed.fp.osId || '').includes('ubuntu') ? 'linux' : (Ed.fp.osId || '').includes('android') ? 'android' : (Ed.fp.osId || '').includes('ios') ? 'ios' : 'windows';
    if (!Ed._models) api('/api/fingerprint/models').then(rr => { Ed._models = rr.models; if (Ed.tab === 'general') drawTab(); }).catch(() => { });
    const list = (Ed._models || []).filter(m => m.family === FAM);
    modelSel.innerHTML = '<option value="">auto-random (keep)</option>' + list.map(m => `<option value="${m.id}" ${Ed.fp.deviceModel === m.id ? 'selected' : ''}>${m.id.replace(/^win-|^mac-|^linux-|^android-|^ios-/, '')} · ${m.cores}c · ${m.screen}</option>`).join('');
    modelSel.onchange = async () => { if (!modelSel.value) return; await guard(async () => {
      const r = await api('/api/fingerprint/generate', { method: 'POST', body: { os: Ed.fp.osId, browser: Ed.fp.browser, country: Ed.fp.meta?.region, seed: Ed.fp.seed, modelId: modelSel.value } });
      Ed.fp = r.fingerprint; drawTab(); markDirty(); toast('Device model applied — GPU/cores/screen/audio rebound', 'ok');
    }); };
  }
  const dice = body.querySelectorAll('[data-dice]');
  dice.forEach(b => b.onclick = () => guard(async () => {
    const r = await api('/api/fingerprint/generate', { method: 'POST', body: { os: Ed.fp.osId, browser: Ed.fp.browser, country: Ed.fp.meta?.region, seed: Math.random().toString(36).slice(2), modelId: Ed.fp.deviceModel || undefined } });
    const v = getPath(r.fingerprint, b.dataset.dice);
    if (v === undefined) return toast('no randomizer for this field', 'warn');
    setPath(Ed.fp, b.dataset.dice, v);
    if (b.dataset.dice === 'screen.dpr') { }
    drawTab(); markDirty();
  }));

  // accordions
  body.querySelectorAll('.acc-h').forEach(h => h.onclick = () => h.parentElement.classList.toggle('open'));
  applyI18n(body);

  // proxy tab wiring
  if (f === 'proxy') wireProxyTab(p);
  const cap = document.getElementById('tlsCapture');
  if (cap) cap.onclick = async () => {
    const out = document.getElementById('tlsResult'); out.innerHTML = '<span class="hint">capturing… (this launches the kernel if stopped)</span>';
    try {
      const r = await api(`/api/fingerprint/tls-capture/${encodeURIComponent(Ed.prof.id)}`, { method: 'POST' });
      if (!r.ok) { out.innerHTML = `<span class="bad">${App.esc(r.error || 'capture failed')}</span>`; return; }
      const t = r.tls;
      out.innerHTML = `<div style="margin-top:4px"><b>JA3</b> <span class="mono">${t.ja3}</span></div>
        <div><b>JA3 hash</b> <span class="mono">${t.ja3Hash}</span></div>
        <div><b>JA4</b> <span class="mono">${t.ja4}</span></div>
        <div><b>ALPN</b> ${t.alpn.join(', ')} · <b>curves</b> ${t.curves.join(',')} · <b>GREASE</b> ${t.grease ? 'yes' : 'no'}</div>
        <div class="hint">This is the exact ClientHello fingerprint the kernel presents to every HTTPS origin. Shaping it requires a custom TLS stack (roadmap).</div>`;
    } catch (e) { out.innerHTML = `<span class="bad">${App.esc(e.message)}</span>`; }
  };
  // launch tab save wiring
  if (f === 'launch') {
    ['lUrls', 'lSize', 'lCloud', 'lFresh', 'lOpenLive', 'lSnap', 'lArgs'].forEach(idv => {
      const n = document.getElementById(idv); if (!n) return;
      n.oninput = n.onchange = () => {
        Ed.prof.settings = Ed.prof.settings || {};
        if (idv === 'lUrls') Ed.prof.settings.startUrls = n.value.split(',').map(s => s.trim()).filter(Boolean);
        if (idv === 'lSize') Ed.prof.settings.windowSize = n.value;
        if (idv === 'lCloud') Ed.prof.settings.cloud = n.checked;
        if (idv === 'lFresh') Ed.prof.settings.fresh = n.checked;
        if (idv === 'lOpenLive') Ed.prof.settings.openLive = n.checked;
        if (idv === 'lSnap') Ed.prof.settings.autoSnapshot = n.checked;
        if (idv === 'lArgs') Ed.prof.settings.extraArgs = n.value;
        Ed.dirty = true;
      };
    });
  }
  if (f === 'proxy') {
    document.getElementById('pxSel').onchange = async e => { Ed.prof.proxy_id = e.target.value; await saveProxyRefs(); wireProxyTab(Ed.prof); };
    document.getElementById('pxInline').onchange = async e => { Ed.prof.inline_proxy = e.target.value; await saveProxyRefs(); wireProxyTab(Ed.prof); };
  }
}
async function saveProxyRefs() {
  await api('/api/profiles/' + Ed.id, { method: 'PUT', body: { proxy_id: Ed.prof.proxy_id || '', inline_proxy: Ed.prof.inline_proxy || '' } }).catch(e => toast(e.message, 'err'));
  await refreshAll();
}
let lastProbe = null;
function wireProxyTab(p) {
  const info = document.getElementById('pxInfo'); lastProbe = null;
  const align = document.getElementById('pxAlign'); if (align) align.disabled = true;
  info.innerHTML = p.proxy_id ? `<div class="r"><span class="k">library</span><span>${App.esc((App.state.proxies.find(x => x.id === p.proxy_id) || {}).label || p.proxy_id)}</span></div>` :
    p.inline_proxy ? `<div class="r"><span class="k">inline</span><span class="mono">${App.esc(p.inline_proxy.replace(/\/\/[^@]+@/, '//***@'))}</span></div>` :
      '<div class="r"><span class="k">proxy</span><span>direct — kernel uses the server IP. Profiles that log into platforms should use a per-profile residential/ISP proxy.</span></div>';
  document.getElementById('pxProbe').onclick = () => guard(async () => {
    const px = p.proxy_id ? App.state.proxies.find(x => x.id === p.proxy_id) : (p.inline_proxy ? parseInline(p.inline_proxy) : null);
    info.innerHTML = '<span class="spin"></span> probing…';
    const r = px ? await api('/api/proxies/test', { method: 'POST', body: px }) : await fetch('https://ip-api.com/json/?fields=status,country,countryCode,city,lat,lon,timezone,isp,proxy,hosting', { mode: 'cors' }).then(x => x.json()).then(g => ({ ok: true, exitIp: 'server-ip', geo: g })).catch(() => ({ ok: false, error: 'server has no outbound ip-api access' }));
    lastProbe = r;
    if (!r.ok) { info.innerHTML = `<div class="issue critical">✗ ${App.esc(r.error || 'unreachable')}</div>`; return; }
    const geo = r.geo || {};
    info.innerHTML = `
      <div class="r"><span class="k">exit IP</span><span class="mono">${App.esc(r.exitIp || '—')}</span></div>
      <div class="r"><span class="k">latency</span><span class="mono">${r.latencyMs ?? '—'}ms</span></div>
      <div class="r"><span class="k">geo</span><span>${App.esc(geo.country || '?')} · ${App.esc(geo.city || '')} <span class="dim">(${App.esc(geo.lat || '')},${App.esc(geo.lon || '')})</span></span></div>
      <div class="r"><span class="k">timezone</span><span class="mono">${App.esc(geo.timezone || '—')}</span></div>
      <div class="r"><span class="k">ISP / ASN</span><span>${App.esc(geo.isp || '')} ${geo.hosting ? '· <span class="warn-c">HOSTING</span>' : geo.proxy ? '· <span class="bad-c">open proxy flag</span>' : '· <span class="ok-c">residential-ish</span>'}</span></div>`;
    if (align) align.disabled = !(geo.timezone || geo.countryCode);
  });
  const alignBtn = document.getElementById('pxAlign');
  if (alignBtn) alignBtn.onclick = () => {
    const geo = (lastProbe || {}).geo || {};
    if (geo.timezone) setPath(Ed.fp, 'timezone.id', geo.timezone);
    if (geo.countryCode) setPath(Ed.fp, 'meta.region', geo.countryCode);
    if (geo.lat) setPath(Ed.fp, 'geolocation.lat', +geo.lat + (Math.random() - .5) * .4);
    if (geo.lon) setPath(Ed.fp, 'geolocation.lon', +geo.lon + (Math.random() - .5) * .4);
    drawTab(); markDirty(); toast('Identity aligned to proxy geo — press Save', 'ok');
  };
}
function parseInline(s) { try { const u = new URL(s); return { scheme: u.protocol.replace(':', '') || 'http', host: u.hostname, port: +u.port, user: decodeURIComponent(u.username || ''), pass: decodeURIComponent(u.password || '') }; } catch (e) { return null; } }

/* ---------- data tab ---------- */
async function drawDataTab(body, p) {
  const running = !!sessOf(Ed.id);
  body.innerHTML = `<div class="card"><h3>Cookies & storage</h3>
    <div class="prow" style="margin-bottom:12px">
      <button class="btn" id="dCookies" ${running ? '' : 'disabled title="launch kernel to inspect live cookies"'}>🍪 ${running ? 'Read live cookies' : 'launch to read live'}</button>
      <button class="btn" id="dSnapNow" ${running ? '' : 'disabled'}>⛶ Snapshot now</button>
      <button class="btn danger" id="dClear" ${running ? '' : 'disabled'}>✂ Wipe cookies & storage</button>
    </div>
    <div id="dCookieBox"></div></div>
  <div class="card" style="margin-top:14px"><h3>Identity snapshots (auto on stop)</h3><div id="dSnaps"><span class="spin"></span></div></div>
  <div class="card" style="margin-top:14px"><h3>Browsing history (this profile)</h3><div id="dHist" class="kv"><span class="spin"></span></div></div>
  <div class="card" style="margin-top:14px"><h3>Device-DNA — encrypted identity export / import</h3>
    <div class="hint" style="margin-bottom:8px">Seal this profile's full anti-detect identity (fingerprint + proxy) with a passphrase (PBKDF2 + AES-256-GCM). Move it between Mirage servers without ever exposing the raw identity.</div>
    <div class="row2"><div><label>Passphrase</label><input id="dnaPass" type="password" placeholder="blank = 'mirage'"></div>
      <div style="display:flex;gap:8px;align-items:flex-end"><button class="btn" id="dnaExport">⬇ Export DNA</button><button class="btn ok" id="dnaImport">⬆ Import DNA</button></div></div>
    <textarea id="dnaOut" class="mono" style="width:100%;height:120px;margin-top:8px" placeholder="exported DNA appears here · paste a DNA blob to import"></textarea>
    <div id="dnaThumb" class="dim mono"></div></div>
  <div class="card" style="margin-top:14px"><h3>Rotation scheduler <span class="dim mut">— new identity, same cookies</span></h3>
    <div class="hint" style="margin-bottom:8px">Periodically regenerate the device identity (seed + optional model) while KEEPING the cookie jar &amp; localStorage — your logged-in sessions survive a fingerprint change.</div>
    <label class="switch"><input type="checkbox" id="rotOn"><i></i><span class="mut">Enable automatic rotation</span></label>
    <div class="row2" style="margin-top:8px">
      <div><label>Interval (hours)</label><input id="rotHrs" type="number" min="1" max="720" value="24"></div>
      <div><label class="switch" style="margin-top:18px"><input type="checkbox" id="rotModel"><i></i><span class="mut">also rotate device model</span></label></div>
    </div>
    <div class="prow" style="margin-top:10px"><button class="btn ok" id="rotSave">Save schedule</button><button class="btn" id="rotNow">⟳ Rotate identity now</button><span id="rotStatus" class="dim mono"></span></div>
  </div>`;
  const loadSnaps = async () => {
    const { snapshots } = await api(`/api/profiles/${Ed.id}/snapshots`);
    document.getElementById('dSnaps').innerHTML = snapshots.length ? `<table class="tbl"><tbody>${snapshots.map(s => `<tr><td class="mono dim">${new Date(s.ts).toLocaleString()}</td><td class="mono">${App.esc(s.origin || '')}</td><td style="text-align:right"><button class="btn sm" data-restore="${s.id}">↺ Restore</button> <button class="btn sm ghost" data-delsnap="${s.id}">✕</button></td></tr>`).join('')}</tbody></table>` : '<span class="dim">No snapshots yet.</span>';
  };
  loadSnaps();
  const { history } = await api(`/api/browser/history/${Ed.id}`).catch(() => ({ history: [] }));
  document.getElementById('dHist').innerHTML = history.length ? history.slice(0, 30).map(h => `<div class="r"><span class="k">${fmtRel(new Date(h.ts).toISOString())}</span><span>${App.esc(h.url || '').slice(0, 90)}</span></div>`).join('') : '<span class="dim">Nothing yet.</span>';
  document.getElementById('dCookies').onclick = () => guard(async () => {
    const { cookies } = await api('/api/browser/cookies/' + Ed.id);
    const box = document.getElementById('dCookieBox');
    box.innerHTML = cookies.length ? `<table class="tbl"><thead><tr><th>Domain</th><th>Name</th><th>Value</th><th>Expires</th><th></th></tr></thead><tbody>
      ${cookies.slice(0, 200).map((c, i) => `<tr><td class="mono">${App.esc(c.domain)}</td><td class="mono">${App.esc(c.name)}</td><td class="mono" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${App.esc(String(c.value).slice(0, 60))}</td><td class="dim">${c.expires > 0 ? new Date(c.expires * 1000).toLocaleDateString() : 'session'}</td><td><button class="iconbtn" data-ckdel="${i}">✕</button></td></tr>`).join('')}</tbody></table><div class="hint">${cookies.length} total.</div>` : '<span class="dim">Empty jar — this identity has never visited anything.</span>';
    box.querySelectorAll('[data-ckdel]').forEach(b => b.onclick = () => guard(async () => {
      const c = cookies[+b.dataset.ckdel];
      await api('/api/browser/cookies', { method: 'POST', body: { profileId: Ed.id, action: 'set', cookies: [{ ...c, value: c.value, expires: -1 }] } }).catch(() => { });
      await api('/api/browser/cookies', { method: 'POST', body: { profileId: Ed.id, action: 'get' } });
      toast('Cookie deletion queued (re-read to confirm)');
    }));
  });
  document.getElementById('dSnapNow').onclick = () => guard(async () => { const r = await api('/api/browser/cookies', { method: 'POST', body: { profileId: Ed.id, action: 'snapshot' } }); toast(`Snapshot: ${r.cookies} cookies`, 'ok'); loadSnaps(); });
  document.getElementById('dClear').onclick = () => confirmDlg('Wipe profile data', 'Removes all cookies + local/session storage from the live kernel. The profile dir on disk stays until next launch.', async () => { await api('/api/browser/cookies', { method: 'POST', body: { profileId: Ed.id, action: 'clear' } }); toast('Cleared', 'ok'); });
  document.getElementById('dSnaps').onclick = e => {
    const r = e.target.closest('[data-restore]'), d = e.target.closest('[data-delsnap]');
    if (r) guard(async () => { const res = await api('/api/snapshots/restore', { method: 'POST', body: { profileId: Ed.id, snapshotId: r.dataset.restore } }); toast(`Restored ${res.restored} cookies${res.offline ? ' (kernel will apply at launch)' : ''}`, 'ok'); });
    if (d) guard(async () => { await api('/api/snapshots/' + d.dataset.delsnap, { method: 'DELETE' }); loadSnaps(); });
  };
  // Device-DNA
  const dnaExport = document.getElementById('dnaExport');
  if (dnaExport) dnaExport.onclick = () => guard(async () => {
    const pw = document.getElementById('dnaPass').value || 'mirage';
    const r = await api(`/api/profiles/${Ed.id}/export`, { method: 'POST', body: { passphrase: pw } });
    if (!r.ok) return toast(r.error || 'export failed', 'bad');
    const blob = JSON.stringify(r.dna);
    document.getElementById('dnaOut').value = blob;
    document.getElementById('dnaThumb').textContent = 'thumb: ' + r.thumb;
    navigator.clipboard && navigator.clipboard.writeText(blob).catch(() => { });
    toast('Device-DNA exported (copied to clipboard)', 'ok');
  });
  const dnaImport = document.getElementById('dnaImport');
  if (dnaImport) dnaImport.onclick = () => guard(async () => {
    const blob = document.getElementById('dnaOut').value.trim();
    if (!blob) return toast('Paste a Device-DNA blob first', 'bad');
    const pw = document.getElementById('dnaPass').value || 'mirage';
    let parsed; try { parsed = JSON.parse(blob); } catch (e) { return toast('DNA blob is not valid JSON', 'bad'); }
    const r = await api('/api/profiles/import', { method: 'POST', body: { dna: parsed, passphrase: pw } });
    if (!r.ok) return toast(r.error || 'import failed', 'bad');
    toast('Imported as ' + r.name, 'ok');
    if (App.load) App.load();
  });
  // Rotation scheduler
  const rotStatus = document.getElementById('rotStatus');
  const loadRot = async () => {
    const r = await api(`/api/profiles/${Ed.id}/rotation`).catch(() => ({ rotation: { enabled: false } }));
    const rot = r.rotation || {};
    document.getElementById('rotOn').checked = !!rot.enabled;
    document.getElementById('rotHrs').value = rot.intervalHours || 24;
    document.getElementById('rotModel').checked = !!rot.rotateModel;
    rotStatus.textContent = rot.rotations ? ('rotated ' + rot.rotations + '× · last ' + (rot.lastRotateAt ? new Date(rot.lastRotateAt).toLocaleString() : '—')) : '';
  };
  loadRot();
  document.getElementById('rotSave').onclick = () => guard(async () => {
    await api(`/api/profiles/${Ed.id}/rotation`, { method: 'PUT', body: { enabled: document.getElementById('rotOn').checked, intervalHours: +document.getElementById('rotHrs').value, rotateModel: document.getElementById('rotModel').checked } });
    toast('Rotation schedule saved', 'ok'); loadRot();
  });
  document.getElementById('rotNow').onclick = () => guard(async () => {
    const r = await api(`/api/profiles/${Ed.id}/rotation/now`, { method: 'POST' });
    if (!r.ok) return toast(r.error || 'rotate failed', 'bad');
    toast('Identity rotated — cookies preserved (' + (r.rotation.cookiesPreserved || 0) + ' cookies)', 'ok'); loadRot();
  });
}

/* ---------- audit panel ---------- */
async function auditNow() {
  const box = document.getElementById('auditBody'); if (!box) return;
  let out;
  try {
    const px = App.state.proxies.find(x => x.id === Ed.prof.proxy_id);
    out = await api('/api/fingerprint/audit', { method: 'POST', body: { fp: Ed.fp, ctx: { proxyCountry: px?.country || '', proxyScheme: px?.scheme } } });
  } catch (e) { box.innerHTML = `<span class="bad-c">${App.esc(e.message)}</span>`; return; }
  const R = 42, C = 2 * Math.PI * R;
  const col = out.score >= 90 ? 'var(--ok)' : out.score >= 70 ? 'var(--warn)' : 'var(--bad)';
  box.innerHTML = `
    <div class="ring"><svg width="118" height="118"><circle cx="59" cy="59" r="${R}" stroke="var(--line)" stroke-width="9" fill="none"/>
      <circle cx="59" cy="59" r="${R}" stroke="${col}" stroke-width="9" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - out.score / 100)}"/></svg>
      <div class="num" style="color:${col}">${out.score}</div></div>
    <div class="dim" style="text-align:center;margin-bottom:10px">${out.critCount ? `<span class="bad-c">${out.critCount} critical</span> · ` : ''}${out.issues.filter(i => i.sev === 'warn').length} warnings</div>
    ${out.issues.length ? out.issues.map(i => `<div class="issue ${i.sev}"><b>${i.sev} · ${App.esc(i.rule)}</b>${App.esc(i.msg)}</div>`).join('') : '<div class="issue info"><b>perfect</b>No inconsistencies found — this identity hangs together.</div>'}`;
}

/* ---------- identity regenerate modal ---------- */
function identityModal(id) {
  const fp = Ed.fp || {};
  modal({ title: 'Generate new identity', body: `
    <div class="form">
      <div class="row3">
        <div><label>OS</label><select id="rgOs">${[['windows-11', 'Win 11'], ['windows-10', 'Win 10'], ['macos-sequoia', 'Sequoia'], ['macos-sonoma', 'Sonoma'], ['ubuntu-2404', 'Ubuntu'], ['android-14', 'Android 14'], ['ios-17', 'iOS 17']].map(o => `<option value="${o[0]}" ${(fp.os?.id || '') === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>
        <div><label>Browser</label><select id="rgBr">${['chrome', 'edge', 'firefox', 'safari'].map(b => `<option ${fp.browser === b ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
        <div><label>Country</label><input id="rgC" value="${App.esc(fp.meta?.region || '')}" placeholder="US" maxlength="2"></div>
      </div>
      <div><label>Seed</label><div style="display:flex;gap:8px"><input id="rgSeed" class="mono" value="${App.esc(fp.seed || '')}"><button class="btn sm" id="rgDice">⚄ new</button></div>
      <div class="hint">Same seed + os/browser = identical fingerprint — keep seed to stay "the same person" across team changes.</div></div>
      <p class="warn-c" style="font-size:12.5px">⚠ A brand-new identity on an old profile's cookies is a risk signal for ad platforms. Regenerate when starting fresh or rotating.</p>
    </div>`, actions: [
      { label: 'Preview only', onClick: ({ bodyEl }) => guard(async () => { const r = await api('/api/fingerprint/generate', { method: 'POST', body: { os: bodyEl.querySelector('#rgOs').value, browser: bodyEl.querySelector('#rgBr').value, country: bodyEl.querySelector('#rgC').value, seed: bodyEl.querySelector('#rgSeed').value } }); modal({ title: 'Generated fingerprint', body: `<pre class="code" style="max-height:480px">${App.esc(JSON.stringify(r.fingerprint, null, 2))}</pre>`, actions: [{ label: 'Close' }] }); return true; }) },
      { label: 'Apply to profile', kind: 'primary', onClick: ({ bodyEl }) => guard(async () => { await api(`/api/profiles/${id}/regenerate`, { method: 'POST', body: { os: bodyEl.querySelector('#rgOs').value, browser: bodyEl.querySelector('#rgBr').value, country: bodyEl.querySelector('#rgC').value, seed: bodyEl.querySelector('#rgSeed').value || undefined } }); await refreshAll(); toast('New identity applied', 'ok'); go('#/profiles/' + id); rerender(); }) },
    ] });
}
