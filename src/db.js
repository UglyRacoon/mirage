// Mirage — SQLite persistence layer (node:sqlite, sync, WAL)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { uid, now, jparse, sha256 } from './util.js';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, group_id TEXT DEFAULT '',
  color TEXT DEFAULT '', favorite INTEGER DEFAULT 0, memo TEXT DEFAULT '',
  tags TEXT DEFAULT '[]', proxy_id TEXT DEFAULT '', inline_proxy TEXT DEFAULT '',
  fingerprint TEXT DEFAULT '{}', settings TEXT DEFAULT '{}',
  created_at INTEGER, updated_at INTEGER, last_open INTEGER DEFAULT 0, open_count INTEGER DEFAULT 0,
  owner TEXT DEFAULT 'me', browser_dir TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS groups ( id TEXT PRIMARY KEY, name TEXT, color TEXT DEFAULT '', created_at INTEGER );
CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY, label TEXT, scheme TEXT, host TEXT, port INTEGER, user TEXT DEFAULT '', pass TEXT DEFAULT '',
  country TEXT DEFAULT '', city TEXT DEFAULT '', note TEXT DEFAULT '', rotator INTEGER DEFAULT 0,
  last_check TEXT DEFAULT '', created_at INTEGER
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
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seedIfEmpty();
  return db;
}
export function getDb() { return db; }

export function kvGet(key, fb = null) {
  const r = db.prepare('SELECT v FROM kv WHERE k=?').get(key);
  return r ? jparse(r.v, fb) : fb;
}
export function kvSet(key, val) {
  db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(key, JSON.stringify(val));
}

// ---------- profiles ----------
export function listProfiles() {
  return db.prepare('SELECT * FROM profiles ORDER BY updated_at DESC').all().map(rowToProfile);
}
export function getProfile(id) {
  const r = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
  return r ? rowToProfile(r) : null;
}
export function saveProfile(p) {
  p.updated_at = now();
  db.prepare(`INSERT INTO profiles (id,name,group_id,color,favorite,memo,tags,proxy_id,inline_proxy,fingerprint,settings,created_at,updated_at,last_open,open_count,owner,browser_dir)
    VALUES (@id,@name,@group_id,@color,@favorite,@memo,@tags,@proxy_id,@inline_proxy,@fingerprint,@settings,@created_at,@updated_at,@last_open,@open_count,@owner,@browser_dir)
    ON CONFLICT(id) DO UPDATE SET name=@name,group_id=@group_id,color=@color,favorite=@favorite,memo=@memo,tags=@tags,proxy_id=@proxy_id,inline_proxy=@inline_proxy,fingerprint=@fingerprint,settings=@settings,updated_at=@updated_at,last_open=@last_open,open_count=@open_count,owner=@owner,browser_dir=@browser_dir`)
    .run({ id: p.id, name: p.name, group_id: p.group_id || '', color: p.color || '', favorite: p.favorite ? 1 : 0, memo: p.memo || '',
      tags: JSON.stringify(p.tags || []), proxy_id: p.proxy_id || '', inline_proxy: p.inline_proxy || '',
      fingerprint: JSON.stringify(p.fingerprint || {}), settings: JSON.stringify(p.settings || {}),
      created_at: p.created_at || now(), updated_at: p.updated_at || now(), last_open: p.last_open || 0, open_count: p.open_count || 0,
      owner: p.owner || 'me', browser_dir: p.browser_dir || '' });
  return p;
}
export function deleteProfile(id) {
  db.prepare('DELETE FROM profiles WHERE id=?').run(id);
  db.prepare('DELETE FROM history WHERE profile_id=?').run(id);
  db.prepare('DELETE FROM snapshots WHERE profile_id=?').run(id);
}
function rowToProfile(r) {
  return { ...r, tags: jparse(r.tags, []), fingerprint: jparse(r.fingerprint, {}), settings: jparse(r.settings, {}),
    favorite: !!r.favorite, created_at: r.created_at, updated_at: r.updated_at };
}

// ---------- groups ----------
export function listGroups() { return db.prepare('SELECT * FROM groups ORDER BY name').all(); }
export function saveGroup(g) {
  const id = g.id || uid(8);
  db.prepare('INSERT INTO groups(id,name,color,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color')
    .run(id, g.name, g.color || '', now());
  return db.prepare('SELECT * FROM groups WHERE id=?').get(id);
}
export function deleteGroup(id) { db.prepare('DELETE FROM groups WHERE id=?').run(id); db.prepare("UPDATE profiles SET group_id='' WHERE group_id=?").run(id); }

// ---------- proxies ----------
export function listProxies() { return db.prepare('SELECT * FROM proxies ORDER BY created_at DESC').all(); }
export function getProxy(id) { return db.prepare('SELECT * FROM proxies WHERE id=?').get(id) || null; }
export function saveProxy(px) {
  const id = px.id || uid(10);
  db.prepare(`INSERT INTO proxies (id,label,scheme,host,port,user,pass,country,city,note,rotator,last_check,created_at)
    VALUES (@id,@label,@scheme,@host,@port,@user,@pass,@country,@city,@note,@rotator,@last_check,@created_at)
    ON CONFLICT(id) DO UPDATE SET label=@label,scheme=@scheme,host=@host,port=@port,user=@user,pass=@pass,country=@country,city=@city,note=@note,rotator=@rotator,last_check=@last_check`)
    .run({ id, label: px.label || `${px.host}:${px.port}`, scheme: px.scheme || 'http', host: px.host, port: +px.port, user: px.user || '', pass: px.pass || '',
      country: px.country || '', city: px.city || '', note: px.note || '', rotator: px.rotator ? 1 : 0, last_check: px.last_check || '', created_at: px.created_at || now() });
  return db.prepare('SELECT * FROM proxies WHERE id=?').get(id);
}
export function deleteProxy(id) { db.prepare('DELETE FROM proxies WHERE id=?').run(id); db.prepare("UPDATE profiles SET proxy_id='' WHERE proxy_id=?").run(id); }

