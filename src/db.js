// Mirage — SQLite persistence layer (node:sqlite, sync, WAL)
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { uid, now, jparse, hashPin } from './util.js';
import { auditFingerprint } from './fingerprint/consistency.js';

let db;
// Prepared-statement cache: the same SQL text is compiled once instead of on every call. node:sqlite
// statements are safe to reuse with different bound params. Cleared on re-init (tests / reopen).
const _stmt = new Map();
function prep(sql) { let s = _stmt.get(sql); if (!s) { s = db.prepare(sql); _stmt.set(sql, s); } return s; }

// Stored-XSS hardening (C-1): entity ids must be server-generated safe tokens. Legit ids are
// uid() hex or short slugs ('me', 'mgk_..'); reject anything carrying markup/quotes so a client-
// supplied id (via proxies/members/flows create, backup/import) can never persist an HTML payload.
function assertSafeId(id, kind) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('invalid ' + (kind || 'id'));
  }
  return id;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, group_id TEXT DEFAULT '',
  color TEXT DEFAULT '', favorite INTEGER DEFAULT 0, memo TEXT DEFAULT '',
  tags TEXT DEFAULT '[]', proxy_id TEXT DEFAULT '', inline_proxy TEXT DEFAULT '',
  fingerprint TEXT DEFAULT '{}', settings TEXT DEFAULT '{}',
  created_at INTEGER, updated_at INTEGER, last_open INTEGER DEFAULT 0, open_count INTEGER DEFAULT 0,
  owner TEXT DEFAULT 'me', browser_dir TEXT DEFAULT '',
  os TEXT, browser TEXT, country TEXT, tz TEXT, screen TEXT, canvas TEXT, os_family TEXT, score INTEGER, issues INTEGER
);
CREATE TABLE IF NOT EXISTS groups ( id TEXT PRIMARY KEY, name TEXT, color TEXT DEFAULT '', created_at INTEGER );
CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY, label TEXT, scheme TEXT, host TEXT, port INTEGER, user TEXT DEFAULT '', pass TEXT DEFAULT '',
  country TEXT DEFAULT '', city TEXT DEFAULT '', note TEXT DEFAULT '', rotator INTEGER DEFAULT 0,
  last_check TEXT DEFAULT '', created_at INTEGER, favorite INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS members ( id TEXT PRIMARY KEY, name TEXT, email TEXT DEFAULT '', role TEXT DEFAULT 'member',
  pin_hash TEXT DEFAULT '', color TEXT DEFAULT '#8b5cf6', active INTEGER DEFAULT 1, created_at INTEGER );
CREATE TABLE IF NOT EXISTS events ( id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, profile_id TEXT DEFAULT '',
  member TEXT DEFAULT '', meta TEXT DEFAULT '{}' );
CREATE TABLE IF NOT EXISTS history ( id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, profile_id TEXT, url TEXT, title TEXT DEFAULT '' );
CREATE TABLE IF NOT EXISTS snapshots ( id TEXT PRIMARY KEY, profile_id TEXT, ts INTEGER, cookies TEXT, local_storage TEXT, origin TEXT DEFAULT '' );
CREATE TABLE IF NOT EXISTS kv ( k TEXT PRIMARY KEY, v TEXT );
CREATE TABLE IF NOT EXISTS apikeys ( key TEXT PRIMARY KEY, label TEXT, created_at INTEGER, last_used INTEGER DEFAULT 0 );
CREATE TABLE IF NOT EXISTS flows ( id TEXT PRIMARY KEY, name TEXT, profile_id TEXT DEFAULT '', steps TEXT DEFAULT '[]', created_at INTEGER );
CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(group_id);
CREATE INDEX IF NOT EXISTS idx_history_profile ON history(profile_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

export function initDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'mirage.db'));
  _stmt.clear();
  db.exec('PRAGMA journal_mode = WAL;');
  // synchronous=NORMAL is crash-safe under WAL (no corruption; worst case the last txn is lost) and
  // materially cuts per-commit fsync latency; busy_timeout avoids SQLITE_BUSY crashes under load.
  db.exec('PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;');
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE proxies ADD COLUMN favorite INTEGER DEFAULT 0'); } catch (_) { /* already present */ }
  migrateProfileDerivedCols();
  seedIfEmpty();
  return db;
}
// Add precomputed list columns (performance: the profile list no longer parses fingerprint blobs
// or re-runs auditFingerprint per row) and backfill any rows saved before they existed.
function migrateProfileDerivedCols() {
  const cols = [['os', 'TEXT'], ['browser', 'TEXT'], ['country', 'TEXT'], ['tz', 'TEXT'], ['screen', 'TEXT'], ['canvas', 'TEXT'], ['os_family', 'TEXT'], ['score', 'INTEGER'], ['issues', 'INTEGER']];
  for (const [c, t] of cols) { try { db.exec(`ALTER TABLE profiles ADD COLUMN ${c} ${t}`); } catch (_) { /* already present */ } }
  const stale = prep('SELECT id, fingerprint FROM profiles WHERE score IS NULL').all();
  const upd = db.prepare('UPDATE profiles SET os=@os,browser=@browser,country=@country,tz=@tz,screen=@screen,canvas=@canvas,os_family=@os_family,score=@score,issues=@issues WHERE id=@id');
  for (const r of stale) { const d = deriveListCols(jparse(r.fingerprint, {})); upd.run({ id: r.id, ...d }); }
}
export function getDb() { return db; }

