const assert=require('node:assert/strict');
const http=require('node:http');
const express=require('express');
const {installProxy}=require('../lib/proxy');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright');
const base=process.argv[2]||'http://localhost:3030';
const film='https://blocked.example/watch';
const alternative='https://mirror.example/watch';
(async()=>{
 let upstreamStatus=403;
 const app=express();installProxy(app,{isolatedOrigin:true,validate:async()=>{},fetchImpl:async url=>url===alternative?new Response('<title>Alternative source fixture</title><h1>Alternative source fixture</h1>',{headers:{'content-type':'text/html'}}):new Response('<title>Security verification</title>',{status:upstreamStatus,headers:{'content-type':'text/html'}})});
 const proxy=http.createServer(app);await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const contexts=[];
 try{
  const room=base+'/room/blocked-'+randomUUID();
  async function participant(){
   const context=await browser.newContext();contexts.push(context);
   await context.route('**/room/**',async route=>{
    const response=await route.fetch();const html=await response.text();
    await route.fulfill({response,body:html.replace('<div class="browser-quick-links">','<div class="browser-quick-links"><button class="chip chip-fixture" data-url="'+film+'" data-fallback="'+alternative+'">Test source</button>')});
   });
   await context.route('**/api/runtime',route=>route.fulfill({json:{proxyOrigin:'http://127.0.0.1:'+proxy.address().port}}));
   await context.route(film,route=>route.fulfill({contentType:'text/html',body:'<title>External tab fixture</title>'}));
   await context.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{value:async()=>{window.captureRequested=true;const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;return canvas.captureStream(10)}})});
   const page=await context.newPage();await page.goto(room,{waitUntil:'domcontentloaded'});return page;
  }
  const a=await participant(),b=await participant();await a.locator('#userCount').filter({hasText:'2'}).waitFor();
  upstreamStatus=404;
  await a.locator('.chip-fixture').click();
  for(const page of [a,b]){
   await page.waitForFunction(url=>document.querySelector('#browserUrlInput').value===url,alternative);
   try {await page.frameLocator('#browserIframe').locator('h1').filter({hasText:'Alternative source fixture'}).waitFor()}
   catch(error){console.log('Fallback diagnostics',await page.locator('#browserStatus').innerText(),await Promise.all(page.frames().map(async frame=>({url:frame.url(),title:await frame.title().catch(()=>null)}))));throw error}
   assert.equal(await page.locator('#browserError').isVisible(),false);
   assert.equal(await page.locator('.chip-fixture').getAttribute('data-url'),film);
  }
  console.log('Unavailable film shortcut switched both participants to its declared alternative.');
  await a.locator('.chip-fixture').evaluate(button=>button.removeAttribute('data-fallback'));
  upstreamStatus=403;
  await a.locator('.chip-fixture').click();
  for(const page of [a,b]){
   await page.locator('#browserError').waitFor({state:'visible'});
   assert.match(await page.locator('#browserErrorTitle').innerText(),/məhdudlaşdırır/);
   assert.equal(await page.locator('.auto-sync-status').innerText(),'● Sayt açılmadı');
   assert.equal(await page.locator('#browserUrlInput').inputValue(),film);
   assert.equal(await page.locator('#browserLoader').isVisible(),false);
  }
  const opened=a.waitForEvent('popup');await a.locator('#btnBrowserExternalFallback').click();const popup=await opened;await popup.waitForLoadState('domcontentloaded');assert.equal(popup.url(),film);await popup.close();
  upstreamStatus=404;await a.locator('#btnBrowserRetry').click();
  await a.waitForFunction(()=>document.querySelector('#browserErrorTitle').textContent==='Film səhifəsi açılmadı');
  await a.locator('#btnBrowserShareFallback').click();
  await a.waitForFunction(()=>window.captureRequested===true);
  await b.locator('#viewScreen.active').waitFor();
  await a.locator('#screenVideoWrapper').waitFor({state:'visible'});
  console.log('Blocked-site fixture: 403/404 classified, no false ready state, exact external URL, retry and screen-share fallback passed.');
 }finally{for(const context of contexts)await context.close();await browser.close();await new Promise(resolve=>proxy.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