// ---------- members ----------
export function listMembers() { return db.prepare('SELECT * FROM members ORDER BY created_at').all().map(m => ({ ...m, pin_hash: undefined })); }
export function getMemberRaw(id) { return db.prepare('SELECT * FROM members WHERE id=?').get(id) || null; }
export function getMemberByPinHash(pinHash) { return db.prepare('SELECT * FROM members WHERE pin_hash=? AND active=1').get(pinHash) || null; }
export function saveMember(m) {
  const id = m.id || uid(8);
  db.prepare(`INSERT INTO members(id,name,email,role,pin_hash,color,active,created_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,pin_hash=excluded.pin_hash,color=excluded.color,active=excluded.active`)
    .run(id, m.name, m.email || '', m.role || 'member', m.pin_hash || '', m.color || '#8b5cf6', m.active === false ? 0 : 1, m.created_at || now());
  return id;
}
export function deleteMember(id) { db.prepare('DELETE FROM members WHERE id=?').run(id); }

// ---------- api keys ----------
export function listApiKeys() { return db.prepare('SELECT * FROM apikeys ORDER BY created_at DESC').all(); }
export function checkApiKey(key) {
  const r = db.prepare('SELECT * FROM apikeys WHERE key=?').get(key);
  if (r) db.prepare('UPDATE apikeys SET last_used=? WHERE key=?').run(now(), key);
  return r || null;
}
export function createApiKey(label) { const key = 'mgk_' + uid(24); db.prepare('INSERT INTO apikeys(key,label,created_at) VALUES(?,?,?)').run(key, label || 'key', now()); return { key, label, created_at: now() }; }
export function revokeApiKey(key) { db.prepare('DELETE FROM apikeys WHERE key=?').run(key); }

// ---------- events / history / snapshots / flows ----------
export function logEvent(type, { profileId = '', member = '', meta = {} } = {}) {
  db.prepare('INSERT INTO events(ts,type,profile_id,member,meta) VALUES(?,?,?,?,?)').run(now(), type, profileId, member, JSON.stringify(meta));
}
export function listEvents(limit = 200, type = '') {
  if (type) return db.prepare('SELECT * FROM events WHERE type=? ORDER BY ts DESC LIMIT ?').all(type, limit);
  return db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit);
}
export function logHistory(profileId, url, title = '') {
  db.prepare('INSERT INTO history(ts,profile_id,url,title) VALUES(?,?,?,?)').run(now(), profileId, url, title);
}
export function listHistory(profileId = '', limit = 100) {
  if (profileId) return db.prepare('SELECT * FROM history WHERE profile_id=? ORDER BY ts DESC LIMIT ?').all(profileId, limit);
  return db.prepare('SELECT * FROM history ORDER BY ts DESC LIMIT ?').all(limit);
}
export function saveSnapshot(profileId, cookies, localStorage, origin = '') {
  db.prepare('INSERT INTO snapshots(id,profile_id,ts,cookies,local_storage,origin) VALUES(?,?,?,?,?,?)')
    .run(uid(10), profileId, now(), JSON.stringify(cookies), JSON.stringify(localStorage || {}), origin);
}
export function listSnapshots(profileId) { return db.prepare('SELECT id,profile_id,ts,origin FROM snapshots WHERE profile_id=? ORDER BY ts DESC').all(profileId); }
export function getSnapshot(id) { const r = db.prepare('SELECT * FROM snapshots WHERE id=?').get(id); return r && { ...r, cookies: jparse(r.cookies, []), local_storage: jparse(r.local_storage, {}) }; }
export function deleteSnapshot(id) { db.prepare('DELETE FROM snapshots WHERE id=?').run(id); }
export function saveFlow(f) { db.prepare('INSERT INTO flows(id,name,profile_id,steps,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,profile_id=excluded.profile_id,steps=excluded.steps').run(f.id, f.name, f.profile_id || '', JSON.stringify(f.steps || []), f.created_at || now()); }
export function listFlows() { return db.prepare('SELECT * FROM flows ORDER BY created_at DESC').all().map(f => ({ ...f, steps: jparse(f.steps, []) })); }
export function getFlow(id) { const f = db.prepare('SELECT * FROM flows WHERE id=?').get(id); return f && { ...f, steps: jparse(f.steps, []) }; }
export function deleteFlow(id) { db.prepare('DELETE FROM flows WHERE id=?').run(id); }

// ---------- seed ----------
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) c FROM profiles').get().c;
  if (count === 0) {
    kvSet('boot', { firstRun: now() });
    // default admin member
    const hasMembers = db.prepare('SELECT COUNT(*) c FROM members').get().c;
    if (!hasMembers) {
      db.prepare('INSERT INTO members(id,name,email,role,pin_hash,color,active,created_at) VALUES(?,?,?,?,?,?,1,?)')
        .run('me', 'Owner', 'owner@local', 'admin', sha256('mirage'), '#22d3ee', now());
    }
    const g1 = saveGroup({ name: 'Affiliate', color: '#22d3ee' });
    const g2 = saveGroup({ name: 'E-commerce', color: '#a78bfa' });
    const g3 = saveGroup({ name: 'SMM', color: '#f59e0b' });
    globalThis.__mirageSeedGroups = { Affiliate: g1.id, 'E-commerce': g2.id, SMM: g3.id };
  }
}
