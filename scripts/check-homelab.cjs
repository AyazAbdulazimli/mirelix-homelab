const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.argv[2] || 'http://localhost:3030';
const sockets = [];

async function participant() {
  const endpoint = new URL('/socket.io/?EIO=4&transport=websocket', base);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(endpoint);
  sockets.push(ws);
  const queue = [], waiting = [];
  await new Promise((resolve, reject) => {
    ws.onerror = reject;
    ws.onmessage = ({ data }) => {
      if (data.startsWith('0')) return ws.send('40');
      if (data.startsWith('40')) return resolve();
      if (data === '2') return ws.send('3');
      if (!data.startsWith('42')) return;
      const [event, payload] = JSON.parse(data.slice(2));
      const index = waiting.findIndex(item => item.event === event);
      if (index < 0) queue.push({ event, payload });
      else waiting.splice(index, 1)[0].resolve(payload);
    };
  });
  return {
    emit(event, payload) { ws.send('42' + JSON.stringify([event, payload])); },
    next(event) {
      const index = queue.findIndex(item => item.event === event);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0].payload);
      return new Promise(resolve => waiting.push({ event, resolve }));
    }
  };
}

(async () => {
  const deadline = setTimeout(() => { console.error('Homelab smoke check timed out'); process.exit(1); }, 15000);
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const runtime = await (await fetch(base + '/api/runtime')).json();
    assert.notEqual(new URL(runtime.proxyOrigin).origin, new URL(base).origin);
    assert.equal((await fetch(runtime.proxyOrigin + '/healthz')).status, 200);
    assert.equal((await fetch(runtime.proxyOrigin + '/room/example')).status, 404);
    assert.equal((await fetch(base + '/socket.io/socket.io.js')).status, 200);
    assert.equal((await fetch(base + '/vendor/hls.min.js')).status, 200);
    assert.ok(Array.isArray((await (await fetch(base + '/api/ice')).json()).iceServers));
    const roomId = 'smoke-' + randomUUID();
    const a = await participant();
    a.emit('join-room', { roomId, username: 'A' });
    await a.next('room-joined');
    await a.next('sync-url');
    const b = await participant();
    b.emit('join-room', { roomId, username: 'B' });
    await b.next('room-joined');
    await b.next('sync-url');
    a.emit('chat-message', { roomId, text: 'Docker smoke check' });
    let message;
    do { message = await b.next('chat-message'); } while (message.isSystem);
    assert.equal(message.text, 'Docker smoke check');
    a.emit('sync-url', { roomId, url: 'https://example.com/watch' });
    assert.equal((await b.next('sync-url')).url, 'https://example.com/watch');
    console.log('PASS: app/proxy health, origin isolation, local assets, ICE, two participants, chat and navigation');
  } finally {
    clearTimeout(deadline);
    sockets.forEach(ws => ws.close());
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
