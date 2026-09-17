/* ============ Mirage live view (cloud-browser UX) + fingerprint lab ============ */

const Live = { meta: null, frames: 0, lastFpsAt: 0, objUrl: null, img: null, _cleanups: [] };
window.LiveCleanup = () => {
  for (const fn of (Live._cleanups || [])) { try { fn(); } catch (_) {} }
  Live._cleanups = [];
  Live.img = null; Live.meta = null;
};

window.onLiveFrame = (buf) => {
  if (App.state.view !== 'live') return;
  Live.frames++;
  const now = Date.now();
  if (now - Live.lastFpsAt > 1000) {
    const el = document.getElementById('fpsTxt');
    if (el) el.textContent = (Live.frames * 1000 / (now - Live.lastFpsAt)).toFixed(1) + ' fps';
    Live.frames = 0; Live.lastFpsAt = now;
  }
  const img = Live.img; if (!img) return;
  if (Live.objUrl) URL.revokeObjectURL(Live.objUrl);
  Live.objUrl = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
  const scroll = img.scrollTop || 0;
  img.src = Live.objUrl;
  void scroll;
};

window.onLiveMsg = (m) => {  if (App.state.view !== 'live') return;
  const pid = App.state.live.pid;
  if (m.type === 'meta') { Live.meta = m; const el = document.getElementById('resTxt'); const sw = m.screenWidth || m.deviceWidth || m.screenshotWidth; if (el && sw) el.textContent = `${sw}×${m.screenHeight || m.deviceHeight || m.screenshotHeight || '?'} @${(m.deviceScaleFactor || m.pageScaleFactor || 1).toFixed(2)}x`; }
  else if (m.type === 'targets') { App.state.live.targets = m.targets || []; drawTabStrip(); syncUrlBar(m.targets); }
  else if (m.type === 'nav') { const u = document.getElementById('liveUrl'); if (u && document.activeElement !== u) u.value = m.url || ''; }
  else if (m.type === 'clipboard') { handleClipboard(m); }
  else if (m.type === 'closed') { toast('Kernel session closed', 'warn'); go('#/profiles'); }
};

// Обработка буфера обмена между системой и антидетект-браузером
async function handleClipboard(m) {
  if (m.action === 'copy' && typeof m.text === 'string') {
    // Копирование из браузера в системный буфер
    try {
      await navigator.clipboard.writeText(m.text);
      toast('Copied to system clipboard', 'ok');
    } catch (e) {
      // A WebSocket reply may arrive after user activation expires. Try legacy copy,
      // but show selectable text if the host denies it; never report a false success.
      const previousFocus = document.activeElement;
      const ta = document.createElement('textarea');
      ta.value = m.text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let done = false;
      try { done = document.execCommand('copy'); } catch (_) { }
      document.body.removeChild(ta);
      previousFocus?.focus({ preventScroll: true });
      if (done) toast('Copied to system clipboard', 'ok');
      else modal({ title: 'Copy failed', body: `<p class="mut">Браузер запретил доступ к буферу (нужен HTTPS или разрешение). Скопируйте вручную:</p><textarea class="code" rows="6" style="width:100%">${App.esc(m.text)}</textarea>`, actions: [{ label: 'Close' }] });
    }
  }
}

function drawTabStrip() {
  const strip = document.getElementById('tabStrip'); if (!strip) return;
  const ts = App.state.live.targets || [];
  strip.innerHTML = ts.map(t => `<span class="tabchip ${t.active ? 'on' : ''}" data-tid="${t.id}">
      <span class="tt">${App.esc(t.title || t.url || 'tab')}</span>
      ${ts.length > 1 ? `<b data-close="${t.id}" style="cursor:pointer">✕</b>` : ''}</span>`).join('') + `<span class="tabchip" id="tabAdd" style="max-width:34px;justify-content:center">+</span>`;
  strip.onclick = e => {
    // keep driving the page without an extra click: hand focus back to the input stage
    const refocus = () => { const st = document.getElementById('lvStage'); if (st) setTimeout(() => { try { st.focus({ preventScroll: true }); } catch (_) { try { st.focus(); } catch (__) {} } }, 60); };
    const close = e.target.closest('[data-close]');
    if (close) { e.stopPropagation(); rpc('browser.tab', { profileId: App.state.live.pid, action: 'close', targetId: close.dataset.close }); refocus(); return; }
    if (e.target.closest('#tabAdd')) { const url = prompt('Open URL in new tab:', 'https://example.com'); if (url !== null) rpc('browser.tab', { profileId: App.state.live.pid, action: 'new', url }); refocus(); return; }
    const chip = e.target.closest('[data-tid]');
    if (chip) rpc('browser.tab', { profileId: App.state.live.pid, action: 'activate', targetId: chip.dataset.tid });
    refocus();
  };
}
function syncUrlBar(targets) {
  const u = document.getElementById('liveUrl'); if (!u || document.activeElement === u) return;
  const list = targets || App.state.live.targets || [];
  const act = list.find(t => t.active) || list[list.length - 1];
  if (act) u.value = act.url || '';
}

