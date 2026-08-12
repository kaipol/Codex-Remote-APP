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

  // Close any settings dialog if open
  const closeBtn = await page.$('.viewer-backdrop button, [class*="close"], .dialog-close');
  if (closeBtn) {
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  // Also try pressing Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Click first thread
  const firstThread = await page.$('.thread-link, [class*="thread-item"], .sidebar button');
  if (firstThread) { await firstThread.click(); await page.waitForTimeout(3000); }

  // Close settings again if it appeared
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Screenshot of full page to see collapsed tool groups
  const firstToolGroup = await page.$('.tool-call-group');
  if (firstToolGroup) {
    await firstToolGroup.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'verify-collapsed-2.png' });
    console.log('screenshot: verify-collapsed-2.png');

    // Try to expand by clicking the header via JS (bypass any overlay)
    await page.evaluate(() => {
      const headers = document.querySelectorAll('.tool-group-header');
      if (headers[0]) headers[0].click();
    });
    await page.waitForTimeout(800);

    // Expand first event too
    await page.evaluate(() => {
      const rows = document.querySelectorAll('.event-row');
      if (rows[0]) rows[0].click();
    });
    await page.waitForTimeout(500);

    await firstToolGroup.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'verify-expanded-2.png' });
    console.log('screenshot: verify-expanded-2.png');

    // Check for any overflow in expanded state
    const expandedBody = await page.$('.tool-group-body-visible');
    if (expandedBody) {
      const info = await expandedBody.evaluate(el => {
        const cs = window.getComputedStyle(el);
        const inner = el.querySelector('.tool-group-inner');
        const innerCS = inner ? window.getComputedStyle(inner) : null;
        const innerRect = inner ? inner.getBoundingClientRect() : null;
        const bodyRect = el.getBoundingClientRect();
        return {
          body: { gridRows: cs.gridTemplateRows, height: cs.height, overflow: cs.overflow, rectHeight: bodyRect.height },
          inner: innerCS ? { padding: innerCS.padding, borderLeft: innerCS.borderLeft, overflow: innerCS.overflow, rectHeight: innerRect.height, scrollWidth: inner.scrollWidth, clientWidth: inner.clientWidth } : null
        };
      });
      console.log('expanded tool-group-body:', JSON.stringify(info));
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
