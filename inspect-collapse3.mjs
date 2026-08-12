import { chromium } from 'playwright';

const CHROME = 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// Auth
const pairRes = await fetch('http://localhost:8787/api/pair/code', { method: 'POST' });
const pairData = await pairRes.json();
const reqRes = await fetch('http://localhost:8787/api/pair/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: pairData.code, device_name: 'inspect3' })
});
const reqData = await reqRes.json();
await page.evaluate((auth) => { localStorage.setItem('auth', JSON.stringify({
  device_id: auth.device_id, refresh_token: auth.refresh_token, access_token: auth.access_token, expires_in: auth.expires_in
})); }, reqData);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// First session is already selected - check tool groups
const toolInfo = await page.evaluate(() => {
  const groups = document.querySelectorAll('.tool-call-group');
  const bodies = document.querySelectorAll('.tool-group-body');
  const events = document.querySelectorAll('.event-body');
  const messages = document.querySelectorAll('.message-row');
  
  const collapsedBodies = [];
  bodies.forEach((b, i) => {
    if (!b.classList.contains('tool-group-body-visible')) {
      const rect = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      const children = b.querySelectorAll('*');
      const visibleChildren = [];
      children.forEach(c => {
        const r = c.getBoundingClientRect();
        const cls = typeof c.className === 'string' ? c.className : (c.className?.baseVal || '');
        if (r.height > 0) visibleChildren.push({
          tag: c.tagName, cls: cls.substring(0, 40), h: Math.round(r.height), w: Math.round(r.width)
        });
      });
      collapsedBodies.push({
        idx: i,
        rectHeight: Math.round(rect.height),
        rectWidth: Math.round(rect.width),
        gridRows: cs.gridTemplateRows,
        overflow: cs.overflow,
        visibleChildren: visibleChildren.slice(0, 8)
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
console.log('TOOL INFO:', JSON.stringify(toolInfo, null, 2));

// Take screenshot
await page.screenshot({ path: 'inspect-collapse3.png' });

// Now expand a tool group and check event-bodies
const firstHeader = await page.$('.tool-group-header');
if (firstHeader) {
  await firstHeader.click();
  await page.waitForTimeout(500);
  
  // Now check event-body collapsed state
  const eventInfo = await page.evaluate(() => {
    const bodies = document.querySelectorAll('.event-body');
    const collapsed = [];
    bodies.forEach((b, i) => {
      if (!b.classList.contains('event-body-visible')) {
        const rect = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        const children = b.querySelectorAll('*');
        const visibleChildren = [];
        children.forEach(c => {
          const r = c.getBoundingClientRect();
          const cls = typeof c.className === 'string' ? c.className : (c.className?.baseVal || '');
          if (r.height > 0) visibleChildren.push({
            tag: c.tagName, cls: cls.substring(0, 40), h: Math.round(r.height), w: Math.round(r.width)
          });
        });
        collapsed.push({
          idx: i,
          rectHeight: Math.round(rect.height),
          gridRows: cs.gridTemplateRows,
          overflow: cs.overflow,
          visibleChildren: visibleChildren.slice(0, 5)
        });
      }
    });
    return { total: bodies.length, collapsed };
  });
  console.log('EVENT INFO:', JSON.stringify(eventInfo, null, 2));
  
  await page.screenshot({ path: 'inspect-expanded3.png' });
}

await browser.close();
