import { chromium } from 'playwright';

const CHROME = 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Auth
  const pairRes = await fetch('http://localhost:8787/api/pair/code', { method: 'POST' });
  const pairData = await pairRes.json();
  const reqRes = await fetch('http://localhost:8787/api/pair/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairData.code, device_name: 'test-browser' })
  });
  const reqData = await reqRes.json();
  await page.evaluate((auth) => { localStorage.setItem('auth', JSON.stringify({
    device_id: auth.device_id, refresh_token: auth.refresh_token, access_token: auth.access_token, expires_in: auth.expires_in
  })); }, reqData);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Click first thread
  const firstThread = await page.$('.thread-link, [class*="thread-item"], .sidebar button');
  if (firstThread) { await firstThread.click(); await page.waitForTimeout(3000); }

  // ===== Check collapsed tool-group-body =====
  const collapsedToolBodies = await page.$$('.tool-group-body:not(.tool-group-body-visible)');
  console.log('collapsed tool-group-body count:', collapsedToolBodies.length);

  for (let i = 0; i < Math.min(collapsedToolBodies.length, 3); i++) {
    const info = await collapsedToolBodies[i].evaluate(el => {
      const cs = window.getComputedStyle(el);
      const inner = el.querySelector('.tool-group-inner');
      const innerCS = inner ? window.getComputedStyle(inner) : null;
      const rect = el.getBoundingClientRect();
      const innerRect = inner ? inner.getBoundingClientRect() : null;
      return {
        body: { gridRows: cs.gridTemplateRows, height: cs.height, overflow: cs.overflow, rectHeight: rect.height },
        inner: innerCS ? { padding: innerCS.padding, borderLeft: innerCS.borderLeft, rectHeight: innerRect.height, overflow: innerCS.overflow } : null
      };
    });
    console.log(`collapsed tool-group-body[${i}]:`, JSON.stringify(info));
  }

  // ===== Check collapsed event-body =====
  const collapsedEventBodies = await page.$$('.event-body:not(.event-body-visible)');
  console.log('collapsed event-body count:', collapsedEventBodies.length);

  for (let i = 0; i < Math.min(collapsedEventBodies.length, 3); i++) {
    const info = await collapsedEventBodies[i].evaluate(el => {
      const cs = window.getComputedStyle(el);
      const inner = el.querySelector('.event-inner');
      const innerCS = inner ? window.getComputedStyle(inner) : null;
      const rect = el.getBoundingClientRect();
      return {
        body: { gridRows: cs.gridTemplateRows, height: cs.height, overflow: cs.overflow, rectHeight: rect.height },
        inner: innerCS ? { padding: innerCS.padding, rectHeight: inner.getBoundingClientRect().height } : null
      };
    });
    console.log(`collapsed event-body[${i}]:`, JSON.stringify(info));
  }

  // ===== Take screenshot of collapsed state =====
  const firstToolGroup = await page.$('.tool-call-group');
  if (firstToolGroup) {
    await firstToolGroup.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'verify-collapsed.png' });
    console.log('screenshot: verify-collapsed.png');
  }

  // ===== Now expand the first tool group and take screenshot =====
  const firstHeader = await page.$('.tool-group-header');
  if (firstHeader) {
    await firstHeader.click();
    await page.waitForTimeout(800);

    // Check expanded state
    const expandedBody = await page.$('.tool-group-body-visible');
    if (expandedBody) {
      const info = await expandedBody.evaluate(el => {
        const cs = window.getComputedStyle(el);
        const inner = el.querySelector('.tool-group-inner');
        const innerCS = inner ? window.getComputedStyle(inner) : null;
        return {
          body: { gridRows: cs.gridTemplateRows, height: cs.height, overflow: cs.overflow },
          inner: innerCS ? { padding: innerCS.padding, borderLeft: innerCS.borderLeft } : null
        };
      });
      console.log('expanded tool-group-body:', JSON.stringify(info));
    }

    // Expand first event too
    const firstEventRow = await page.$('.event-row');
    if (firstEventRow) {
      await firstEventRow.click();
      await page.waitForTimeout(500);
    }

    await firstToolGroup.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'verify-expanded.png' });
    console.log('screenshot: verify-expanded.png');
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
