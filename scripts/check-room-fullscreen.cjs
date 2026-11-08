const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const express = require('express');
const http = require('node:http');
const {installProxy} = require('../lib/proxy');
const engines = require('playwright');
const base = process.argv[2] || 'http://localhost:3056';
const engine = process.argv[3] || 'chromium';
(async () => {
  const app = express();
  installProxy(app,{isolatedOrigin:true,validate:async()=>{},fetchImpl:async value=>new Response(new URL(value).pathname==='/nested'?`<!doctype html><style>body{margin:0}#player{width:240px;height:130px;background:#202020}video{width:100%;height:100%;object-fit:contain}button{position:absolute;top:0;left:0;z-index:2}</style><div id="player" class="jwplayer"><video></video><button class="jw-icon-fullscreen" onclick="document.fullscreenElement?document.exitFullscreen():this.parentElement.requestFullscreen()">Fullscreen</button></div>`:`<!doctype html><h1>Film page</h1><iframe src="/nested" style="width:280px;height:180px;border:0"></iframe>`,{headers:{'content-type':'text/html'}})});
  const server = http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const localProxy = 'http://127.0.0.1:'+server.address().port;
  const proxyOrigin = base.startsWith('https:')?'https://fullscreen-fixture.example':localProxy;
  const browser = await engines[engine].launch({headless:true,...(engine==='chromium'?{args:['--no-sandbox']}:{})});
  const contexts = [];
  const room = base+'/room/fullscreen-'+randomUUID();
  async function participant(viewport) {
    const context = await browser.newContext({viewport}); contexts.push(context);
    await context.route('**/api/runtime',route=>route.fulfill({json:{proxyOrigin}}));
    if(proxyOrigin!==localProxy)await context.route(proxyOrigin+'/**',async route=>{
      const url = new URL(route.request().url());
      const response = await context.request.get(localProxy+url.pathname+url.search);
      await route.fulfill({response,body:(await response.text()).split(localProxy).join(proxyOrigin)});
    });
    const page = await context.newPage(); await page.goto(room,{waitUntil:'domcontentloaded'});
    await page.locator('#roomSidebar[aria-hidden="false"]').waitFor(); return page;
  }
  const nested = page=>page.frameLocator('#browserIframe').frameLocator('iframe');
  async function verify(page,mobile) {
    await page.waitForFunction(mobile=>window.RoomFullscreen.active&&(mobile||document.fullscreenElement===document.documentElement),mobile);
    try {await nested(page).locator('#player[data-kosmi-fullscreen]').waitFor()}
    catch(error){
      console.log('FULLSCREEN DIAGNOSTICS',await page.evaluate(()=>({active:window.RoomFullscreen.active,full:document.fullscreenElement?.tagName,body:document.body.className})),await Promise.all(page.frames().map(async frame=>({url:frame.url().slice(0,160),state:await frame.evaluate(()=>({full:document.fullscreenElement?.tagName,marked:document.querySelector('[data-kosmi-fullscreen]')?.tagName,viewport:[innerWidth,innerHeight]})).catch(()=>null)}))));
      await page.screenshot({path:'/tmp/kosmi-fullscreen-failure-'+engine+'.png'});throw error;
    }
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const full = await page.evaluate(()=>document.fullscreenElement?.tagName||null);
    assert.equal(full,mobile?null:'HTML');
    const stage = await page.locator('#stageArea').boundingBox(), chat = await page.locator('#roomSidebar').boundingBox();
    const frame = await page.locator('#browserIframe').boundingBox();
    assert.ok(chat && frame && Math.abs(stage.height-frame.height)<2,JSON.stringify({stage,chat,frame}));
    if(mobile) assert.ok(chat.y>=stage.y+stage.height-1);
    else assert.ok(chat.x>=stage.x+stage.width-1);
    const player = await nested(page).locator('#player').boundingBox();
    assert.ok(Math.abs(player.width-frame.width)<2 && Math.abs(player.height-frame.height)<2,JSON.stringify({player,frame}));
  }
  try {
    const mobile = await participant({width:390,height:844}),desktop = await participant({width:1440,height:900});
    await mobile.locator('#userCount').filter({hasText:'2'}).waitFor();
    await mobile.locator('#browserUrlInput').fill('https://cinema.example/movie');await mobile.locator('#btnBrowserGo').click();
    await nested(mobile).locator('button').waitFor();await nested(desktop).locator('button').waitFor();
    const source = await mobile.locator('#browserIframe').getAttribute('src');
    await nested(mobile).locator('button').click();await verify(mobile,true);
    assert.equal(await desktop.evaluate(()=>window.RoomFullscreen.active),false,'Fullscreen must remain local');
    await mobile.screenshot({path:'/tmp/kosmi-fullscreen-mobile.png'});
    await nested(mobile).locator('button').click();await mobile.waitForFunction(()=>!window.RoomFullscreen.active);
    assert.equal(await nested(mobile).locator('#player').evaluate(el=>Boolean(el.ownerDocument.fullscreenElement)),false);
    await mobile.locator('#btnExpandBrowser').click();await verify(mobile,true);
    await mobile.locator('#btnExitRoomFullscreen').click();
    assert.equal(await mobile.locator('#browserIframe').getAttribute('src'),source);
    await desktop.locator('#btnToggleSidebar').click();
    await nested(desktop).locator('button').click();await verify(desktop,false);
    assert.equal(await mobile.evaluate(()=>window.RoomFullscreen.active),false);
    await desktop.screenshot({path:'/tmp/kosmi-fullscreen-desktop.png'});
    await desktop.locator('#chatInput').fill('Tam ekranda da söhbət');await desktop.locator('#chatInput').press('Enter');
    await mobile.locator('.msg-body').filter({hasText:'Tam ekranda da söhbət'}).waitFor();
    await desktop.locator('#btnExitRoomFullscreen').click();await desktop.waitForFunction(()=>!document.fullscreenElement&&!window.RoomFullscreen.active);
    await desktop.locator('#btnExpandBrowser').click();await verify(desktop,false);
    await desktop.evaluate(()=>document.exitFullscreen());await desktop.waitForFunction(()=>!window.RoomFullscreen.active);
    assert.equal(await nested(desktop).locator('#player').evaluate(el=>Boolean(el.ownerDocument.fullscreenElement)),false);
    console.log(engine,'Nested player and toolbar fullscreen: mobile stage only; desktop whole room with chat; local preference, live chat and exit restore passed.');
  } finally {
    for(const context of contexts)await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1});
