// Real browser peer connections; fake devices and canvas streams avoid OS prompts.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium, firefox } = require('playwright');
const mixed = process.argv[3] === 'mixed';
const base = process.argv[2] || 'http://localhost:3058';
(async () => {
 const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
 const firefoxBrowser = mixed ? await firefox.launch({headless:true,firefoxUserPrefs:{'media.navigator.streams.fake':true,'media.navigator.permission.disabled':true,'media.autoplay.default':0}}) : null;
 const contexts = [], pages = [], errors = [];
 const room = base+'/room/multiparty-'+randomUUID();
 async function participant(name, delayed=false) {
  const useFirefox = mixed && name === 'B';
  const context = await (useFirefox ? firefoxBrowser : browser).newContext({ ...(useFirefox ? {} : {permissions:['camera','microphone']}),viewport:{width:1280,height:800} });contexts.push(context);
  if(!process.env.MIRELIX_TEST_STUN) await context.route('**/api/ice',r=>r.fulfill({json:{iceServers:[]}}));
  await context.route('https://fonts.googleapis.com/**',r=>r.fulfill({contentType:'text/css',body:''}));
  await context.route('https://www.youtube-nocookie.com/**',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));
  await context.addInitScript(({name, delayed})=>{
   localStorage.setItem('kosmi_username',name);
   if(delayed){const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);let release;const ready=new Promise(r=>{release=r});window.releaseMedia=release;navigator.mediaDevices.getUserMedia=async options=>{await ready;return original(options)}}
   navigator.mediaDevices.getDisplayMedia=async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');
    setInterval(()=>{ctx.fillStyle=name==='A'?'#7146bb':'#278e79';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='30px sans-serif';ctx.fillText(name+' screen '+Date.now(),30,90)},50);
    const stream=canvas.captureStream(15);const audio=new AudioContext();const oscillator=audio.createOscillator();const destination=audio.createMediaStreamDestination();oscillator.connect(destination);oscillator.start();stream.addTrack(destination.stream.getAudioTracks()[0]);return stream;
   };
  },{name,delayed});
  const page=await context.newPage();page.setDefaultTimeout(25000);pages.push(page);console.log('Joining',name);page.on('pageerror',e=>{errors.push(name+': '+e.message);console.log('PAGEERROR',name,e.message)});
  page.on('console',m=>{if(m.type()==='warning'&&/WebRTC|ICE:/.test(m.text()))console.log(name,m.text())});
  await page.goto(room,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window.mirelixCall?.socket.connected);
  console.log('Joined',name);return page;
 }
 async function connected(page,count) {
  await page.waitForFunction(count=>window.mirelixCall.peers.size===count&&[...window.mirelixCall.peers.values()].every(p=>p.pc.connectionState==='connected'),count,{timeout:15000}).catch(async error=>{console.log('PEERS',await page.evaluate(()=>({self:window.mirelixCall.socket.id,peers:[...window.mirelixCall.peers.values()].map(p=>({id:p.id,state:p.pc.connectionState,signaling:p.pc.signalingState,ice:p.pc.iceConnectionState,gathering:p.pc.iceGatheringState,local:p.pc.localDescription?.type,remote:p.pc.remoteDescription?.type,candidates:p.candidates.length}))})));throw error});
 }
 async function decoded(page,count){
  await page.waitForFunction(count=>[...document.querySelectorAll('.remote-card video')].filter(v=>v.videoWidth>0&&v.readyState>=2).length===count,count,{timeout:15000}).catch(async error=>{console.log('VIDEO',JSON.stringify(await page.evaluate(()=>({local:window.mirelixCall.localTracks().map(t=>t&&({kind:t.kind,enabled:t.enabled,state:t.readyState})),peers:[...window.mirelixCall.peers.values()].map(p=>({id:p.id,media:p.media,camera:p.camera.getTracks().map(t=>({kind:t.kind,muted:t.muted})),slots:p.pc.getTransceivers().map(t=>({mid:t.mid,kind:t.receiver.track.kind,send:t.sender.track?.kind})),video:{width:p.card.querySelector('video').videoWidth,ready:p.card.querySelector('video').readyState},screen:p.screen.getTracks().map(t=>t.kind)}))}))));throw error});
  const stats=await page.evaluate(async()=>Promise.all([...window.mirelixCall.peers.values()].map(async p=>{
   const rows=[...await p.pc.getStats()].map(([,row])=>row);
   return {id:p.id,video:rows.filter(s=>s.type==='inbound-rtp'&&s.kind==='video').some(s=>s.framesDecoded>0),audio:rows.filter(s=>s.type==='inbound-rtp'&&s.kind==='audio').some(s=>s.packetsReceived>0)};
  })));
  assert.ok(stats.every(s=>s.video&&s.audio),JSON.stringify(stats));
 }
 try {
  const a=await participant('A'), b=await participant('B'), c=await participant('C');
  await Promise.all(pages.map(p=>connected(p,2)));
  for(const page of pages){await page.locator('#btnToggleCam').click();await page.locator('.stage-tab[data-view="video"]').click()}
  await Promise.all(pages.map(p=>decoded(p,2)));
  await a.evaluate(()=>{window.firstConnection=[...window.mirelixCall.peers.values()][0].pc});
  console.log('PASS: three participants receive every camera and microphone');
  await a.evaluate(()=>window.mirelixCall.startScreenShare());
  await b.evaluate(()=>window.mirelixCall.startScreenShare());
  for(const page of pages)await page.waitForFunction(()=>window.mirelixCall.shares.size===2);
  const bid=await b.evaluate(()=>window.mirelixCall.socket.id);
  await c.locator('#screenSourceSelect').selectOption(bid);
  await c.waitForFunction(()=>document.getElementById('screenShareVideo').videoWidth>0);
  for(const page of [a,b])assert.ok(await page.evaluate(()=>[...window.mirelixCall.peers.values()].every(p=>p.pc.getSenders().filter(s=>s.track).length===4)));
  console.log('PASS: two simultaneous screen shares with separate camera, microphone and screen audio');
  const d=await participant('D',true);
  await Promise.all(pages.map(p=>connected(p,3)));
  assert.equal(await a.evaluate(()=>[...window.mirelixCall.peers.values()].some(p=>p.pc===window.firstConnection)),true);
  await d.waitForFunction(()=>window.mirelixCall.shares.size===2);
  await d.waitForFunction(()=>document.getElementById('screenShareVideo').videoWidth>0);
  await d.evaluate(()=>window.releaseMedia());
  await d.waitForFunction(()=>window.mirelixCall.localStream.getVideoTracks().length>0);
  await d.locator('#btnToggleCam').click();
  await Promise.all(pages.map(p=>decoded(p,3)));
  console.log('PASS: fourth participant joins during sharing; delayed media permission fills every connection');
  await a.evaluate(()=>window.mirelixCall.stopScreenShare());
  for(const page of pages)await page.waitForFunction(()=>window.mirelixCall.shares.size===1);
  assert.equal(await c.locator('#screenSourceSelect').inputValue(),bid);
  await a.locator('#btnToggleMic').click();
  const aid=await a.evaluate(()=>window.mirelixCall.socket.id);
  await c.waitForFunction(id=>window.mirelixCall.peers.get(id).media.mic===false,aid);
  await c.locator('#chatInput').fill('Four-way chat');await c.locator('#chatInput').press('Enter');
  await d.locator('.msg-body').filter({hasText:'Four-way chat'}).waitFor();
  // Force a genuine ICE restart and Socket.IO reconnect while other peers remain.
  await a.evaluate(()=>{const peer=[...window.mirelixCall.peers.values()][0];window.previousIce=peer.pc.localDescription.sdp.match(/a=ice-ufrag:(.*)/)[1];window.mirelixCall.restartPeer(peer.id)});
  await a.waitForFunction(()=>[...window.mirelixCall.peers.values()][0].pc.localDescription.sdp.match(/a=ice-ufrag:(.*)/)[1]!==window.previousIce);
  await connected(a,3);
  await d.evaluate(()=>{window.mirelixCall.socket.disconnect();window.mirelixCall.socket.connect()});
  await Promise.all(pages.map(p=>connected(p,3)));
  await d.waitForFunction(()=>window.mirelixCall.shares.size===1);
  await decoded(d,3);
  console.log('PASS: mute status, group chat, ICE restart and reconnect');
  await contexts[1].close();
  for(const page of [a,c,d])await connected(page,2);
  for(const page of [a,c,d])await page.waitForFunction(()=>window.mirelixCall.shares.size===0);
  assert.equal(await c.locator('#screenEmptyState').isVisible(),true);
  await c.locator('.stage-tab[data-view="video"]').click();
  const tile=await c.locator('#localVideoCard').boundingBox();assert.ok(tile.height/tile.width<0.85,'Camera cards retain their aspect ratio');
  await c.screenshot({path:'/tmp/mirelix-multiparty.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: sharing participant leaves; remaining cameras and connections survive');
 } finally {for(const context of contexts)await context.close().catch(()=>{});await browser.close();await firefoxBrowser?.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
