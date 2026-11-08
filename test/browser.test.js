const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = { window: {}, document: { getElementById() {}, querySelector() {} }, URL, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync('public/js/browser.js', 'utf8'), context);
const browser = Object.create(context.window.BrowserManager.prototype);

test('domain, URL, unicode and search inputs normalize correctly', () => {
  assert.equal(browser.formatUrl(' cinema.example/film?x=1 '), 'https://cinema.example/film?x=1');
  assert.equal(browser.formatUrl('HTTPS://EXAMPLE.COM'), 'https://example.com/');
  assert.equal(browser.formatUrl('//example.com/a'), 'https://example.com/a');
  assert.equal(browser.formatUrl('film axtar'), 'https://duckduckgo.com/?q=film%20axtar');
  assert.match(browser.formatUrl('bücher.de'), /xn--bcher-kva/);
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:pass@example.com']) assert.throws(() => browser.formatUrl(url));
});

test('YouTube links support watch, short, shorts, live and timestamps', () => {
  for (const url of ['https://youtu.be/jfKfPfyJRdk', 'https://youtube.com/watch?v=jfKfPfyJRdk', 'https://youtube.com/shorts/jfKfPfyJRdk', 'https://youtube.com/live/jfKfPfyJRdk']) assert.match(browser.getYouTubeEmbed(url), /embed\/jfKfPfyJRdk/);
  assert.match(browser.getYouTubeEmbed('https://youtu.be/jfKfPfyJRdk?t=1m30s'), /start=90/);
  assert.equal(browser.getYouTubeEmbed('https://youtube.com'), '/youtube.html');
  assert.equal(browser.getYouTubeEmbed('https://notyoutube.com/watch?v=jfKfPfyJRdk'), null);
});

test('back and forward use room history and new navigation truncates forward history', async () => {
  const emitted = [];
  Object.assign(browser, { proxyOrigin: '', history: ['https://a.example/', 'https://b.example/'], historyIndex: 1, urlInput: {}, iframe: { setAttribute() {} }, socket: { emit: (event, data) => emitted.push(data.url) }, roomId: 'test', showLoader() {}, updateHistoryButtons() {} });
  await browser.moveHistory(-1);
  assert.equal(browser.currentUrl, 'https://a.example/');
  await browser.navigateTo('c.example');
  assert.deepEqual(browser.history, ['https://a.example/', 'https://c.example/']);
  assert.equal(emitted.length, 2);
  assert.equal(browser.iframe.src, '/proxy?url=https%3A%2F%2Fc.example%2F&view=1');
});

test('a local media action supersedes the previous participant cached state', () => {
  const sent=[];
  const instance=Object.create(context.window.BrowserManager.prototype);
  Object.assign(instance,{navId:7,roomId:'room',lastPlayback:{revision:3,state:{time:50,paused:false}},socket:{emit:(type,data)=>sent.push({type,data})}});
  instance.handleMediaMessage({type:'media',path:[],reason:'pause',state:{time:52,paused:true,rate:1,mediaIndex:0}});
  assert.equal(instance.lastPlayback,null);
  assert.equal(sent[0].type,'media-sync');
  assert.equal(sent[0].data.state.paused,true);
});


test('all external sites automatically use synchronized transport and YouTube retains its API wrapper', async () => {
  const instance = Object.create(context.window.BrowserManager.prototype);
  const frames = [];
  const attributes = new Map();
  Object.assign(instance, {
    proxyOrigin: 'https://proxy.example', history: [], historyIndex: -1, urlInput: {},
    iframe: { set src(value) { frames.push(value); }, setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); } },
    socket: { emit() {} }, roomId: 'test', showLoader() {}, updateHistoryButtons() {}
  });
  const film = 'https://blocked.example/watch';
  for (const url of [film, 'https://music.example/listen', 'https://cinema.example/watch#episode-3']) {
    await instance.navigateTo(url);
    const source = new URL(frames.pop());
    assert.equal(source.origin, 'https://proxy.example');
    assert.equal(source.searchParams.get('url'), url);
    assert.equal(source.hash, new URL(url).hash);
    const sandbox = attributes.get('sandbox').split(' ');
    assert.ok(sandbox.includes('allow-scripts') && sandbox.includes('allow-forms') && sandbox.includes('allow-same-origin'));
    assert.ok(!sandbox.some(token => /top-navigation|popups/.test(token)));
  }
  await instance.navigateTo('https://anikototv.com/home/');
  assert.equal(new URL(frames.pop()).searchParams.get('url'), 'https://anikototv.com/home/');
  assert.ok(!/top-navigation|popups/.test(attributes.get('sandbox')));
  await instance.navigateTo('https://youtu.be/jfKfPfyJRdk');
  assert.match(frames.pop(), /^\/player.html\?video=jfKfPfyJRdk/);
});


