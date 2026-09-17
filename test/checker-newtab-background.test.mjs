// Fully mocked regression: no browser, network, database, or production state.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserManager } from '../src/browser/manager.js';
import { createApi } from '../src/api.js';

function managerFixture() {
  const calls = [];
  const bm = new BrowserManager({});
  const s = {
    firstTargetId: 'live', activeTargetId: 'live-session', screencastOn: true,
    child: { exitCode: null },
    targets: new Map([['live', { type: 'page', ready: true, _ov: true, sessionId: 'live-session' }]]),
    cdp: { async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') {
        s.targets.set('new', { type: 'page', ready: true, _ov: true, sessionId: 'new-session' });
        return { targetId: 'new' };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { score: 100, leaks: 0 } } };
      return {};
    } },
  };
  bm.sessions.set('p1', s);
  bm._broadcastTargets = () => calls.push({ method: 'broadcast', active: s.firstTargetId });
  bm.stopLive = async () => calls.push({ method: 'stopLive' });
  bm.startLive = async () => calls.push({ method: 'startLive' });
  return { bm, s, calls };
}

for (const background of [false, true]) {
  test(`newTab ${background ? 'background preserves focus' : 'defaults to foreground'}`, async () => {
    const { bm, s, calls } = managerFixture();
    const id = background
      ? await bm.newTab('p1', 'http://example.test/', { background: true })
      : await bm.newTab('p1', 'http://example.test/');
    assert.equal(id, 'new');
    assert.deepEqual(calls[0], { method: 'Target.createTarget', params: { url: 'about:blank', background }, sessionId: undefined });
    assert.deepEqual(calls[1], { method: 'Page.navigate', params: { url: 'http://example.test/' }, sessionId: 'new-session' });
    assert.equal(s.firstTargetId, background ? 'live' : 'new');
    assert.equal(bm._pick(s).sessionId, background ? 'live-session' : 'new-session');
    assert.equal(s.activeTargetId, 'live-session');
    for (const method of ['Target.activateTarget', 'stopLive', 'startLive']) {
      assert.equal(calls.filter(c => c.method === method).length, background ? 0 : 1, method);
    }
    assert.equal(calls.find(c => c.method === 'broadcast').active, s.firstTargetId);
    if (background) {
      await bm.evaluate('p1', 'window.__MIRAGE_REPORT || null', id);
      assert.equal(calls.find(c => c.method === 'Runtime.evaluate').sessionId, 'new-session');
      await bm.closeTab('p1', id);
      assert.equal(s.firstTargetId, 'live');
      assert.equal(s.targets.has(id), false);
      assert.equal(s.screencastOn, true);
      assert.equal(calls.some(c => ['Target.activateTarget', 'stopLive', 'startLive'].includes(c.method)), false);
    }
  });
}

for (const mode of ['success', 'timeout', 'evaluate-error', 'wait-error', 'close-error']) {
  test(`checker background target and cleanup: ${mode}`, async t => {
    let clock = 0;
    t.mock.method(Date, 'now', () => clock);
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
      if (mode === 'wait-error') throw new Error('wait failed');
      clock += delay;
      callback();
    });
    const { bm, s, calls } = managerFixture();
    const report = { leaks: 0, score: 100 };
    const evals = [];
    bm.evaluate = async (profileId, expression, targetId) => {
      evals.push({ profileId, expression, targetId });
      assert.equal(s.firstTargetId, 'live');
      if (mode === 'evaluate-error') throw new Error('evaluation failed');
      return mode === 'timeout' ? null : report;
    };
    if (mode === 'close-error') {
      bm.closeTab = async (profileId, targetId) => {
        calls.push({ method: 'Target.closeTarget', params: { targetId } });
        throw new Error('target already closed');
      };
    }
    const logs = [];
    const { H } = createApi({ bm, db: { checkApiKey: () => true, logEvent: (...args) => logs.push(args) } });
    const req = { url: '/api/checker/run/p1', headers: { 'x-api-key': 'mock' } };
    const res = {
      writeHead(code) { this.statusCode = code; },
      end(body) { this.body = JSON.parse(body); },
    };
    await H['POST /api/checker/run/:profileId'](req, res, { profileId: 'p1' });
    assert.equal(res.statusCode, mode === 'wait-error' ? 400 : ['timeout', 'evaluate-error'].includes(mode) ? 408 : 200);
    assert.equal(calls.find(c => c.method === 'Target.createTarget').params.background, true);
    assert.match(calls.find(c => c.method === 'Page.navigate').params.url, /\/checker\?embed=1&v=/);
    assert.equal(calls.filter(c => c.method === 'Target.closeTarget').length, 1);
    assert.equal(calls.find(c => c.method === 'Target.closeTarget').params.targetId, 'new');
    assert.equal(s.firstTargetId, 'live');
    assert.equal(s.activeTargetId, 'live-session');
    assert.equal(s.screencastOn, true);
    assert.equal(calls.some(c => ['Target.activateTarget', 'stopLive', 'startLive'].includes(c.method)), false);
    assert.equal(evals.length > 0, mode !== 'wait-error');
    for (const evaluation of evals) {
      assert.deepEqual(evaluation, { profileId: 'p1', expression: 'window.__MIRAGE_REPORT || null', targetId: 'new' });
    }
    assert.equal(logs.length, res.statusCode === 200 ? 1 : 0);
    if (res.statusCode === 200) assert.deepEqual(res.body, report);
  });
}
