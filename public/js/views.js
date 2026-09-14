/* ============ Mirage views: dashboard / profiles / proxies / team / activity / api / settings / flows ============ */

/* ===================== DASHBOARD ===================== */
ROUTES.dashboard = (view) => {
  const st = App.state.stats || {};
  const events = App.state.profiles.slice().sort((a, b) => (b.last_open || 0) - (a.last_open || 0)).slice(0, 6);
  view.innerHTML = `
  <div class="grid stats">
    <div class="card stat"><h3>${App.t('nav.profiles') || 'Profiles'}</h3><div class="v">${st.totalProfiles ?? '—'}</div><div class="s">${st.running || 0} running now</div></div>
    <div class="card stat"><h3>Proxies</h3><div class="v">${st.proxies ?? '—'} <em>/ ${st.healthyProxies || 0} ok</em></div><div class="s">healthy after last probe</div></div>
    <div class="card stat"><h3>Identity health</h3><div class="v" id="dashScore">…</div><div class="s">avg consistency score</div></div>
    <div class="card stat"><h3>Activity · 24h</h3><div class="v">${st.todayEvents ?? '—'}</div><div class="s">events logged</div></div>
  </div>
  <div class="split" style="margin-top:16px">
    <div class="card">
      <h3>Quick launch</h3>
      <div id="quickLaunch" class="grid" style="grid-template-columns:1fr;gap:8px"></div>
    </div>
    <div class="card">
      <h3>Recent activity</h3>
      <div id="dashEvents" class="kv"><span class="dim">loading…</span></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <h3>Kernel</h3>
    <div class="kv" id="dashKernel"></div>
  </div>`;
  const avg = App.state.profiles.length ? Math.round(App.state.profiles.reduce((a, p) => a + (p.score || 0), 0) / App.state.profiles.length) : 100;
  const ds = document.getElementById('dashScore');
  ds.innerHTML = `<span class="${avg >= 90 ? 'ok-c' : avg >= 70 ? 'warn-c' : 'bad-c'}">${avg}%</span>`;
  // quick launch list
  const ql = document.getElementById('quickLaunch');
  const recent = events.filter(p => p.last_open);
  const list = recent.concat(App.state.profiles.filter(p => !recent.some(r => r.id === p.id))).slice(0, 6);
  if (!list.length) ql.innerHTML = '<div class="dim">No profiles yet — create one.</div>';
  list.forEach(p => {
    const running = !!sessOf(p.id);
    ql.appendChild(el(`<div class="prow" style="margin:0;padding:7px 0;border-bottom:1px dashed var(--line)">
      <span style="font-size:17px">${osIcon(p.fingerprint || { os: { family: (p.os || '').toLowerCase() } })}</span>
      <div class="grow"><b>${App.esc(p.name)}</b><div class="pmeta">${App.esc(p.os || '')} · ${App.esc(p.browser || '')} · ${App.esc(p.tz || '')}</div></div>
      ${running ? `<span class="running-dot"></span><button class="btn sm" data-act="open" data-id="${p.id}">Open live view</button>` :
      `<button class="btn sm primary" data-act="launch" data-id="${p.id}">▶ Launch</button>`}
      <button class="btn sm ghost" data-act="edit" data-id="${p.id}">Edit</button>
    </div>`));
  });
  ql.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'launch') guard(async () => { toast('Launching kernel…'); await launchProfile(b.dataset.id); go('#/live/' + b.dataset.id); });
    if (b.dataset.act === 'open') go('#/live/' + b.dataset.id);
    if (b.dataset.act === 'edit') go('#/profiles/' + b.dataset.id);
  };
  // events
  api('/api/events?limit=14').then(r => {
    document.getElementById('dashEvents').innerHTML = r.events.length ? r.events.map(ev => {
      const icon = { 'profile.create': '✚', 'profile.delete': '🗑', 'browser.start': '▶', 'browser.stop': '■', 'browser.nav': '⌾', 'proxy.probe': '⇄', 'fingerprint.gen': '⚗', 'checker': '⌕', 'auth': '⚿', 'profile.update': '✎', 'flow.run': '⟿', 'backup': '⛝' }[ev.type.split('.')[0]] || '•';
      return `<div class="r"><span class="k">${icon} ${App.esc(ev.type)}</span><span class="dim">${App.esc(ev.profileId || ev.meta?.host || '')} · ${fmtRel(new Date(ev.ts).toISOString())}</span></div>`;
    }).join('') : '<span class="dim">No events yet.</span>';
  }).catch(() => { });
  // kernel
  const k = App.state.kernel || {};
  document.getElementById('dashKernel').innerHTML = `
    <div class="r"><span class="k">binary</span><span>${App.esc(k.binary || 'NOT FOUND — set path in Settings')}</span></div>
    <div class="r"><span class="k">version</span><span>${App.esc(k.version || '—')}</span></div>
    <div class="r"><span class="k">X display</span><span>${k.xAvailable ? '<span class="ok-c">available</span> — local windows supported' : '<span class="warn-c">none</span> — cloud mode (Xvfb) only'}</span></div>
    <div class="r"><span class="k">Xvfb</span><span>${k.xvfb ? 'installed (cloud mode ready)' : 'missing'}</span></div>
    <div class="r"><span class="k">host</span><span>${App.state.stats.cpu || '?'} CPUs · ${App.state.stats.memMB || '?'} MB</span></div>`;
};

