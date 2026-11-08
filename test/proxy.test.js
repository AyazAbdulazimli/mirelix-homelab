const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { load } = require('cheerio');
const { installProxy, validatePublic, rewriteHtml, rewriteCss, rewritePlaylist } = require('../lib/proxy');

async function fixture(t, fetchImpl, validate = async () => {}) {
  const app = express();
  installProxy(app, { fetchImpl, validate });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/proxy?url=`;
}

test('HTML rewrites assets, nested players and base URLs without losing navigation targets', () => {
  const $ = load(rewriteHtml('<HTML><HEAD data-x="1"><base href="/films/"><meta http-equiv="Content-Security-Policy" content="default-src none"></HEAD><body><a href="next">Film</a><iframe src="../player/7"></iframe><video src="clip.mp4"></video><script src="/app.js" integrity="bad"></script></body></HTML>', 'https://cinema.example/catalog', 'https://room.example'));
  assert.equal($('base').attr('href'), 'https://cinema.example/films/');
  assert.equal(new URL($('a').attr('href')).searchParams.get('url'), 'https://cinema.example/films/next');
  assert.equal(new URL($('iframe').attr('src')).searchParams.get('url'), 'https://cinema.example/player/7');
  assert.equal(new URL($('video').attr('src')).searchParams.get('url'), 'https://cinema.example/films/clip.mp4');
  assert.equal($('meta[http-equiv]').length, 0);
  assert.equal($('script[integrity]').length, 0);
  const bridge = $('script').map((_, el) => $(el).text()).get().find(source => source.includes('XMLHttpRequest'));
  assert.doesNotThrow(() => new Function(bridge));
  assert.match(bridge, /XMLHttpRequest/);
});

test('CSS and HLS resolve relative resources and encryption-key URIs', () => {
  const css = rewriteCss('@import "theme.css";a{background:url(../a.png)}', 'https://media.example/css/main.css', 'https://room.example');
  assert.match(css, /https%3A%2F%2Fmedia.example%2Fa.png/);
  assert.match(css, /theme.css/);
  const playlist = rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\nseg.ts\n', 'https://media.example/movie/index.m3u8', 'https://room.example');
  assert.match(playlist, /movie%2Fkey/);
  assert.match(playlist, /movie%2Fseg.ts/);
});

test('range requests stream 206 bytes and preserve media headers', async t => {
  const base = await fixture(t, async (url, options) => {
    assert.equal(options.headers.Range, 'bytes=2-5');
    return new Response(Buffer.from('cdef'), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 2-5/8', 'accept-ranges': 'bytes', 'content-length': '4' } });
  });
  const response = await fetch(base + encodeURIComponent('https://media.example/film.mp4'), { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/8');
  assert.equal(response.headers.get('content-length'), '4');
  assert.equal(await response.text(), 'cdef');
});

test('redirects resolve final base and each destination is validated', async t => {
  const checked = [];
  const base = await fixture(t, async url => url.endsWith('/start') ? new Response(null, { status: 302, headers: { location: '/films/' } }) : new Response('<html><h1>Films</h1></html>', { headers: { 'content-type': 'text/html' } }), async url => checked.push(url.href));
  const response = await fetch(base + encodeURIComponent('https://cinema.example/start'));
  assert.deepEqual(checked, ['https://cinema.example/start', 'https://cinema.example/films/']);
  assert.equal(load(await response.text())('base').attr('href'), 'https://cinema.example/films/');
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
});

test('local, metadata and mapped private addresses are rejected', async () => {
  for (const address of ['http://127.0.0.1', 'http://10.0.0.2', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]']) await assert.rejects(validatePublic(new URL(address)));
});

test('upstream failures render escaped, actionable error pages', async t => {
  const base = await fixture(t, async () => { throw new Error('<img src=x onerror=alert(1)>'); });
  const response = await fetch(base + encodeURIComponent('https://cinema.example'));
  assert.equal(response.status, 502);
  const html = await response.text();
  assert.match(html, /&lt;img/);
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /KOSMI_FRAME_ERROR/);
});

test('preflight supports range requests from isolated website frames', async t => {
  const base = await fixture(t, async () => new Response(''));
  const response = await fetch(base + 'https://media.example', { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('access-control-allow-headers'), /Range/);
});

test('player fragments remain in the iframe URL and dynamic src assignments are intercepted', () => {
  const $ = load(rewriteHtml('<iframe src="https://player.example/watch#episode.5.sub"></iframe>', 'https://cinema.example/film', 'https://room.example'));
  const source = new URL($('iframe').attr('src'));
  assert.equal(source.hash, '#episode.5.sub');
  assert.equal(new URL(source.searchParams.get('url')).hash, '#episode.5.sub');
  assert.equal(source.searchParams.get('ref'), 'https://cinema.example/film');
  assert.match($('script').map((_, el) => $(el).text()).get().join('\n'), /HTMLIFrameElement.prototype/);
  assert.match($('script').map((_, el) => $(el).text()).get().join('\n'), /HTMLScriptElement.prototype/);
});

test('player API requests retain the original page referrer', async t => {
  let seen;
  const base = await fixture(t, async (url, options) => {
    seen = options.headers.Referer;
    return new Response('{"mode":"embed"}', {headers:{'content-type':'application/json'}});
  });
  await fetch(base + encodeURIComponent('https://player.example/get/episode') + '&ref=' + encodeURIComponent('https://player.example/watch#episode'));
  assert.equal(seen, 'https://player.example/watch');
});

test('isolated proxy documents permit origin APIs while the main-origin proxy remains restricted', async t => {
  const app = express();
  installProxy(app, { isolatedOrigin: true, validate: async () => {}, fetchImpl: async () => new Response('<html>Player</html>', {headers:{'content-type':'text/html'}}) });
  const server = app.listen(0, '127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/proxy?url=https://player.example/`);
  assert.equal(response.headers.get('content-security-policy'), null);
});

