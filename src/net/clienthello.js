// Mirage — TLS ClientHello parser → JA3 / JA4 fingerprints.
// A TLS ClientHello is transmitted in PLAINTEXT at the very start of a connection, so we can
// observe a browser's real network signature by simply reading the first bytes of a socket the
// kernel connects to — no MITM, no CA, works offline. This is the honest way to KNOW your JA3.
// (Shaping it — injecting GREASE or reordering extensions — requires a custom TLS stack/kernel,
//  which is documented as the real moat in the README.)
import crypto from 'node:crypto';

const grease = (v) => (v & 0xff) === ((v >> 8) & 0xff) && [0x0a, 0x1a, 0x2a, 0x3a, 0x4a, 0x5a, 0x6a, 0x7a, 0x8a, 0x9a, 0xaa, 0xba, 0xca, 0xda, 0xea, 0xfa].includes(v & 0x0f);

function stripGrease(list) { return list.filter(v => !grease(v)); }

/**
 * Parse a TLS record buffer's first handshake (must be a ClientHello).
 * @param {Buffer} buf raw bytes beginning of the connection
 * @returns {null | object}
 */
export function parseClientHello(buf) {
  try {
    if (!buf || buf.length < 44 || buf[0] !== 0x16) return null;   // 0x16 = handshake record
    const recordLen = buf.readUInt16BE(3);
    let o = 5;                                                       // handshake header
    if (buf[o] !== 0x01) return null;                                // handshake_type = client_hello
    o += 4;                                                          // type + 3-byte length
    const legacyVersion = buf.readUInt16BE(o); o += 2;               // 0x0303 typically
    o += 32;                                                         // random
    const sidLen = buf[o]; o += 1 + sidLen;                          // session id
    const csLen = buf.readUInt16BE(o); o += 2;                       // cipher suites
    const ciphers = [];
    for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(o + i));
    o += csLen;
    const compLen = buf[o]; o += 1 + compLen;                        // compression methods
    const extTotal = buf.readUInt16BE(o); o += 2;                    // extensions
    const extEnd = o + extTotal;
    const extensions = []; let supportedVersions = [], curves = [], pointFormats = [], alpn = [], sni = null, hasGrease = false;
    while (o + 4 <= extEnd && o + 4 <= buf.length) {
      const et = buf.readUInt16BE(o); const el = buf.readUInt16BE(o + 2); o += 4;
      if (grease(et)) hasGrease = true; else if (!extensions.includes(et)) extensions.push(et);
      const data = buf.subarray(o, o + el); o += el;
      try {
        if (et === 0x0000) { /* SNI */ const nl = data.readUInt16BE(3); sni = data.subarray(5, 5 + nl).toString('latin1'); }
        else if (et === 0x000a) { const gl = data.readUInt16BE(0); for (let i = 2; i < 2 + gl; i += 2) { const g = data.readUInt16BE(i); if (!grease(g)) curves.push(g); } }
        else if (et === 0x000b) { const pl = data[0]; for (let i = 1; i <= pl; i++) pointFormats.push(data[i]); }
        else if (et === 0x0010) { let p = 2; while (p < data.length) { const l = data[p]; if (!l) break; alpn.push(data.subarray(p + 1, p + 1 + l).toString('latin1')); p += 1 + l; } }
        else if (et === 0x002f) { const vl = data[0]; for (let i = 1; i < vl; i += 2) { const v = data.readUInt16BE(i); if (!grease(v)) supportedVersions.push(v); } }
      } catch (e) { }
    }
    const version = supportedVersions.length ? Math.max(...supportedVersions) : legacyVersion;
    const extsSorted = extensions.slice().sort((a, b) => a - b);
    const buildJA3 = (cs, ex, cv, pf) => `${version},${cs.join('-')},${ex.join(',')},${cv.join(',')},${pf.join(',')}`;
    const ja3 = buildJA3(ciphers, extsSorted, curves, pointFormats);
    const ja3Clean = buildJA3(stripGrease(ciphers), stripGrease(extsSorted), curves, pointFormats);
    // JA4 (draft): protocol+tlsver+SNIs+algo+ALPN, then a hash of the sorted cipher list and sorted ext list.
    const proto = buf.length ? 'tn' : 'tn';
    const verTag = version >= 0x0304 ? '13' : version >= 0x0303 ? '12' : version >= 0x0302 ? '11' : 's3';
    const csClean = stripGrease(ciphers);
    const extClean = stripGrease(extsSorted);
    const jA4Head = `ja4_${proto}${verTag}${sni ? 'd' : 'i'}${Math.min(csClean.length, 255).toString(36).padStart(2, '0')}${Math.min(extClean.length, 255).toString(36).padStart(2, '0')}`;
    const alpnTag = (alpn.find(a => a === 'h3') ? 'h3' : alpn.find(a => a === 'h2') ? 'h2' : alpn[0] ? 'xx' : '00');
    const jA4 = `${jA4Head}${alpnTag}000_${crypto.createHash('sha256').update(csClean.join(',') + ',').digest('hex').slice(0, 12)}_${crypto.createHash('sha256').update((sni ? 'abcdefghijklmnop' : '000000') + ',' + extClean.join(',') + ',').digest('hex').slice(0, 12)}`;
    return {
      ja3, ja3Hash: crypto.createHash('md5').update(ja3).digest('hex'),
      ja3Clean, ja3CleanHash: crypto.createHash('md5').update(ja3Clean).digest('hex'),
      ja4: jA4, version, supportedVersions, ciphers, extensions: extsSorted, curves, pointFormats, alpn, sni, grease: hasGrease,
      cipherHex: ciphers.map(c => '0x' + c.toString(16).padStart(4, '0')),
    };
  } catch (e) { return null; }
}
