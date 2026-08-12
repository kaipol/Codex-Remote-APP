import { chromium } from 'playwright';

const CHROME = 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const browser = await chromium.launch({ executablePath: CHROME, headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// Auth: POST to /api/pair/code
const pairRes = await fetch('http://localhost:8787/api/pair/code', { method: 'POST' });
const pairData = await pairRes.json();
console.log('pair/code:', JSON.stringify(pairData));

if (pairData.code) {
  const reqRes = await fetch('http://localhost:8787/api/pair/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairData.code, device_name: 'inspect-final' })
  });
  const reqData = await reqRes.json();
  console.log('pair/request keys:', Object.keys(reqData).join(', '));
  
  if (reqData.device_id) {
    await page.evaluate((auth) => { localStorage.setItem('auth', JSON.stringify({
      device_id: auth.device_id, refresh_token: auth.refresh_token, access_token: auth.access_token, expires_in: auth.expires_in
    })); }, reqData);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Check what sessions exist
    const pageInfo = await page.evaluate(() => {
      const body = document.body.innerText.substring(0, 800);
      const threadLinks = [...document.querySelectorAll('.thread-link, [class*="thread"], [class*="session"]')].map(e => ({
        cls: (e.className || '').substring(0, 40),
        text: (e.innerText || '').substring(0, 60)
      }));
      return { body, threadLinks };
    });
    console.log('PAGE:', JSON.stringify(pageInfo, null, 2));
    
    // Click first thread-link if exists
    const firstThread = await page.$('.thread-link');
    if (firstThread) {
      console.log('Clicking first thread...');
      await firstThread.click();
      await page.waitForTimeout(3000);
    } else {
      // Try any clickable session item
      const sessionBtn = await page.$('.session-item, [class*="thread"] button, .sidebar button[class*="thread"]');
      if (sessionBtn) {
        console.log('Clicking session button...');
        await sessionBtn.click();
        await page.waitForTimeout(3000);
      } else {
        console.log('No sessions found to click');
      }
    }
    
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'inspect-final-1.png' });
    
    // Check for tool groups
    const toolInfo = await page.evaluate(() => {
      const groups = document.querySelectorAll('.tool-call-group');
      const bodies = document.querySelectorAll('.tool-group-body');
      const events = document.querySelectorAll('.event-body');
      const messages = document.querySelectorAll('.message-row');
      
      // Check each collapsed tool-group-body
      const collapsedBodies = [];
      bodies.forEach((b, i) => {
        if (!b.classList.contains('tool-group-body-visible')) {
          const rect = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          // Check children
          const children = b.querySelectorAll('*');
          const visibleChildren = [];
          children.forEach(c => {
            const r = c.getBoundingClientRect();
            if (r.height > 0) visibleChildren.push({
              tag: c.tagName, cls: (c.className || '').substring(0, 40), h: r.height, w: r.width
            });
          });
          collapsedBodies.push({
            idx: i,
            rectHeight: rect.height,
            gridRows: cs.gridTemplateRows,
            overflow: cs.overflow,
            visibleChildren: visibleChildren.slice(0, 5)
          });
        }
      });
      
      return {
        groups: groups.length,
        bodies: bodies.length,
        events: events.length,
        messages: messages.length,
        collapsedBodies
      };
    });
    console.log('TOOLS:', JSON.stringify(toolInfo, null, 2));
  }
}

await browser.close();
