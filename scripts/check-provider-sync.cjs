// Live provider check: real upstream availability is required.
const assert = require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const engines=require('playwright');
const base=process.argv[2]||'http://localhost:3058';
const engine=process.argv[3]||'chromium';
const source=process.env.MIRELIX_TEST_URL||'https://anikototv.com/watch/magic-repo-man-dumped-by-my-party-i-ll-cash-in-with-a-cute-support-fairy-to-become-the-strongest-7805/';
(async()=>{
 const browser=await engines[engine].launch({headless:true,...(engine==='chromium'?{args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']}:{firefoxUserPrefs:{'media.autoplay.default':0,'media.autoplay.blocking_policy':0}})});
 const contexts=[],pages=[];const room=base+'/room/provider-'+randomUUID();
 async function participant(){
  const context=await browser.newContext();contexts.push(context);
  await context.route('https://fonts.googleapis.com/**',r=>r.fulfill({contentType:'text/css',body:''}));
  const page=await context.newPage();pages.push(page);page.setDefaultTimeout(35000);
  page.on('pageerror',e=>console.log('Provider page error:',e.message));
  await page.goto(room,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.mirelixCall?.socket.connected);return page;
 }
 async function provider(page, paused=false){
  let frame;
  for(let i=0;i<200;i++){
   frame=page.frames().find(f=>{try{return new URL(new URL(f.url()).searchParams.get('url')).hostname==='megaplay.buzz'}catch{return false}});
   if(frame)break;await new Promise(r=>setTimeout(r,200));
  }
  if(!frame){console.log('FRAMES',page.frames().map(f=>f.url()));throw Error('Provider did not open')}
  await frame.waitForFunction(paused=>document.querySelector('video')?.readyState>=(paused?1:2),paused,{timeout:45000,polling:200}).catch(async error=>{console.log('PLAYER',await frame.evaluate(()=>({text:document.body.innerText,video:[...document.querySelectorAll('video')].map(v=>({ready:v.readyState,time:v.currentTime,duration:v.duration,paused:v.paused,seeking:v.seeking,error:v.error?.message})),jw:window.jwplayer?.().getState?.()})));throw error});
  return frame;
 }
 try{
  const a=await participant(),b=await participant();
  await a.locator('#userCount').filter({hasText:'2'}).waitFor();
  await a.locator('#browserUrlInput').fill(source);await a.locator('#btnBrowserGo').click();
  await a.frameLocator('#browserIframe').locator('#player .play').click();
  const [va,vb]=await Promise.all([provider(a),provider(b)]);
  await Promise.all([va,vb].map(f=>f.waitForFunction(()=>{const v=document.querySelector('video');return !v.paused&&v.currentTime>2},null,{timeout:30000,polling:200})));
  console.log(engine,'PASS: independent provider players both decode and play');
  await va.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=25});
  await vb.waitForFunction(()=>{const v=document.querySelector('video');return v.paused&&Math.abs(v.currentTime-25)<1.5},null,{polling:200,timeout:30000});
  const c=await participant(),vc=await provider(c,true);
  await vc.waitForFunction(()=>{const v=document.querySelector('video');return v.paused&&Math.abs(v.currentTime-25)<1.5},null,{polling:200,timeout:30000});
  assert.equal(await c.locator('#browserUrlInput').inputValue(),await a.locator('#browserUrlInput').inputValue());
  console.log(engine,'PASS: third participant restores selected provider and paused timestamp');
  await vb.locator('video').click({force:true});
  await vb.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=40;v.playbackRate=1.25;v.volume=0.4;v.muted=true;v.play()});
  for(const frame of [va,vc])await frame.waitForFunction(()=>{const v=document.querySelector('video');return !v.paused&&v.currentTime>=39&&v.playbackRate===1.25&&v.muted&&Math.abs(v.volume-0.4)<0.02},null,{polling:200,timeout:30000});
  const before=await vc.evaluate(()=>document.querySelector('video').currentTime);
  await new Promise(r=>setTimeout(r,4000));
  const after=await vc.evaluate(()=>document.querySelector('video').currentTime);
  assert.ok(after>before+2);
  console.log(engine,'PASS: follower controls play/seek/rate/volume/mute across all three; HLS keeps advancing');
 }finally{for(const context of contexts)await context.close();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