/* ---- rpc (browser.* commands) is provided by core.js ---- */

ROUTES.live = (view, params) => {
  if (window.LiveCleanup) LiveCleanup(); // drop stale window listeners on re-render (launch → rerender)
  const pid = params[0];
  const prof = profileOf(pid);
  const running = !!sessOf(pid);
  App.state.live.pid = pid;
  document.getElementById('crumbs').innerHTML = `<span style="color:var(--mut);cursor:pointer" onclick="go('#/profiles')">Profiles</span> <span>/</span> ${App.esc(prof?.name || pid)} <span>·</span> <span class="ok-c">live</span>`;
  view.innerHTML = `
  <div class="live" id="lvHost">
    <div class="live-bar">
      <button class="iconbtn" id="lvBack" title="Back">←</button>
      <button class="iconbtn" id="lvFwd" title="Forward">→</button>
      <button class="iconbtn" id="lvRel" title="Reload">⟳</button>
      <div class="urlbar"><input id="liveUrl" placeholder="address" spellcheck="false"><button class="btn sm" id="lvGo">Go</button></div>
      <button class="btn sm" id="lvSnap" title="cookies+storage snapshot">⛶ Snapshot</button>
      <button class="btn sm" id="lvChk" title="run leak checker in this kernel">⌕ Leak test</button>
      <button class="btn sm" id="lvCookie" title="view cookies">🍪</button>
      <button class="btn sm ok" id="lvOpen" title="grab a hi-res screenshot">📷</button>
      <button class="btn sm" id="lvFull" title="Fullscreen — keeps the address bar">⤢ Full</button>
      <button class="btn sm danger" id="lvStop">■ Stop</button>
      <span class="fps" id="fpsTxt">—</span><span class="fps" id="resTxt">…</span>
    </div>
    <div class="tabs-strip" id="tabStrip"></div>
    <div class="live-stage" id="lvStage" tabindex="0">
      <img id="lvImg" alt="live view" draggable="false">
      <div class="stage-hint" id="lvHint">${running ? 'click the page to capture input · Esc releases' : 'kernel not running'}</div>
    </div>
  </div>`;
  Live.img = document.getElementById('lvImg');
  const host = document.getElementById('lvHost'), fsb = document.getElementById('lvFull');
  const setFull = on => {
    host.classList.toggle('full', on); document.body.classList.toggle('fs-lock', on);
    fsb.textContent = on ? '⤡ Exit' : '⤢ Full'; applyI18n(fsb);
    if (on && host.requestFullscreen) host.requestFullscreen().catch(() => { });
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
  };
  fsb.onclick = () => setFull(!host.classList.contains('full'));
  const onFsChange = () => { if (!document.fullscreenElement && host.isConnected) setFull(false); };
  document.addEventListener('fullscreenchange', onFsChange);
  Live._cleanups.push(() => document.removeEventListener('fullscreenchange', onFsChange));
  const img = Live.img;
  if (!running) {
    guard(async () => { await launchProfile(pid); toast('Launched'); }).then(() => setTimeout(rerender, 1200));
  }
  wsSend({ type: 'subscribe', channel: 'live:' + pid });
  api('/api/browser/tabs?profileId=' + pid).then(r => { App.state.live.targets = r.tabs || []; drawTabStrip(); syncUrlBar(); }).catch(() => { });

  /* ---- navigation toolbar ---- */
  document.getElementById('lvGo').onclick = goNav;
  document.getElementById('liveUrl').onkeydown = e => { if (e.key === 'Enter') goNav(); };
  function goNav() { const u = document.getElementById('liveUrl').value.trim(); if (u) rpc('browser.navigate', { profileId: pid, url: u }).catch(e => toast(e.message, 'err')); }
  document.getElementById('lvBack').onclick = () => rpc('browser.tab', { profileId: pid, action: 'back' }).catch(() => { });
  document.getElementById('lvFwd').onclick = () => rpc('browser.tab', { profileId: pid, action: 'forward' }).catch(() => { });
  document.getElementById('lvRel').onclick = () => rpc('browser.tab', { profileId: pid, action: 'reload' }).catch(() => { });
  document.getElementById('lvSnap').onclick = () => guard(async () => { const r = await rpc('browser.snapshot', { profileId: pid }); toast(`Snapshot saved · ${r.cookies} cookies`, 'ok'); });
  document.getElementById('lvChk').onclick = async () => {
    const stage = document.getElementById('lvHint'); stage.textContent = 'running leak checker in kernel…';
    try { const r = await api(`/api/checker/run/${pid}`, { method: 'POST', body: {} }); stage.textContent = r.leaks ? `⚠ ${r.leaks} leak(s) — open Fingerprint Lab for details` : '✓ 0 leaks'; toast(r.leaks ? r.leaks + ' leaks found' : 'No leaks — clean identity', r.leaks ? 'warn' : 'ok');
    } catch (e) { stage.textContent = 'checker failed: ' + e.message; }
  };
  document.getElementById('lvCookie').onclick = () => guard(async () => {
    const { cookies } = await rpc('browser.cookies', { profileId: pid });
    modal({ title: `Cookies (${cookies.length})`, wide: true, body: `<div style="max-height:420px;overflow:auto">${cookies.length ? `<table class="tbl"><thead><tr><th>Domain</th><th>Name</th><th>Value</th></tr></thead><tbody>${cookies.map(c => `<tr><td class="mono">${App.esc(c.domain)}</td><td class="mono">${App.esc(c.name)}</td><td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${App.esc(String(c.value).slice(0, 80))}</td></tr>`).join('')}</tbody></table>` : 'Empty.'}</div>`, actions: [{ label: 'Wipe all', kind: 'danger', onClick: async () => { await api('/api/browser/cookies', { method: 'POST', body: { profileId: pid, action: 'clear' } }); toast('Cleared', 'ok'); } }] });
  });
  document.getElementById('lvOpen').onclick = () => guard(async () => {
    const { dataUrl } = await api(`/api/browser/screenshot/${pid}`).catch(async e => { throw e; });
    const a = document.createElement('a'); a.href = dataUrl; a.download = `${(prof?.name || pid)}-${Date.now()}.jpg`; a.click(); toast('Screenshot saved', 'ok');
  });
  document.getElementById('lvStop').onclick = () => guard(async () => { await stopProfile(pid); toast('Stopped — snapshot auto-saved', 'ok'); go('#/profiles'); });

  /* ---- input capture ---- */
  const stage = document.getElementById('lvStage');
  let focused = false, downBtn = null, downAt = 0, clickCount = 0, lastMove = 0, lastP = { x: 0, y: 0 };
  const setHint = t => { const h = document.getElementById('lvHint'); if (h) h.textContent = t; };
  const capture = () => {
    if (!focused) { focused = true; setHint('input captured · Esc to release'); }
    if (document.activeElement !== stage) { try { stage.focus({ preventScroll: true }); } catch (_) { try { stage.focus(); } catch (__) {} } }
  };
  const release = () => {
    focused = false; downBtn = null;
    setHint('click the page to capture input');
    try { stage.blur(); } catch (_) {}
  };
  const toCSS = e => {
    const m = Live.meta || {};
    const r = img.getBoundingClientRect();
    // cssWidth/cssHeight (kernel layout metrics) stay correct under DPR≠1 and mobile emulation;
    // raw screencast metadata is in device pixels and would overshoot there.
    const sw = m.cssWidth || m.screenWidth || m.deviceWidth || m.screenshotWidth || r.width || 1;
    const sh = m.cssHeight || m.screenHeight || m.deviceHeight || m.screenshotHeight || r.height || 1;
    const w = r.width || 1, h = r.height || 1;
    const x = (e.clientX - r.left) / w * sw, y = (e.clientY - r.top) / h * sh;
    return {
      x: Math.max(0, Math.min(Math.round(x), Math.max(0, Math.round(sw) - 1))),
      y: Math.max(0, Math.min(Math.round(y), Math.max(0, Math.round(sh) - 1))),
    };
  };
  const btnName = b => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');
  const btnMask = b => (b === 2 ? 2 : b === 1 ? 4 : 1); // CDP/DOM bitmask: left=1 right=2 middle=4
  stage.addEventListener('mousedown', e => { if (e.target !== img) return; capture(); });
  stage.addEventListener('contextmenu', e => e.preventDefault());
  // Focus left the stage while a modifier was held → the remote side would see a stuck
  // Ctrl/Shift/Alt. Release them explicitly but keep hover/click capture armed.
  stage.addEventListener('blur', () => {
    if (!focused) return;
    for (const [key, code] of [['Control', 'ControlLeft'], ['Shift', 'ShiftLeft'], ['Alt', 'AltLeft'], ['Meta', 'MetaLeft']]) {
      wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: 'key', type: 'keyUp', key, code, modifiers: 0 } });
    }
    downBtn = null;
  });
  img.addEventListener('pointerdown', e => {
    capture(); // the first click both captures input AND is delivered — never swallow it
    e.preventDefault();
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
    const p = toCSS(e); lastP = p;
    const button = btnName(e.button);
    const nowMs = Date.now();
    clickCount = (button === downBtn && nowMs - downAt < 450) ? clickCount + 1 : 1;
    downBtn = button; downAt = nowMs;
    wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: e.pointerType === 'touch' ? 'touch' : 'mouse', type: 'mousePressed', ...p, button, clickCount, buttons: btnMask(e.button), pointerType: e.pointerType || 'mouse' } });
  });
  const onPointerUp = e => {
    if (!focused || !downBtn) return;
    const p = toCSS(e); lastP = p;
    wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: e.pointerType === 'touch' ? 'touch' : 'mouse', type: 'mouseReleased', ...p, button: downBtn, clickCount, buttons: 0 } });
    downBtn = null;
  };
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  const onWinBlur = () => {
    if (focused && downBtn) wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: 'mouse', type: 'mouseReleased', ...lastP, button: downBtn, clickCount, buttons: 0 } });
    downBtn = null;
  };
  window.addEventListener('blur', onWinBlur);
  Live._cleanups.push(() => {
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('blur', onWinBlur);
  });
  img.addEventListener('pointermove', e => {
    if (!focused) return; const nowMs = performance.now(); if (nowMs - lastMove < 33) return; lastMove = nowMs;
    const p = toCSS(e); lastP = p;
    wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: e.pointerType === 'touch' && e.buttons ? 'touch' : 'mouse', type: 'mouseMoved', ...p, button: 'none', buttons: e.buttons || 0, pointerType: e.pointerType || 'mouse' } });
  });
  img.addEventListener('wheel', e => { if (!focused) capture(); e.preventDefault(); const p = toCSS(e); wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY } }); }, { passive: false });
  // Native paste events expose text even on HTTP origins where navigator.clipboard is
  // unavailable. Do not cancel Ctrl/Cmd+V: let the host browser deliver that trusted event.
  stage.addEventListener('paste', e => {
    if (!focused) return;
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text) wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: 'clipboard', action: 'paste', text } });
  });
  stage.addEventListener('keydown', e => {
    if (!focused) return;
    if (e.key === 'Escape') { release(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyV' || e.key.toLowerCase() === 'v')) return;
    e.preventDefault();
    const mods = (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.shiftKey ? 8 : 0) | (e.metaKey ? 4 : 0);
    const printable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;

    // System clipboard sync for Ctrl/⌘+C/X/V (the remote kernel has its own clipboard)
    if ((e.ctrlKey || e.metaKey) && (['KeyC', 'KeyX'].includes(e.code) || ['c', 'x'].includes(e.key.toLowerCase()))) {
      const k = e.code === 'KeyC' ? 'c' : e.code === 'KeyX' ? 'x' : e.key.toLowerCase();
      if (k === 'c') {
        // Copy: the selection survives, so let the page handle the combo AND mirror the text out
        wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: 'key', type: 'keyDown', key: e.key, code: e.code || '', modifiers: mods, repeat: e.repeat } });
        wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: 'clipboard', action: 'copy', modifiers: mods } });
      } else {
        // Cut: the server reads the selection first, then performs the cut — no race
        wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: 'clipboard', action: 'cut', modifiers: mods } });
      }
      return;
    }

    // Full keyDown/keyUp pairs for every key (incl. printable ones, with code) so pages that
    // listen for keydown/keyup (masks, hotkeys, bot-behavior checks) see realistic typing.
    const ev = { kind: 'key', type: 'keyDown', key: e.key, code: e.code || '', modifiers: mods, repeat: !!e.repeat };
    if (printable) { ev.text = e.key; }
    wsSend({ type: 'input', channel: 'live:' + pid, ev });
  });
  stage.addEventListener('keyup', e => {
    if (!focused) return;
    if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyV' || e.key.toLowerCase() === 'v')) return;
    e.preventDefault();
    const mods = (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.shiftKey ? 8 : 0) | (e.metaKey ? 4 : 0);
    wsSend({ type: 'input', channel: 'live:' + pid, ev: { kind: 'key', type: 'keyUp', key: e.key, code: e.code || '', modifiers: mods } });
  });
  console.info('[mirage] live input armed for ' + pid);
};

