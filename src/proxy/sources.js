// Mirage — free public proxy-list sources + fetcher.
// Pulls raw proxy text from well-known community lists, parses it with ./parse.js,
// and (optionally) verifies each proxy with ./checker.js. Every source is best-effort:
// failures are isolated so one dead list never breaks the whole fetch.

import { parseProxyList, proxyKey } from './parse.js';

// Curated public lists that expose raw "one proxy per line" text. types = what they contain.
export const SOURCES = [
  { id: 'thefspeedx-http', label: 'TheSpeedX · HTTP', type: 'http', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt' },
  { id: 'thefspeedx-socks5', label: 'TheSpeedX · SOCKS5', type: 'socks5', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt' },
  { id: 'shiftytr-http', label: 'ShiftyTR · HTTP', type: 'http', url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt' },
  { id: 'shiftytr-socks5', label: 'ShiftyTR · SOCKS5', type: 'socks5', url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt' },
  { id: 'monosans-http', label: 'monosans · HTTP', type: 'http', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
  { id: 'monosans-socks5', label: 'monosans · SOCKS5', type: 'socks5', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt' },
  { id: 'clarketm-http', label: 'clarketm · HTTP', type: 'http', url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt' },
  { id: 'murongpig-http', label: 'MuRongPIG · HTTP', type: 'http', url: 'https://raw.githubusercontent.com/MuRongPIG/Proxy-List/main/http.txt' },
  { id: 'murongpig-socks5', label: 'MuRongPIG · SOCKS5', type: 'socks5', url: 'https://raw.githubusercontent.com/MuRongPIG/Proxy-List/main/socks5.txt' },
  { id: 'proxylistdl-http', label: 'proxy-list.download · HTTP', type: 'http', url: 'https://www.proxy-list.download/api/v1/get?type=http' },
  { id: 'proxylistdl-socks5', label: 'proxy-list.download · SOCKS5', type: 'socks5', url: 'https://www.proxy-list.download/api/v1/get?type=socks5' },
  { id: 'openproxylist-http', label: 'openproxylist · HTTP', type: 'http', url: 'https://api.openproxylist.xyz/http.txt' },
  { id: 'openproxylist-socks5', label: 'openproxylist · SOCKS5', type: 'socks5', url: 'https://api.openproxylist.xyz/socks5.txt' },
];

export function listSources() {
  return SOURCES.map(s => ({ id: s.id, label: s.label, type: s.type, url: s.url }));
}

async function getText(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mirage-Probe/1.0', 'Accept': 'text/plain,*/*' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

/**
 * Fetch and parse proxies.
 * @param {object} opts
 *  - sources: array of SOURCES ids (or full source objects)
 *  - urls: array of extra raw-list URLs to also try
 *  - types: e.g. ['http','socks5'] — keep only these schemes (default: all)
 *  - limit: max total proxies to return (default 300)
 * @returns {Promise<{proxies:object[], perSource:object[], errors:string[]}>}
 */
export async function fetchProxies({ sources = [], urls = [], types = null, limit = 300 } = {}) {
  const wantedTypes = (types && types.length) ? new Set(types.map(t => String(t).toLowerCase())) : null;
  const jobs = [];
  for (const id of sources) {
    const s = typeof id === 'object' ? id : SOURCES.find(x => x.id === id);
    if (s) jobs.push({ label: s.label || s.url, url: s.url, fixedType: s.type });
  }
  for (const u of urls) jobs.push({ label: u, url: u, fixedType: null });

  const seen = new Set();
  const proxies = [];
  const perSource = [];
  const errors = [];

  await Promise.all(jobs.map(async (job) => {
    try {
      const text = await getText(job.url);
      let parsed = parseProxyList(text);
      if (job.fixedType) parsed = parsed.map(p => ({ ...p, scheme: job.fixedType })); // honor the source's declared type
      if (wantedTypes) parsed = parsed.filter(p => wantedTypes.has(p.scheme));
      let added = 0;
      for (const p of parsed) {
        if (proxies.length >= limit) break;
        const k = proxyKey(p);
        if (seen.has(k)) continue;
        seen.add(k); proxies.push({ ...p, source: job.label }); added++;
      }
      perSource.push({ source: job.label, found: parsed.length, added });
    } catch (e) { errors.push(`${job.label}: ${e.message}`); perSource.push({ source: job.label, found: 0, added: 0, error: e.message }); }
  }));

  return { proxies: proxies.slice(0, limit), perSource, errors };
}
