const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function connect(t, port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const queue = [], waiting = [];
  t.after(() => ws.close());
  const connected = new Promise((resolve, reject) => {
    ws.onerror = reject;
    ws.onmessage = ({ data }) => {
      if (data.startsWith('0')) return ws.send('40');
      if (data.startsWith('40')) return resolve();
      if (data === '2') return ws.send('3');
      if (!data.startsWith('42')) return;
      const [event, payload] = JSON.parse(data.slice(2));
      const index = waiting.findIndex(item => item.event === event);
      if (index >= 0) waiting.splice(index, 1)[0].resolve(payload);
      else queue.push({ event, payload });
    };
  });
  await connected;
  return {
    close() { ws.close(); },
    hasQueued(event) { return queue.some(item => item.event === event); },
    send(event, payload) { ws.send('42' + JSON.stringify([event, payload])); },
    next(event) {
      const index = queue.findIndex(item => item.event === event);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0].payload);
      return new Promise(resolve => waiting.push({ event, resolve }));
    }
  };
}

test('new room members receive the shared URL and live navigation stays synchronized', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await once(child, 'exit'); });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/localhost:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on('data', chunk => reject(new Error(String(chunk))));
  });
  const first = await connect(t, port);
  first.send('join-room', { roomId: 'cinema', username: 'First' });
  await first.next('room-joined');
  await first.next('sync-url');
  first.send('sync-url', { roomId: 'cinema', url: 'https://cinema.example/film/1' });
  await first.next('sync-url');
  // The next websocket connection is established after the prior ordered packet.
  const second = await connect(t, port);
  second.send('join-room', { roomId: 'cinema', username: 'Second' });
  await second.next('room-joined');
  assert.equal((await second.next('sync-url')).url, 'https://cinema.example/film/1');
  second.send('sync-url', { roomId: 'cinema', url: 'https://cinema.example/film/2' });
  assert.equal((await first.next('sync-url')).url, 'https://cinema.example/film/2');
});

test('group rooms retain every sharer and media flags across late joins and departures', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', PROXY_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await once(child, 'exit'); });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => { const match = String(chunk).match(/localhost:(\d+)/); if (match) resolve(Number(match[1])); });
    child.stderr.on('data', chunk => reject(new Error(String(chunk))));
  });
  async function join(name, roomId = 'group') {
    const client = await connect(t, port);
    client.send('join-room', { roomId, username: name });
    const joined = await client.next('room-joined');
    await client.next('sync-url');
    return { client, joined };
  }
  const a = await join('A'), b = await join('B');
  a.client.send('media-state', { roomId: 'group', mic: true, camera: true });
  assert.equal((await b.client.next('media-state')).camera, true);
  a.client.send('screenshare-status', { roomId: 'group', isSharing: true });
  await b.client.next('screenshare-status');
  b.client.send('screenshare-status', { roomId: 'group', isSharing: true });
  await a.client.next('screenshare-status');
  const c = await join('C');
  assert.equal(c.joined.users.find(user => user.socketId === a.joined.myId).camera, true);
  const shares = [await c.client.next('screenshare-status'), await c.client.next('screenshare-status')];
  assert.deepEqual(new Set(shares.map(share => share.senderId)), new Set([a.joined.myId, b.joined.myId]));
  a.client.close();
  assert.equal((await c.client.next('screenshare-status')).senderId, a.joined.myId);
  await c.client.next('user-left');
  const d = await join('D');
  assert.equal((await d.client.next('screenshare-status')).senderId, b.joined.myId);
  const outsider = await join('Outside', 'outside');
  c.client.send('webrtc-offer', { targetId: outsider.joined.myId, offer: { type: 'offer', sdp: 'wrong-room' } });
  c.client.send('webrtc-offer', { targetId: b.joined.myId, offer: { type: 'offer', sdp: 'correct-room' } });
  assert.equal((await b.client.next('webrtc-offer')).offer.sdp, 'correct-room');
  outsider.client.send('browser-clock', { roomId: 'outside', sentAt: 1 });
  await outsider.client.next('browser-clock');
  assert.equal(outsider.client.hasQueued('webrtc-offer'), false);
  c.client.send('webrtc-restart', { targetId: b.joined.myId, request: true });
  assert.equal((await b.client.next('webrtc-restart')).senderId, c.joined.myId);
});

