// Mirage — Device-DNA: encrypted, portable identity export/import.
// A "Device-DNA" is the complete anti-detect identity (fingerprint + profile metadata) serialized
// and sealed with a user passphrase (PBKDF2 + AES-256-GCM). It can be backed up or moved between
// Mirage servers without ever exposing the raw identity in transit or at rest.
import crypto from 'node:crypto';

const PBKDF2_ITERS = 150000;

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function unb64(s) { return Buffer.from(s, 'base64'); }

/** Seal an object with a passphrase. Returns a self-describing JSON-able envelope. */
export function sealDNA(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(String(passphrase), salt, PBKDF2_ITERS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = Buffer.from(JSON.stringify(obj));
  const ct = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1, alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iter: PBKDF2_ITERS,
    salt: b64(salt), iv: b64(iv), tag: b64(tag), ct: b64(ct),
    hint: 'Mirage Device-DNA — decrypt with the same passphrase',
  };
}

/** Open an envelope produced by sealDNA. Throws on wrong passphrase / tamper. */
export function openDNA(env, passphrase) {
  if (!env || env.v !== 1 || !env.ct || !env.salt || !env.iv || !env.tag) throw new Error('not a Mirage Device-DNA envelope');
  const salt = unb64(env.salt), iv = unb64(env.iv), tag = unb64(env.tag), ct = unb64(env.ct);
  const key = crypto.pbkdf2Sync(String(passphrase), salt, env.iter || PBKDF2_ITERS, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let json;
  try { json = Buffer.concat([decipher.update(ct), decipher.final()]); }
  catch (e) { throw new Error('decryption failed — wrong passphrase or tampered DNA'); }
  return JSON.parse(json.toString('utf8'));
}

/** Short, human-checkable fingerprint of the DNA contents (for the UI to show a "checksum"). */
export function dnaThumb(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}
