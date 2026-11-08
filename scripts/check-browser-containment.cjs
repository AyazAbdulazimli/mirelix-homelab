const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { installProxy } = require('../lib/proxy');
const engines = require('playwright');
const base = process.argv[2] || 'http://localhost:3055';
const engine = process.argv[3] || 'chromium';
const target = 'https://cinema.example';
const outside = 'https://escape.example/outside';
const fixture = path => `<!doctype html><html><head><title>Navigation fixture</title></head><body>
  <h1>${path}</h1><output id="result"></output>
  <script>function escapeRoom(method) {try {
    if (method === 'href') top.location.href = '${outside}';
    if (method === 'replace') top.location.replace('${outside}');
    if (method === 'open') window.open('${outside}', '_top');
    if (method === 'popup') window.open('${outside}', '_blank');
    if (method === 'form') document.getElementById('escapeForm').submit();
  } catch(error) {} document.getElementById('result').textContent = method; }
  try {top.location.href = '${outside}'} catch(error) {}</script>
  ${['href','replace','open','popup','form'].map(method => `<button id="${method}" onclick="escapeRoom('${method}')">${method}</button>`).join('')}
  <form id="escapeForm" target="_top" action="${outside}" method="post"></form>
  <a id="next" target="_top" href="/next">Next inside room</a>
  <form id="search" target="_top" action="/search"><input name="q" value="movie"><button>Search inside room</button></form>
  ${path === '/nested' ? '' : '<iframe id="nested" sandbox="allow-scripts allow-forms allow-same-origin allow-top-navigation allow-popups" src="/nested"></iframe>'}
</body></html>`;

(async () => {
  const app = express();
  installProxy(app, {isolatedOrigin:true,validate:async url=>assert.equal(url.hostname,'cinema.example'),fetchImpl:async value=>new Response(fixture(new URL(value).pathname),{headers:{'content-type':'text/html'}})});
  const proxy = http.createServer(app);
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const browser = await engines[engine].launch({headless:true,...(engine==='chromium'?{args:['--no-sandbox']}:{})});
  const contexts = [];
  const room = base + '/room/containment-' + randomUUID();
  const localProxy = 'http://127.0.0.1:' + proxy.address().port;
  // A published HTTPS room cannot embed an HTTP fixture. Keep its browser-side
  // fixture origin HTTPS and relay only these test requests to the local proxy.
  const proxyOrigin = base.startsWith('https:') ? 'https://containment-proxy.example' : localProxy;
  async function participant() {
    const context = await browser.newContext(); contexts.push(context);
    await context.route('**/api/runtime',route=>route.fulfill({json:{proxyOrigin}}));
    if (proxyOrigin !== localProxy) await context.route(proxyOrigin+'/**',async route=>{
      const incoming = new URL(route.request().url());
      const response = await context.request.fetch(localProxy+incoming.pathname+incoming.search,{method:route.request().method(),data:route.request().postDataBuffer()||undefined});
      await route.fulfill({response,body:(await response.text()).split(localProxy).join(proxyOrigin)});
    });
    await context.route('https://escape.example/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Escaped room</h1>'}));
    await context.route(target+'/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Explicit external tab</h1>'}));
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(room,{waitUntil:'domcontentloaded'}); return page;
  }
  try {
    const a = await participant(), b = await participant();
    await a.locator('#userCount').filter({hasText:'2'}).waitFor();
    await a.locator('#browserUrlInput').fill(target+'/probe');
    await a.locator('#browserUrlInput').press('Enter');
    for (const page of [a,b]) await page.frameLocator('#browserIframe').locator('h1').filter({hasText:'/probe'}).waitFor();
    for (const page of [a,b]) {
      const root = page.frameLocator('#browserIframe');
      for (const frame of [root,root.frameLocator('#nested')]) {
        for (const method of ['href','replace','open','popup','form']) {
          await frame.locator('#'+method).click();
          await page.waitForTimeout(100);
          assert.equal(page.url(),room,method+' must keep the room open');
          assert.equal(page.context().pages().length,1,'website scripts must not open another tab');
        }
      }
    }
    console.log(engine,'Pasted URL, scripted top redirects, window.open, forms and nested-frame escapes kept both rooms open.');
    await a.frameLocator('#browserIframe').locator('#next').click();
    for (const page of [a,b]) {
      await page.frameLocator('#browserIframe').locator('h1').filter({hasText:'/next'}).waitFor();
      assert.equal(page.url(),room);
      assert.equal(await page.locator('#browserUrlInput').inputValue(),target+'/next');
    }
    await b.frameLocator('#browserIframe').locator('#search button').click();
    for (const page of [a,b]) {
      await page.frameLocator('#browserIframe').locator('h1').filter({hasText:'/search'}).waitFor();
      assert.equal(page.url(),room);
      assert.equal(await page.locator('#browserUrlInput').inputValue(),target+'/search?q=movie');
    }
    const popupPromise = a.waitForEvent('popup');
    await a.locator('#btnOpenExternal').click();
    const popup = await popupPromise; await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(),target+'/search?q=movie'); await popup.close();
    assert.equal(a.url(),room);
    console.log(engine,'Links and GET forms with target=_top navigated inside both synchronized browsers; explicit external-tab button still works.');
  } finally {
    for (const context of contexts) await context.close();
    await browser.close(); await new Promise(resolve=>proxy.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1});
