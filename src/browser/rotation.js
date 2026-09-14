// Mirage — fingerprint rotation scheduler with cookie/storage memory.
// A "rotation" regenerates the profile's device identity (seed + optional device model) while
// LEAVING the cookie jar and localStorage untouched — so a logged-in session survives a fingerprint
// change. The browser kernel restores cookies at launch, so memory is preserved by construction.
import { now } from '../util.js';

const HOUR = 3600 * 1000;

/**
 * Build a new fingerprint for the same persona but with a fresh seed (and optionally a new device
 * model). OS / browser / region / proxy are preserved so the rotation stays "the same account,
 * new device" rather than "a different person". Pure — safe to unit test.
 * @param {object} fp current fingerprint
 * @param {object} cfg { rotateModel?: boolean }
 * @param {string} seed new seed
 * @param {function} generateFingerprint
 */
export function buildRotatedFingerprint(fp, cfg, seed, generateFingerprint) {
  return generateFingerprint({
    os: fp.osId, browser: fp.browser, country: fp.meta && fp.meta.region, seed,
    modelId: cfg.rotateModel ? undefined : fp.deviceModel || undefined,
  });
}


/**
 * @param {object} ctx { db, bm, generateFingerprint, randomSeed }
 */
export function createRotator(ctx) {
  const { db, bm, generateFingerprint, randomSeed } = ctx;
  let timer = null;

  async function rotateNow(profileId) {
    const pr = db.getProfile(profileId);
    if (!pr) throw new Error('profile not found');
    const fp = pr.fingerprint || {};
    const cfg = (pr.settings && pr.settings.rotation) || {};
    // preserve the live cookie jar before we touch anything
    let cookiesPreserved = 0;
    try {
      if (bm.isRunning(profileId)) { const snap = await bm.snapshot(profileId); cookiesPreserved = snap.cookies || 0; }
    } catch (e) { }

    const seed = randomSeed();
    const ng = buildRotatedFingerprint(fp, cfg, seed, generateFingerprint);

    pr.fingerprint = ng;
    pr.settings = pr.settings || {};
    pr.settings.rotation = Object.assign({}, pr.settings.rotation, { lastRotateAt: now(), rotations: (pr.settings.rotation && pr.settings.rotation.rotations || 0) + 1 });
    db.saveProfile(pr);
    db.logEvent('rotate', { profileId, meta: { seed, cookiesPreserved, rotateModel: !!cfg.rotateModel, region: fp.meta && fp.meta.region } });
    return { seed, cookiesPreserved, fingerprint: ng };
  }

  async function tick() {
    for (const pr of db.listProfiles()) {
      const cfg = pr.settings && pr.settings.rotation;
      if (!cfg || !cfg.enabled || !cfg.intervalHours) continue;
      if (now() - (cfg.lastRotateAt || 0) >= cfg.intervalHours * HOUR) {
        try { await rotateNow(pr.id); } catch (e) { }
      }
    }
  }

  return {
    rotateNow,
    start() { if (!timer) timer = setInterval(() => tick().catch(() => { }), 60 * 1000); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
