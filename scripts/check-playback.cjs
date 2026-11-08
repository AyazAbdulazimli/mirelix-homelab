// Live integration check: requires a running Mirelix server and internet access.
// Usage: npm run test:playback -- http://localhost:3040 firefox
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const engines = require('playwright');
const base = process.argv[2] || 'http://localhost:3040';
const engine = process.argv[3] || 'firefox';

async function playing(frame, timeout = 30000) {
  await frame.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && video.readyState >= 2 && video.currentTime > 1 && !video.paused && !video.error;
  }, null, { timeout });
  return frame.evaluate(() => {
    const v = document.querySelector('video');
    return { time: v.currentTime, duration: v.duration, readyState: v.readyState, paused: v.paused, error: v.error?.message || null };
  });
}
(async () => {
  const browser = await engines[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  const artifacts = path.join(process.cwd(), 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    await page.goto(base + '/room/playback-' + randomUUID(), { waitUntil: 'domcontentloaded' });
    const navigate = async url => {
      await page.locator('#browserUrlInput').fill(url);
      await page.locator('#btnBrowserGo').click();
    };
    await navigate('https://www.youtube.com/watch?v=NWANo9BRz6Y');
    const youtube = page.frames().find(f => f.url().includes('/embed/NWANo9BRz6Y')) || await page.waitForEvent('framenavigated', { predicate: f => f.url().includes('youtube-nocookie.com/embed/NWANo9BRz6Y') }).catch(() => page.frames().find(f => f.url().includes('/embed/NWANo9BRz6Y')));
    assert.ok(youtube, 'YouTube frame is present');
    console.log(engine, 'YouTube playing:', await playing(youtube));
    await page.screenshot({ path: path.join(artifacts, `${engine}-youtube.png`) });

    await navigate('https://anikototv.com/watch/i-m-dating-a-dark-summoner-8215/');
    const content = page.frameLocator('#browserIframe');
    await content.locator('#player .play').click();
    // Anikoto builds its player and nested provider dynamically after the click.
    await page.waitForFunction(() => document.getElementById('browserIframe').src.includes('/proxy?'));
    let provider;
    for (let attempt = 0; attempt < 100; attempt++) {
      provider = page.frames().find(f => {
        try { return new URL(new URL(f.url()).searchParams.get('url')).hostname === 'megaplay.buzz'; } catch { return false; }
      });
      if (provider) break;
      await page.waitForTimeout(200);
    }
    assert.ok(provider, 'Nested provider frame is present');
    let before;
    try { before = await playing(provider); }
    catch (error) {
      console.error('Playback failure frames:', page.frames().map(f => f.url()));
      await page.screenshot({ path: path.join(artifacts, `${engine}-failure.png`) });
      throw error;
    }
    await page.waitForTimeout(15000);
    const after = await playing(provider);
    assert.ok(after.time > before.time + 8, 'Video continues across multiple HLS segments');
    await provider.evaluate(() => { document.querySelector('video').currentTime = 60; });
    await provider.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.currentTime >= 60 && v.readyState >= 2 && !v.seeking && !v.error;
    }, null, { timeout: 30000 });
    console.log(engine, 'Anikoto plays continuously and seeks:', await playing(provider));
    await page.screenshot({ path: path.join(artifacts, `${engine}-anikoto.png`) });

    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false, `No overflow at ${viewport.width}px`);
    }
    console.log(engine, 'Mobile layout: 320, 390, 844px passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
