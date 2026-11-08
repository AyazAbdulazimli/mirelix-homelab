const { inspectBody } = require('./proxy-body');
const { proxyFailure } = require('./proxy-error');
const { raw } = require('express');
const { rewriteHtml, rewriteCss, rewritePlaylist } = require('./proxy-transform');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');

function targetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Sayt ünvanını daxil edin.');
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Yalnız HTTP və HTTPS ünvanları dəstəklənir.');
  return url;
}
async function validatePublic(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
    throw new Error('Yalnız açıq internet saytlarına baxmaq olar.');
  }
}
function installProxy(app, { fetchImpl = fetch, validate = validatePublic, isolatedOrigin = false } = {}) {
  app.options('/proxy', (req, res) => res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Range,Content-Type,Accept' }).sendStatus(204));
  app.all('/proxy', raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return res.sendStatus(405);
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range,Accept-Ranges,Content-Length', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30000);
    res.on('close', () => { clearTimeout(timeout); abort.abort(); });
    let url;
    try {
      url = targetUrl(req.query.url);
      const origin = `${req.protocol}://${req.get('host')}`;
      let referer;
      try {
        const ref = new URL(req.query.ref);
        if (['http:', 'https:'].includes(ref.protocol)) referer = ref.href;
      } catch { /* Use the target origin for requests without a page referrer. */ }
      let upstream;
      let method = req.method;
      let body = method === 'POST' ? (Buffer.isBuffer(req.body) ? req.body : req.body ? JSON.stringify(req.body) : undefined) : undefined;
      for (let redirects = 0; redirects <= 8; redirects++) {
        await validate(url);
        const headers = { 'User-Agent': req.get('user-agent') || 'Mozilla/5.0', Accept: req.get('accept') || '*/*', 'Accept-Language': 'az,en;q=0.9', 'Accept-Encoding': 'identity', Referer: referer && new URL(referer).origin === url.origin ? referer.split('#')[0] : (referer ? new URL(referer).origin : url.origin) + '/' };
        if (referer) headers.Origin = new URL(referer).origin;
        if (req.get('range')) headers.Range = req.get('range');
        if (method === 'POST' && req.get('content-type')) headers['Content-Type'] = req.get('content-type');
        upstream = await fetchImpl(url.href, { headers, signal: abort.signal, redirect: 'manual', method, body });
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
        if (upstream.status === 303 || (method === 'POST' && [301, 302].includes(upstream.status))) { method = 'GET'; body = undefined; }
        const location = upstream.headers.get('location');
        await upstream.body?.cancel();
        if (!location || redirects === 8) throw new Error('Sayt həddindən artıq yönləndirmə edir.');
        url = new URL(location, url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Yanlış yönləndirmə ünvanı.');
      }
      // The 30s deadline covers connection/headers, never a whole movie stream.
      clearTimeout(timeout);
      const type = upstream.headers.get('content-type') || 'application/octet-stream';
      const inspected = req.method === 'HEAD' || [204,304].includes(upstream.status) ? {body:null,playlist:false} : await inspectBody(upstream.body);
      const playlist = inspected.playlist;
      const rawMedia = req.query.media === '1' && !playlist;
      if (upstream.status >= 400 && type.includes('text/html')) throw Object.assign(new Error(`Sayt sorğunu qəbul etmədi (HTTP ${upstream.status}).`), { upstreamStatus: upstream.status });
      // A URL need not have a media extension (signed CDN links often do not).
      // Only room document navigation opts in; HLS/fetch/Range requests keep bytes.
      if (req.query.view === '1' && req.method === 'GET' && upstream.ok && (playlist || /^(video|audio)\//i.test(type))) {
        await inspected.body?.cancel();
        const packet = { type: 'KOSMI_FRAME_MEDIA', url: url.href, requestedUrl: req.query.url, format: playlist ? 'hls' : 'native' };
        return res.type('html').send('<!doctype html><meta charset="utf-8"><script>parent.postMessage(' + JSON.stringify(packet).replace(/</g, '\\u003c') + ',"*")</script>');
      }
      res.status(upstream.status);
      res.set('Content-Type', rawMedia ? 'application/octet-stream' : type);
      for (const name of ['content-range', 'accept-ranges']) if (upstream.headers.has(name)) res.set(name, upstream.headers.get(name));
      // The dedicated proxy has no app endpoints or app storage. The room's
      // outer iframe keeps navigation restrictions while retaining origin APIs.
      if (!isolatedOrigin && !rawMedia && type.includes('text/html')) res.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-presentation');
      if (req.method === 'HEAD' || [204, 304].includes(upstream.status)) return res.end();
      if (playlist) return res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(await new Response(inspected.body).text(), url.href, origin, referer || url.origin + '/'));
      if (!rawMedia && (type.includes('text/html') || type.includes('text/css'))) {
        const encoding = type.match(/charset=["']?([^;\s"']+)/i)?.[1] || 'utf-8';
        const bytes = await new Response(inspected.body).arrayBuffer();
        let text;
        try { text = new TextDecoder(encoding).decode(bytes); } catch { text = new TextDecoder().decode(bytes); }
        res.set('Content-Type', `${type.split(';')[0]}; charset=utf-8`);
        return res.send(type.includes('text/html') ? rewriteHtml(text, url.href, origin) : rewriteCss(text, url.href, origin));
      }
      if (!upstream.headers.has('content-encoding') && upstream.headers.has('content-length')) res.set('Content-Length', upstream.headers.get('content-length'));
      if (inspected.body) await pipeline(Readable.fromWeb(inspected.body), res);
      else res.end();
    } catch (err) {
      if (res.headersSent) return res.destroy();
      res.status(502).type('html').send(proxyFailure(err, url?.href, req.query.url).html);
    } finally { clearTimeout(timeout); }
  });
}
module.exports = { installProxy, targetUrl, validatePublic, rewriteHtml, rewriteCss, rewritePlaylist };