/* ===================== FINGERPRINT LAB ===================== */
const EXT_CHECKERS = [
  ['Pixelscan', 'https://pixelscan.net', 'consistency gates + bot behavior'],
  ['BrowserScan', 'https://www.browserscan.net/en/check', 'browser authenticity %'],
  ['BrowserLeaks · WebGL', 'https://browserleaks.com/webgl', 'vendor/renderer/extensions'],
  ['BrowserLeaks · Canvas', 'https://browserleaks.com/canvas', 'canvas hash'],
  ['BrowserLeaks · WebRTC', 'https://browserleaks.com/webrtc', 'local/public IP leak'],
  ['BrowserLeaks · Fonts', 'https://browserleaks.com/fonts', 'enumerated font set'],
  ['CreepJS', 'https://abrahamjuliot.github.io/creepjs/', 'entropy · like% · resistance'],
  ['Iphey', 'https://iphey.com', 'MX score vs real-user corpus'],
  ['AmIUnique', 'https://amiunique.org/fingerprint', 'per-attribute uniqueness'],
  ['ipleak.net', 'https://ipleak.net', 'raw IP · DNS · headers'],
];
ROUTES.checker = (view) => {
  view.innerHTML = `
  <div class="toolbar"><div style="font-size:13px;color:var(--mut)">Pick what to audit — Mirage's 60-probe lab and the well-known public checkers all run against the selected resource.</div><div class="grow"></div></div>
  <div class="chk-wrap">
    <div><iframe id="chkFrame" class="chk-frame" src="/checker"></iframe></div>
    <div style="display:grid;gap:14px;align-content:start">
      <div class="card"><h3>Audit target</h3>
        <div class="form">
          <div><label>Identity source</label><select id="ckPid">${App.state.profiles.map(p => `<option value="${p.id}">${App.esc(p.name)} (◆${p.score})</option>`).join('')}</select></div>
          <button class="btn primary" id="ckRun" style="justify-content:center">⌕ Launch kernel &amp; run 60-probe audit</button>
          <div class="hint">Left pane is your own browser — it is NOT masked (comparison only). The kernel audit runs all 60 probes inside the real patched profile browser against its expected identity map.</div>
        </div></div>
      <div class="card"><h3>Last result</h3><div id="ckOut" class="dim">not run yet</div></div>
      <div class="card"><h3>Public checkers</h3>
        <div class="hint" style="margin:0 0 8px">Opens the industry detectors as new tabs inside the selected profile's kernel — watch and interact via Live view.</div>
        <table class="tbl"><tbody>
          ${EXT_CHECKERS.map(e => `<tr><td><b>${e[0]}</b><div class="dim" style="font-size:11px">${e[2]}</div></td><td style="text-align:right;white-space:nowrap"><button class="btn sm" data-ext="${App.esc(e[1])}">▶ kernel</button></td></tr>`).join('')}
        </tbody></table></div>
      <div class="card"><h3>What is tested</h3>
        <div class="kv">
          <div class="r"><span class="k">Identity</span><span>UA · platform · vendor · languages · webdriver · CH (low+high entropy)</span></div>
          <div class="r"><span class="k">Time/Geo</span><span>Intl tz vs offset vs region vs proxy country</span></div>
          <div class="r"><span class="k">Graphics</span><span>canvas stability · WebGL vendor/renderer/ext count · WebGL2 presence · WebGPU</span></div>
          <div class="r"><span class="k">Audio</span><span>OfflineAudioContext render hash + determinism</span></div>
          <div class="r"><span class="k">Leaks</span><span>WebRTC ICE candidates · font enum · device list · voices · battery</span></div>
          <div class="r"><span class="k">Stealth</span><span>Function.toString self-hiding · patched surfaces report native</span></div>
        </div></div>
    </div>
  </div>`;
  let ckBusy = false;
  document.getElementById('ckRun').onclick = async () => {
    if (ckBusy) return;
    const pid = val('ckPid'); const out = document.getElementById('ckOut'); const btn = document.getElementById('ckRun');
    ckBusy = true; btn.disabled = true;
    const t0 = Date.now();
    out.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><span class="spin"></span><span>launching kernel + running 60 probes…</span><b class="dim" id="ckEl">0s</b></div>`;
    const tick = setInterval(() => { const e = document.getElementById('ckEl'); if (e) e.textContent = Math.round((Date.now() - t0) / 1000) + 's'; }, 500);
    const ctl = new AbortController(); const killer = setTimeout(() => ctl.abort(), 120000);
    try {
      const r = await api(`/api/checker/run/${pid}`, { method: 'POST', body: {}, signal: ctl.signal });
      const okN = r.checks.filter(c => c.status === 'ok').length;
      const sc = (r.score != null ? r.score : (r.total ? Math.round(okN / (okN + (r.checks.filter(c => c.status === 'no').length || 1)) * 100) : 0));
      out.innerHTML = `
        <div class="issue ${r.leaks ? 'critical' : 'info'}"><b>result</b><span class="${r.leaks ? 'bad-c' : 'ok-c'}" style="font-size:16px;font-weight:800">${r.leaks ? r.leaks + ' leak(s)' : 'CLEAN'}</span> <span class="dim">· score</span> <b style="font-size:16px;font-weight:800;color:${sc >= 90 ? 'var(--ok)' : sc >= 70 ? 'var(--warn)' : 'var(--bad)'}">${sc}%</b> <span class="dim">· ${okN}/${r.total} probes verified</span></div>
        ${r.checks.filter(c => c.status !== 'ww').sort((a, b) => (a.status === 'no' ? -1 : 1) - (b.status === 'no' ? -1 : 1)).map(c => `
          <div class="r" style="display:flex;gap:8px;padding:3.5px 0;border-bottom:1px dashed var(--line);font-size:12px">
            <span style="min-width:14px">${c.status === 'ok' ? '<span class="ok-c">✓</span>' : '<span class="bad-c">✗</span>'}</span>
            <span class="dim" style="min-width:88px">${App.esc(c.group)}</span>
            <span style="flex:1">${App.esc(c.key)}</span>
            <span class="mono dim" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${App.esc(String(c.observed))}">${App.esc(String(c.observed).slice(0, 42))}</span>
          </div>`).join('')}
        <div style="margin-top:9px"><a class="btn sm" href="#/live/${pid}">watch this kernel →</a></div>`;
      document.getElementById('chkFrame').src = '/checker?r=' + Date.now() + (App.state.lang === 'ru' ? '&lang=ru' : '');
    } catch (e) {
      out.innerHTML = `<div class="issue critical"><b>run failed</b><span class="mono" style="font-size:11px">${App.esc(e.name === 'AbortError' ? 'timed out after 120s — kernel may be stuck' : (e.message || String(e)))}</span></div>
        <div class="hint" style="margin-top:6px">Stop stale sessions (Profiles → ■ stop) and retry; details in server journal: <span class="mono">journalctl -u mirage</span>.</div>`;
    } finally { clearInterval(tick); clearTimeout(killer); ckBusy = false; btn.disabled = false; }
  };
  view.querySelectorAll('[data-ext]').forEach(b => b.onclick = () => guard(async () => {
    const pid = val('ckPid'); const url = b.dataset.ext;
    const old = b.textContent; b.disabled = true; b.textContent = 'booting…';
    try {
      const s = await api('/api/browser/start', { method: 'POST', body: { profileId: pid } });
      if (s.status === 'starting' || !s.up) await new Promise(r2 => setTimeout(r2, 2000));
      b.textContent = 'opening…';
      await api('/api/browser/tab', { method: 'POST', body: { action: 'new', profileId: pid, url } });
      const host = url.split('/')[2];
      toast(`${host} opened in kernel — <a href="#/live/${pid}" style="color:inherit;text-decoration:underline">open Live view</a>`, 'ok', { html: true, ms: 7000 });
    } finally { b.disabled = false; b.textContent = old; }
  }));
};