test('direct media URLs open an app-owned player with their full signed query intact',()=>{
  for(const extension of ['mp4','m3u8','webm','wav','mp3']){
    const source='https://cdn.example/movie.'+extension+'?token=a%2Fb&expires=42';
    const player=new URL(browser.getMediaEmbed(source),'https://app.example');
    assert.equal(player.pathname,'/media.html');assert.equal(player.searchParams.get('url'),source);
  }
  assert.equal(browser.getMediaEmbed('https://cinema.example/watch?id=film.mp4'),null);
});

test('clock synchronization uses the lowest RTT sample and corrects ongoing playback for elapsed time',()=>{
  let clock=10200;const local={window:{},URL,Date:{now:()=>clock},setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync('public/js/browser.js','utf8'),local);
  const instance=Object.create(local.window.BrowserManager.prototype);instance.clockSamples=[];
  instance.updateClock({sentAt:10000,serverTime:15100});assert.equal(instance.clockOffset,5000);
  clock=10600;instance.updateClock({sentAt:10200,serverTime:15500});assert.equal(instance.clockOffset,5000);
  instance.navId=1;let message;instance.postMedia=value=>{message=value};
  instance.applyPlayback({navId:1,revision:2,at:15000,serverTime:15000,state:{time:10,paused:false,rate:2,mediaIndex:0}});
  assert.ok(Math.abs(message.state.time-11.2)<0.001);
  instance.applyPlayback({navId:1,revision:3,at:15000,state:{time:10,paused:true,rate:2,mediaIndex:0}});
  assert.equal(message.state.time,10);
});

test('a newer navigation wins while runtime configuration is still loading',async()=>{
  let resolveRuntime;const wait=new Promise(resolve=>{resolveRuntime=resolve});const emitted=[];
  const instance=Object.create(context.window.BrowserManager.prototype);
  Object.assign(instance,{runtimeReady:wait,proxyOrigin:'',history:[],historyIndex:-1,urlInput:{},iframe:{setAttribute(){}},socket:{emit:(event,data)=>emitted.push(data.url)},roomId:'test',showLoader(){},updateHistoryButtons(){}});
  const first=instance.navigateTo('first.example'),second=instance.navigateTo('second.example');resolveRuntime();
  await Promise.all([first,second]);assert.equal(instance.currentUrl,'https://second.example/');assert.deepEqual(emitted,['https://second.example/']);
});

test('film fallback only runs once for the failing current bookmark and broadcasts its real URL',async()=>{
  const instance=Object.create(context.window.BrowserManager.prototype),emitted=[];
  context.window.toast=()=>{};
  Object.assign(instance,{proxyOrigin:'https://proxy.example',history:[],historyIndex:-1,urlInput:{},iframe:{setAttribute(){},removeAttribute(){}},socket:{emit:(event,data)=>emitted.push(data.url)},roomId:'test',showLoader(){},updateHistoryButtons(){}});
  await instance.navigateTo('https://cinema.example/missing',true,true,'https://alternative.example/same-film');
  instance.showFrameError({code:'missing',requestedUrl:'https://cinema.example/stale'});
  assert.equal(instance.currentUrl,'https://cinema.example/missing');
  instance.showFrameError({code:'missing',requestedUrl:instance.currentUrl});
  await Promise.resolve();
  assert.equal(instance.currentUrl,'https://alternative.example/same-film');
  assert.equal(instance.pendingFallback,null);
  assert.deepEqual(emitted,['https://cinema.example/missing','https://alternative.example/same-film']);
});

test('detected extensionless media uses the owned player and ignores stale navigation', () => {
  const instance = Object.create(context.window.BrowserManager.prototype);
  Object.assign(instance, { currentUrl: 'https://media.example/stream?token=1', iframe: { setAttribute() {} } });
  instance.openDetectedMedia({ requestedUrl: instance.currentUrl, url: instance.currentUrl, format: 'hls' });
  const player = new URL(instance.iframe.src, 'https://room.example');
  assert.equal(player.pathname, '/media.html');
  assert.equal(player.searchParams.get('url'), instance.currentUrl);
  assert.equal(player.searchParams.get('format'), 'hls');
  instance.openDetectedMedia({ requestedUrl: 'https://old.example/', url: 'https://wrong.example/', format: 'native' });
  assert.equal(instance.iframe.src, player.pathname + player.search);
  instance.openDetectedMedia({ requestedUrl: instance.currentUrl, url: 'javascript:alert(1)', format: 'native' });
  assert.equal(instance.iframe.src, player.pathname + player.search);
});