/* ===================== PROFILES ===================== */
let pfilter = { q: '', group: '', tag: '', fav: false, mode: 'grid' };
ROUTES.profiles = (view) => {
  if (App.state.params[0] && App.state.params[0] !== 'new') return ROUTES.profileEditor(view, App.state.params);
  if (App.state.params[0] === 'new') return newProfileWizard(view);
  const groups = App.state.groups;
  view.innerHTML = `
  <div class="toolbar">
    <div class="search grow"><input id="pq" placeholder="search name, tag, country, os…" value="${App.esc(pfilter.q)}"></div>
    <select id="pgroup" style="width:160px"><option value="">All groups</option>${groups.map(g => `<option ${pfilter.group === g.id ? 'selected' : ''} value="${g.id}">${App.esc(g.name)}</option>`).join('')}</select>
    <label class="switch"><input type="checkbox" id="pfav" ${pfilter.fav ? 'checked' : ''}><i></i><span class="mut">Favorites</span></label>
    <div class="seg"><button id="gmGrid" class="${pfilter.mode === 'grid' ? 'on' : ''}">▦</button><button id="gmList" class="${pfilter.mode === 'list' ? 'on' : ''}">☰</button></div>
    <button class="btn primary" id="pNew">+ New profile</button>
  </div>
  <div id="pBulk" class="bulkbar hidden">
    <b id="pBulkN">0</b><span class="mut">selected</span><div class="grow" style="flex:1"></div>
    <button class="btn sm" data-b="favorite">★ Favorite</button>
    <button class="btn sm" data-b="group">Move to group…</button>
    <button class="btn sm" data-b="regenerate">⚗ New identity</button>
    <button class="btn sm danger" data-b="delete">Delete</button>
    <button class="btn sm ghost" data-b="clear">Clear</button>
  </div>
  <div id="pList"></div>`;
  const draw = () => {
    const q = pfilter.q.toLowerCase();
    let list = App.state.profiles.filter(p =>
      (!pfilter.group || p.group_id === pfilter.group) &&
      (!pfilter.fav || p.favorite) &&
      (!q || [p.name, p.os, p.browser, p.country, p.tz, (p.tags || []).join(' ')].join(' ').toLowerCase().includes(q)));
    const box = document.getElementById('pList');
    if (!list.length) { box.innerHTML = `<div class="empty"><div class="big">◪</div>No profiles match.<br><button class="btn primary" style="margin-top:14px" onclick="location.hash='#/profiles/new'">Create first profile</button></div>`; return; }
    if (pfilter.mode === 'grid') {
      box.className = 'grid pgrid'; box.innerHTML = '';
      list.forEach(p => box.appendChild(profileCard(p)));
    } else {
      box.className = ''; box.innerHTML = `<div class="card" style="padding:6px 10px"><table class="tbl"><thead><tr>
        <th style="width:26px"><input type="checkbox" id="ckAll" style="width:auto"></th><th>Name</th><th>Identity</th><th class="hide-sm">Region</th><th>Proxy</th><th>Score</th><th class="hide-sm">Last opened</th><th></th></tr></thead>
        <tbody>${list.map(p => { const s = sessOf(p.id); return `<tr data-id="${p.id}">
          <td><input type="checkbox" class="cks" ${App.state.sel.has(p.id) ? 'checked' : ''} style="width:auto"></td>
          <td><b class="link" data-open="${p.id}" style="cursor:pointer">${App.esc(p.name)}</b>${p.favorite ? ' <span class="warn-c">★</span>' : ''}</td>
          <td class="mono">${App.esc(p.os || '')} · ${App.esc(p.browser || '')}</td>
          <td class="mono hide-sm">${App.esc(p.country || '')} · ${App.esc((p.tz || '').split('/').pop())}</td>
          <td class="mono dim">${App.esc((App.state.proxies.find(x => x.id === p.proxy_id) || {}).label || 'direct')}</td>
          <td><span class="tag score ${scoreCls(p.score)}">${p.score}</span></td>
          <td class="dim hide-sm">${fmtRel(p.last_open ? new Date(p.last_open).toISOString() : null)}</td>
          <td style="text-align:right">${s ? `<button class="btn sm ok" data-live="${p.id}">● Live</button> <button class="btn sm danger" data-stop="${p.id}">■</button>` : `<button class="btn sm primary" data-launch="${p.id}">▶</button>`}
            <button class="btn sm" data-edit="${p.id}">Edit</button></td></tr>`; }).join('')}</tbody></table></div>`;
    }
    syncBulk();
  };
  boxEvents(view, draw);
  document.getElementById('pq').oninput = e => { pfilter.q = e.target.value; draw(); };
  document.getElementById('pgroup').onchange = e => { pfilter.group = e.target.value; draw(); };
  document.getElementById('pfav').onchange = e => { pfilter.fav = e.target.checked; draw(); };
  document.getElementById('gmGrid').onclick = () => { pfilter.mode = 'grid'; draw(); document.getElementById('gmGrid').classList.add('on'); document.getElementById('gmList').classList.remove('on'); };
  document.getElementById('gmList').onclick = () => { pfilter.mode = 'list'; draw(); document.getElementById('gmList').classList.add('on'); document.getElementById('gmGrid').classList.remove('on'); };
  document.getElementById('pNew').onclick = () => go('#/profiles/new');
  draw();
};
function profileCard(p) {
  const s = sessOf(p.id);
  const c = el(`<div class="pcard ${App.state.sel.has(p.id) ? 'sel' : ''}" data-id="${p.id}" style="--pc:${App.esc(p.color || 'var(--grad)')}">
    <div class="accent"></div>
    <div class="pcard-top">
      <input type="checkbox" class="cks" ${App.state.sel.has(p.id) ? 'checked' : ''} style="width:auto">
      <div class="pavatar">${osIcon({ os: { family: (p.os || '').toLowerCase().includes('win') ? 'windows' : (p.os || '').toLowerCase() } })}</div>
      <div class="grow" style="flex:1;min-width:0">
        <div class="pname">${p.favorite ? '<span class="fav">★</span> ' : ''}${App.esc(p.name)}</div>
        <div class="pmeta">${App.esc(p.os || '')} · ${App.esc(p.browser || '')}</div>
      </div>
      ${s ? '<span class="running-dot" title="running"></span>' : ''}
    </div>
    <div class="pbadges">
      <span class="tag score ${scoreCls(p.score)}" title="consistency score">◆ ${p.score}${p.issues ? ' · ' + p.issues + ' crit' : ''}</span>
      <span class="tag">${App.esc(p.country || 'multi')}</span>
      <span class="tag">${App.esc((p.tz || '').split('/').pop() || '—')}</span>
      <span class="tag">${App.esc(p.screen || '')}</span>
      <span class="tag ${p.canvas === 'noise' ? 'os' : ''}">cv:${App.esc(p.canvas || 'off')}</span>
      <span class="tag">px:${App.esc((App.state.proxies.find(x => x.id === p.proxy_id) || {}).label || 'direct')}</span>
      ${(p.tags || []).slice(0, 3).map(t => `<span class="tag">#${App.esc(t)}</span>`).join('')}
    </div>
    <div class="prow">
      ${s ? `<button class="btn ok" data-act="open">◉ Open live</button><button class="btn danger sm" data-act="stop">■</button>` :
      `<button class="btn primary" data-act="launch">▶ Launch</button>`}
      <div class="grow"></div>
      <button class="btn sm ghost" data-act="edit">Edit</button>
      <button class="btn sm ghost" data-act="menu">⋯</button>
    </div>
  </div>`);
  c.querySelector('.cks').onchange = e => { e.stopPropagation(); toggleSel(p.id); };
  c.querySelector('.cks').onclick = e => e.stopPropagation();
  c.onclick = e => { if (e.target.closest('button,.cks')) return; go('#/profiles/' + p.id); };
  c.querySelector('[data-act=menu]').onclick = e => { e.stopPropagation(); profileMenu(p); };
  c.onclick = null;
  c.querySelectorAll('[data-act]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); const a = b.dataset.act;
    if (a === 'launch') guard(async () => { toast('Launching ' + p.name + '…'); await launchProfile(p.id); go('#/live/' + p.id); });
    if (a === 'open') go('#/live/' + p.id);
    if (a === 'stop') guard(async () => { await stopProfile(p.id); toast('Stopped', 'ok'); });
    if (a === 'edit') go('#/profiles/' + p.id);
  });
  return c;
}
function toggleSel(id) { App.state.sel.has(id) ? App.state.sel.delete(id) : App.state.sel.add(id); syncBulk(); document.querySelectorAll(`.pcard[data-id="${id}"]`).forEach(c => c.classList.toggle('sel', App.state.sel.has(id))); }
function syncBulk() {
  const bar = document.getElementById('pBulk'); if (!bar) return;
  const n = App.state.sel.size; bar.classList.toggle('hidden', !n);
  const bn = document.getElementById('pBulkN'); if (bn) bn.textContent = n;
}
function boxEvents(view, draw) {
  view.addEventListener('click', e => {
    const b = e.target.closest('[data-launch],[data-stop],[data-live],[data-edit],[data-open]');
    if (!b) return;
    if (b.dataset.launch) guard(async () => { await launchProfile(b.dataset.launch); go('#/live/' + b.dataset.launch); });
    if (b.dataset.stop) guard(async () => { await stopProfile(b.dataset.stop); });
    if (b.dataset.live) go('#/live/' + b.dataset.live);
    if (b.dataset.edit) go('#/profiles/' + b.dataset.edit);
    if (b.dataset.open) go('#/profiles/' + b.dataset.open);
  });
  view.addEventListener('change', e => { if (e.target.classList.contains('cks')) { toggleSel(e.target.closest('tr')?.dataset.id || e.target.closest('.pcard')?.dataset.id); } if (e.target.id === 'ckAll') { App.state.sel.clear(); if (e.target.checked) document.querySelectorAll('.cks').forEach(c => { const id = c.closest('tr')?.dataset.id || c.closest('.pcard')?.dataset.id; if (id) App.state.sel.add(id); }); draw(); } });
  const bulk = document.getElementById('pBulk');
  if (bulk && !bulk._bound) {
    bulk._bound = true;
    bulk.onclick = e => {
      const b = e.target.closest('[data-b]'); if (!b) return;
      const ids = Array.from(App.state.sel);
      if (b.dataset.b === 'clear') { App.state.sel.clear(); draw(); return; }
      if (b.dataset.b === 'delete') return confirmDlg('Delete profiles', `Delete ${ids.length} profile(s)? Browser data on disk will be erased.`, async () => { await api('/api/profiles/bulk', { method: 'POST', body: { ids, action: 'delete' } }); App.state.sel.clear(); await refreshAll(); draw(); toast('Deleted', 'ok'); });
      if (b.dataset.b === 'favorite') { guard(async () => { await api('/api/profiles/bulk', { method: 'POST', body: { ids, action: 'favorite' } }); await refreshAll(); draw(); }); return; }
      if (b.dataset.b === 'regenerate') return confirmDlg('Regenerate identity', `Generate fresh fingerprints for ${ids.length} profile(s)? Existing cookies stay, identity changes.`, async () => { await api('/api/profiles/bulk', { method: 'POST', body: { ids, action: 'regenerate' } }); await refreshAll(); draw(); toast('Identities regenerated', 'ok'); });
      if (b.dataset.b === 'group') modal({ title: 'Move to group', body: groupPicker(), actions: [{ label: 'Move', kind: 'primary', onClick: async () => { await api('/api/profiles/bulk', { method: 'POST', body: { ids, action: 'group', group_id: val('grpSel') } }); await refreshAll(); draw(); } }] });
    };
  }
}
function groupPicker() {
  const d = document.createElement('div');
  d.innerHTML = `<label>Group</label><select id="grpSel">${App.state.groups.map(g => `<option value="${g.id}">${App.esc(g.name)}</option>`).join('')}<option value="">— no group —</option></select>`;
  return d;
}
function profileMenu(p) {
  const m = modal({ title: p.name, body: `<div class="form">
      <button class="btn" id="mmClone">⧉ Clone profile (new id, same fingerprint)</button>
      <button class="btn" id="mmExport">⤓ Export as JSON</button>
      <button class="btn" id="mmRegen">⚗ Regenerate identity (keep name/group)</button>
      <button class="btn" id="mmOpenDir">🗀 Reveal browser data folder</button>
      <button class="btn danger" id="mmDel" style="margin-top:8px">🗑 Delete profile</button>
    </div>`, actions: [{ label: 'Close' }] });
  m.bodyEl.querySelector('#mmClone').onclick = () => guard(async () => { await api(`/api/profiles/${p.id}/clone`, { method: 'POST', body: {} }); await refreshAll(); rerender(); toast('Cloned', 'ok'); });
  m.bodyEl.querySelector('#mmExport').onclick = () => { location.href = '/api/backup/export?scope=profile&id=' + p.id; };
  m.bodyEl.querySelector('#mmRegen').onclick = () => guard(async () => { await api(`/api/profiles/${p.id}/regenerate`, { method: 'POST', body: {} }); await refreshAll(); m.close(); rerender(); toast('New identity generated', 'ok'); });
  m.bodyEl.querySelector('#mmDel').onclick = () => confirmDlg('Delete', `Delete "${p.name}" and all its browsing data?`, async () => { await api('/api/profiles/' + p.id, { method: 'DELETE' }); await refreshAll(); m.close(); rerender(); });
  m.bodyEl.querySelector('#mmOpenDir').onclick = () => { m.close(); modal({ title: 'Browser data folder', body: `<p class="mut">Persistent kernel profile dir on the server (cookies, storage live here):</p><pre class="code">data/browsers/${p.id}/</pre>` }); };
}

/* ---------- new profile wizard ---------- */
function newProfileWizard(view) {
  document.getElementById('crumbs').innerHTML = `<span class="link" style="cursor:pointer;color:var(--mut)" onclick="go('#/profiles')">Profiles</span> <span>/</span> New profile`;
  view.innerHTML = `
  <div style="max-width:660px;margin:20px auto">
    <div class="card">
      <h3>Create profile</h3>
      <div class="form">
        <div class="row2">
          <div><label>Profile name</label><input id="wName" placeholder="e.g. FB Ads #1"></div>
          <div><label>Group</label><select id="wGroup"><option value="">None</option>${App.state.groups.map(g => `<option value="${g.id}">${App.esc(g.name)}</option>`).join('')}</select></div>
        </div>
        <label style="margin-top:8px">Pick a base template</label>
        <div class="grid" id="wTmpl" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"></div>
        <div class="row3" style="margin-top:6px">
          <div><label>OS</label><select id="wOs"></select></div>
          <div><label>Browser</label><select id="wBr"></select></div>
          <div><label>Country</label><select id="wCountry"><option value="">random</option></select></div>
        </div>
        <div><label>Proxy (optional)</label><select id="wProxy"><option value="">direct</option>${App.state.proxies.map(px => `<option value="${px.id}">${App.esc(px.label || (px.host + ':' + px.port))}</option>`).join('')}</select></div>
        <div><label>Seed (same seed = same identity)</label><div style="display:flex;gap:8px"><input id="wSeed" placeholder="auto" style="font-family:var(--mono)"><button class="btn sm" id="wDice">⚄ random</button></div></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
          <button class="btn ghost" onclick="go('#/profiles')">Cancel</button>
          <button class="btn primary" id="wCreate">Create profile</button>
        </div>
      </div>
    </div>
  </div>`;
  const OS_OPTS = [['windows-11', 'Windows 11'], ['windows-10', 'Windows 10'], ['windows-7', 'Windows 7 (legacy)'], ['macos-sequoia', 'macOS Sequoia'], ['macos-sonoma', 'macOS Sonoma'], ['macos-ventura', 'macOS Ventura'], ['ubuntu-2404', 'Ubuntu 24.04'], ['debian-12', 'Debian 12'], ['android-14', 'Android 14'], ['android-13', 'Android 13'], ['ios-17', 'iOS 17'], ['ios-16', 'iOS 16']];
  const BR_OPTS = [['chrome', 'Chrome'], ['edge', 'Edge'], ['firefox', 'Firefox'], ['safari', 'Safari']];
  document.getElementById('wOs').innerHTML = OS_OPTS.map(o => `<option value="${o[0]}">${o[1]}</option>`).join('');
  document.getElementById('wBr').innerHTML = BR_OPTS.map(o => `<option value="${o[0]}">${o[1]}</option>`).join('');
  fetch('/api/fingerprint/templates').then(r => r.json()).then(r => {
    document.getElementById('wTmpl').innerHTML = (r.templates || []).map(t => `<button class="btn sm" data-t="${t.id}" style="justify-content:flex-start">${App.esc(t.label)}</button>`).join('');
    document.getElementById('wTmpl').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; const t = r.templates.find(x => x.id === b.dataset.t); document.getElementById('wOs').value = t.os; document.getElementById('wBr').value = t.browser; document.querySelectorAll('#wTmpl [data-t]').forEach(x => x.classList.toggle('ok', x === b)); };
  });
  const guessCountry = ((navigator.language || '').split('-')[1] || '').toUpperCase();
  {
    const sel = document.getElementById('wCountry');
    const countries = ['US', 'DE', 'GB', 'FR', 'NL', 'ES', 'IT', 'PL', 'BR', 'CA', 'AU', 'JP', 'KR', 'IN', 'UA', 'SE', 'NO', 'FI', 'PT', 'MX', 'AR', 'SG', 'AE', 'TR', 'RO', 'CZ', 'RU'];
    sel.innerHTML = `<option value="">random</option>` + countries.map(c => `<option value="${c}" ${c === guessCountry ? 'selected' : ''}>${c}${c === guessCountry ? ' ← your locale' : ''}</option>`).join('');
  }
  document.getElementById('wDice').onclick = () => { document.getElementById('wSeed').value = Math.random().toString(36).slice(2, 10); };
  document.getElementById('wCreate').onclick = () => guard(async () => {
    const b = await api('/api/fingerprint/generate', { method: 'POST', body: { os: val('wOs'), browser: val('wBr'), country: val('wCountry'), seed: val('wSeed') || undefined } });
    const r = await api('/api/profiles', { method: 'POST', body: { name: val('wName') || 'New Profile', group_id: val('wGroup'), proxy_id: val('wProxy'), fingerprint: b.fingerprint, seed: val('wSeed') || undefined } });
    App.state.sel.clear();
    await refreshAll();
    toast('Profile created', 'ok');
    go('#/profiles/' + r.profile.id);
  });
}

/* ===================== PROXIES ===================== */
ROUTES.proxies = (view) => {
  view.innerHTML = `
  <div class="toolbar">
    <div class="search grow"><input id="xq" placeholder="search host, label, city…"></div>
    <button class="btn" id="xProbeAll">⇅ Probe all</button>
    <button class="btn ghost" id="xImport">⤒ Bulk import</button>
    <button class="btn primary" id="xAdd">+ Add proxy</button>
  </div>
  <div class="card" style="padding:6px 10px"><table class="tbl"><thead><tr>
    <th>Label</th><th>Endpoint</th><th class="hide-sm">Scheme</th><th class="hide-sm">Geo (last probe)</th><th>Exit IP</th><th class="hide-sm">Latency</th><th>Used by</th><th></th></tr></thead><tbody id="xRows"></tbody></table></div>
  <div class="hint" style="margin-top:10px">Mirage routes the kernel through a local relay that adds Proxy-Authorization — HTTP(S) and SOCKS5 with auth all work. TLS/JA3 fingerprints belong to the real kernel and are shared per-binary (see docs).</div>`;
  const draw = () => {
    const q = (val('xq') || '').toLowerCase();
    const rows = App.state.proxies.filter(px => !q || [px.label, px.host, px.city, px.country].join(' ').toLowerCase().includes(q));
    document.getElementById('xRows').innerHTML = rows.length ? rows.map(px => {
      const chk = safeParse(px.last_check);
      const used = App.state.profiles.filter(p => p.proxy_id === px.id).length;
      return `<tr data-id="${px.id}">
        <td><b>${App.esc(px.label || '—')}</b>${px.rotator ? ' <span class="tag">rotator</span>' : ''}</td>
        <td class="mono">${App.esc(px.host)}:${px.port}${px.user ? ` <span class="dim">/ ${App.esc(px.user)}</span>` : ''}</td>
        <td><span class="tag">${App.esc(px.scheme)}</span></td>
        <td class="hide-sm">${chk?.ok ? App.esc([chk.geo?.country, chk.geo?.city].filter(Boolean).join(', ') || '—') : '<span class="dim">not probed</span>'} ${chk?.ok && chk.geo ? `<div class="dim mono" style="font-size:10.5px">${App.esc(chk.geo.isp || '')} ${chk.geo.hosting ? '· <span class="warn-c">hosting</span>' : ''}</div>` : ''}</td>
        <td class="mono">${chk?.ok ? App.esc(chk.exitIp) : chk && !chk.ok ? `<span class="bad-c" title="${App.esc(chk.error || '')}">fail</span>` : '—'}</td>
        <td class="mono hide-sm">${chk?.ok ? chk.latencyMs + 'ms' : '—'}</td>
        <td>${used ? `<span class="tag">${used} profile(s)</span>` : '<span class="dim">—</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn sm" data-act="probe">⇅ Test</button>
          <button class="btn sm ghost" data-act="edit">✎</button>
          <button class="btn sm ghost" data-act="del">🗑</button></td></tr>`;
    }).join('') : `<tr><td colspan="8"><div class="empty">No proxies. Add one or bulk-import.</div></td></tr>`;
  };
  document.getElementById('xq').oninput = draw;
  document.getElementById('xRows').onclick = e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return; const px = App.state.proxies.find(x => x.id === tr.dataset.id); if (!px) return;
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'probe') { tr.querySelectorAll('td')[5].innerHTML = '<span class="spin"></span>'; guard(async () => { const r = await api(`/api/proxies/${px.id}/probe`, { method: 'POST', body: {} }); await refreshAll(); draw(); r.ok ? toast(`${px.host}: exit ${r.exitIp} (${r.latencyMs}ms)`, 'ok') : toast('probe failed: ' + r.error, 'err'); }); }
    if (b.dataset.act === 'edit') proxyForm(px);
    if (b.dataset.act === 'del') confirmDlg('Delete proxy', `Remove ${px.host}:${px.port}?`, async () => { await api('/api/proxies/' + px.id, { method: 'DELETE' }); await refreshAll(); draw(); });
  };
  document.getElementById('xAdd').onclick = () => proxyForm(null, draw);
  document.getElementById('xImport').onclick = () => importProxies(draw);
  document.getElementById('xProbeAll').onclick = () => guard(async () => {
    toast('Probing all proxies…');
    for (const px of App.state.proxies) { try { await api(`/api/proxies/${px.id}/probe`, { method: 'POST', body: {} }); } catch (e) { } }
    await refreshAll(); draw(); toast('Probes complete', 'ok');
  });
  draw();
};
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function proxyForm(px = null, onDone) {
  const isNew = !px;
  modal({ title: isNew ? 'Add proxy' : 'Edit proxy', wide: false, body: `
    <div class="form">
      <div class="row2">
        <div><label>Scheme</label><select id="pxScheme">${['http', 'https', 'socks5'].map(s => `<option ${(px?.scheme || 'http') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div><label>Label</label><input id="pxLabel" value="${App.esc(px?.label || '')}" placeholder="ISP / Stockholm"></div>
      </div>
      <div class="row2">
        <div><label>Host</label><input id="pxHost" value="${App.esc(px?.host || '')}" placeholder="1.2.3.4 or gate.example.com"></div>
        <div><label>Port</label><input id="pxPort" value="${px?.port || ''}" placeholder="8080"></div>
      </div>
      <div class="row2">
        <div><label>User</label><input id="pxUser" value="${App.esc(px?.user || '')}"></div>
        <div><label>Password</label><input id="pxPass" type="text" value="${App.esc(px?.pass || '')}"></div>
      </div>
      <div class="row2">
        <div><label>Country</label><input id="pxCountry" value="${App.esc(px?.country || '')}" placeholder="US"></div>
        <div><label>City</label><input id="pxCity" value="${App.esc(px?.city || '')}" placeholder="New York"></div>
      </div>
      <label class="switch"><input type="checkbox" id="pxRot" ${px?.rotator ? 'checked' : ''}><i></i><span class="mut">Rotator endpoint (one IP per session)</span></label>
      <div id="pxTestOut"></div>
    </div>`, actions: [
      { label: 'Test first', onClick: ({ bodyEl }) => { const o = bodyEl.querySelector('#pxTestOut'); o.innerHTML = '<span class="spin"></span> probing…'; guard(async () => { const r = await api('/api/proxies/test', { method: 'POST', body: proxyBody(bodyEl) }); o.innerHTML = r.ok ? `<div class="issue info">✓ ${r.latencyMs}ms · exit <b>${App.esc(r.exitIp)}</b> · ${App.esc(r.geo?.country || '?')} ${App.esc(r.geo?.city || '')} · ${App.esc(r.geo?.isp || '')} ${r.geo?.hosting ? '(<span class="warn-c">datacenter</span>)' : '(residential?)'} · proxy=${r.geo?.proxy ? 'yes' : 'no'}</div>` : `<div class="issue critical">✗ ${App.esc(r.error || 'unreachable')}</div>`; }); return true; } },
      { label: isNew ? 'Add proxy' : 'Save', kind: 'primary', onClick: async ({ bodyEl }) => { const b = proxyBody(bodyEl); if (!b.host || !b.port) throw new Error('host + port required'); await api(isNew ? '/api/proxies' : '/api/proxies/' + px.id, { method: isNew ? 'POST' : 'PUT', body: b }); await refreshAll(); onDone?.(); toast(isNew ? 'Proxy added' : 'Saved', 'ok'); } },
    ] });
}
function proxyBody(root) {
  return { label: root.querySelector('#pxLabel').value, scheme: root.querySelector('#pxScheme').value, host: root.querySelector('#pxHost').value.trim(), port: +root.querySelector('#pxPort').value, user: root.querySelector('#pxUser').value, pass: root.querySelector('#pxPass').value, country: root.querySelector('#pxCountry').value, city: root.querySelector('#pxCity').value, rotator: root.querySelector('#pxRot').checked ? 1 : 0 };
}
function importProxies(onDone) {
  modal({ title: 'Bulk import proxies', body: `<label>One per line — <span class="mono">host:port</span>, <span class="mono">user:pass@host:port</span> or <span class="mono">socks5://user:pass@host:port</span></label>
    <textarea id="impText" rows="10" placeholder="185.10.23.5:8080&#10;login:secret@gate.proxysite.com:7000&#10;socks5://user:pass@1.2.3.4:1080"></textarea>
    <label class="switch" style="margin-top:10px"><input type="checkbox" id="impRot"><i></i><span class="mut">mark as rotators</span></label>`, actions: [{ label: 'Import', kind: 'primary', onClick: async ({ bodyEl }) => { const r = await api('/api/proxies/import', { method: 'POST', body: { text: bodyEl.querySelector('#impText').value, rotator: bodyEl.querySelector('#impRot').checked } }); await refreshAll(); onDone?.(); toast(`Imported ${r.created} proxies`, 'ok'); } }] });
}

/* ===================== TEAM ===================== */
ROUTES.team = async (view) => {
  let members = []; try { members = (await api('/api/members')).members; } catch (e) { view.innerHTML = `<div class="empty">Admin only: ${App.esc(e.message)}</div>`; return; }
  view.innerHTML = `
  <div class="toolbar"><div class="grow"></div><button class="btn primary" id="mAdd">+ Add member</button></div>
  <div class="card" style="padding:6px 10px"><table class="tbl"><thead><tr><th>Member</th><th>Role</th><th>Profiles owned</th><th>Actions</th></tr></thead>
  <tbody>${members.map(m => `<tr data-id="${m.id}"><td><div style="display:flex;gap:9px;align-items:center"><span class="pavatar" style="width:30px;height:30px;border-radius:9px;color:${App.esc(m.color || '#22d3ee')}">${App.esc((m.name || '?')[0])}</span><div><b>${App.esc(m.name)}</b><div class="dim">${App.esc(m.email || '')}</div></div></div></td>
    <td><span class="tag ${m.role === 'admin' ? 'os' : ''}">${App.esc(m.role)}</span></td>
    <td>${App.state.profiles.filter(p => p.owner === m.id).length}</td>
    <td style="text-align:right"><button class="btn sm ghost" data-m="edit">✎</button> ${m.id !== 'me' ? '<button class="btn sm ghost" data-m="del">🗑</button>' : ''}</td></tr>`).join('')}</tbody></table></div>
  <div class="hint" style="margin-top:12px">Roles: <b>admin</b> — full control incl. settings/team · <b>member</b> — manage profiles & proxies · <b>viewer</b> — read-only, cannot launch kernels via UI*</div>`;
  document.getElementById('mAdd').onclick = () => memberForm(null);
  view.querySelector('tbody').onclick = e => {
    const tr = e.target.closest('tr'); const m = members.find(x => x.id === tr?.dataset.id); const b = e.target.closest('[data-m]'); if (!m || !b) return;
    if (b.dataset.m === 'edit') memberForm(m);
    if (b.dataset.m === 'del') confirmDlg('Remove member', `Remove ${m.name}?`, async () => { await api('/api/members/' + m.id, { method: 'DELETE' }); rerender(); });
  };
};
function memberForm(m) {
  const isNew = !m;
  modal({ title: isNew ? 'Add member' : 'Edit member', body: `<div class="form">
    <div><label>Name</label><input id="mbName" value="${App.esc(m?.name || '')}"></div>
    <div><label>Email (optional)</label><input id="mbEmail" value="${App.esc(m?.email || '')}"></div>
    <div class="row2"><div><label>Role</label><select id="mbRole">${['admin', 'member', 'viewer'].map(r => `<option ${m?.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
    <div><label>${isNew ? 'PIN (word or digits)' : 'New PIN (blank = keep)'}</label><input id="mbPin" placeholder="${isNew ? 'e.g. mirage' : 'unchanged'}"></div></div>
    <div><label>Color</label><input id="mbColor" type="color" value="${App.esc(m?.color || '#22d3ee')}" style="height:38px;padding:3px"></div>
  </div>`, actions: [{ label: 'Save', kind: 'primary', onClick: async () => {
      const body = { id: m?.id, name: val('mbName'), email: val('mbEmail'), role: val('mbRole'), color: val('mbColor') };
      if (val('mbPin')) body.pin = val('mbPin');
      await api(isNew ? '/api/members' : '/api/members/' + m.id, { method: isNew ? 'POST' : 'PUT', body });
      rerender(); toast('Saved', 'ok');
    } }] });
}

/* ===================== ACTIVITY ===================== */
ROUTES.activity = async (view) => {
  view.innerHTML = `
  <div class="toolbar">
    <div class="seg"><button class="on" data-t="events">Event log</button><button data-t="history">Browsing history</button><button data-t="audit">Audit trail (team)</button></div>
    <div class="grow"></div><button class="btn sm ghost" id="aRefresh">↻ refresh</button>
  </div><div id="aBody"></div>`;
  let mode = 'events';
  const draw = async () => {
    const box = document.getElementById('aBody'); box.innerHTML = '<span class="spin"></span>';
    if (mode === 'events') {
      const { events } = await api('/api/events?limit=300');
      box.innerHTML = `<div class="card" style="padding:6px 10px"><table class="tbl"><thead><tr><th>Time</th><th>Type</th><th class="hide-sm">Profile</th><th class="hide-sm">Details</th></tr></thead><tbody>
        ${events.map(ev => `<tr><td class="mono dim">${new Date(ev.ts).toLocaleString()}</td><td><span class="tag">${App.esc(ev.type)}</span></td><td class="mono hide-sm">${App.esc(ev.profileId || '')}</td><td class="mono dim hide-sm">${App.esc(JSON.stringify(ev.meta || {})).slice(0, 140)}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (mode === 'audit') {
      const { rows } = await api('/api/audit?limit=300');
      box.innerHTML = `<div class="card" style="padding:6px 10px"><table class="tbl"><thead><tr><th>Time</th><th>Actor</th><th class="hide-sm">Action</th><th>Profile</th><th class="hide-sm">Exit IP</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td class="mono dim">${new Date(r.ts).toLocaleString()}</td><td class="mono">${App.esc(r.actor)}</td><td class="hide-sm"><span class="tag">${App.esc(r.type)}</span></td><td class="mono">${App.esc(r.profileName || r.profileId || '')}</td><td class="mono dim hide-sm">${App.esc(r.exitIp || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">No audit entries yet.</td></tr>'}</tbody></table>
        <div class="hint">Records who launched/stopped/rotated/imported each profile and, when a proxy is attached, the exit IP the kernel used — the team accountability trail.</div></div>`;
    } else {
      const { history } = await api('/api/history?limit=300');
      box.innerHTML = `<div class="card" style="padding:6px 10px"><table class="tbl"><thead><tr><th>Time</th><th>Profile</th><th>URL</th><th class="hide-sm">Title</th></tr></thead><tbody>
        ${history.map(h => `<tr><td class="mono dim">${new Date(h.ts).toLocaleString()}</td><td class="mono">${App.esc((profileOf(h.profile_id) || {}).name || h.profile_id || '')}</td><td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${App.esc(h.url)}</td><td class="hide-sm">${App.esc(h.title || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">Nothing yet — visit sites in a launched profile.</td></tr>'}</tbody></table></div>`;
    }
  };
  view.querySelector('.seg').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; mode = b.dataset.t; view.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
  document.getElementById('aRefresh').onclick = draw;
  draw();
};

/* ===================== AUTOMATION API ===================== */
ROUTES.automation = async (view) => {
  let keys = []; try { keys = (await api('/api/apikeys')).keys; } catch (e) { }
  const origin = location.origin;
  view.innerHTML = `
  <div class="split" style="grid-template-columns:1fr 340px">
    <div class="card doc">
      <h3>Automation API — drive kernels from your scripts</h3>
      <p>Mirage speaks the <b>AdsPower-compatible</b> startup protocol, so existing Selenium / Puppeteer / Playwright / Puppeteer-extra stealth integrations work with a single base-URL change.</p>
      <h2>1 · Start a browser</h2>
      <pre class="code"><span class="cm"># returns a CDP ws endpoint you can connect to</span>
curl -X POST <span class="st">${origin}/api/v1/browser/start</span> \\
  -H <span class="st">"X-Api-Key: mgk_…"</span> -H <span class="st">"Content-Type: application/json"</span> \\
  -d <span class="st">'{"user_id":"&lt;profile id&gt;"}'</span>

<span class="k">→</span> { "code":0, "data": { "ws": { "puppeteer": "ws://…/devtools/browser/…" },
     "debug_port": "9333", "driver": "/api/v1/wdm/&lt;id&gt;/chromedriver" } }</span></pre>
      <h2>2 · Attach with Playwright</h2>
      <pre class="code">import playwright from 'playwright-core';
const browser = await playwright.chromium.connectOverCDP(
  data.start_session_status === 'success' ? data.ws.puppeteer : url);
const ctx = browser.contexts()[0];       <span class="cm">// the profile: real persistent cookies!</span>
const page = ctx.pages()[0] ?? await ctx.newPage();</pre>
      <h2>3 · Endpoints</h2>
      <table class="tbl"><tbody>
      <tr><td class="mono">POST /api/v1/browser/start</td><td>launch profile kernel → ws url</td></tr>
      <tr><td class="mono">POST /api/v1/browser/stop</td><td>graceful shutdown + snapshot save</td></tr>
      <tr><td class="mono">GET&nbsp; /api/v1/browser/status</td><td>running states for all profiles</td></tr>
      <tr><td class="mono">GET&nbsp; /api/v1/user/list</td><td>profiles (user_id ↔ profile)</td></tr>
      <tr><td class="mono">GET&nbsp; /api/v1/group/list</td><td>groups</td></tr>
      <tr><td class="mono">POST /api/browser/eval</td><td>run JS in the live page (CDP Runtime)</td></tr>
      <tr><td class="mono">POST /api/checker/run/:id</td><td>full stealth audit of a live session</td></tr>
      </tbody></table>
      <h2>4 · Inside-page API</h2>
      <p>Every injected kernel exposes <span class="kbd">window.__MIRAGE</span> — <span class="kbd">{fp, expected, salt, errors}</span> — so your automation can read the active identity and verify patches self-reported correctly.</p>
      <h2>5 · Limits & honesty</h2>
      <p>JS-level spoofing covers canvas/WebGL/audio/fonts/WebRTC/navigator/geolocation/timezone/headers. TLS handshake (JA3/JA4) and HTTP/2 SETTINGS frames come from the kernel binary itself — matching them requires proxy-side TLS masking (roadmap), and we label rather than fake these fields.</p>
    </div>
    <div>
      <div class="card">
        <h3>API keys</h3>
        <div id="kList">${keys.map(k => `<div class="r" style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px dashed var(--line)"><span class="mono" title="${App.esc(k.key)}">${App.esc((k.key || '').slice(0, 15))}…</span><span class="dim" style="margin-left:auto">${App.esc(k.label || '')}</span><button class="iconbtn" data-rev="${App.esc(k.key)}">✕</button></div>`).join('') || '<span class="dim">none yet</span>'}</div>
        <div style="margin-top:12px;display:flex;gap:8px"><input id="kLabel" placeholder="label (CI, bot…)"><button class="btn primary sm" id="kNew">+ create</button></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>Try it</h3>
        <div class="form"><label>profile</label><select id="apiPid">${App.state.profiles.map(p => `<option value="${p.id}">${App.esc(p.name)}</option>`).join('')}</select>
        <button class="btn" id="apiStart">POST /browser/start</button>
        <button class="btn" id="apiStop">POST /browser/stop</button></div>
        <pre class="code" id="apiOut" style="margin-top:10px;max-height:230px"></pre>
      </div>
    </div>
  </div>`;
  document.getElementById('kNew').onclick = () => guard(async () => {
    const k = await api('/api/apikeys', { method: 'POST', body: { label: val('kLabel') || 'key' } });
    modal({ title: 'New API key', body: `<p class="mut">Copy it now — only the prefix is stored server-side:</p><pre class="code">${App.esc(k.key)}</pre>`, actions: [{ label: 'Copied — close', kind: 'primary', onClick: () => rerender() }] });
  });
  view.querySelectorAll('[data-rev]').forEach(b => b.onclick = () => guard(async () => { await api('/api/apikeys/' + encodeURIComponent(b.dataset.rev), { method: 'DELETE' }); rerender(); }));
  document.getElementById('apiStart').onclick = () => guard(async () => { const out = document.getElementById('apiOut'); out.textContent = '…'; const body = { profileId: val('apiPid') }; const r = await api('/api/browser/start', { method: 'POST', body }); out.textContent = JSON.stringify(r, null, 2); });
  document.getElementById('apiStop').onclick = () => guard(async () => { const r = await api('/api/browser/stop', { method: 'POST', body: { profileId: val('apiPid') } }); document.getElementById('apiOut').textContent = JSON.stringify(r, null, 2); });
};

/* ===================== SETTINGS ===================== */
ROUTES.settings = (view) => {
  const s = App.state.settings || {};
  view.innerHTML = `
  <div class="split" style="grid-template-columns:1fr 1fr;align-items:start">
    <div style="display:grid;gap:14px">
      <div class="card"><h3>Kernel</h3>
        <div class="form">
          <div><label>Chromium binary</label><input id="sPath" value="${App.esc(s.chromiumPath || '')}" placeholder="/usr/bin/chromium (auto-detect if blank)"></div>
          <label class="switch"><input type="checkbox" id="sXvfb" ${s.forceXvfb ? 'checked' : ''}><i></i><span class="mut">Force cloud mode (Xvfb, no visible window)</span></label>
          <div class="row2"><div><label>X display override</label><input id="sDisp" value="${App.esc(s.xdisplay || '')}" placeholder="auto (:0)"></div>
          <div><label>Default homepage</label><input id="sHome" value="${App.esc(s.homepage || '')}" placeholder="about:blank"></div></div>
        </div>
      </div>
      <div class="card"><h3>Live view</h3>
        <div class="form">
          <div class="row2"><div><label>Max concurrent kernels</label><input id="sMax" type="number" value="${s.maxSessions ?? 3}"></div>
          <div><label>Screencast FPS (1–12)</label><input id="sFps" type="number" value="${s.liveFps ?? 6}"></div></div>
          <div><label>JPEG quality (20–95)</label><input id="sQ" type="number" value="${s.shotQuality ?? 55}"></div>
          <label class="switch"><input type="checkbox" id="sSnap" ${s.autoSaveSnapshot !== false ? 'checked' : ''}><i></i><span class="mut">Auto-save cookies/storage snapshot on stop</span></label>
        </div>
      </div>
    </div>
    <div style="display:grid;gap:14px">
      <div class="card"><h3>Backup & data</h3>
        <div class="form">
          <button class="btn" id="sExport">⤓ Export all (profiles + groups + proxies)</button>
          <button class="btn" id="sImport">⤒ Import from JSON file</button>
          <input type="file" id="sFile" accept=".json" class="hidden">
        </div>
      </div>
      <div class="card"><h3>Danger zone</h3>
        <button class="btn danger" id="sWipe">🗑 Stop all kernels & delete ALL data</button>
        <div class="hint">Removes profiles, proxies, history, snapshots and kernel user-data dirs. API keys kept.</div>
      </div>
      <div class="card"><h3>About</h3>
        <div class="kv">
          <div class="r"><span class="k">Control plane</span><span>Mirage v0.9 · zero-dep Node + SQLite</span></div>
          <div class="r"><span class="k">Transport</span><span>CDP over WebSocket · relay proxy (HTTP/SOCKS5)</span></div>
          <div class="r"><span class="k">Honesty note</span><span>TLS/JA3 & HTTP/2 come from the kernel binary — labeled, not faked</span></div>
        </div>
      </div>
    </div>
  </div>
  <div style="margin-top:16px"><button class="btn primary" id="sSave">Save settings</button></div>`;
  document.getElementById('sSave').onclick = () => guard(async () => {
    await api('/api/settings', { method: 'PUT', body: {
      chromiumPath: val('sPath'), forceXvfb: val('sXvfb'), xdisplay: val('sDisp'), homepage: val('sHome'),
      maxSessions: +val('sMax') || 3, liveFps: +val('sFps') || 6, shotQuality: +val('sQ') || 55, autoSaveSnapshot: val('sSnap'),
    } });
    await refreshAll(); toast('Settings saved', 'ok');
  });
  document.getElementById('sExport').onclick = () => location.href = '/api/backup/export';
  document.getElementById('sImport').onclick = () => document.getElementById('sFile').click();
  document.getElementById('sFile').onchange = e => guard(async () => {
    const f = e.target.files[0]; if (!f) return;
    const text = await f.text();
    const r = await api('/api/backup/import', { method: 'POST', body: JSON.parse(text) });
    await refreshAll(); toast(`Imported: ${r.profiles || 0} profiles, ${r.proxies || 0} proxies`, 'ok');
  });
  document.getElementById('sWipe').onclick = () => confirmDlg('Delete everything', 'This wipes all profiles, proxies, history and on-disk browser data. Continue?', async () => {
    for (const s of App.state.sessions) { try { await stopProfile(s.profileId); } catch (e) { } }
    for (const p of App.state.profiles) { try { await api('/api/profiles/' + p.id, { method: 'DELETE' }); } catch (e) { } }
    await refreshAll(); go('#/dashboard'); toast('Wiped', 'ok');
  }, 'Wipe it all');
};

/* ===================== FLOWS ===================== */
ROUTES.flows = async (view) => {
  let flows = []; try { flows = (await api('/api/flows')).flows; } catch (e) { }
  view.innerHTML = `
  <div class="toolbar"><div class="grow"></div><button class="btn primary" id="fNew">+ New flow</button></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
  ${flows.map(f => { let steps = f.steps; try { steps = JSON.parse(steps); } catch (e) { steps = steps || []; }
    return `<div class="card"><h3 style="text-transform:none;font-size:14px;color:var(--txt);font-weight:650">${App.esc(f.name)}</h3>
      <div class="dim mono" style="margin-bottom:10px">${steps.length} steps · profile: ${App.esc((profileOf(f.profile_id) || {}).name || f.profile_id || '—')}</div>
      <div class="prow"><button class="btn sm primary" data-run="${f.id}">▶ Run</button><button class="btn sm" data-edit="${f.id}">✎ Edit</button><button class="btn sm ghost" data-del="${f.id}">🗑</button></div></div>`; }).join('') || '<div class="empty">No flows. Automate a human-like sequence: goto → wait → click → type → move → scroll → eval → screenshot. Steps run with curved pointer paths and realistic keystroke cadence.</div>'}
  </div>
  <div id="fOut" class="card hidden" style="margin-top:14px"><h3>Run results</h3><pre class="code" id="fOutCode"></pre></div>`;
  document.getElementById('fNew').onclick = () => flowEditor(null);
  view.onclick = e => {
    const b = e.target.closest('[data-run],[data-edit],[data-del]'); if (!b) return;
    const f = flows.find(x => x.id === (b.dataset.run || b.dataset.edit || b.dataset.del)); if (!f) return;
    if (b.dataset.run) guard(async () => {
      const out = document.getElementById('fOut'), code = document.getElementById('fOutCode');
      out.classList.remove('hidden'); code.textContent = 'running…';
      const r = await api(`/api/flows/${f.id}/run`, { method: 'POST', body: {} });
      code.textContent = JSON.stringify(r.results, null, 2);
    });
    if (b.dataset.edit) flowEditor(f);
    if (b.dataset.del) confirmDlg('Delete flow', f.name, async () => { await api('/api/flows/' + f.id, { method: 'DELETE' }); rerender(); });
  };
};
function flowEditor(f) {
  let steps = f?.steps || [];
  if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch (e) { steps = []; } }
  const body = document.createElement('div');
  const render = () => {
    body.innerHTML = `<div class="form"><div class="row2"><div><label>Name</label><input id="flName" value="${App.esc(f?.name || '')}"></div>
      <div><label>Target profile</label><select id="flPid">${App.state.profiles.map(p => `<option value="${p.id}" ${f?.profile_id === p.id ? 'selected' : ''}>${App.esc(p.name)}</option>`).join('')}</select></div></div>
      <label>Steps</label>
      <div id="flSteps" style="display:grid;gap:8px">${steps.map((s, i) => stepRow(s, i)).join('')}</div>
      <div><button class="btn sm" id="flAdd">+ step</button></div></div>`;
    body.querySelector('#flAdd').onclick = () => { steps.push({ action: 'goto', value: 'https://example.com' }); render(); };
    body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { steps.splice(+b.dataset.rm, 1); render(); });
    body.querySelectorAll('[data-k]').forEach(inp => inp.oninput = () => { steps[+inp.dataset.i][inp.dataset.k] = inp.type === 'number' ? +inp.value : inp.value; });
    body.querySelectorAll('[data-hk]').forEach(cb => cb.onchange = () => { steps[+cb.dataset.i].human = cb.checked; });
    body.querySelectorAll('select[data-k=action]').forEach(sel => sel.onchange = () => { steps[+sel.dataset.i].action = sel.value; render(); });
  };
  render();
  modal({ title: f ? 'Edit flow' : 'New flow', body, wide: true, actions: [{ label: 'Save', kind: 'primary', onClick: async () => { steps.forEach((s, i) => { s._i = i; }); await api('/api/flows', { method: 'POST', body: { id: f?.id, name: body.querySelector('#flName').value || 'Flow', profile_id: body.querySelector('#flPid').value, steps } }); rerender(); toast('Flow saved', 'ok'); } }] });
}
function stepRow(s, i) {
  const A = ['goto', 'wait', 'eval', 'screenshot', 'click', 'type', 'move', 'scroll'];
  const hum = s.human !== false;
  const humanBox = ['click', 'type'].includes(s.action) ? `<label class="mut" style="font-size:11.5px;display:flex;align-items:center;gap:4px;white-space:nowrap"><input type="checkbox" data-hk="human" data-i="${i}" ${hum ? 'checked' : ''}>⚡ human</label>` : '';
  return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <span class="mono dim">${i + 1}</span>
    <select data-k="action" data-i="${i}" style="width:130px">${A.map(a => `<option ${s.action === a ? 'selected' : ''}>${a}</option>`).join('')}</select>
    ${['goto', 'eval', 'type'].includes(s.action) ? `<input data-k="value" data-i="${i}" value="${App.esc(s.value || '')}" placeholder="${s.action === 'goto' ? 'https://…' : s.action === 'eval' ? 'JS expression' : 'text to type'}">` : ''}
    ${s.action === 'wait' ? `<input type="number" data-k="value" data-i="${i}" value="${s.value || 2}" style="width:80px" min="0" step="0.5"><span class="mut">sec</span>` : ''}
    ${['click', 'move'].includes(s.action) ? `<input type="number" data-k="x" data-i="${i}" value="${s.x ?? 100}" style="width:70px" title="x"><input type="number" data-k="y" data-i="${i}" value="${s.y ?? 100}" style="width:70px" title="y">` : ''}
    ${s.action === 'scroll' ? `<input type="number" data-k="value" data-i="${i}" value="${s.value ?? 300}" style="width:80px" title="deltaY (negative = up)"><span class="mut">px</span>` : ''}
    ${humanBox}
    <button class="iconbtn" data-rm="${i}">✕</button></div>`;
}
