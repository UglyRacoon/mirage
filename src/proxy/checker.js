// Mirage — bulk proxy verification with a bounded worker pool.
import { probeProxy } from './probe.js';

/**
 * Probe a list of proxies concurrently (default 6 at a time).
 * @param {Array} proxies objects with {scheme,host,port,user,pass}
 * @param {object} opts { concurrency=6, onEach(resultItem, index, total) }
 * @returns {Promise<Array<{proxy, result}>>} results aligned to the input order
 */
export async function bulkProbe(proxies, { concurrency = 6, onEach } = {}) {
  const items = Array.from(proxies || []);
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      let res;
      try { res = await probeProxy(items[i]); }
      catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      results[i] = { proxy: items[i], result: res };
      try { onEach && onEach(results[i], i, items.length); } catch (e) { }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  const alive = results.filter(r => r.result && r.result.ok).length;
  return { results, total: items.length, alive, dead: items.length - alive };
}
