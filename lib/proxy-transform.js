const { mediaBridge } = require('./media-bridge');
const { load } = require('cheerio');

function proxied(value, base, origin, referer = base) {
  if (!value || /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(value)) return value;
  try {
    const url = new URL(value, base);
    if (url.origin === origin && url.pathname === '/proxy') return url.href;
    return ['http:', 'https:'].includes(url.protocol) ? `${origin}/proxy?url=${encodeURIComponent(url.href)}&ref=${encodeURIComponent(referer)}${url.hash}` : value;
  } catch { return value; }
}
function rewriteCss(css, base, origin) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, quote, url) => `url("${proxied(url, base, origin)}")`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, quote, url) => `@import "${proxied(url, base, origin)}"`);
}
function frameBridge(pageUrl, origin) {
  // Function serialization keeps URLs out of executable source interpolation.
  return `(${function(pageUrl, proxyOrigin) {
    // MegaPlay provides this option for embedded hosts. Without it, its
    // canonical-domain redirect copies our /proxy path onto megaplay.buzz (404).
    if (new URL(pageUrl).hostname === 'megaplay.buzz') {
      const address = new URL(location.href);
      address.searchParams.set('bypass_host', '1');
      history.replaceState(history.state, '', address.href);
    }
    const send = (type, url) => parent.postMessage({ type, url }, '*');
    const resolve = value => {
      const url = new URL(value, document.baseURI);
      return url.origin === proxyOrigin && url.pathname === '/proxy' ? url.searchParams.get('url') || url.href : url.href;
    };
    const route = value => {
      let url = new URL(value, document.baseURI);
      if (!/^https?:$/.test(url.protocol)) return url.href;
      if (url.origin === proxyOrigin && url.pathname === '/proxy') return url.href;
      if (url.origin === proxyOrigin) url = new URL(url.pathname + url.search + url.hash, pageUrl);
      return /^https?:$/.test(url.protocol) ? proxyOrigin + '/proxy?url=' + encodeURIComponent(url.href) + '&ref=' + encodeURIComponent(pageUrl) + url.hash : url.href;
    };
    // Legacy players assign document.domain to itself as a capability probe.
    // On our shared transport origin that assignment must remain a no-op;
    // preserve the browser's restrictions for every actual domain change.
    const domain = window.Document && Object.getOwnPropertyDescriptor(window.Document.prototype, 'domain');
    if (domain?.get && domain?.set && domain.configurable) Object.defineProperty(window.Document.prototype, 'domain', {
      ...domain,
      set(value) {
        if (String(value).toLowerCase() === domain.get.call(this).toLowerCase()) return;
        return domain.set.call(this, value);
      }
    });
    // Rewrite an iframe before it starts navigation, not after the browser has
    // already sent an unproxied request. Players commonly assign .src dynamically.
    const iframeSrc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (iframeSrc?.set) Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      ...iframeSrc,
      set(value) { iframeSrc.set.call(this, route(String(value))); }
    });
    // Libraries infer their chunk directory from document.currentScript.src.
    // Expose the original script URL while loading its bytes through the proxy.
    const scriptSrc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (scriptSrc?.set) Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      ...scriptSrc,
      get() { return resolve(scriptSrc.get.call(this)); },
      set(value) { scriptSrc.set.call(this, route(String(value))); }
    });
    // Route dynamic media before play()/load(), while the caller still has its
    // user gesture. Rewriting it in the observer aborts the active play request.
    for (const MediaType of [window.HTMLMediaElement, window.HTMLSourceElement]) {
      if (!MediaType) continue;
      const source = Object.getOwnPropertyDescriptor(MediaType.prototype, 'src');
      if (source?.set) Object.defineProperty(MediaType.prototype, 'src', {
        ...source,
        set(value) { source.set.call(this, route(String(value))); }
      });
    }
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (['IFRAME', 'SCRIPT', 'VIDEO', 'AUDIO', 'SOURCE'].includes(this.tagName) && String(name).toLowerCase() === 'src') value = route(String(value));
      return nativeSetAttribute.call(this, name, value);
    };
    // SPA routers can change the page without an anchor navigation or reload.
    // Keep their history on this isolated origin and report the original URL.
    const reportLocation = value => {
      const next = new URL(value);
      const base = document.querySelector('base[data-kosmi-auto]');
      if (base) base.href = next.href;
      pageUrl = next.href;
      send('KOSMI_FRAME_LOADED', pageUrl);
    };
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function(state, title, value) {
        if (value === undefined || value === null) return original.call(this, state, title, value);
        const next = resolve(String(value));
        const result = original.call(this, state, title, route(next));
        reportLocation(next);
        return result;
      };
    }
    window.addEventListener('popstate', () => reportLocation(resolve(location.href)));
    send('KOSMI_FRAME_LOADED', pageUrl);
    document.addEventListener('click', event => {
      const link = event.target.closest?.('a[href]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || link.hasAttribute('download')) return;
      const href = link.getAttribute('href');
      if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return;
      const url = resolve(href);
      if (!/^https?:/.test(url)) return;
      event.preventDefault();
      if (window === window.parent || window.parent !== window.top) location.href = route(url);
      else send('KOSMI_FRAME_NAVIGATE', url);
    });
    document.addEventListener('submit', event => {
      const form = event.target;
      if (form.method.toLowerCase() !== 'get') return;
      event.preventDefault();
      const url = new URL(form.getAttribute('action') || pageUrl, document.baseURI);
      const data = new FormData(form, event.submitter);
      url.search = new URLSearchParams(data).toString();
      if (window === window.parent || window.parent !== window.top) location.href = route(url.href);
      else send('KOSMI_FRAME_NAVIGATE', url.href);
    });
    const nativeFetch = window.fetch;
    window.fetch = (resource, init) => {
      if (resource instanceof Request) return nativeFetch(new Request(route(resource.url), resource), init);
      return nativeFetch(route(String(resource)), init);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) { return open.call(this, method, route(String(url)), ...args); };
    const configureJQuery = () => {
      const jq = window.jQuery;
      if (!jq?.ajaxPrefilter || jq.__kosmiProxy) return;
      jq.__kosmiProxy = true;
      // jQuery chooses its script/JSONP transport before XMLHttpRequest.open.
      // Reclassify routed requests as same-origin so synchronous dependencies
      // (for example a player's crypto helper) remain synchronous.
      const prepare = options => {
        const next = route(options.url || pageUrl);
        if (/^https?:/.test(next)) { options.url = next; options.crossDomain = false; }
      };
      jq.ajaxPrefilter('+script +json +jsonp *', prepare);
    };
    configureJQuery();
    new MutationObserver(records => {
      configureJQuery();
      for (const record of records) {
        const elements = record.type === 'attributes' ? [record.target] : [...record.addedNodes].flatMap(node => node.nodeType === 1 ? [node, ...node.querySelectorAll('iframe,script,video,audio,source')] : []);
        for (const element of elements) {
          if (!element.matches('iframe,script,video,audio,source')) continue;
          const src = element.getAttribute('src');
          if (src && !/^(blob:|data:)/i.test(src)) {
            const next = route(src);
            if (next !== src) element.setAttribute('src', next);
          }
          if (element.tagName === 'VIDEO') element.setAttribute('playsinline', '');
        }
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    window.addEventListener('DOMContentLoaded', () => { configureJQuery(); document.querySelectorAll('video').forEach(video => video.setAttribute('playsinline', '')); });
  }.toString()})(${JSON.stringify(pageUrl).replace(/</g, '\\u003c')},${JSON.stringify(origin).replace(/</g, '\\u003c')});`;
}
function rewriteHtml(html, finalUrl, origin) {
  const $ = load(html);
  const declaredBase = $('base[href]').first().attr('href');
  const base = new URL(declaredBase || finalUrl, finalUrl).href;
  $('base').remove();
  $('meta[charset]').attr('charset', 'utf-8');
  $('meta[http-equiv]').each((_, el) => {
    if (/content-security-policy|refresh/i.test($(el).attr('http-equiv'))) $(el).remove();
  });
  // Cache/lazy-load plugins often leave player frames at about:blank and put
  // the real source in a data attribute. Load media without depending on the
  // original site's deferred-script loader surviving the proxy origin.
  $('iframe,video,audio,source').each((_, el) => {
    const node = $(el), current = node.attr('src');
    if (current && current !== 'about:blank' && !/^data:/i.test(current)) return;
    const attribute = ['data-litespeed-src','data-src','data-lazy-src'].find(name => node.attr(name));
    if (!attribute) return;
    node.attr('src', node.attr(attribute)).removeAttr(attribute).removeAttr('data-lazyloaded');
  });
  $('[integrity]').removeAttr('integrity');
  $('[crossorigin]').removeAttr('crossorigin');
  $('script[src],link[rel=stylesheet][href],link[rel=icon][href],link[rel=preload][href],link[rel=modulepreload][href],a[href],img[src],iframe[src],video[src],audio[src],source[src],track[src],video[poster]').each((_, el) => {
    const node = $(el);
    for (const attr of ['src', 'href', 'poster']) {
      if (node.attr(attr)) node.attr(attr, proxied(node.attr(attr), base, origin));
    }
  });
  $('[srcset]').each((_, el) => {
    const node = $(el), srcset = node.attr('srcset');
    if (!srcset.includes('data:')) node.attr('srcset', srcset.split(',').map(candidate => {
      const [url, ...size] = candidate.trim().split(/\s+/);
      return [proxied(url, base, origin), ...size].join(' ');
    }).join(', '));
  });
  $('style').each((_, el) => $(el).text(rewriteCss($(el).text(), base, origin)));
  $('[style]').each((_, el) => $(el).attr('style', rewriteCss($(el).attr('style'), base, origin)));
  $('video').attr('playsinline', '');
  $('iframe').attr('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen').attr('allowfullscreen', '');
  $('head').prepend(`<base ${declaredBase ? '' : 'data-kosmi-auto '}href="${base.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`);
  $('base').after($('<script>').text(frameBridge(finalUrl, origin)));
  if (!$('meta[name="viewport"]').length) $('head').prepend('<meta name="viewport" content="width=device-width,initial-scale=1">');
  $('base').after($('<script>').text(`(${mediaBridge.toString()})();`));
  return $.html();
}
function rewritePlaylist(text, base, origin, referer = base) {
  const mediaUrl = value => {
    const routed = proxied(value, base, origin, referer);
    if (!/^https?:/.test(routed)) return routed;
    const url = new URL(routed);
    url.searchParams.set('media', '1');
    return url.href;
  };
  return text.split('\n').map(line => line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, url) => `URI="${mediaUrl(url)}"`) : line.trim() ? mediaUrl(line.trim()) : line).join('\n');
}


module.exports = { rewriteHtml, rewriteCss, rewritePlaylist };
