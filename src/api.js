// Mirage — REST API + AdsPower/Multilogin-style automation API.
import os from 'node:os';
import net from 'node:net';
import { generateFingerprint, quickTemplates } from './fingerprint/generate.js';
import { MODELS } from './fingerprint/models.js';
import { REGIONS } from './fingerprint/pools.js';
import { auditFingerprint } from './fingerprint/consistency.js';
import { buildStealthBundle } from './fingerprint/stealth.js';
import { probeProxy } from './proxy/probe.js';
import { parseProxyList, proxyKey } from './proxy/parse.js';
import { listSources, fetchProxies } from './proxy/sources.js';
import { bulkProbe } from './proxy/checker.js';
import { parseClientHello } from './net/clienthello.js';
import { sealDNA, openDNA, dnaThumb } from './fingerprint/dna.js';
import { uid, now, jparse, signToken, verifyToken, sha256, fmtBytes, sleep } from './util.js';

export function createApi(ctx) {
  const { db, bm, hub, getSettings, setSettings, rotator } = ctx;
  const SECRET = ctx.secret;
  const H = {};
  const PORT = process.env.PORT || 7788;

  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
  const ok = (res, o) => json(res, 200, o);
  const err = (res, code, msg) => json(res, code, { error: msg });

  // ---- RBAC ----
  function sessionFor(req) {
    const c = req.headers.cookie || '';
    const m = c.match(/mirage_sid=([^;]+)/); if (!m) return null;
    const p = m[1].split('.');
    if (p.length !== 2) return null;
    const expect = sha256(SECRET + m[1].split('.')[0]); if (expect !== m[1].split('.')[1]) return null;
    const id = Buffer.from(m[1].split('.')[0], 'base64url').toString();
    const mem = db.getMemberRaw ? null : null;
    return id;
  }
  function memberFor(req) {
    const id = sessionFor(req); if (!id) return null;
    const m = db.getMemberRaw(id); if (!m || !m.active) return null;
    return m;
  }
  function apiKeyFor(req) {
    const k = (req.headers['x-api-key'] || (req.url.includes('key=') ? new URL(req.url, 'http://x').searchParams.get('key') : '')) || '';
    return k ? db.checkApiKey(k) : null;
  }
  const canWrite = (req, res) => { const m = memberFor(req); if (!m) { err(res, 401, 'auth required'); return false; } if (m.role === 'viewer') { err(res, 403, 'viewer cannot modify'); return false; } return true; };
  const need = (req, res, roles) => { const m = memberFor(req); if (!m) { err(res, 401, 'auth required'); return false; } if (roles && !roles.includes(m.role)) { err(res, 403, 'insufficient role'); return false; } return true; };
  const authInfo = (req) => { const m = memberFor(req); return m ? { member: m.id, role: m.role } : (apiKeyFor(req) ? { role: 'automation' } : null); };

  // ---- Team audit trail: who did what, on which profile, via which exit IP ----
  function auditLog(type, req, opts = {}) {
    const ai = authInfo(req) || {};
    const actor = ai.member ? ('member:' + ai.member) : (apiKeyFor(req) ? 'api-key' : (opts.actor || 'system'));
    let exitIp = null;
    if (opts.profileId) {
      const pr = db.getProfile(opts.profileId);
      if (pr && pr.proxy_id) { const px = db.getProxy(pr.proxy_id); if (px && px.last_check) { try { exitIp = JSON.parse(px.last_check).exitIp || null; } catch (e) { } } }
    }
    db.logEvent(type, {
      profileId: opts.profileId || '', member: actor,
      meta: Object.assign({ actor, exitIp, ip: req && req.socket ? req.socket.remoteAddress : null }, opts.meta || {}),
    });
  }
  H['GET /api/audit'] = (req, res) => {
    const u = new URL(req.url, 'http://x');
    const limit = Math.min(500, +(u.searchParams.get('limit')) || 200);
    const type = u.searchParams.get('type') || '';
    const rows = db.listEvents(limit, type);
    const enriched = rows.map(r => ({
      ts: r.ts, type: r.type,
      actor: (r.meta && r.meta.actor) || r.member || 'system',
      profileId: r.profile_id, profileName: r.profile_id ? (db.getProfile(r.profile_id)?.name || '') : '',
      exitIp: r.meta && r.meta.exitIp || null, meta: r.meta,
    }));
    ok(res, { rows: enriched });
  };

  // ---------------- profiles ----------------
  H['GET /api/profiles'] = (req, res) => ok(res, { profiles: db.listProfiles().map(publicProfile) });
  H['GET /api/profiles/:id'] = (req, res, p) => { const pr = db.getProfile(p.id); if (!pr) return err(res, 404, 'not found');
    const full = publicProfile(pr); full.fingerprint = pr.fingerprint; full.inline_proxy = pr.inline_proxy || ''; full.owner = pr.owner; full.created_at = pr.created_at;
    ok(res, { profile: full }); };
  H['POST /api/profiles'] = (req, res, _p, body) => {
    if (!canWrite(req, res)) return;
    const id = uid(10);
    const fp = body.fingerprint ? body.fingerprint : generateFingerprint({ os: body.os, browser: body.browser, country: body.country, seed: body.seed, modelId: body.modelId });
    const prof = { id, name: body.name || 'New Profile', group_id: body.group_id || '', color: body.color || '', favorite: !!body.favorite, tags: body.tags || [],
      memo: body.memo || '', proxy_id: body.proxy_id || '', inline_proxy: body.inline_proxy || '', fingerprint: fp, settings: body.settings || defaultSettings(), created_at: now(), updated_at: now(), last_open: 0, open_count: 0, owner: authInfo(req)?.member || 'me', browser_dir: '' };
    db.saveProfile(prof); auditLog('audit.profile.create', req, { profileId: id, meta: { name: prof.name, os: fp.osId, browser: fp.browser } });
    ok(res, { profile: publicProfile(db.getProfile(id)) });
  };
  H['GET /api/fingerprint/countries'] = (req, res) => ok(res, { countries: Object.keys(REGIONS) });

  // Country-targeted bulk profile generation. Each profile gets a unique seed so the
  // OS/browser/model/screen/timezone vary, while the country stays pinned. Optional
  // osList/browserList constrain the device variety; proxy_id attaches a proxy to all.
  H['POST /api/profiles/generate-bulk'] = (req, res, _p, body) => {
    if (!canWrite(req, res)) return;
    const country = String(body.country || '').trim().toUpperCase();
    if (!country || !REGIONS[country]) return err(res, 400, 'unknown or missing country (see /api/fingerprint/countries)');
    const count = Math.max(1, Math.min(100, parseInt(body.count || 5) || 5));
    const osList = Array.isArray(body.osList) ? body.osList.filter(Boolean) : null;
    const browserList = Array.isArray(body.browserList) ? body.browserList.filter(Boolean) : null;
    const prefix = (body.namePrefix || country || 'Batch');
    const group_id = body.group_id || '';
    const proxy_id = body.proxy_id || '';
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : (body.tags ? String(body.tags).split(',').map(s => s.trim()).filter(Boolean) : []);
    const created = [];
    for (let i = 0; i < count; i++) {
      const seed = uid(10) + '-' + i;
      const os = osList ? osList[i % osList.length] : undefined;
      const browser = browserList ? browserList[i % browserList.length] : undefined;
      const fp = generateFingerprint({ country, os, browser, seed, variant: body.forceVariant ? (i % 3) : undefined });
      const id = uid(10);
      const name = `${prefix} · ${fp.browserLabel || fp.browser} · ${String(i + 1).padStart(2, '0')}`;
      db.saveProfile({ id, name, group_id, color: body.color || '', favorite: false, tags, memo: body.memo || '',
        proxy_id, inline_proxy: '', fingerprint: fp, settings: defaultSettings(), created_at: now(), updated_at: now(), last_open: 0, open_count: 0, owner: authInfo(req)?.member || 'me', browser_dir: '' });
      created.push(publicProfile(db.getProfile(id)));
    }
    auditLog('audit.profiles.generate_bulk', req, { meta: { country, count: created.length } });
    ok(res, { created: created.length, country, profiles: created });
  };
  H['PUT /api/profiles/:id'] = (req, res, p, body) => {
    if (!canWrite(req, res)) return;
    const cur = db.getProfile(p.id); if (!cur) return err(res, 404, 'not found');
    const merged = { ...cur, ...body, id: cur.id, fingerprint: body.fingerprint || cur.fingerprint, settings: body.settings || cur.settings,
      tags: body.tags || cur.tags, updated_at: now() };
    db.saveProfile(merged); ok(res, { profile: publicProfile(db.getProfile(p.id)) });
  };
  H['DELETE /api/profiles/:id'] = (req, res, p) => { if (!canWrite(req, res)) return; if (bm.isRunning(p.id)) bm.stop(p.id, { save: false }).catch(() => { }); db.deleteProfile(p.id); auditLog('audit.profile.delete', req, { profileId: p.id }); ok(res, { ok: true }); };

  // ---- Device-DNA: encrypted, portable identity export / import ----
  H['POST /api/profiles/:id/export'] = (req, res, p, body) => {
    const pr = db.getProfile(p.id); if (!pr) return err(res, 404, 'profile not found');
    const fp = pr.fingerprint || {};
    const dna = {
      meta: { name: pr.name, osId: fp.osId, browser: fp.browser, region: fp.meta?.region, modelId: fp.deviceModel, exportedAt: now() },
      fingerprint: fp, proxy_id: pr.proxy_id || null, inline_proxy: pr.inline_proxy || null,
    };
    const env = sealDNA(dna, body.passphrase || 'mirage');
    auditLog('audit.export', req, { profileId: p.id, meta: { thumb: dnaThumb(dna) } });
    ok(res, { ok: true, dna: env, thumb: dnaThumb(dna) });
  };
  H['POST /api/profiles/import'] = (req, res, _p, body) => {
    if (!canWrite(req, res)) return;
    let dna; try { dna = openDNA(body.dna, body.passphrase || 'mirage'); } catch (e) { return err(res, 400, e.message); }
    const fp = dna.fingerprint; if (!fp || !fp.osId) return err(res, 400, 'DNA contains no fingerprint');
    const id = uid(20);
    const profile = { id, name: ((dna.meta?.name) || 'Imported DNA') + ' (DNA)', group_id: body.group_id || null, proxy_id: dna.proxy_id || null, inline_proxy: dna.inline_proxy || null, fingerprint: fp, created_at: now() };
    db.saveProfile(profile);
    auditLog('audit.import', req, { profileId: id, meta: { thumb: dnaThumb(dna), name: profile.name } });
    ok(res, { ok: true, id, name: profile.name });
  };

  // ---- Rotation scheduler (regenerates identity, preserves cookies/storage) ----
  H['GET /api/profiles/:id/rotation'] = (req, res, p) => {
    const pr = db.getProfile(p.id); if (!pr) return err(res, 404, 'profile not found');
    ok(res, { rotation: pr.settings && pr.settings.rotation || { enabled: false } });
  };
  H['PUT /api/profiles/:id/rotation'] = (req, res, p, body) => {
    if (!canWrite(req, res)) return;
    const pr = db.getProfile(p.id); if (!pr) return err(res, 404, 'profile not found');
    pr.settings = pr.settings || {};
    pr.settings.rotation = {
      enabled: !!body.enabled,
      intervalHours: Math.max(0.05, Math.min(720, +(body.intervalHours || 24))),
      rotateModel: !!body.rotateModel,
      rotateProxy: !!body.rotateProxy,
      lastRotateAt: pr.settings.rotation && pr.settings.rotation.lastRotateAt || 0,
      rotations: pr.settings.rotation && pr.settings.rotation.rotations || 0,
    };
    db.saveProfile(pr);
    db.logEvent('rotation.config', { profileId: p.id, meta: { enabled: pr.settings.rotation.enabled, intervalHours: pr.settings.rotation.intervalHours } });
    ok(res, { ok: true, rotation: pr.settings.rotation });
  };
  H['POST /api/profiles/:id/rotation/now'] = async (req, res, p) => {
    if (!canWrite(req, res)) return;
    if (!rotator) return err(res, 500, 'rotator not available');
    try { const r = await rotator.rotateNow(p.id); auditLog('audit.rotate', req, { profileId: p.id, meta: { seed: r.seed, cookiesPreserved: r.cookiesPreserved } }); ok(res, { ok: true, rotation: r }); }
    catch (e) { err(res, 400, e.message); }
  };
  H['POST /api/profiles/:id/clone'] = (req, res, p) => {
    if (!canWrite(req, res)) return; const cur = db.getProfile(p.id); if (!cur) return err(res, 404, 'not found');
    const id = uid(10); const cp = { ...cur, id, name: (cur.name || 'Profile') + ' (copy)', created_at: now(), updated_at: now(), last_open: 0, open_count: 0, fingerprint: { ...cur.fingerprint } };
    db.saveProfile(cp); ok(res, { profile: publicProfile(db.getProfile(id)) });
  };
  H['POST /api/profiles/bulk'] = (req, res, _p, body) => {
    if (!canWrite(req, res)) return;
    const ids = body.ids || [];
    for (const id of ids) {
      const cur = db.getProfile(id); if (!cur) continue;
      if (body.action === 'delete') { if (bm.isRunning(id)) bm.stop(id, { save: false }).catch(() => { }); db.deleteProfile(id); }
      else if (body.action === 'favorite') { cur.favorite = true; db.saveProfile(cur); }
      else if (body.action === 'unfavorite') { cur.favorite = false; db.saveProfile(cur); }
      else if (body.action === 'group') { cur.group_id = body.group_id || ''; db.saveProfile(cur); }
      else if (body.action === 'proxy') { cur.proxy_id = body.proxy_id || ''; cur.inline_proxy = body.inline_proxy || ''; db.saveProfile(cur); }
      else if (body.action === 'regenerate') { cur.fingerprint = generateFingerprint({ seed: uid(8), country: cur.fingerprint?.meta?.region }); db.saveProfile(cur); }
      else if (body.action === 'delete-selected') { if (bm.isRunning(id)) bm.stop(id, { save: true }).catch(() => { }); db.deleteProfile(id); }
    }
    ok(res, { ok: true, count: ids.length });
  };
  H['POST /api/profiles/:id/regenerate'] = (req, res, p, body) => {
    if (!canWrite(req, res)) return; const cur = db.getProfile(p.id); if (!cur) return err(res, 404, 'not found');
    cur.fingerprint = generateFingerprint({ os: body.os, browser: body.browser, country: body.country, seed: body.seed || uid(8), modelId: body.modelId });
    db.saveProfile(cur); auditLog('audit.regenerate', req, { profileId: p.id, meta: { os: body.os, browser: body.browser, country: body.country } }); ok(res, { profile: publicProfile(db.getProfile(p.id)) });
  };
  // fingerprint helpers
  H['POST /api/fingerprint/generate'] = (req, res, _p, body) => ok(res, { fingerprint: generateFingerprint({ os: body.os, browser: body.browser, country: body.country, seed: body.seed || uid(8), modelId: body.modelId }) });
  H['GET /api/fingerprint/models'] = (req, res) => ok(res, { models: MODELS.map(m => ({ id: m.id, family: m.family, renderer: m.gpu.renderer, cores: m.hardware.hardwareConcurrency, memory: m.hardware.deviceMemory ?? null, screen: `${m.screen.w}x${m.screen.h}@${m.screen.dpr}`, audio: m.audio.sampleRate, media: m.media })) });
  H['GET /api/fingerprint/templates'] = (req, res) => ok(res, { templates: quickTemplates() });

  // ---- TLS network signature (JA3/JA4) capture ----
  // A TLS ClientHello is transmitted in plaintext, so pointing the running kernel at a local TCP
  // socket lets us read the REAL JA3/JA4 it presents to origins — the honest way to verify this
  // kernel's network fingerprint (shaping it is a kernel-level moat; see README §4).
  const tlsCaptureCache = new Map();
  async function captureJA3(profileId) {
    let server;
    const got = await new Promise((resolve) => {
      server = net.createServer(sock => { sock.once('data', d => { sock.destroy(); resolve(d); }); sock.on('error', () => { }); });
      server.on('error', () => resolve(null));
      server.listen(0, '127.0.0.1', async () => {
        const p = server.address().port;
        try { await bm.navigate(profileId, `https://127.0.0.1:${p}/ja3`); } catch (e) { }
        setTimeout(() => resolve(null), 4000);
      });
    });
    try { server.close(); } catch (e) { }
    return got && got.length ? parseClientHello(got) : null;
  }
  H['POST /api/fingerprint/tls-capture/:id'] = async (req, res, p) => {
    const pid = p.id;
    if (!db.getProfile(pid)) return err(res, 404, 'profile not found');
    if (!bm.isRunning(pid)) { try { await bm.launch(pid, { url: `http://127.0.0.1:${PORT}/checker` }); } catch (e) { return err(res, 500, 'launch failed: ' + e.message); } }
    await sleep(600);
    const rep = await captureJA3(pid);
    if (!rep) return ok(res, { ok: false, error: 'no ClientHello observed (kernel busy or blocked)' });
    tlsCaptureCache.set(pid, rep);
    ok(res, { ok: true, tls: rep });
  };
  H['GET /api/fingerprint/tls-capture/:id'] = (req, res, p) => {
    const rep = tlsCaptureCache.get(p.id);
    ok(res, { ok: !!rep, tls: rep || null });
  };
  H['POST /api/fingerprint/audit'] = (req, res, _p, body) => ok(res, auditFingerprint(body.fp, body.ctx || {}));
  H['POST /api/fingerprint/stealth'] = (req, res, _p, body) => ok(res, { bundle: buildStealthBundle(body.fp || generateFingerprint({}), { sessionSalt: body.sessionSalt }) });

  // ---------------- groups ----------------
  H['GET /api/groups'] = (req, res) => ok(res, { groups: db.listGroups() });
  H['POST /api/groups'] = (req, res, _p, body) => { if (!canWrite(req, res)) return; const g = db.saveGroup({ name: body.name, color: body.color }); ok(res, { group: g }); };
  H['DELETE /api/groups/:id'] = (req, res, p) => { if (!canWrite(req, res)) return; db.deleteGroup(p.id); ok(res, { ok: true }); };

  // ---------------- proxies ----------------
  H['GET /api/proxies'] = (req, res) => ok(res, { proxies: db.listProxies() });
  H['POST /api/proxies'] = (req, res, _p, body) => { if (!canWrite(req, res)) return; const pr = db.saveProxy({ id: body.id, label: body.label, scheme: (body.scheme || 'http').toLowerCase(), host: body.host, port: body.port, user: body.user, pass: body.pass, country: body.country || '', city: body.city || '', note: body.note || '', rotator: body.rotator }); ok(res, { proxy: pr }); };
  H['PUT /api/proxies/:id'] = (req, res, p, body) => { if (!canWrite(req, res)) return; const cur = db.getProxy(p.id); if (!cur) return err(res, 404, 'not found'); const merged = { ...cur, ...body, id: cur.id }; db.saveProxy(merged); ok(res, { proxy: db.getProxy(p.id) }); };
  H['DELETE /api/proxies/:id'] = (req, res, p) => { if (!canWrite(req, res)) return; db.deleteProxy(p.id); ok(res, { ok: true }); };
  H['POST /api/proxies/test'] = async (req, res, _p, body) => { const r = await probeProxy({ scheme: (body.scheme || 'http').toLowerCase(), host: body.host, port: body.port, user: body.user, pass: body.pass }); json(res, r.ok ? 200 : 200, r); };
  H['POST /api/proxies/:id/probe'] = async (req, res, p) => { const px = db.getProxy(p.id); if (!px) return err(res, 404, 'not found'); const r = await probeProxy(px); if (r.ok) db.saveProxy({ ...px, last_check: JSON.stringify(r) }); ok(res, r); };
  // dedupe helpers for proxy import/fetch
  const existingProxyKeys = () => { const s = new Set(); for (const p of db.listProxies()) s.add(proxyKey(p)); return s; };
  function saveProxiesDedup(parsed, { labelPrefix = '', country = '', rotator = 0, note = '', seen = null } = {}) {
    const set = seen || existingProxyKeys();
    const created = [];
    for (const p of parsed) {
      const k = proxyKey(p); if (set.has(k)) continue; set.add(k);
      const rec = db.saveProxy({
        scheme: p.scheme, host: p.host, port: p.port, user: p.user, pass: p.pass,
        label: labelPrefix ? `${labelPrefix} ${p.host}:${p.port}` : `${p.host}:${p.port}`,
        country: p.country || country, city: p.city || '', note: p.source ? ('src:' + p.source) : note, rotator,
      });
      created.push(rec);
    }
    return created;
  }
  async function verifyAndStore(created, { concurrency = 8, onlyKeepAlive = false } = {}) {
    if (!created.length) return { ran: true, checked: 0, alive: 0, dead: 0 };
    const { results, alive, dead } = await bulkProbe(created, { concurrency });
    for (const { proxy, result } of results) {
      try { if (result && result.ok) db.saveProxy({ ...proxy, last_check: JSON.stringify(result) }); else if (onlyKeepAlive) db.deleteProxy(proxy.id); else db.saveProxy({ ...proxy, last_check: JSON.stringify(result) }); } catch (e) { }
    }
    return { ran: true, checked: results.length, alive, dead };
  }

  H['POST /api/proxies/import'] = async (req, res, _p, body) => {
    if (!canWrite(req, res)) return;
    const created = saveProxiesDedup(parseProxyList(body.text || ''), { country: body.country || '', rotator: body.rotator ? 1 : 0, note: 'imported' });
    const check = body.check ? await verifyAndStore(created, { concurrency: +(body.concurrency || 8), onlyKeepAlive: !!body.onlyKeepAlive }) : { ran: false };
    ok(res, { created: created.length, check, proxies: created.map(c => ({ ...c, pass: undefined })) });
  };

  // Known public proxy-list resources (raw text). Lets the UI offer one-click "fetch & check".
  H['GET /api/proxies/sources'] = (req, res) => ok(res, { sources: listSources() });

  H['POST /api/proxies/fetch'] = async (req, res, _p, body) => {
    if (!canWrite(req, res)) return;
    const { proxies, perSource, errors } = await fetchProxies({
      sources: body.sources || [], urls: body.urls || [], types: body.types || null, limit: Math.min(1000, +(body.limit || 200)),
    });
    const created = saveProxiesDedup(proxies, { note: 'fetched' });
    const check = body.check === false ? { ran: false } : await verifyAndStore(created.slice(0, Math.min(created.length, +(body.checkLimit || 250))), { concurrency: +(body.concurrency || 10), onlyKeepAlive: !!body.onlyKeepAlive });
    ok(res, { fetched: proxies.length, created: created.length, perSource, errors, check });
  };

  // Server-side bulk probe of stored proxies (fast, bounded concurrency).
  H['POST /api/proxies/probe-all'] = async (req, res, _p, body) => {
    if (!canWrite(req, res)) return;
    const all = db.listProxies();
    const targets = Array.isArray(body.ids) && body.ids.length ? all.filter(p => body.ids.includes(p.id)) : all;
    const { results, alive, dead } = await bulkProbe(targets, { concurrency: +(body.concurrency || 8) });
    for (const { proxy, result } of results) { try { db.saveProxy({ ...proxy, last_check: JSON.stringify(result) }); } catch (e) { } }
    ok(res, { total: targets.length, alive, dead });
  };

  // ---------------- browser sessions ----------------
  const canOperate = (req, res) => { const m = memberFor(req); if (m && m.role !== 'viewer') return true; if (m && m.role === 'viewer') return true; if (apiKeyFor(req)) return true; err(res, 401, 'auth required'); return false; };
  H['POST /api/browser/start'] = async (req, res, _p, body) => {
    if (!canOperate(req, res)) return;
    try { const info = await bm.launch(body.profileId, { url: body.url, cloud: body.cloud, fresh: body.fresh }); bumpProfile(body.profileId); auditLog('audit.launch', req, { profileId: body.profileId }); ok(res, info); }
    catch (e) { err(res, 400, e.message); }
  };
  H['POST /api/browser/stop'] = async (req, res, _p, body) => { if (!canOperate(req, res)) return; await bm.stop(body.profileId || body.user_id, { save: body.save !== false }); auditLog('audit.stop', req, { profileId: body.profileId || body.user_id }); ok(res, { ok: true }); };
  H['GET /api/browser/list'] = (req, res) => ok(res, { sessions: bm.list() });
  H['GET /api/browser/status'] = async (req, res) => ok(res, { status: await bm.status() });
  H['GET /api/browser/tabs'] = (req, res) => { const q = new URL(req.url, 'http://x').searchParams; const pid = q.get('profileId'); if (!pid) return err(res, 400, 'profileId'); try { ok(res, { tabs: bm.tabs(pid) }); } catch (e) { err(res, 400, e.message); } };
  H['POST /api/browser/navigate'] = async (req, res, _p, body) => { try { await bm.navigate(body.profileId, body.url); ok(res, { ok: true }); } catch (e) { err(res, 400, e.message); } };
  H['POST /api/browser/tab'] = async (req, res, _p, body) => {
    try {
      if (body.action === 'new') { const id = await bm.newTab(body.profileId, body.url); ok(res, { targetId: id }); }
      else if (body.action === 'close') { await bm.closeTab(body.profileId, body.targetId); ok(res, { ok: true }); }
      else if (body.action === 'activate') { await bm.activateTab(body.profileId, body.targetId); ok(res, { ok: true }); }
      else if (body.action === 'reload') { await bm.reload(body.profileId); ok(res, { ok: true }); }
      else if (body.action === 'back') { await bm.goBack(body.profileId); ok(res, { ok: true }); }
      else if (body.action === 'forward') { await bm.goForward(body.profileId); ok(res, { ok: true }); }
      else if (body.action === 'screenshot') { const d = await bm.screenshot(body.profileId); ok(res, { dataUrl: 'data:image/jpeg;base64,' + d }); }
      else err(res, 400, 'unknown action');
    } catch (e) { err(res, 400, e.message); }
  };
  H['GET /api/browser/screenshot/:profileId'] = async (req, res, p) => { try { const d = await bm.screenshot(p.profileId); json(res, 200, { dataUrl: 'data:image/jpeg;base64,' + d }); } catch (e) { err(res, 400, e.message); } };
  H['POST /api/browser/cookies'] = async (req, res, _p, body) => {
    try {
      if (body.action === 'get') return ok(res, { cookies: await bm.cookies(body.profileId) });
      if (body.action === 'set') { await bm.setCookies(body.profileId, body.cookies || []); return ok(res, { ok: true }); }
      if (body.action === 'clear') { await bm.clearAll(body.profileId); return ok(res, { ok: true }); }
      if (body.action === 'snapshot') return ok(res, await bm.snapshot(body.profileId));
    } catch (e) { err(res, 400, e.message); }
  };
  H['GET /api/browser/cookies/:profileId'] = async (req, res, p) => { try { ok(res, { cookies: await bm.cookies(p.profileId) }); } catch (e) { err(res, 400, e.message); } };
  H['GET /api/browser/history/:profileId'] = (req, res, p) => ok(res, { history: db.listHistory(p.profileId, 200) });
  H['GET /api/profiles/:id/snapshots'] = (req, res, p) => ok(res, { snapshots: bm.snapshots(p.id) });
  H['POST /api/snapshots/restore'] = async (req, res, _p, body) => {
    if (!canOperate(req, res)) return;
    try { ok(res, await bm.restoreSnapshot(body.profileId, body.snapshotId)); } catch (e) { err(res, 400, e.message); }
  };
  H['DELETE /api/snapshots/:id'] = (req, res, p) => { if (!canWrite(req, res)) return; bm.deleteSnapshot(p.id); ok(res, { ok: true }); };
  H['POST /api/browser/human'] = async (req, res, _p, body) => {
    if (!canOperate(req, res)) return;
    try {
      const pid = body.profileId;
      if (body.action === 'click') await bm.humanClick(pid, +body.x, +body.y, { button: body.button || 'left' });
      else if (body.action === 'type') await bm.humanType(pid, body.text, { wpm: body.wpm });
      else if (body.action === 'move') await bm.humanMove(pid, +body.x, +body.y);
      else if (body.action === 'scroll') await bm.humanScroll(pid, +(body.dy || 200));
      else if (body.action === 'clickText') { /* convenience handled by UI via evaluate first */ return err(res, 400, 'use click with coords'); }
      else return err(res, 400, 'unknown human action');
      ok(res, { ok: true });
    } catch (e) { err(res, 400, e.message); }
  };
  H['POST /api/browser/eval'] = async (req, res, _p, body) => {
    if (!canOperate(req, res)) return;
    try { ok(res, { value: await bm.evaluate(body.profileId, body.expression) }); } catch (e) { err(res, 400, e.message); }
  };
  // full anti-detect audit: launch (if needed) → open built-in checker → wait for report → return
  H['POST /api/checker/run/:profileId'] = async (req, res, p) => {
    if (!canOperate(req, res)) return;
    const port = +(process.env.PORT || 7788);
    try {
      if (!bm.isRunning(p.profileId)) await bm.launch(p.profileId, {});
      const tabId = await bm.newTab(p.profileId, `http://127.0.0.1:${port}/checker?embed=1&v=${Date.now()}`);
      const t0 = Date.now();
      let rep = null;
      while (Date.now() - t0 < 18000) {
        await new Promise(r => setTimeout(r, 800));
        try { rep = await bm.evaluate(p.profileId, 'window.__MIRAGE_REPORT || null', tabId); if (rep) break; } catch (e) { }
      }
      await bm.closeTab(p.profileId, tabId).catch(() => { });   // leave no checker-tab litter
      if (rep) { db.logEvent('checker', { profileId: p.profileId, meta: { leaks: rep.leaks, score: rep.score } }); return ok(res, rep); }
      err(res, 408, 'checker did not produce a report in time');
    } catch (e) { err(res, 400, e.message); }
  };

  // ---------------- members ----------------
  H['GET /api/members'] = (req, res) => { if (!need(req, res, ['admin'])) return; ok(res, { members: db.listMembers() }); };
  H['POST /api/members'] = (req, res, _p, body) => { if (!need(req, res, ['admin'])) return; const id = db.saveMember({ id: body.id, name: body.name, email: body.email, role: body.role || 'member', pin_hash: body.pin ? sha256(String(body.pin)) : '', color: body.color }); ok(res, { id }); };
  H['PUT /api/members/:id'] = (req, res, p, body) => { if (!need(req, res, ['admin'])) return; const cur = db.getMemberRaw(p.id); if (!cur) return err(res, 404, 'not found'); const m = { ...cur, ...body, id: cur.id, pin_hash: body.pin ? sha256(String(body.pin)) : cur.pin_hash }; db.saveMember(m); ok(res, { ok: true }); };
  H['DELETE /api/members/:id'] = (req, res, p) => { if (!need(req, res, ['admin'])) return; db.deleteMember(p.id); ok(res, { ok: true }); };

  // ---------------- api keys ----------------
  H['GET /api/apikeys'] = (req, res) => { if (!need(req, res, ['admin'])) return; ok(res, { keys: db.listApiKeys().map(k => ({ ...k, key: k.key.slice(0, 12) + '…' })) }); };
  H['POST /api/apikeys'] = (req, res, _p, body) => { if (!need(req, res, ['admin'])) return; const k = db.createApiKey(body.label); ok(res, { ...k }); };
  H['DELETE /api/apikeys/:key'] = (req, res, p) => { if (!need(req, res, ['admin'])) return; db.revokeApiKey(p.key); ok(res, { ok: true }); };

  // ---------------- auth ----------------
  H['POST /api/auth/login'] = (req, res, _p, body) => {
    const m = db.getMemberByPinHash(sha256(String(body.pin)));
    if (!m) return err(res, 401, 'invalid pin');
    const tok = Buffer.from(m.id).toString('base64url') + '.' + sha256(SECRET + Buffer.from(m.id).toString('base64url'));
    res.setHeader('Set-Cookie', `mirage_sid=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=864000`);
    db.logEvent('audit.login', { profileId: '', member: 'member:' + m.id, meta: { actor: 'member:' + m.id, role: m.role, ip: req.socket.remoteAddress } });
    ok(res, { member: { id: m.id, name: m.name, role: m.role, color: m.color } });
  };
  H['POST /api/auth/logout'] = (req, res) => { res.setHeader('Set-Cookie', 'mirage_sid=; HttpOnly; Path=/; Max-Age=0'); ok(res, { ok: true }); };
  H['GET /api/auth/me'] = (req, res) => { const m = memberFor(req); ok(res, { member: m ? { id: m.id, name: m.name, role: m.role, color: m.color } : null }); };

  // ---------------- settings ----------------
  H['GET /api/settings'] = async (req, res) => {
    const st = { ...getSettings(), secretBits: undefined };
    const m = memberFor(req);
    if (!m && !apiKeyFor(req)) return err(res, 401, 'auth required');
    const kernel = await bm.status();
    ok(res, { settings: st, kernel, me: m ? { id: m.id, name: m.name, role: m.role } : null });
  };
  H['PUT /api/settings'] = (req, res, _p, body) => { if (!need(req, res, ['admin'])) return; setSettings({ ...getSettings(), ...body }); ok(res, { ok: true, settings: getSettings() }); };

  // ---------------- events / history ----------------
  H['GET /api/events'] = (req, res) => { const q = new URL(req.url, 'http://x').searchParams; ok(res, { events: db.listEvents(Math.min(+q.get('limit') || 100, 500), q.get('type') || '') }); };
  H['GET /api/history'] = (req, res) => { const q = new URL(req.url, 'http://x').searchParams; ok(res, { history: db.listHistory(q.get('profileId') || '', Math.min(+q.get('limit') || 100, 500)) }); };
  H['GET /api/stats'] = (req, res) => {
    const profiles = db.listProfiles(); const running = bm.list().length;
    const groups = db.listGroups(); const proxies = db.listProxies();
    const healthyProxies = proxies.filter(p => { try { const c = jparse(p.last_check); return c && c.ok; } catch { return false; } }).length;
    ok(res, { totalProfiles: profiles.length, running, groups: groups.length, proxies: proxies.length, healthyProxies, todayEvents: db.listEvents(500).filter(e => e.ts > now() - 86400e3).length, cpu: os.cpus().length, memMB: Math.round(os.totalmem() / 1048576) });
  };

  // ---------------- flows (RPA-lite) ----------------
  H['GET /api/flows'] = (req, res) => ok(res, { flows: db.listFlows() });
  H['POST /api/flows'] = (req, res, _p, body) => { if (!canWrite(req, res)) return; const id = body.id || uid(8); db.saveFlow({ id, name: body.name || 'Flow', profile_id: body.profile_id || '', steps: body.steps || [] }); ok(res, { id }); };
  H['DELETE /api/flows/:id'] = (req, res, p) => { if (!canWrite(req, res)) return; db.deleteFlow(p.id); ok(res, { ok: true }); };
  H['POST /api/flows/:id/run'] = async (req, res, p, body) => {
    try {
      const flow = db.getFlow(p.id); if (!flow) return err(res, 404, 'not found');
      const pid = body.profileId || flow.profile_id;
      if (!bm.isRunning(pid)) await bm.launch(pid, {});
      const results = [];
      for (let i = 0; i < flow.steps.length; i++) {
        const st = flow.steps[i];
        try {
          if (st.action === 'goto') await bm.navigate(pid, st.value);
          else if (st.action === 'wait') await new Promise(r => setTimeout(r, +st.value * 1000 || 1000));
          else if (st.action === 'eval') await bm.evaluate(pid, st.value);
          else if (st.action === 'screenshot') await bm.screenshot(pid);
          else if (st.action === 'click') { const hum = st.human !== false && body.humanize !== false; if (hum) await bm.humanClick(pid, +st.x, +st.y, { button: st.button || 'left' }); else { await bm.inputMouse(pid, { type: 'mousePressed', x: +st.x, y: +st.y, button: 'left', clickCount: 1 }); await bm.inputMouse(pid, { type: 'mouseReleased', x: +st.x, y: +st.y, button: 'left' }); } }
          else if (st.action === 'type') { const hum = st.human !== false && body.humanize !== false; if (hum) await bm.humanType(pid, st.value); else await bm.inputKey(pid, { type: 'char', key: st.value, text: st.value }); }
          else if (st.action === 'move') await bm.humanMove(pid, +st.x, +st.y);
          else if (st.action === 'scroll') await bm.humanScroll(pid, +(st.dy ?? st.value) || 200);
          results.push({ step: i, ok: true });
        } catch (e) { results.push({ step: i, ok: false, error: e.message }); if (st.stopOnError) break; }
      }
      ok(res, { results });
    } catch (e) { err(res, 400, e.message); }
  };

  // ---------------- backup ----------------
  H['GET /api/backup/export'] = (req, res) => {
    const dump = { version: 1, exportedAt: now(), profiles: db.listProfiles(), groups: db.listGroups(), proxies: db.listProxies(), members: db.listMembers(), settings: getSettings() };
    const b = JSON.stringify(dump, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="mirage-backup-${now()}.json"`, 'Content-Length': Buffer.byteLength(b) }); res.end(b);
  };
  H['POST /api/backup/import'] = (req, res, _p, body) => {
    if (!need(req, res, ['admin'])) return;
    const dump = body; if (!dump || !Array.isArray(dump.profiles)) return err(res, 400, 'invalid backup');
    let n = 0;
    for (const p of dump.profiles) { db.saveProfile(p); n++; }
    if (Array.isArray(dump.groups)) for (const g of dump.groups) db.saveGroup(g);
    if (Array.isArray(dump.proxies)) for (const px of dump.proxies) db.saveProxy({ ...px, last_check: '' });
    ok(res, { imported: n });
  };

  // ---------------- checker helpers ----------------
  H['GET /api/checker/whoami'] = (req, res) => {
    ok(res, { headers: req.headers, ip: req.socket.remoteAddress, ua: req.headers['user-agent'] });
  };

  // ---------------- automation API (AdsPower/Multilogin style) ----------------
  const autoAuth = (req, res) => { const k = apiKeyFor(req); if (!k) { err(res, 401, 'invalid or missing API key'); return false; } return true; };
  H['GET /api/v1/group/list'] = (req, res) => { if (!autoAuth(req, res)) return; ok(res, { code: 0, data: { list: db.listGroups().map(g => ({ group_id: g.id, group_name: g.name, remark: '' })) } }); };
  H['GET /api/v1/user/list'] = (req, res) => { if (!autoAuth(req, res)) return; const list = db.listProfiles().map(p => ({ user_id: p.id, user_name: p.name, group_id: p.group_id })); ok(res, { code: 0, data: { list, total: list.length } }); };
  H['POST /api/v1/browser/start'] = async (req, res, _p, body) => {
    if (!autoAuth(req, res)) return;
    const pid = body.profile_id || body.user_id; if (!pid) return json(res, 200, { code: 10005, msg: 'profile_id or user_id required' });
    try {
      const info = await bm.launch(pid, { url: body.website || body.url, fresh: body.fresh === 'true' || body.fresh === true, cloud: body.cloud === 'true' || body.cloud === true });
      const port = info.port;
      bumpProfile(pid);
      ok(res, {
        code: 0, msg: 'success',
        data: {
          user_id: pid, status: 'loaded',
          ws: {
            puppeteer: `ws://127.0.0.1:${port}`,
            playwright: `http://127.0.0.1:${port}`,
            selenium: `http://127.0.0.1:${port}`,
            webdriver: `http://127.0.0.1:${port}/wd/hub`,
            cdp: `ws://127.0.0.1:${port}`,
          },
          debug_port: port, driving_api_cdp: `http://127.0.0.1:${port}/json/version`, wdm: `/api/v1/wdm/${pid}/capabilities`,
        },
      });
    } catch (e) { json(res, 200, { code: 10001, msg: String(e.message || e) }); }
  };
  H['POST /api/v1/browser/stop'] = async (req, res, _p, body) => {
    if (!autoAuth(req, res)) return;
    const pid = body.profile_id || body.user_id; if (!pid) return json(res, 400, { code: 10005, msg: 'profile_id required' });
    await bm.stop(pid, { save: true });
    ok(res, { code: 0, data: { user_id: pid, status: 'closed' } });
  };
  H['POST /api/v1/browser/update'] = (req, res, _p, body) => { if (!autoAuth(req, res)) return; ok(res, { code: 0, data: { user_id: body.user_id, status: 'updated' } }); };
  H['GET /api/v1/browser/status'] = (req, res) => { if (!autoAuth(req, res)) return; ok(res, { code: 0, data: { list: bm.list().map(s => ({ user_id: s.profileId, status: s.status })) } }); };
  // Web Driver Manager style endpoint
  H['GET /api/v1/wdm/:profileId/capabilities'] = (req, res, p) => { if (!autoAuth(req, res)) return; const pr = db.getProfile(p.profileId); const info = bm.isRunning(p.profileId) ? bm.public(p.profileId) : null; ok(res, { profile: pr ? pr.name : p.profileId, cdp: info ? `ws://127.0.0.1:${info.port}/devtools/browser` : null, debug_port: info?.port }); };

  function defaultSettings() { return { mode: 'headed', startUrl: '', cookiesMode: 'persist', blockWebBluetooth: true, quic: 'off', bypassCSP: false, autoCloseMin: 0 }; }
  function bumpProfile(pid) { try { const p = db.getProfile(pid); if (p) { p.last_open = now(); p.open_count = (p.open_count || 0) + 1; db.saveProfile(p); } } catch (e) { } }
  // WebSocket RPC used by the live-view toolbar (authenticated via session cookie token)
  async function invokeRpc(conn, msg) {
    const [domain, action] = String(msg.method || '').split('.');
    const a = msg.args || {};
    if (domain === 'browser') {
      if (action === 'tabs') return bm.tabs(a.profileId);
      if (action === 'tab') {
        if (a.action === 'new') return await bm.newTab(a.profileId, a.url);
        if (a.action === 'close') return await bm.closeTab(a.profileId, a.targetId);
        if (a.action === 'activate') return await bm.activateTab(a.profileId, a.targetId);
        if (a.action === 'reload') return await bm.reload(a.profileId);
        if (a.action === 'back') return await bm.goBack(a.profileId);
        if (a.action === 'forward') return await bm.goForward(a.profileId);
      }
      if (action === 'navigate') return await bm.navigate(a.profileId, a.url);
      if (action === 'human') {
        if (a.action === 'click') return await bm.humanClick(a.profileId, +a.x, +a.y, { button: a.button || 'left' });
        if (a.action === 'type') return await bm.humanType(a.profileId, a.text, { wpm: a.wpm });
        if (a.action === 'move') return await bm.humanMove(a.profileId, +a.x, +a.y);
        if (a.action === 'scroll') return await bm.humanScroll(a.profileId, +(a.dy || 200));
        throw new Error('unknown human action');
      }
      if (action === 'screenshot') return await bm.screenshot(a.profileId);
      if (action === 'stop') return await bm.stop(a.profileId);
      if (action === 'cookies') return await bm.cookies(a.profileId);
      if (action === 'snapshot') return await bm.snapshot(a.profileId);
    }
    if (domain === 'profile') {
      if (action === 'get') { const p = db.getProfile(a.profileId); return p && publicProfile(p); }
      if (action === 'fingerprint') return db.getProfile(a.profileId)?.fingerprint;
    }
    if (domain === 'kernel') return await bm.status();
    throw new Error('unknown rpc: ' + msg.method);
  }
  function publicProfile(p) {
    const fp = p.fingerprint || {};
    const audit = auditFingerprint(fp, {});
    return { id: p.id, name: p.name, group_id: p.group_id, color: p.color, favorite: !!p.favorite, tags: p.tags, memo: p.memo, proxy_id: p.proxy_id, inline_proxy: p.inline_proxy ? maskProxy(p.inline_proxy) : '',
      os: fp.osName, browser: fp.browserLabel, ua: fp.ua, tz: fp.timezone?.id, country: fp.meta?.region, screen: fp.screen ? `${fp.screen.width}x${fp.screen.height}` : '', gpu: fp.gpu?.unmaskedVendor,
      canvas: fp.canvas?.mode, audio: fp.audio?.mode, webrtc: fp.webrtc?.mode, score: audit.score, issues: audit.critCount, last_open: p.last_open, open_count: p.open_count, updated_at: p.updated_at, settings: p.settings };
  }
  function maskProxy(s) { try { return s.replace(/\/\/[^@]+@/, '//***:***@'); } catch { return s; } }
  function authCtx(req) { return { member: memberFor(req), key: apiKeyFor(req) }; }

  return { H, json, ok, err, memberFor, apiKeyFor, authCtx, canWrite, need, publicProfile, invokeRpc, bumpProfile };
}
