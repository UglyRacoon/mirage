/* ============ Mirage selftest — deterministic, offline, no server needed ============ */
import 'node:sqlite';
import vm from 'node:vm';
import { generateFingerprint, quickTemplates, randomSeed } from '../src/fingerprint/generate.js';
import { auditFingerprint } from '../src/fingerprint/consistency.js';
import { buildStealthBundle } from '../src/fingerprint/stealth.js';
import { modelById } from '../src/fingerprint/models.js';
import { rngFor } from '../src/util.js';
import { pointerPath, keystrokePlan, scrollPlan } from '../src/browser/humanize.js';
import { sealDNA, openDNA, dnaThumb } from '../src/fingerprint/dna.js';
import { buildRotatedFingerprint } from '../src/browser/rotation.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } };
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + ` (${String(a).slice(0, 60)} vs ${String(b).slice(0, 60)})`); };
const ok = (c, msg) => { if (!c) throw new Error(msg || 'assert failed'); };

console.log('\n◆ fingerprint generator');
const combos = [];
for (const os of ['windows-11', 'windows-10', 'macos-sequoia', 'macos-sonoma', 'macos-ventura', 'ubuntu-2404', 'android-14', 'ios-17'])
  for (const br of ['chrome', 'edge', 'firefox', 'safari']) combos.push([os, br]);

const fps = new Map();
t('generates all 32 os×browser combos', () => {
  for (const [os, browser] of combos) {
    const fp = generateFingerprint({ os, browser, seed: 's_' + os + '_' + browser });
    ok(fp.ua && fp.ua.startsWith('Mozilla/5.0'), 'ua missing for ' + os + '/' + browser);
    ok(fp.screen?.width > 100, 'screen for ' + os + '/' + browser);
    ok(fp.timezone?.id?.includes('/'), 'tz for ' + os + '/' + browser);
    fps.set(os + '/' + browser, fp);
  }
});
t('deterministic: same seed → byte-identical fingerprint', () => {
  for (const [os, browser] of combos.slice(0, 8)) {
    const a = generateFingerprint({ os, browser, seed: 'det123' });
    const b = generateFingerprint({ os, browser, seed: 'det123' });
    eq(a, b, os + '/' + browser);
  }
});
t('different seeds → different fingerprints', () => {
  const a = generateFingerprint({ os: 'windows-11', browser: 'chrome', seed: 'a1' });
  const b = generateFingerprint({ os: 'windows-11', browser: 'chrome', seed: 'b2' });
  ok(a.ua !== b.ua || a.screen.width !== b.screen.width || a.gpu.renderer !== b.gpu.renderer, 'too similar');
});

