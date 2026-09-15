// Mirage — shared proxy-line parser (stdlib only).
// Handles the common formats found in public lists and vendor exports:
//   socks5://user:pass@1.2.3.4:1080
//   http://host:8080
//   user:pass@1.2.3.4:8080
//   1.2.3.4:8080
//   1.2.3.4:8080:user:pass
//   1.2.3.4:8080:user:pass:socks5
//   1.2.3.4:8080:socks5
// Returns {scheme,host,port,user,pass} or null. Never throws.

const SCHEMES = new Set(['http', 'https', 'socks5', 'socks4']);
function normScheme(s) {
  s = (s || '').toLowerCase();
  if (!s) return 'http';
  if (s === 'socks' || s === 'socks5' || s === 'socks5h') return 'socks5';
  if (s === 'socks4' || s === 'socks4a') return 'socks4';
  return SCHEMES.has(s) ? s : 'http';
}
const validPort = (p) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535;
// IPv6 literal: [::1]:1080 — the bracket group is kept intact as host
function hostOk(h) {
  return /^\[?[^\s:/\]]+\]?$/.test(h);
}

export function parseProxyLine(raw) {
  if (!raw) return null;
  let line = String(raw).trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;
  line = line.replace(/\s+/g, '');
  let scheme = 'http', user = '', pass = '', host = '', port = '';

  // 1) scheme://[user[:pass]@]host:port
  let m = line.match(/^([a-z0-9]+):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?(\[[0-9a-f:.]+\]|[^:/@]+):(\d{1,5})\/?(?:[/?#].*)?$/i);
  if (m) {
    scheme = normScheme(m[1]);
    user = m[2] || ''; pass = m[3] || ''; host = m[4]; port = m[5];
    if (!validPort(port)) return null;
    return { scheme, host, port: +port, user, pass };
  }

  // 2) user:pass@host:port[:scheme]
  m = line.match(/^(?:([^:@]+):([^@]+)@)(\[[0-9a-f:.]+\]|[^:/@]+):(\d{1,5})(?::([a-z0-9]+))?$/i);
  if (m) {
    user = m[1] || ''; pass = m[2] || ''; host = m[3]; port = m[4]; scheme = normScheme(m[5]);
    if (!validPort(port)) return null;
    return { scheme, host, port: +port, user, pass };
  }

  // 3) host:port[:user[:pass]][(:scheme)]   (user:pass with optional trailing scheme)
  m = line.match(/^(\[[0-9a-f:.]+\]|[^:/@]+):(\d{1,5})(?::([^:]*):?([^:]*))?(?::([a-z0-9]+))?$/i);
  if (m) {
    host = m[1]; port = m[2];
    let u = m[3] || '', p = m[4] || ''; const trail = m[5] || '';
    // trailing token is a scheme only if it is non-numeric and known
    if (trail) scheme = normScheme(trail);
    else if (u && !p && !SCHEMES.has(u.toLowerCase())) { /* keep u as user */ }
    if (!validPort(port) || !hostOk(host)) return null;
    return { scheme, host, port: +port, user: decodeURIComponent(u || ''), pass: decodeURIComponent(p || '') };
  }
  return null;
}

export function parseProxyList(text) {
  const out = [];
  for (const ln of String(text || '').split(/\r?\n/)) {
    const p = parseProxyLine(ln);
    if (p) out.push(p);
  }
  return out;
}

export function proxyKey(p) { return `${p.scheme}|${p.host}|${p.port}|${p.user || ''}`; }
export function formatProxyLine(p) {
  const auth = p.user ? `${p.user}:${p.pass || ''}@` : '';
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}
