const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { installProxy } = require('../lib/proxy');
const { randomUUID } = require('node:crypto');
const engines = require('playwright');
const engine = process.argv[3] || 'chromium';
const base = process.argv[2] || 'http://localhost:8787';
const findFrame = (page, url) => page.frames().find(frame => { try { return new URL(frame.url()).searchParams.get('url') === url; } catch { return false; } });
function tone() {
  const rate = 8000, samples = rate * 120, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  return data;
}
const sound = tone();
const fixture = http.createServer((req, res) => {
  if (req.url === '/tone.wav') {
    res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Accept-Ranges', 'bytes');
    const match = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (match) { const start = Number(match[1]), end = Math.min(sound.length - 1, match[2] ? Number(match[2]) : sound.length - 1); res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${sound.length}`, 'Content-Length': end-start+1 }); res.end(sound.subarray(start,end+1)); }
    else res.end(sound);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/dynamic') {
    res.end(`<!doctype html><html><body><div id="player"><button class="play" onclick="const a=document.createElement('audio');a.src='/tone.wav';a.controls=true;this.parentElement.appendChild(a);a.play();this.remove()">Start player</button></div></body></html>`);
    return;
  }
  res.end(`<!doctype html><html><head><title>Browser sync fixture</title><style>body{margin:0;height:4000px}#scroller{height:180px;width:280px;overflow:auto}#long{height:1800px}iframe{height:220px;width:400px}</style></head><body>
  <button id="play" onclick="document.querySelector('audio').play()">Play</button><button id="pause" onclick="document.querySelector('audio').pause()">Pause</button>
  <button id="spa" onclick="history.pushState({},'','/spa')">SPA page</button><audio controls preload="auto" src="/tone.wav"></audio><a id="next" href="/next">Next page</a>
  <div id="scroller"><div id="long">Nested scroll area</div></div>
  ${req.url === '/nested' ? '' : '<iframe id="nested" src="/nested"></iframe>'}
  </body></html>`);
});
(async () => {
 const contexts = [];
 const browser = await engines[engine].launch({headless:true,...(engine === 'chromium' ? {args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']} : {firefoxUserPrefs:{'media.autoplay.default':0,'media.autoplay.blocking_policy':0}})});
 await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
 const upstream = 'http://127.0.0.1:' + fixture.address().port;
 const target = 'https://cinema.example';
 // Public-domain fixtures are fetched from this local server only in this test.
 const proxyApp = express();
 installProxy(proxyApp, { isolatedOrigin:true, validate:async url=>{assert.equal(url.hostname,'cinema.example')}, fetchImpl:(value, options)=>{const url=new URL(value);return fetch(upstream+url.pathname+url.search, options)} });
 const proxy = http.createServer(proxyApp);
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const proxyOrigin = 'http://127.0.0.1:' + proxy.address().port;
 const room = base + '/room/browser-sync-' + randomUUID();
 async function participant(viewport = {width:1280,height:720}) {
  const context = await browser.newContext({viewport}); contexts.push(context);
  await context.route('**/api/runtime',route=>route.fulfill({json:{version:3,proxyOrigin}}));
  const page = await context.newPage();
  if(process.env.KOSMI_DEBUG)page.on('console', m=>console.log('CONSOLE',m.text()));
  page.on('pageerror', e=>console.log('PAGEERROR', e.message));
  await page.goto(room, { waitUntil:'domcontentloaded' });
  return page;
 }
 try {
  const a = await participant(), b = await participant({width:390,height:844});
  await a.locator('#userCount').filter({hasText:'2'}).waitFor();
  await a.locator('#browserUrlInput').fill(target+'/'); await a.locator('#btnBrowserGo').click();
  const rootA = a.frameLocator('#browserIframe'), rootB = b.frameLocator('#browserIframe');
  await rootA.locator('audio').waitFor(); await rootB.locator('audio').waitFor();
  await rootB.locator('#play').click();
  await rootA.locator('audio').evaluate(audio=>new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(!audio.paused){clearInterval(timer);resolve()}},50);setTimeout(()=>{clearInterval(timer);reject(new Error('Media not synchronized'))},10000)}));
  await rootA.locator('#pause').click();
  await rootB.locator('audio').evaluate(audio=>new Promise(resolve=>{const timer=setInterval(()=>{if(audio.paused){clearInterval(timer);resolve()}},50)}));
  const frameA = findFrame(a,target+'/'), frameB = findFrame(b,target+'/');
  await frameA.evaluate(()=>document.querySelector('audio').currentTime=35);
  await frameB.waitForFunction(()=>Math.abs(document.querySelector('audio').currentTime-35)<1);
  await frameA.evaluate(()=>window.scrollTo(0,1200));
  const ratioA = await frameA.evaluate(()=>scrollY/(document.scrollingElement.scrollHeight-innerHeight));
  await frameB.waitForFunction(expected=>Math.abs(scrollY/(document.scrollingElement.scrollHeight-innerHeight)-expected)<0.003,ratioA);
  await frameB.evaluate(()=>window.scrollTo(0,450));
  const ratioB = await frameB.evaluate(()=>scrollY/(document.scrollingElement.scrollHeight-innerHeight));
  await frameA.waitForFunction(expected=>Math.abs(scrollY/(document.scrollingElement.scrollHeight-innerHeight)-expected)<0.003,ratioB);
  await frameB.evaluate(()=>document.querySelector('#scroller').scrollTop=700);
  await frameA.waitForFunction(()=>Math.abs(document.querySelector('#scroller').scrollTop-700)<5);
  console.log(engine, 'Without extensions: proxied cross-origin audio, bidirectional root/element scrolling and seek passed.');
  const nestedA = findFrame(a,target+'/nested'), nestedB = findFrame(b,target+'/nested');
  await nestedB.locator('#play').click();
  await nestedA.waitForFunction(()=>!document.querySelector('audio').paused);
  await nestedB.locator('#pause').click();
  await nestedA.waitForFunction(()=>document.querySelector('audio').paused);
  await nestedB.evaluate(()=>document.querySelector('audio').currentTime=50);
  await nestedA.waitForFunction(()=>Math.abs(document.querySelector('audio').currentTime-50)<1);
  await frameA.evaluate(()=>window.scrollTo(0,450));
  const restoredRatio = await frameA.evaluate(()=>scrollY/(document.scrollingElement.scrollHeight-innerHeight));
  await frameB.waitForFunction(expected=>Math.abs(scrollY/(document.scrollingElement.scrollHeight-innerHeight)-expected)<0.003,restoredRatio);
  await a.waitForTimeout(200);
  const late = await participant();
  await late.frameLocator('#browserIframe').locator('audio').waitFor();
  const lateRoot = findFrame(late,target+'/');
  await lateRoot.waitForFunction(expected=>Math.abs(scrollY/(document.scrollingElement.scrollHeight-innerHeight)-expected)<0.003 && Math.abs(document.querySelector('#scroller').scrollTop-700)<5,restoredRatio);
  const lateNested = findFrame(late,target+'/nested');
  await lateNested.waitForFunction(()=>document.querySelector('audio').paused && Math.abs(document.querySelector('audio').currentTime-50)<1);
  console.log(engine, 'Without extensions: nested media and late join restore scroll/media passed.');
  await rootA.locator('#next').click();
  await b.waitForFunction(expected=>document.querySelector('#browserUrlInput').value===expected,target+'/next');
  console.log(engine, 'Without extensions: in-page navigation synchronized.');
  await a.frameLocator('#browserIframe').locator('#spa').click();
  await b.waitForFunction(expected=>document.querySelector('#browserUrlInput').value===expected,target+'/spa');
  console.log(engine, 'Without extensions: SPA history navigation synchronized.');
  await a.locator('#browserUrlInput').fill(target+'/dynamic'); await a.locator('#btnBrowserGo').click();
  await b.frameLocator('#browserIframe').locator('.play').click();
  await a.frameLocator('#browserIframe').locator('audio').waitFor();
  const dynamicA = findFrame(a,target+'/dynamic');
  await dynamicA.waitForFunction(()=>!document.querySelector('audio').paused);
  console.log(engine, 'Without extensions: participant 2 starts a dynamically created player for participant 1.');
 } finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await new Promise(resolve=>proxy.close(resolve));
  await new Promise(resolve=>fixture.close(resolve));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
