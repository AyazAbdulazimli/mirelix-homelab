const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://localhost:3030';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const contexts = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    await context.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    assert.equal(await page.locator('html').getAttribute('lang'), 'az');
    await page.locator('[data-language-select]').selectOption('en');
    assert.match(await page.locator('#btnCreateRoom').innerText(), /Create a Room/);
    assert.equal(await page.locator('#roomIdInput').getAttribute('placeholder'), 'Room code / link');
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    // Deliberately use a name and message that also occur in the UI dictionary.
    await page.locator('#usernameInput').fill('Brauzer');
    await page.locator('#btnCreateRoom').click();
    await page.waitForURL(url => url.pathname.startsWith('/room/'), { waitUntil: 'domcontentloaded' });
    await page.locator('#myUsernameDisplay[data-i18n-bound]').waitFor();
    assert.equal(await page.locator('#myUsernameDisplay').innerText(), 'Brauzer');
    assert.equal(await page.locator('#localUserCardName').innerText(), 'Brauzer (You)');
    assert.equal(await page.locator('#chatInput').getAttribute('placeholder'), 'Write a message…');
    const room = page.url();
    const peerContext = await browser.newContext();
    contexts.push(peerContext);
    await peerContext.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
    const peer = await peerContext.newPage();
    await peer.goto(room, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('userCount').textContent === '2');
    await page.locator('#chatInput').fill('Brauzer');
    await page.locator('#chatInput').press('Enter');
    await peer.locator('.msg-body').filter({ hasText: 'Brauzer' }).waitFor();
    await page.evaluate(() => { window.languageTestMarker = 'still-connected'; });
    await page.locator('[data-language-select]').selectOption('tr');
    assert.equal(await page.locator('.stage-tab[data-view="browser"] .tab-text').innerText(), 'Tarayıcı');
    assert.equal(await page.locator('#chatWelcome').isHidden(), true);
    assert.equal(await page.locator('#myUsernameDisplay').innerText(), 'Brauzer');
    assert.equal(await page.locator('.msg-body').last().innerText(), 'Brauzer');
    assert.equal(await page.locator('#chatInput').getAttribute('placeholder'), 'Mesaj yaz…');
    assert.equal(await page.evaluate(() => window.languageTestMarker), 'still-connected');
    assert.equal(await peer.locator('html').getAttribute('lang'), 'az');
    // A language change must not disconnect the room or affect another participant.
    await page.locator('#chatInput').fill('Still here');
    await page.locator('#chatInput').press('Enter');
    await peer.locator('.msg-body').filter({ hasText: 'Still here' }).waitFor();
    await page.locator('[data-language-select]').selectOption('az');
    assert.equal(await page.locator('#localUserCardName').innerText(), 'Brauzer (Siz)');
    assert.equal(await page.locator('.stage-tab[data-view="browser"] .tab-text').innerText(), 'Brauzer');
    for (const language of ['en', 'tr', 'az']) {
      await page.locator('[data-language-select]').selectOption(language);
      for (const width of [320, 390, 844, 1440]) {
        await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
        await page.waitForFunction(() => Math.abs(document.body.clientHeight - innerHeight) <= 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${language} overflow at ${width}`);
        const picker = await page.locator('[data-language-select]').boundingBox();
        assert.ok(picker.x >= 0 && picker.x + picker.width <= width, `${language} picker clipped at ${width}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-language-select]').selectOption('en');
    await page.screenshot({ path: '/tmp/mirelix-language-en.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: AZ/EN/TR live switching, persistence, room continuity, independent participants, unchanged names/messages, mobile layout');
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