test('binary HLS segments survive misleading HTML/CSS MIME types without text decoding', async t => {
  const bytes = Buffer.from([0x47, 0x40, 0x11, 0x10, 0, 255, 128, 150, 200]);
  const base = await fixture(t, async () => new Response(bytes, {headers:{'content-type':'text/html'}}));
  const response = await fetch(base + encodeURIComponent('https://cdn.example/seg-00001.html') + '&media=1');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-security-policy'), null);
});

test('HLS children retain the embedding referrer and request raw bytes', () => {
  const playlist = rewritePlaylist('#EXTM3U\nseg-00001.css\n', 'https://cdn.example/film/index.m3u8', 'https://room.example', 'https://player.example/watch');
  const url = new URL(playlist.split('\n')[1]);
  assert.equal(url.searchParams.get('media'), '1');
  assert.equal(url.searchParams.get('ref'), 'https://player.example/watch');
});

test('player POST handshake preserves body, content type and embedding origin', async t => {
  const payload = '{"id":"episode-5","time":12}';
  const base = await fixture(t, async (url, options) => {
    assert.equal(url, 'https://megaplay.buzz/stream/trustWatch');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.toString(), payload);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers.Origin, 'https://megaplay.buzz');
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  });
  const response = await fetch(base + encodeURIComponent('https://megaplay.buzz/stream/trustWatch') + '&ref=' + encodeURIComponent('https://megaplay.buzz/stream/s-2/5/sub'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('MegaPlay embedding option prevents canonical-domain /proxy 404', () => {
  const vm = require('node:vm');
  const $ = load(rewriteHtml('<html><body>Player</body></html>', 'https://megaplay.buzz/stream/s-2/5/sub', 'https://proxy.example'));
  const source = $('script').map((_, el) => $(el).text()).get().find(text => text.includes('XMLHttpRequest'));
  let current = 'https://proxy.example/proxy?url=https%3A%2F%2Fmegaplay.buzz%2Fstream%2Fs-2%2F5%2Fsub';
  const context = {
    URL, location: { get href() { return current; } },
    history: { state: null, pushState() {}, replaceState(state, title, url) { current = url; } },
    parent: { postMessage() {} },
    HTMLIFrameElement: function() {}, HTMLScriptElement: function() {},
    Element: function() {}, XMLHttpRequest: function() {},
    MutationObserver: class { observe() {} },
    document: { baseURI: 'https://megaplay.buzz/stream/s-2/5/sub', documentElement: {}, addEventListener() {} },
    window: { addEventListener() {} }
  };
  context.Element.prototype.setAttribute = () => {};
  vm.runInNewContext(source, context);
  assert.equal(new URL(current).origin, 'https://proxy.example');
  assert.equal(new URL(current).searchParams.get('bypass_host'), '1');
  assert.equal(new URL(current).searchParams.get('url'), 'https://megaplay.buzz/stream/s-2/5/sub');
});

test('dynamic audio/video sources route synchronously before a player can call play', () => {
  const vm = require('node:vm');
  const $ = load(rewriteHtml('<html><body>Player</body></html>', 'https://cinema.example/watch', 'https://proxy.example'));
  const source = $('script').map((_, el) => $(el).text()).get().find(text => text.includes('XMLHttpRequest'));
  const loaded=[];
  class Media {}
  class Source {}
  for (const Type of [Media, Source]) Object.defineProperty(Type.prototype, 'src', { configurable:true, get(){return this.value}, set(value){this.value=value;loaded.push(value)} });
  const context={URL,history:{pushState(){},replaceState(){}},location:{href:'https://proxy.example/proxy?url=https://cinema.example/watch'},parent:{postMessage(){}},HTMLIFrameElement:function(){},HTMLScriptElement:function(){},Element:function(){},XMLHttpRequest:function(){},MutationObserver:class{observe(){}},document:{baseURI:'https://cinema.example/watch',documentElement:{},addEventListener(){}},window:{HTMLMediaElement:Media,HTMLSourceElement:Source,addEventListener(){}}};
  context.Element.prototype.setAttribute=()=>{};
  vm.runInNewContext(source,context);
  const media=new Media();media.src='/clip.mp4';
  assert.equal(new URL(loaded[0]).searchParams.get('url'),'https://cinema.example/clip.mp4');
  media.src='blob:https://proxy.example/token';assert.equal(loaded[1],'blob:https://proxy.example/token');
  const child=new Source();child.src='/track.mp3';assert.equal(new URL(loaded[2]).searchParams.get('url'),'https://cinema.example/track.mp3');
});

test('lazy-loaded film frames receive their real proxied source before navigation',()=>{
  const $=load(rewriteHtml('<iframe src="about:blank" data-lazyloaded="1" data-litespeed-src="https://player.example/embed/film"></iframe><video data-src="/movie.mp4"></video><iframe src="https://player.example/active" data-src="/unused"></iframe>','https://cinema.example/film','https://proxy.example'));
  assert.equal(new URL($('iframe').first().attr('src')).searchParams.get('url'),'https://player.example/embed/film');
  assert.equal($('iframe').first().attr('data-litespeed-src'),undefined);
  assert.equal(new URL($('video').attr('src')).searchParams.get('url'),'https://cinema.example/movie.mp4');
  assert.equal(new URL($('iframe').last().attr('src')).searchParams.get('url'),'https://player.example/active');
});

test('extensionless film playlists are identified by content before HTML transformation',async t=>{
  const base=await fixture(t,async()=>new Response('#EXTM3U\n#EXTINF:4,\nseg.jpg\n',{headers:{'content-type':'text/plain'}}));
  const response=await fetch(base+encodeURIComponent('https://player.example/m3u/token')+'&media=1');
  assert.match(response.headers.get('content-type'),/mpegurl/);
  const segment=new URL((await response.text()).split('\n')[2]);assert.equal(segment.searchParams.get('url'),'https://player.example/m3u/seg.jpg');assert.equal(segment.searchParams.get('media'),'1');
});

test('jQuery synchronous script dependencies retain their same-origin transport',()=>{
  const vm=require('node:vm');const $=load(rewriteHtml('<html><body>Player</body></html>','https://player.example/embed/film','https://proxy.example'));
  const source=$('script').map((_,el)=>$(el).text()).get().find(text=>text.includes('XMLHttpRequest'));let prepare;
  const context={URL,history:{pushState(){},replaceState(){}},location:{href:'https://proxy.example/proxy?url=https://player.example/embed/film'},parent:{postMessage(){}},HTMLIFrameElement:function(){},HTMLScriptElement:function(){},Element:function(){},XMLHttpRequest:function(){},MutationObserver:class{observe(){}},document:{baseURI:'https://player.example/embed/film',documentElement:{},addEventListener(){}},window:{jQuery:{ajaxPrefilter:(types,handler)=>{assert.match(types,/\+script/);prepare=handler}},addEventListener(){}}};
  context.Element.prototype.setAttribute=()=>{};vm.runInNewContext(source,context);
  const options={url:'https://player.example/cry.js',crossDomain:true,async:false};prepare(options);
  assert.equal(options.async,false);assert.equal(options.crossDomain,false);assert.equal(new URL(options.url).origin,'https://proxy.example');assert.equal(new URL(options.url).searchParams.get('url'),'https://player.example/cry.js');
});

test('legacy player domain self-assignment stays a no-op without permitting origin changes',()=>{
  const vm=require('node:vm');const $=load(rewriteHtml('<html><body>Player</body></html>','https://player.example/embed/film','https://proxy.example'));
  const source=$('script').map((_,el)=>$(el).text()).get().find(text=>text.includes('XMLHttpRequest'));let domainChanges=0;
  class Document {}
  Object.defineProperty(Document.prototype,'domain',{configurable:true,get(){return 'proxy.example'},set(){domainChanges++;throw new Error('Domain change forbidden')}});
  const document=Object.assign(new Document(),{baseURI:'https://player.example/embed/film',documentElement:{},addEventListener(){}});
  const context={URL,history:{pushState(){},replaceState(){}},location:{href:'https://proxy.example/proxy?url=https://player.example/embed/film'},parent:{postMessage(){}},HTMLIFrameElement:function(){},HTMLScriptElement:function(){},Element:function(){},XMLHttpRequest:function(){},MutationObserver:class{observe(){}},document,window:{Document,addEventListener(){}}};
  context.Element.prototype.setAttribute=()=>{};vm.runInNewContext(source,context);
  assert.doesNotThrow(()=>{document.domain=document.domain});assert.equal(domainChanges,0);
  assert.throws(()=>{document.domain='example'},/forbidden/);assert.equal(domainChanges,1);
  assert.equal(document.domain,'proxy.example');
});

test('binary segments with a misleading playlist MIME are streamed unchanged',async t=>{
  const bytes=new Uint8Array([0x47,0x40,0x11,0x10,0,0xff,0x80,7,8,9,10,11,12,13,14,15,16,17]);
  const base=await fixture(t,async()=>new Response(bytes,{headers:{'content-type':'application/x-mpegURL'}}));
  const response=await fetch(base+encodeURIComponent('https://cdn.example/process/token')+'&media=1');assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
});

test('document navigation detects extensionless media without changing stream requests', async t => {
  const base = await fixture(t, async value => new URL(value).pathname === '/stream'
    ? new Response('#EXTM3U\n#EXT-X-TARGETDURATION:2\nseg.ts\n', { headers: { 'content-type': 'text/plain' } })
    : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }));
  for (const [path, format] of [['stream', 'hls'], ['signed-video', 'native']]) {
    const url = 'https://media.example/' + path + '?token=keep-this';
    const response = await fetch(base + encodeURIComponent(url) + '&view=1');
    const html = await response.text();
    assert.match(html, /KOSMI_FRAME_MEDIA/);
    assert.match(html, new RegExp('"format":"' + format + '"'));
    assert.ok(html.includes(url));
  }
  const playlist = await fetch(base + encodeURIComponent('https://media.example/stream') + '&media=1');
  assert.match(await playlist.text(), /^#EXTM3U/);
});