export function kvGet(key, fb = null) {
  const r = prep('SELECT v FROM kv WHERE k=?').get(key);
  return r ? jparse(r.v, fb) : fb;
}
export function kvSet(key, val) {
  prep('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(key, JSON.stringify(val));
}

// ---------- profiles ----------
export function listProfiles() {
  return prep('SELECT * FROM profiles ORDER BY updated_at DESC').all().map(rowToProfile);
}
// Lightweight read for the profile list: returns precomputed scalar columns only (no fingerprint /
// settings JSON parse). Consumed by GET /api/profiles; the single-profile GET /api/profiles/:id keeps
// returning the full object (the editor needs the whole fingerprint).
export function listProfilesLite() {
  return prep(`SELECT id,name,group_id,color,favorite,memo,tags,proxy_id,inline_proxy,last_open,open_count,updated_at,owner,os,browser,country,tz,screen,canvas,os_family,score,issues
    FROM profiles ORDER BY updated_at DESC`).all().map(r => ({ ...r, favorite: !!r.favorite, tags: jparse(r.tags, []) }));
}
export function getProfile(id) {
  const r = prep('SELECT * FROM profiles WHERE id=?').get(id);
  return r ? rowToProfile(r) : null;
}
// Precompute the scalar fields the profile-list endpoint needs, so GET /api/profiles never parses the
// full fingerprint blob nor re-runs auditFingerprint (which was ~70% of the list's request cost).
function deriveListCols(fp) {
  fp = fp || {};
  let a; try { a = auditFingerprint(fp, {}); } catch (_) { a = { score: 0, critCount: 0 }; }
  return {
    os: fp.osName || '', browser: fp.browserLabel || '', country: (fp.meta && fp.meta.region) || '',
    tz: (fp.timezone && fp.timezone.id) || '', screen: fp.screen ? `${fp.screen.width}x${fp.screen.height}` : '',
    canvas: (fp.canvas && fp.canvas.mode) || '', os_family: (fp.os && fp.os.family) || '',
    score: a.score, issues: a.critCount,
  };
}
export function saveProfile(p) {
  assertSafeId(p.id, 'profile id');
  p.updated_at = now();
  const d = p.fingerprint ? deriveListCols(p.fingerprint)
    : (prep('SELECT os,browser,country,tz,screen,canvas,os_family,score,issues FROM profiles WHERE id=?').get(p.id) || deriveListCols({}));
  prep(`INSERT INTO profiles (id,name,group_id,color,favorite,memo,tags,proxy_id,inline_proxy,fingerprint,settings,created_at,updated_at,last_open,open_count,owner,browser_dir,os,browser,country,tz,screen,canvas,os_family,score,issues)
    VALUES (@id,@name,@group_id,@color,@favorite,@memo,@tags,@proxy_id,@inline_proxy,@fingerprint,@settings,@created_at,@updated_at,@last_open,@open_count,@owner,@browser_dir,@os,@browser,@country,@tz,@screen,@canvas,@os_family,@score,@issues)
    ON CONFLICT(id) DO UPDATE SET name=@name,group_id=@group_id,color=@color,favorite=@favorite,memo=@memo,tags=@tags,proxy_id=@proxy_id,inline_proxy=@inline_proxy,fingerprint=@fingerprint,settings=@settings,updated_at=@updated_at,last_open=@last_open,open_count=@open_count,owner=@owner,browser_dir=@browser_dir,os=@os,browser=@browser,country=@country,tz=@tz,screen=@screen,canvas=@canvas,os_family=@os_family,score=@score,issues=@issues`)
    .run({ id: p.id, name: p.name, group_id: p.group_id || '', color: p.color || '', favorite: p.favorite ? 1 : 0, memo: p.memo || '',
      tags: JSON.stringify(p.tags || []), proxy_id: p.proxy_id || '', inline_proxy: p.inline_proxy || '',
      fingerprint: JSON.stringify(p.fingerprint || {}), settings: JSON.stringify(p.settings || {}),
      created_at: p.created_at || now(), updated_at: p.updated_at || now(), last_open: p.last_open || 0, open_count: p.open_count || 0,
      owner: p.owner || 'me', browser_dir: p.browser_dir || '', ...d });
  return p;
}
export function deleteProfile(id) {
  prep('DELETE FROM profiles WHERE id=?').run(id);
  prep('DELETE FROM history WHERE profile_id=?').run(id);
  prep('DELETE FROM snapshots WHERE profile_id=?').run(id);
}
function rowToProfile(r) {
  return { ...r, tags: jparse(r.tags, []), fingerprint: jparse(r.fingerprint, {}), settings: jparse(r.settings, {}),
    favorite: !!r.favorite, created_at: r.created_at, updated_at: r.updated_at };
}

// ---------- groups ----------
export function listGroups() { return prep('SELECT * FROM groups ORDER BY name').all(); }
export function saveGroup(g) {
  const id = g.id || uid(8);
  assertSafeId(id, 'group id');
  prep('INSERT INTO groups(id,name,color,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color')
    .run(id, g.name, g.color || '', now());
  return prep('SELECT * FROM groups WHERE id=?').get(id);
}
export function deleteGroup(id) { prep('DELETE FROM groups WHERE id=?').run(id); prep("UPDATE profiles SET group_id='' WHERE group_id=?").run(id); }

// ---------- proxies ----------
export function listProxies() { return prep('SELECT * FROM proxies ORDER BY favorite DESC, created_at DESC').all(); }
export function getProxy(id) { return prep('SELECT * FROM proxies WHERE id=?').get(id) || null; }
export function saveProxy(px) {
  const id = px.id || uid(10);
  assertSafeId(id, 'proxy id');
  prep(`INSERT INTO proxies (id,label,scheme,host,port,user,pass,country,city,note,rotator,last_check,created_at,favorite)
    VALUES (@id,@label,@scheme,@host,@port,@user,@pass,@country,@city,@note,@rotator,@last_check,@created_at,@favorite)
    ON CONFLICT(id) DO UPDATE SET label=@label,scheme=@scheme,host=@host,port=@port,user=@user,pass=@pass,country=@country,city=@city,note=@note,rotator=@rotator,last_check=@last_check,favorite=@favorite`)
    .run({ id, label: px.label || `${px.host}:${px.port}`, scheme: px.scheme || 'http', host: px.host, port: +px.port, user: px.user || '', pass: px.pass || '',
      country: px.country || '', city: px.city || '', note: px.note || '', rotator: px.rotator ? 1 : 0, last_check: px.last_check || '',
      created_at: px.created_at || now(), favorite: px.favorite ? 1 : 0 });
  return prep('SELECT * FROM proxies WHERE id=?').get(id);
}
export function setProxyFavorite(id, val) { prep('UPDATE proxies SET favorite=? WHERE id=?').run(val ? 1 : 0, id); }
export function deleteProxy(id) { prep('DELETE FROM proxies WHERE id=?').run(id); prep("UPDATE profiles SET proxy_id='' WHERE proxy_id=?").run(id); }
export function deleteProxies(ids) { for (const id of ids) deleteProxy(id); }
export function clearProxies() { const all = prep('SELECT id FROM proxies').all(); for (const r of all) deleteProxy(r.id); }
export function countProxiesInUse() { return prep('SELECT COUNT(*) AS n FROM profiles WHERE proxy_id<>?').get('').n; }

// ---------- members ----------
export function listMembers() { return prep('SELECT * FROM members ORDER BY created_at').all().map(m => ({ ...m, pin_hash: undefined })); }
export function getMemberRaw(id) { return prep('SELECT * FROM members WHERE id=?').get(id) || null; }
export function getMemberByPinHash(pinHash) { return prep('SELECT * FROM members WHERE pin_hash=? AND active=1').get(pinHash) || null; }
// For scrypt (random salt) the hash can't be looked up directly — auth iterates active members.
export function listMembersForAuth() { return prep('SELECT * FROM members WHERE active=1').all(); }
export function setMemberPinHash(id, pinHash) { prep('UPDATE members SET pin_hash=? WHERE id=?').run(pinHash, id); }
export function saveMember(m) {
  const id = m.id || uid(8);
  assertSafeId(id, 'member id');
  prep(`INSERT INTO members(id,name,email,role,pin_hash,color,active,created_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,pin_hash=excluded.pin_hash,color=excluded.color,active=excluded.active`)
    .run(id, m.name, m.email || '', m.role || 'member', m.pin_hash || '', m.color || '#8b5cf6', m.active === false ? 0 : 1, m.created_at || now());
  return id;
}
export function deleteMember(id) { prep('DELETE FROM members WHERE id=?').run(id); }

// ---------- api keys ----------
export function listApiKeys() { return prep('SELECT * FROM apikeys ORDER BY created_at DESC').all(); }
export function checkApiKey(key) {
  const r = prep('SELECT * FROM apikeys WHERE key=?').get(key);
  if (r) prep('UPDATE apikeys SET last_used=? WHERE key=?').run(now(), key);
  return r || null;
}
export function createApiKey(label) { const key = 'mgk_' + uid(24); prep('INSERT INTO apikeys(key,label,created_at) VALUES(?,?,?)').run(key, label || 'key', now()); return { key, label, created_at: now() }; }
export function revokeApiKey(key) { prep('DELETE FROM apikeys WHERE key=?').run(key); }

// ---------- events / history / snapshots / flows ----------
export function logEvent(type, { profileId = '', member = '', meta = {} } = {}) {
  prep('INSERT INTO events(ts,type,profile_id,member,meta) VALUES(?,?,?,?,?)').run(now(), type, profileId, member, JSON.stringify(meta));
}
export function listEvents(limit = 200, type = '') {
  if (type) return prep('SELECT * FROM events WHERE type=? ORDER BY ts DESC LIMIT ?').all(type, limit);
  return prep('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit);
}
export function logHistory(profileId, url, title = '') {
  prep('INSERT INTO history(ts,profile_id,url,title) VALUES(?,?,?,?)').run(now(), profileId, url, title);
}
export function listHistory(profileId = '', limit = 100) {
  if (profileId) return prep('SELECT * FROM history WHERE profile_id=? ORDER BY ts DESC LIMIT ?').all(profileId, limit);
  return prep('SELECT * FROM history ORDER BY ts DESC LIMIT ?').all(limit);
}
export function saveSnapshot(profileId, cookies, localStorage, origin = '') {
  prep('INSERT INTO snapshots(id,profile_id,ts,cookies,local_storage,origin) VALUES(?,?,?,?,?,?)')
    .run(uid(10), profileId, now(), JSON.stringify(cookies), JSON.stringify(localStorage || {}), origin);
}
export function listSnapshots(profileId) { return prep('SELECT id,profile_id,ts,origin FROM snapshots WHERE profile_id=? ORDER BY ts DESC').all(profileId); }
export function getSnapshot(id) { const r = prep('SELECT * FROM snapshots WHERE id=?').get(id); return r && { ...r, cookies: jparse(r.cookies, []), local_storage: jparse(r.local_storage, {}) }; }
export function deleteSnapshot(id) { prep('DELETE FROM snapshots WHERE id=?').run(id); }
export function saveFlow(f) { assertSafeId(f.id, 'flow id'); prep('INSERT INTO flows(id,name,profile_id,steps,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,profile_id=excluded.profile_id,steps=excluded.steps').run(f.id, f.name, f.profile_id || '', JSON.stringify(f.steps || []), f.created_at || now()); }
export function listFlows() { return prep('SELECT * FROM flows ORDER BY created_at DESC').all().map(f => ({ ...f, steps: jparse(f.steps, []) })); }
export function getFlow(id) { const f = prep('SELECT * FROM flows WHERE id=?').get(id); return f && { ...f, steps: jparse(f.steps, []) }; }
export function deleteFlow(id) { prep('DELETE FROM flows WHERE id=?').run(id); }

// ---------- seed ----------
function seedIfEmpty() {
  const count = prep('SELECT COUNT(*) c FROM profiles').get().c;
  if (count === 0) {
    kvSet('boot', { firstRun: now() });
    // default admin member
    const hasMembers = prep('SELECT COUNT(*) c FROM members').get().c;
    if (!hasMembers) {
      // No publicly-known default PIN (C5): generate a random one-time admin PIN, store it with a
      // salted scrypt hash, and print it once at first run. The operator MUST change it in Settings.
      const adminPin = String(crypto.randomInt(100000, 1000000));
      prep('INSERT INTO members(id,name,email,role,pin_hash,color,active,created_at) VALUES(?,?,?,?,?,?,1,?)')
        .run('me', 'Owner', 'owner@local', 'admin', hashPin(adminPin), '#22d3ee', now());
      console.log('\x1b[33m[mirage] FIRST RUN — temporary admin PIN:\x1b[0m ' + adminPin + '  \x1b[31m(change it immediately; shown only once)\x1b[0m');
    }
    const g1 = saveGroup({ name: 'Affiliate', color: '#22d3ee' });
    const g2 = saveGroup({ name: 'E-commerce', color: '#a78bfa' });
    const g3 = saveGroup({ name: 'SMM', color: '#f59e0b' });
    globalThis.__mirageSeedGroups = { Affiliate: g1.id, 'E-commerce': g2.id, SMM: g3.id };
  }
}
