const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const express=require('express');
const {installProxy}=require('../lib/proxy');
const engines=require('playwright');
const {randomUUID}=require('node:crypto');
const base=process.argv[2]||'http://localhost:8787',engine=process.argv[3]||'chromium';
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'kosmi-native-'));
 const command=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=320x180:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','24','-c:v','libx264','-preset','ultrafast','-crf','35','-pix_fmt','yuv420p','-g','20','-c:a','aac','-b:a','32k','-movflags','+faststart',path.join(directory,'movie.mp4')]);
 if(command.status!==0)throw new Error('ffmpeg is required for native-media tests: '+command.stderr);
 const hls=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-i',path.join(directory,'movie.mp4'),'-c','copy','-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(directory,'segment-%03d.ts'),path.join(directory,'movie.m3u8')]);
 if(hls.status!==0)throw new Error(String(hls.stderr));
 const upstream=express();upstream.get('/stream',(_req,res)=>res.sendFile(path.join(directory,'movie.m3u8')));upstream.get('/video',(_req,res)=>res.sendFile(path.join(directory,'movie.mp4')));upstream.use(express.static(directory));const source=http.createServer(upstream);await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));
 const proxyApp=express();installProxy(proxyApp,{isolatedOrigin:true,validate:async url=>assert.equal(url.hostname,'media.example'),fetchImpl:(value,options)=>{const url=new URL(value);return fetch('http://127.0.0.1:'+source.address().port+url.pathname+url.search,options)}});
 const proxy=http.createServer(proxyApp);await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const proxyOrigin='http://127.0.0.1:'+proxy.address().port;
 const browser=await engines[engine].launch({headless:true,...(engine==='chromium'?{args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']}:{firefoxUserPrefs:{'media.autoplay.default':0,'media.autoplay.blocking_policy':0}})});
 const contexts=[];const room=base+'/room/native-'+randomUUID();
 async function participant(){const context=await browser.newContext();contexts.push(context);await context.route('**/api/runtime',route=>route.fulfill({json:{version:3,proxyOrigin}}));const page=await context.newPage();if(process.env.KOSMI_DEBUG)page.on('websocket',ws=>{for(const direction of ['framesent','framereceived'])ws.on(direction,message=>{try{const packet=JSON.parse(message.payload);if(['media-sync','browser-role'].includes(packet.event))console.log(direction,JSON.stringify(packet.data))}catch{}})});page.on('pageerror',e=>console.log('PAGEERROR',e.message));await page.goto(room,{waitUntil:'domcontentloaded'});return page}
 async function player(page,url){
  let frame;
  for(let attempt=0;attempt<100;attempt++){
    frame=page.frames().find(f=>{try{const parsed=new URL(f.url());return parsed.pathname==='/media.html'&&parsed.searchParams.get('url')===url}catch{return false}});
    if(frame)break;
    await page.waitForTimeout(100);
  }
  assert.ok(frame,'Expected media page for '+url);
  await frame.locator('#mediaPlayer').waitFor();
  await frame.waitForFunction(()=>document.querySelector('video').readyState>=2,null,{timeout:20000});
  return frame;
 }
 try{
  const a=await participant(),b=await participant();await a.locator('#userCount').filter({hasText:'2'}).waitFor();
  for(const extension of ['mp4','m3u8','stream','video']){
   const url='https://media.example/'+(['mp4','m3u8'].includes(extension)?'movie.'+extension:extension)+'?token=source-token';
   await a.locator('#browserUrlInput').fill(url);await a.locator('#btnBrowserGo').click();
   const va=await player(a,url),vb=await player(b,url);
   await b.frameLocator('#browserIframe').locator('#mediaToggle').click(); // Establish a real local gesture.
   await vb.evaluate(async()=>{const v=document.querySelector('video');v.pause();v.currentTime=8;v.volume=0.35;v.muted=true;v.playbackRate=1.5;await v.play()});
   try{await va.waitForFunction(()=>{const v=document.querySelector('video');return !v.paused&&v.currentTime>=8&&Math.abs(v.volume-0.35)<0.01&&v.muted&&v.playbackRate===1.5})}catch(error){console.log('STATES',await Promise.all([va,vb].map(f=>f.evaluate(()=>{const v=document.querySelector('video');return {time:v.currentTime,paused:v.paused,volume:v.volume,muted:v.muted,rate:v.playbackRate}}))));throw error}
   await a.waitForTimeout(1400);
   const times=await Promise.all([va,vb].map(frame=>frame.evaluate(()=>document.querySelector('video').currentTime)));assert.ok(Math.abs(times[0]-times[1])<0.8,JSON.stringify(times));
   // The other browser now becomes the controller and seeks backward.
   await a.frameLocator('#browserIframe').locator('#mediaToggle').click();
   await va.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=3;v.volume=0.65;v.muted=false;v.playbackRate=1});
   await vb.waitForFunction(()=>{const v=document.querySelector('video');return v.paused&&Math.abs(v.currentTime-3)<0.6&&Math.abs(v.volume-0.65)<0.01&&!v.muted&&v.playbackRate===1});
   const late=await participant(),vl=await player(late,url);await vl.waitForFunction(()=>{const v=document.querySelector('video');return v.paused&&Math.abs(v.currentTime-3)<0.6&&Math.abs(v.volume-0.65)<0.01&&!v.muted});
   await late.close();
   console.log(engine,extension,'two independent players: bidirectional play/pause/seek/rate/volume/mute and late join passed; time difference',Math.abs(times[0]-times[1]));
  }
 }finally{for(const context of contexts)await context.close();await browser.close();await new Promise(resolve=>proxy.close(resolve));await new Promise(resolve=>source.close(resolve));await fs.rm(directory,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
