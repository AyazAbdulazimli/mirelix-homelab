const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtimeConfig } = require('../lib/runtime');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('homelab configuration supports mapped ports and custom TURN servers', () => {
  const iceServers = [{ urls: ['stun:lan.example:3478', 'turn:lan.example:3478'], username: 'user', credential: 'secret' }];
  const config = runtimeConfig({ PROXY_ORIGIN: 'https://proxy.example.net/', PROXY_PUBLIC_PORT: '8031', ICE_SERVERS: JSON.stringify(iceServers) });
  assert.equal(config.proxyOrigin, 'https://proxy.example.net');
  assert.equal(config.publicPort, 8031);
  assert.deepEqual(config.iceServers, iceServers);
  assert.deepEqual(runtimeConfig({ ICE_SERVERS: '[]' }).iceServers, []);
});

test('invalid deployment configuration fails at startup', () => {
  assert.equal(runtimeConfig({ PUBLIC_ORIGIN: 'https://homelab.example:8443/' }).publicOrigin, 'https://homelab.example:8443');
  for (const PUBLIC_ORIGIN of ['http://homelab.example', 'https://user:pass@homelab.example', 'https://homelab.example/path', 'https://homelab.example/?x=1']) assert.throws(() => runtimeConfig({ PUBLIC_ORIGIN }));
  for (const PROXY_ORIGIN of ['file:///tmp/x', 'https://user:pass@example.com', 'https://proxy.example/path', 'https://proxy.example/?x=1']) assert.throws(() => runtimeConfig({ PROXY_ORIGIN }));
  for (const ICE_SERVERS of ['{}', '[null]', '[{"urls":"https://example.com"}]', '[{"urls":[]}]', 'invalid']) assert.throws(() => runtimeConfig({ ICE_SERVERS }));
  for (const PROXY_PUBLIC_PORT of ['-1', '0', '65536', '3.5', 'abc']) assert.throws(() => runtimeConfig({ PROXY_PUBLIC_PORT }));
});

test('remote HTTP room links redirect to configured HTTPS while health and HTTPS stay usable', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', PROXY_PORT: '0', PUBLIC_ORIGIN: 'https://homelab.example:8443' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await once(child, 'exit'); });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => { const match = String(chunk).match(/localhost:(\d+)/); if (match) resolve(Number(match[1])); });
    child.stderr.on('data', chunk => reject(new Error(String(chunk))));
  });
  const base = `http://127.0.0.1:${port}`;
  const remote = { 'X-Forwarded-Host': '100.100.100.100:3030' };
  const response = await fetch(base + '/room/1?invite=yes', { headers: remote, redirect: 'manual' });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://homelab.example:8443/room/1?invite=yes');
  assert.equal((await fetch(base + '/healthz', { headers: remote })).status, 200);
  assert.equal((await fetch(base + '/room/1')).status, 200);
  assert.equal((await fetch(base + '/room/1', { headers: { ...remote, 'X-Forwarded-Proto': 'https' }, redirect: 'manual' })).status, 200);
});