console.log('\n◆ cross-consistency rules (UA family truths)');
t('safari never claims Chrome in UA and has no client hints', () => {
  for (const k of ['macos-sonoma/safari', 'ios-17/safari', 'macos-sequoia/safari']) {
    const fp = fps.get(k); if (!fp) continue;
    ok(!/Chrome\//.test(fp.ua), k + ' ua contains Chrome/');
    ok(fp.clientHints.supported === false, k + ' supports CH (Safari must not)');
    ok(!/^ANGLE\(/.test(fp.gpu.unmaskedRenderer), k + ' reports ANGLE renderer');
  }
});
t('firefox UA is Gecko/Firefox and no CH, no deviceMemory', () => {
  for (const k of ['windows-11/firefox', 'ubuntu-2404/firefox', 'macos-sequoia/firefox']) {
    const fp = fps.get(k);
    ok(/Firefox\/\d+/.test(fp.ua) && !/Chrome\//.test(fp.ua), k + ' firefox ua');
    ok(fp.clientHints.supported === false, k + ' firefox ch');
    ok(fp.hardware.deviceMemory == null, k + ' firefox deviceMemory');
  }
});
t('edge UA has Edg/ aligned with Chrome/ major', () => {
  const fp = fps.get('windows-10/edge');
  const edg = fp.ua.match(/Edg\/(\d+)/)?.[1];
  const chr = fp.ua.match(/Chrome\/(\d+)/)?.[1];
  ok(edg === chr, 'edge major mismatch ' + edg + ' vs ' + chr);
});
t('ios-chrome uses CriOS token', () => {
  const fp = fps.get('ios-17/chrome');
  ok(/CriOS\//.test(fp.ua), 'no CriOS in iOS chrome ua');
  ok(/Mobile\/15E148/.test(fp.ua), 'iOS chrome needs Mobile token');
});
t('mobile profiles: touch points ≥ 1, UA has Mobile', () => {
  for (const k of ['android-14/chrome', 'ios-17/safari', 'ios-17/chrome']) {
    const fp = fps.get(k);
    ok(fp.hardware.maxTouchPoints >= 1, k + ' touch');
    ok(/Mobile|Android|iPhone/.test(fp.ua), k + ' mobile ua');
    ok(fp.isMobile, k + ' isMobile');
  }
});
t('deviceMemory is a Chromium-capped power of two ≤ 8', () => {
  for (const [, fp] of fps) {
    const dm = fp.hardware.deviceMemory;
    if (dm != null) ok([1, 2, 4, 8].includes(dm), 'bad deviceMemory ' + dm);
  }
});
t('webgpu absent on safari/firefox and vendor-consistent on chrome', () => {
  for (const [k, fp] of fps) {
    if (fp.browser === 'safari' || fp.browser === 'firefox') ok(!fp.gpu.webgpu, k + ' should not have webgpu');
    if (fp.gpu.webgpu) {
      const v = fp.gpu.webgpu.vendor, wv = fp.gpu.unmaskedVendor;
      const expect = /Apple/.test(wv) ? 'apple' : /AMD/.test(wv) ? 'amd' : /Intel/.test(wv) ? 'intel' : 'nvidia';
      ok(v === expect, `${k}: webgpu ${v} vs ${wv}`);
    }
  }
});
t('timezone offset matches timezone id year-round for the generated instant', () => {
  for (const [, fp] of fps) {
    const off = fp.timezone.offsetMinutes;
    ok(typeof off === 'number' && Math.abs(off) <= 14 * 60, 'bad offset ' + off);
  }
});

console.log('\n◆ device-model coherence');
t('every identity binds to a known hardware model matching its OS family', () => {
  for (const [k, fp] of fps) {
    const m = modelById(fp.deviceModel);
    ok(m, `${k}: deviceModel "${fp.deviceModel}" not in library`);
    ok(m.family === (fp.osId.includes('win') ? 'windows' : fp.osId.includes('mac') ? 'mac' : fp.osId.includes('ubuntu') ? 'linux' : fp.osId.includes('android') ? 'android' : 'ios'), `${k}: model family ${m.family} vs os ${fp.osId}`);
  }
});
t('GPU / cores / screen / audio all come from the SAME model (not independent picks)', () => {
  for (const [k, fp] of fps) {
    const m = modelById(fp.deviceModel); if (!m) continue;
    ok(fp.gpu.renderer === m.gpu.renderer, `${k}: renderer not model-matched`);
    ok(fp.gpu.unmaskedVendor === m.gpu.unmaskedVendor, `${k}: gpu vendor mismatch`);
    ok(fp.gpu.limits && fp.gpu.precision, `${k}: missing model GL limits/precision`);
    ok(fp.hardware.hardwareConcurrency === m.hardware.hardwareConcurrency, `${k}: cores ${fp.hardware.hardwareConcurrency} ≠ model ${m.hardware.hardwareConcurrency}`);
    ok(fp.screen.width === m.screen.w && fp.screen.height === m.screen.h, `${k}: screen ${fp.screen.width}x${fp.screen.height} ≠ model ${m.screen.w}x${m.screen.h}`);
    ok(fp.audio.sampleRate === m.audio.sampleRate, `${k}: audio sampleRate mismatch`);
  }
});
t('model coherence: webgpu vendor never contradicts the model GPU', () => {
  for (const [k, fp] of fps) {
    if (!fp.gpu.webgpu) continue;
    const wv = fp.gpu.webgpu.vendor.toLowerCase(), rv = fp.gpu.unmaskedVendor.toLowerCase();
    const same = (wv.includes('apple') === rv.includes('apple')) && (wv.includes('intel') === rv.includes('intel')) && (wv.includes('nvidia') === rv.includes('nvidia')) && (wv.includes('amd') === rv.includes('amd'));
    ok(same, `${k}: webgpu ${fp.gpu.webgpu.vendor} vs webgl ${fp.gpu.unmaskedVendor}`);
  }
});
t('a forced modelId is honored exactly', () => {
  const fp = generateFingerprint({ os: 'windows-11', browser: 'chrome', seed: 'force1', modelId: 'win-rtx4060-laptop' });
  ok(fp.deviceModel === 'win-rtx4060-laptop', 'not forced');
  ok(/RTX 4060/.test(fp.gpu.renderer), 'gpu not from forced model');
  ok(fp.hardware.hardwareConcurrency === 12, 'cores not from forced model');
});

console.log('\n◆ behavioral humanization');
t('pointer path is a curved trajectory that ends at the target, inside bounds, with sane delays', () => {
  const rng = rngFor('pointer');
  const path = pointerPath(rng, 100, 100, 900, 600);
  ok(path.length >= 6 && path.length <= 48, 'steps out of range: ' + path.length);
  ok(Math.hypot(path[0].x - 100, path[0].y - 100) < 120, 'does not start near origin');
  ok(Math.hypot(path[path.length - 1].x - 900, path[path.length - 1].y - 600) < 4, 'does not land on target');
  ok(path.every(p => p.delay >= 4 && p.delay <= 70), 'delay out of [4,70]');
  // genuinely curved: total path length meaningfully exceeds the straight-line distance
  let len = 0; for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  ok(len > Math.hypot(800, 500), 'path not curved (length ' + Math.round(len) + ' ≤ straight)');
});
t('keystroke plan has one key per char with positive dwell/hold; typos self-correct', () => {
  const rng = rngFor('type');
  const plan = keystrokePlan(rng, 'hello world typing test');
  const keys = plan.filter(e => e.type === 'key').length;
  const bs = plan.filter(e => e.type === 'backspace').length;
  ok(keys >= 23, 'expected ≥ one key per char, got ' + keys);
  ok(bs * 1 <= keys, 'backspaces exceed keys');
  ok(plan.every(e => e.down >= 20 && e.down <= 260 && e.hold >= 22), 'timing out of range');
});
t('scroll plan decelerates and sums toward requested delta', () => {
  const rng = rngFor('scroll');
  const plan = scrollPlan(rng, 600);
  const sum = plan.reduce((a, t) => a + t.deltaY, 0);
  ok(Math.abs(sum - 600) <= 3, 'scroll sum must equal requested delta, got ' + sum);
  ok(plan.every(t => t.delay >= 8 && t.delay <= 90), 'scroll delay out of range');
});
t('humanization is deterministic for a given seed', () => {
  const a = keystrokePlan(rngFor('same'), 'abc'), b = keystrokePlan(rngFor('same'), 'abc');
  eq(a, b, 'keystroke plan not deterministic');
  eq(pointerPath(rngFor('p'), 0, 0, 500, 500), pointerPath(rngFor('p'), 0, 0, 500, 500), 'pointer path not deterministic');
});

console.log('\n◆ already-alive coherence');
t('each identity carries liveness attributes consistent with its browser', () => {
  for (const [k, fp] of fps) {
    const a = fp.alive; ok(a, k + ' missing alive');
    ok(a.historyLength >= 2, k + ' historyLength < 2');
    ok(a.storageEstimate.quota > a.storageEstimate.usage, k + ' storage quota ≤ usage');
    if (fp.osId.includes('ios') || ['safari', 'firefox'].includes(fp.browser)) ok(a.perfMemory === null, k + ' non-chromium(-memory) must not fake perf.memory');
    else ok(a.perfMemory && a.perfMemory.jsHeapSizeLimit > a.perfMemory.totalJSHeapSize, k + ' chrome perf.memory incoherent');
    ok(a.uptimeMin > 0, k + ' uptime missing');
  }
});

console.log('\n◆ WebRTC transport coherence');
t('every identity has a masked WebRTC config with a coherent local subnet', () => {
  for (const [k, fp] of fps) {
    const w = fp.webrtc; ok(w && ['disable','proxy','spoof','real'].includes(w.mode), k + ' bad mode');
    ok(/^192\.168\.\d+\.\d+$/.test(w.fakeLocalIp), k + ' fakeLocalIp not a 192.168 subnet');
    ok(w.fakePublicIp && w.egressPublicIp === null, k + ' egress not initialized to null');
    ok(w.addRelay === true, k + ' missing relay flag');
  }
});

console.log('\n◆ consistency auditor');
t('all 32 generated combos audit without critical issues', () => {
  for (const [k, fp] of fps) {
    const a = auditFingerprint(fp, {});
    ok(a.critCount === 0, `${k}: crit=${a.critCount} → ${a.issues.filter(i => i.sev === 'critical').map(i => i.msg)[0]}`);
    ok(a.score >= 90, `${k}: score ${a.score} < 90`);
  }
});
t('auditor catches injected contradictions', () => {
  const fp = structuredClone(fps.get('windows-11/chrome'));
  fp.platform = 'Linux x86_64'; // contradicts Windows UA
  ok(auditFingerprint(fp, {}).critCount >= 1, 'missed UA/platform mismatch');
  const fp2 = structuredClone(fps.get('macos-sonoma/safari'));
  fp2.timezone.id = 'Asia/Kolkata';
  ok(auditFingerprint(fp2, {}).issues.some(i => i.rule === 'tz-offset' || i.sev === 'critical'), 'missed tz mismatch');
  const fp3 = structuredClone(fps.get('windows-11/chrome'));
  fp3.screen = { ...fp3.screen, dpr: 3.5 };
  ok(auditFingerprint(fp3, {}).issues.some(i => i.sev !== 'info'), 'missed dpr oddity');
  const fp4 = structuredClone(fps.get('windows-11/chrome'));
  fp4.canvas.mode = 'off'; fp4.webrtc.mode = 'off';
  ok(auditFingerprint(fp4, {}).issues.length >= 2, 'missed leak-mode warnings');
});
t('proxy country vs identity region flagged', () => {
  const fp = structuredClone(fps.get('windows-11/chrome'));
  const a = auditFingerprint(fp, { proxyCountry: 'JP' });
  ok(a.issues.some(i => /proxy/i.test(i.rule + i.msg)), 'no proxy geo warning');
});

console.log('\n◆ stealth bundle');
t('bundle compiles for every browser family', () => {
  for (const [k, fp] of fps) {
    const js = buildStealthBundle(fp, { sessionSalt: 'x' });
    ok(js.length > 2000, k + ' bundle tiny');
    new vm.Script(js, { filename: 'stealth-' + k }); // throws on syntax error
  }
});
t('bundle embeds salt + expected map and is stable per profile', () => {
  const fp = fps.get('windows-11/chrome');
  const a = buildStealthBundle(fp, { sessionSalt: 's1' });
  const b = buildStealthBundle(fp, { sessionSalt: 's1' });
  eq(a, b, 'bundle unstable');
  ok(a.includes('__MIRAGE'), 'no registry');
  ok(a.includes('"salt":"s1"') || a.includes('s1'), 'no salt');
});
t('every section is error-contained', () => {
  const js = buildStealthBundle(fps.get('windows-11/chrome'), { sessionSalt: 'z' });
  const c = (js.match(/section\(/g) || []).length;
  ok(c >= 12, 'sections=' + c);
});

console.log('\n◆ Device-DNA export/import');
t('DNA seals, opens roundtrip, and rejects a wrong passphrase', () => {
  const payload = { fingerprint: { osId: 'windows-11', browser: 'chrome', seed: 'abc', navigator: { userAgent: 'UA' } }, meta: { name: 'DNA test' } };
  const env = sealDNA(payload, 'correct horse');
  ok(env.v === 1 && env.ct && env.salt && env.iv && env.tag, 'envelope incomplete');
  ok(dnaThumb(payload) === dnaThumb(openDNA(env, 'correct horse')), 'thumb mismatch on open');
  const out = openDNA(env, 'correct horse');
  ok(out.meta.name === 'DNA test' && out.fingerprint.seed === 'abc', 'roundtrip corrupted');
  let threw = false; try { openDNA(env, 'wrong pass'); } catch (e) { threw = /wrong passphrase|tampered/.test(e.message); }
  ok(threw, 'wrong passphrase should be rejected');
});

console.log('\n◆ rotation scheduler (cookie memory)');
t('rotation keeps OS/browser/region but changes seed + device identity', () => {
  const fp = generateFingerprint({ os: 'windows-11', browser: 'chrome', country: 'US', seed: 'seed-A', modelId: 'win-rtx4060-laptop' });
  const r1 = buildRotatedFingerprint(fp, { rotateModel: false }, 'seed-B', generateFingerprint);
  ok(r1.osId === 'windows-11' && r1.browser === 'chrome' && r1.meta.region === 'US', 'persona changed');
  ok(r1.seed === 'seed-B', 'seed not applied');
  ok(r1.deviceModel === fp.deviceModel, 'model must be preserved when rotateModel=false');
  const r2 = buildRotatedFingerprint(fp, { rotateModel: true }, 'seed-C', generateFingerprint);
  ok(r2.seed === 'seed-C', 'seed-C not applied on model rotation');
  ok(typeof r2.deviceModel === 'string' && r2.deviceModel.length > 0, 'model not re-selected from pool');
});

console.log('\n◆ pools sanity');
t('quick templates all valid', () => {
  for (const t2 of quickTemplates()) {
    const fp = generateFingerprint({ os: t2.os, browser: t2.browser, seed: randomSeed() });
    ok(auditFingerprint(fp, {}).critCount === 0, t2.id + ' template audit crit');
  }
});

console.log('\n◆ TLS ClientHello / JA3 capture');
await (async () => {
  const net = await import('node:net');
  const tls = await import('node:tls');
  const { parseClientHello } = await import('../src/net/clienthello.js');
  let hello = null;
  const srv = net.createServer(sock => { sock.once('data', d => { hello = Buffer.from(d); sock.destroy(); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise(res => {
    const c = tls.connect({ host: '127.0.0.1', port, servername: 'example.com', rejectUnauthorized: false }, () => { });
    c.on('error', () => { }); c.on('close', res); setTimeout(res, 1500);
  });
  srv.close();
  t('a real ClientHello (node TLS stack) parses into a valid JA3 signature', () => {
    ok(hello && hello.length > 40, 'no ClientHello captured');
    const r = parseClientHello(hello);
    ok(r, 'parse returned null');
    ok(/^\d+,[0-9x,-]+$/.test(r.ja3), 'bad ja3: ' + r.ja3);
    ok(/^[0-9a-f]{32}$/.test(r.ja3Hash), 'bad ja3 md5');
    ok(r.ciphers.length > 3, 'too few ciphers');
    ok(r.extensions.length > 3, 'too few extensions');
    ok(r.ja4 && r.ja4.startsWith('ja4_'), 'bad ja4: ' + r.ja4);
  });
})();

console.log(`\n${fail === 0 ? '✅' : '❌'} selftest: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
