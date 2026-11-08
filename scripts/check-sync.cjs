const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const engines = require('playwright');
const base = process.argv[2] || 'http://localhost:3040';
const engine = process.argv[3] || 'firefox';
const anikotoOnly = process.argv[4] === 'anikoto';
async function waitFrame(page, match) {
  for (let i = 0; i < 150; i++) {
    const frame = page.frames().find(f => match(f.url()));
    if (frame) return frame;
    await page.waitForTimeout(200);
  }
  throw new Error('Frame did not appear');
}
async function youtube(page) {
  const frame = await waitFrame(page, url => url.includes('/player.html?video=NWANo9BRz6Y'));
  await frame.waitForFunction(() => window.kosmiYouTube?.getDuration() > 0, null, {timeout:30000});
  return frame;
}
async function provider(page) {
  const frame = await waitFrame(page, value => {
    try { return new URL(new URL(value).searchParams.get('url')).hostname === 'megaplay.buzz'; } catch { return false; }
  });
  try {await frame.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, {timeout:30000})}
  catch(error){
    if(process.env.KOSMI_DEBUG)console.log('PLAYER',await frame.evaluate(()=>({text:document.body?.innerText.slice(0,600),media:[...document.querySelectorAll('video')].map(v=>({ready:v.readyState,time:v.currentTime,error:v.error?.message})),player:window.jwplayer?.().getState?.()})).catch(()=>null));
    throw error;
  }
  return frame;
}
(async () => {
 const browser = await engines[engine].launch({headless:true,...(engine === 'chromium' ? {args:['--no-sandbox']} : {})});
 try {
  const firstContext = await browser.newContext(), secondContext = await browser.newContext();
  // Optional relay for environments where the provider's CDN rejects local IPs.
  async function configureContext(context) {
    if (!process.env.KOSMI_TEST_MEDIA_RELAY) return;
    await context.route('**/proxy?**', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('media') !== '1') return route.continue();
      const relay = new URL('/proxy', process.env.KOSMI_TEST_MEDIA_RELAY);
      relay.search = url.search;
      const response = await context.request.get(relay.href);
      await route.fulfill({ response });
    });
  }
  await configureContext(firstContext);
  await configureContext(secondContext);
  const a = await firstContext.newPage(), b = await secondContext.newPage();
  for (const page of [a,b]) {
    page.on('pageerror', e=>console.log('PAGEERROR', e.message));
    if(process.env.KOSMI_DEBUG){
      page.on('response',response=>{if(response.status()>=400){let value=response.url();try{const outer=new URL(value);const target=new URL(outer.searchParams.get('url')||value);value=(target.origin+target.pathname).slice(0,160)}catch{}console.log('HTTP',response.status(),value)}});
      page.on('framenavigated', frame=>{let value=frame.url();try{const outer=new URL(value);value=outer.searchParams.get('url')||value;const target=new URL(value);value=target.origin+target.pathname}catch{}console.log('NAV',page===a?'A':'B',value)});
      page.on('websocket',ws=>ws.on('framesent',message=>{try{const packet=JSON.parse(message.payload);if(['sync-url','browser-ui'].includes(packet.event))console.log('SENT',page===a?'A':'B',JSON.stringify(packet))}catch{}}));
    }
  }
  const url = base + '/room/sync-' + randomUUID();
  await a.goto(url,{waitUntil:'domcontentloaded'});
  await b.goto(url,{waitUntil:'domcontentloaded'});
  await a.locator('#userCount').filter({hasText:'2'}).waitFor();
  await b.locator('#userCount').filter({hasText:'2'}).waitFor();
  assert.equal(await a.locator('#browserMode').count(),0);
  if (!anikotoOnly) {
  await a.locator('#browserUrlInput').fill('https://www.youtube.com/watch?v=NWANo9BRz6Y');
  await a.locator('#btnBrowserGo').click();
  const ya = await youtube(a), yb = await youtube(b);
  await ya.waitForFunction(()=>window.kosmiYouTube.getPlayerState()===1);
  await yb.waitForFunction(()=>window.kosmiYouTube.getPlayerState()===1);
  await ya.evaluate(()=>window.kosmiYouTube.pauseVideo());
  await yb.waitForFunction(()=>window.kosmiYouTube.getPlayerState()===2);
  await ya.evaluate(()=>window.kosmiYouTube.seekTo(50,true));
  await yb.waitForFunction(()=>Math.abs(window.kosmiYouTube.getCurrentTime()-50)<1.5);
  await ya.evaluate(()=>window.kosmiYouTube.playVideo());
  await yb.waitForFunction(()=>window.kosmiYouTube.getPlayerState()===1);
  await b.waitForTimeout(2500);
  const times = await Promise.all([ya,yb].map(frame=>frame.evaluate(()=>window.kosmiYouTube.getCurrentTime())));
  assert.ok(Math.abs(times[0]-times[1])<2, JSON.stringify(times));
  await yb.evaluate(()=>window.kosmiYouTube.pauseVideo());
  await ya.waitForFunction(()=>window.kosmiYouTube.getPlayerState()===2);
  await yb.evaluate(()=>window.kosmiYouTube.seekTo(15,true));
  await ya.waitForFunction(()=>Math.abs(window.kosmiYouTube.getCurrentTime()-15)<1.5);
  console.log(engine,'YouTube URL, two-way pause/play and forward/backward seek synchronized:', times);
  }
  // Navigation inside a proxied page must also synchronize without a room button.
  await a.locator('#browserUrlInput').fill('https://anikototv.com/home/');
  await a.locator('#btnBrowserGo').click();
  const root = a.frameLocator('#browserIframe');
  await root.locator('a[href*="i-m-dating-a-dark-summoner-8215"]').first().evaluate(link => link.click());
  await b.waitForFunction(()=>document.getElementById('browserUrlInput').value.includes('i-m-dating-a-dark-summoner-8215'));
  await root.locator('#player .play').click();
  let va = await provider(a), vb = await provider(b);
  await va.evaluate(()=>document.querySelector('video').pause());
  await vb.waitForFunction(()=>document.querySelector('video').paused);
  await va.evaluate(()=>{document.querySelector('video').currentTime=45});
  await vb.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-45)<1);
  await va.evaluate(()=>document.querySelector('video').play());
  await vb.waitForFunction(()=>!document.querySelector('video').paused && document.querySelector('video').currentTime>=45);
  const started = await va.evaluate(()=>document.querySelector('video').currentTime);
  await a.waitForTimeout(10000);
  // Providers may replace an iframe during CDN failover; verify the current player.
  va = await provider(a); vb = await provider(b);
  const finished = await va.evaluate(()=>({time:document.querySelector('video').currentTime,error:document.querySelector('video').error?.message}));
  assert.ok(finished.time > started + 6, JSON.stringify(finished));
  assert.ok(!finished.error, JSON.stringify(finished));
  assert.ok(!a.frames().some(frame=>frame.url().startsWith('https://megaplay.buzz/proxy')));
  console.log(engine,'Anikoto nested link/player/start/pause/seek/play synchronized; playback advances', finished.time-started);
  // A newly joined participant must receive both the page and current paused time.
  await va.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=80});
  await vb.waitForFunction(()=>document.querySelector('video').paused && Math.abs(document.querySelector('video').currentTime-80)<1);
  const lateContext = await browser.newContext(), late = await lateContext.newPage();
  await configureContext(lateContext);
  await late.goto(url,{waitUntil:'domcontentloaded'});
  const vl = await provider(late);
  await vl.waitForFunction(()=>document.querySelector('video').paused && Math.abs(document.querySelector('video').currentTime-80)<1);
  console.log(engine,'Late join restores URL, player and paused timestamp');
  await b.frameLocator('#browserIframe').locator('.eplist a[data-num="1"]').click();
  for (const page of [a,b,late]) {
    const root = page.frameLocator('#browserIframe');
    await root.locator('.eplist a[data-num="1"].active').waitFor();
  }
  console.log(engine,'Episode selection from the other participant synchronized');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
