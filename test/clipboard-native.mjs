// Real Chromium/X11 clipboard test against the actual live.js handlers on an HTTP origin.
// Requires chromium, Xvfb. No production data, service, or browser is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CDP } from '../src/browser/cdp.js';
const live = await fs.readFile(new URL('../public/js/live.js', import.meta.url), 'utf8');
const index = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const selectionExpression = index.match(/const text = await bm\.evaluate\(pid, `([\s\S]*?)`\);/)?.[1];
assert.ok(selectionExpression, 'test the actual server selection expression');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-clipboard-'));
let xvfb, browser, cdp;
const server = http.createServer((req, res) => {
  if (req.url === '/live.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(live); }
  res.end(`<!doctype html><div id="crumbs"></div><div id="view"></div><textarea id="hostClipboard"></textarea>
<script>
window.App={state:{view:'live',live:{}},esc:s=>String(s)};
window.ROUTES={}; window.profileOf=()=>({name:'test'}); window.sessOf=()=>({});
window.sent=[]; window.wsSend=m=>sent.push(m); window.api=async()=>({tabs:[]});
window.toast=()=>{}; window.applyI18n=()=>{}; window.rpc=async()=>({});
window.modal=()=>{window.modalShown=true};
</script><script src="/live.js"></script><script>ROUTES.live(document.getElementById('view'),['profile-A']);</script>`);
});
const waitFor = async (f) => { for (let i=0;i<100;i++) { const v=await f(); if(v)return v; await new Promise(r=>setTimeout(r,50)); } throw Error('timed out'); };
try {
  xvfb = spawn('Xvfb', ['-displayfd','3','-screen','0','1280x900x24','-nolisten','tcp'], {stdio:['ignore','ignore','pipe','pipe']});
  const display = await new Promise((resolve,reject)=> { xvfb.once('error',reject); xvfb.stdio[3].once('data',d=>resolve(':'+String(d).trim())); });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=spawn(process.env.MIRAGE_CHROMIUM || '/usr/bin/chromium', ['--no-sandbox','--disable-gpu','--no-proxy-server',`--user-data-dir=${dir}`,'--remote-debugging-port=0','--host-resolver-rules=MAP clipboard.test 127.0.0.1','--no-first-run','about:blank'], {env:{...process.env,DISPLAY:display},stdio:['ignore','ignore','pipe']});
  let endpoint=''; browser.stderr.on('data',d=>{ const m=String(d).match(/DevTools listening on (ws:\/\/\S+)/); if(m)endpoint=m[1]; });
  await waitFor(()=>endpoint);
  cdp=await CDP.connect(endpoint,5000);
  const {targetId}=await cdp.send('Target.createTarget',{url:`http://clipboard.test:${server.address().port}/`});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  const evaluate=async(expression,userGesture=false)=>{
    const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture},sessionId);
    if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
  };
  await waitFor(()=>evaluate('!!document.getElementById("lvStage")'));
  assert.deepEqual(await evaluate('[isSecureContext,typeof navigator.clipboard]'),[false,'undefined']);
  for(const text of ['ASCII clipboard 123','Кириллица: Привет мир 🦝\nвторая строка']) {
    // execCommand seeds the real host/X11 clipboard. This is NOT a synthetic paste event.
    assert.equal(await evaluate(`(() => { const t=document.getElementById('hostClipboard'); t.value=${JSON.stringify(text)};t.focus();t.select();return document.execCommand('copy') })()`,true),true);
    await evaluate(`document.getElementById('lvImg').dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); sent=[]; window.nativePaste=null; document.getElementById('lvStage').addEventListener('paste',e=>window.nativePaste=e.isTrusted,{once:true})`);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:2},sessionId);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2},sessionId);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2},sessionId);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17},sessionId);
    await waitFor(()=>evaluate('nativePaste !== null'));
    assert.equal(await evaluate('nativePaste'),true,'paste must originate in the browser');
    assert.deepEqual(await evaluate('sent.filter(m=>m.ev?.kind==="clipboard")'),[{type:'input',channel:'live:profile-A',ev:{kind:'clipboard',action:'paste',text}}]);
    assert.equal(await evaluate('sent.some(m=>m.ev?.code==="KeyV")'),false,'do not paste stale kernel clipboard as well');
    // Real copy fallback: deliver the same reply handled by the WebSocket client, then
    // read back through a native paste into a host field, not navigator.clipboard.
    await evaluate(`handleClipboard({action:'copy',text:${JSON.stringify(text+' copied')}})`,true);
    await evaluate(`(() => { const t=document.getElementById('hostClipboard');t.value='';t.focus(); })()`);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2},sessionId);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86},sessionId);
    await waitFor(()=>evaluate('document.getElementById("hostClipboard").value'));
    assert.equal(await evaluate('document.getElementById("hostClipboard").value'),text+' copied');
  }
  await evaluate(`(() => { const t=document.getElementById('hostClipboard');t.value='abc Привет xyz';t.focus();t.setSelectionRange(4,10); })()`);
  assert.equal(await evaluate(selectionExpression), 'Привет', 'server reads textarea selection');
  await evaluate(`(() => { const t=document.createElement('input'); t.type='password';t.value='secret';document.body.append(t);t.focus();t.select(); })()`);
  assert.equal(await evaluate(selectionExpression), '', 'do not mirror password selection');
  console.log('PASS: HTTP native trusted paste, ASCII/Unicode, one insert, real host clipboard copy roundtrip, server selection');
} finally {
  if(cdp)await cdp.send('Browser.close').catch(()=>{});
  for(const child of [browser,xvfb]) if(child && child.exitCode===null) { child.kill(); await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,2000))]); }
  server.closeAllConnections(); await new Promise(r=>server.close(r));
  await fs.rm(dir,{recursive:true,force:true});
}
