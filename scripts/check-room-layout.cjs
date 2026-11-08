const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require('playwright');
const base = process.argv[2] || 'http://localhost:3056';

(async () => {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const contexts = [];
  const room = base+'/room/layout-'+randomUUID();
  async function participant(viewport,hasTouch=false) {
    const context = await browser.newContext({viewport,hasTouch}); contexts.push(context);
    // Layout tests do not depend on an external video provider being available.
    await context.route('https://www.youtube-nocookie.com/**',route=>route.fulfill({contentType:'text/html',body:'<body style="background:#090a0c"></body>'}));
    const page = await context.newPage();
    await page.goto(room,{waitUntil:'domcontentloaded'});
    await page.locator('#roomSidebar[aria-hidden="false"]').waitFor();
    return page;
  }
  async function layout(page,stacked) {
    // visualViewport resize is asynchronous when the simulated keyboard closes.
    await page.waitForFunction(()=>Math.abs(document.body.clientHeight-innerHeight)<=1);
    const stage = await page.locator('#stageArea').boundingBox();
    const chat = await page.locator('#roomSidebar').boundingBox();
    const input = await page.locator('#chatInput').boundingBox();
    const frame = await page.locator('#browserIframe').boundingBox();
    const viewport = page.viewportSize();
    assert.ok(stage && chat && input && frame);
    if (stacked) assert.ok(chat.y >= stage.y+stage.height-1,JSON.stringify({stage,chat}));
    else assert.ok(chat.x >= stage.x+stage.width-1,JSON.stringify({stage,chat}));
    assert.ok(input.y+input.height <= viewport.height+1 && input.width>100,JSON.stringify({input,viewport}));
    assert.ok(frame.height>50 && stage.width>180,JSON.stringify({frame,stage}));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    return {stage,chat,input,frame};
  }
  try {
    const mobile = await participant({width:390,height:844});
    const desktop = await participant({width:1440,height:900});
    await desktop.locator('#userCount').filter({hasText:'2'}).waitFor();
    assert.equal(await mobile.locator('#btnQuickBrowser').isVisible(),false);
    assert.equal(await mobile.locator('.stage-tab[data-view="browser"]').isVisible(),true);
    assert.equal(await desktop.locator('#btnQuickBrowser').isVisible(),true);
    await layout(mobile,true); await layout(desktop,false);
    for (const [page,name] of [[mobile,'mobile'],[desktop,'desktop']]) {
      await page.locator('[data-view="screen"]').click();
      await page.screenshot({path:'/tmp/kosmi-layout-'+name+'.png'});
      await page.locator('[data-view="browser"]').click();
    }
    await mobile.locator('#chatInput').fill('Telefondan salam 👋');
    await mobile.locator('#chatInput').press('Enter');
    await desktop.locator('.msg-body').filter({hasText:'Telefondan salam 👋'}).waitFor();
    await desktop.locator('#chatInput').fill('Kompüterdən salam!');
    await desktop.locator('#chatInput').press('Enter');
    await mobile.locator('.msg-body').filter({hasText:'Kompüterdən salam!'}).waitFor();
    await mobile.setViewportSize({width:390,height:450});
    await mobile.locator('#chatInput').focus();
    await layout(mobile,true);
    await mobile.screenshot({path:'/tmp/kosmi-layout-keyboard.png'});
    await mobile.locator('#chatInput').blur();
    await mobile.setViewportSize({width:390,height:844});
    const before = await layout(mobile,true);
    const source = await mobile.locator('#browserIframe').getAttribute('src');
    await mobile.locator('#btnToggleSidebar').click();
    await mobile.locator('#roomSidebar').waitFor({state:'hidden'});
    assert.ok((await mobile.locator('#stageArea').boundingBox()).height>before.stage.height);
    await mobile.locator('#btnToggleSidebar').click();
    await layout(mobile,true);
    assert.equal(await mobile.locator('#browserIframe').getAttribute('src'),source);
    await mobile.setViewportSize({width:320,height:640}); await layout(mobile,true);
    await mobile.setViewportSize({width:844,height:390}); await layout(mobile,false);
    assert.equal(await mobile.locator('#btnQuickBrowser').isVisible(),false);
    await mobile.setViewportSize({width:1280,height:720}); await layout(mobile,false);
    const tablet = await participant({width:1280,height:800},true);
    assert.equal(await tablet.locator('#btnQuickBrowser').isVisible(),false);
    assert.equal(await tablet.locator('.stage-tab[data-view="browser"]').isVisible(),true);
    assert.equal(await tablet.locator('#btnToggleScreen').isVisible(),true);
    console.log('Mobile stacked stage/chat, desktop sidebar, two-way chat, keyboard-sized viewport, hide/reopen, narrow and landscape layouts passed.');
    console.log('Bottom browser shortcut hidden on phones and touch tablets; top browser tab and desktop shortcut remain available.');
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
