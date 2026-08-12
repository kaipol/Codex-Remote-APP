import { chromium } from 'playwright';

const CHROME = 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

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

  // Check the event-body collapsed state
  const collapsedEventBodies = await page.$$('.event-body:not(.event-body-visible)');
  console.log('collapsed event bodies:', collapsedEventBodies.length);
  
  if (collapsedEventBodies.length > 0) {
    const styles = await collapsedEventBodies[0].evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        gridTemplateRows: computed.gridTemplateRows,
        height: computed.height,
        overflow: computed.overflow,
      };
    });
    console.log('collapsed event body:', JSON.stringify(styles));
    
    const inner = await collapsedEventBodies[0].$('.event-inner');
    if (inner) {
      const innerStyles = await inner.evaluate(el => {
        const computed = window.getComputedStyle(el);
        return {
          height: computed.height,
          overflow: computed.overflow,
          padding: computed.padding,
          border: computed.border,
        };
      });
      console.log('event inner:', JSON.stringify(innerStyles));
    }
  }

  // Take a screenshot showing the visible border issue on collapsed groups
  // Let's scroll to the first tool group
  const firstToolGroup = await page.$('.tool-call-group');
  if (firstToolGroup) {
    await firstToolGroup.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'inspect-collapsed-border.png' });
    console.log('screenshot of collapsed groups taken');
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