test('media state is ordered, rejects stale navigation and restores a late participant', {timeout:10000}, async t => {
  const child = spawn(process.execPath, ['server.js'], {env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill();await once(child,'exit')});
  const port = await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.stdout.on('data',chunk=>{const match=String(chunk).match(/localhost:(\d+)/);if(match)resolve(Number(match[1]))});
    child.stderr.on('data',chunk=>reject(new Error(String(chunk))));
  });
  const a=await connect(t,port),b=await connect(t,port);
  a.send('join-room',{roomId:'media',username:'A'});
  await a.next('room-joined');await a.next('sync-url');
  a.send('sync-url',{roomId:'media',url:'https://cinema.example/watch'});
  const navigation=await a.next('sync-url');
  b.send('join-room',{roomId:'media',username:'B'});
  await b.next('room-joined');await b.next('sync-url');
  const state={time:42,paused:false,rate:1,mediaIndex:0,volume:0.4,muted:true};
  a.send('media-sync',{roomId:'media',navId:navigation.navId,path:[0,0],reason:'play',state});
  const playing=await b.next('media-sync');
  assert.equal(playing.state.time,42);
  assert.equal(playing.state.paused,false);
  b.send('media-sync',{roomId:'media',navId:navigation.navId,path:[0,0],reason:'pause',state:{...state,time:80,paused:true}});
  const paused=await a.next('media-sync');
  assert.ok(paused.revision>playing.revision);
  assert.equal(paused.state.paused,true);
  // An old page and an unrelated room cannot overwrite current playback.
  a.send('media-sync',{roomId:'media',navId:navigation.navId-1,path:[],reason:'play',state});
  a.send('media-sync',{roomId:'other-room',navId:navigation.navId,path:[],reason:'play',state});
  a.send('browser-state-request',{roomId:'media',navId:navigation.navId});
  assert.equal((await a.next('browser-state')).playback.revision,paused.revision);
  b.send('browser-ui',{roomId:'media',navId:navigation.navId,path:[],selector:'#player .play',group:'start'});
  const control=await a.next('browser-ui');
  assert.equal(control.selector,'#player .play');
  b.send('media-sync',{roomId:'media',navId:navigation.navId,path:[0,0],reason:'pause',state:{...state,time:80,paused:true}});
  await a.next('media-sync');
  a.send('browser-scroll',{roomId:'media',navId:navigation.navId,path:[],selector:'',x:0,y:0.6});
  const scrolling=await b.next('browser-scroll');assert.equal(scrolling.y,0.6);
  b.send('browser-scroll',{roomId:'media',navId:navigation.navId,path:[0],selector:'#list',x:0,y:0.3});
  const nested=await a.next('browser-scroll');assert.equal(nested.selector,'#list');
  for (const invalid of [{y:NaN},{y:2},{selector:42},{path:[-1]},{navId:navigation.navId-1},{roomId:'other-room'}]) a.send('browser-scroll',{roomId:'media',navId:navigation.navId,path:[],selector:'',x:0,y:0.8,...invalid});
  a.send('browser-state-request',{roomId:'media',navId:navigation.navId});
  assert.equal((await a.next('browser-state')).scrolls[0].revision,scrolling.revision);
  const late=await connect(t,port);
  late.send('join-room',{roomId:'media',username:'Late'});
  await late.next('room-joined');
  const restored=await late.next('sync-url');
  assert.equal(restored.url,'https://cinema.example/watch');
  assert.equal(restored.playback.state.time,80);
  assert.equal(restored.playback.state.paused,true);
  assert.equal(restored.playback.state.volume,0.4);assert.equal(restored.playback.state.muted,true);
  assert.equal(restored.controls[0].selector,'#player .play');
  assert.equal(restored.scrolls[0].y,0.6);
  assert.equal(restored.scrolls[1].selector,'#list');
});
