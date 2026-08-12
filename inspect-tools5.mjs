import { chromium } from 'playwright';

const CHROME = 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Pair
  const pairRes = await fetch('http://localhost:8787/api/pair/code', { method: 'POST' });
  const pairData = await pairRes.json();
  const reqRes = await fetch('http://localhost:8787/api/pair/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairData.code, device_name: 'test-browser' })
  });
  const reqData = await reqRes.json();
  const authObj = {
    device_id: reqData.device_id,
    refresh_token: reqData.refresh_token,
    access_token: reqData.access_token,
    expires_in: reqData.expires_in
  };
  await page.evaluate((auth) => { localStorage.setItem('auth', JSON.stringify(auth)); }, authObj);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Click the first thread (the one with tool calls)
  // The thread items are in the sidebar list
  const threadLinks = await page.$$('a[href*="thread"], .thread-link, button[class*="thread"]');
  console.log('thread links:', threadLinks.length);

  // Try clicking list items in the sidebar
  const listItems = await page.$$('.thread-list .thread-link, .sidebar-list button, [class*="thread-row"]');
  console.log('list items:', listItems.length);

  // Just click the first conversation-like element
  const firstThread = await page.$('.thread-link, [class*="thread-item"], .sidebar button');
  if (firstThread) {
    await firstThread.click();
    await page.waitForTimeout(3000);
    console.log('clicked first thread');
  } else {
    console.log('no thread found to click');
    // Try to find any clickable text containing thread content
    const allLinks = await page.$$('button, a');
    for (const link of allLinks.slice(0, 10)) {
      const text = await link.textContent().catch(() => '');
      if (text && text.includes('/')) {
        console.log('found link with text:', text.slice(0, 50));
      }
    }
  }

  await page.screenshot({ path: 'inspect-thread-open.png', fullPage: false });
  console.log('screenshot taken');

  // Check for tool groups
  const toolGroups = await page.$$('.tool-call-group');
  console.log('tool groups:', toolGroups.length);
  
  const eventCards = await page.$$('.event-card');
  console.log('event cards:', eventCards.length);

  // Check for collapsed bodies that may show visible background
  const collapsedBodies = await page.$$('.tool-group-body:not(.tool-group-body-visible)');
  console.log('collapsed tool bodies:', collapsedBodies.length);
  
  // Check computed styles of the first collapsed body
  if (collapsedBodies.length > 0) {
    const styles = await collapsedBodies[0].evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        gridTemplateRows: computed.gridTemplateRows,
        height: computed.height,
        overflow: computed.overflow,
        border: computed.border,
        background: computed.background,
        paddingBottom: computed.paddingBottom,
        paddingTop: computed.paddingTop,
        marginTop: computed.marginTop,
        marginBottom: computed.marginBottom,
      };
    });
    console.log('collapsed body styles:', JSON.stringify(styles));
    
    // Also check the inner element
    const inner = await collapsedBodies[0].$('.tool-group-inner');
    if (inner) {
      const innerStyles = await inner.evaluate(el => {
        const computed = window.getComputedStyle(el);
        return {
          height: computed.height,
          overflow: computed.overflow,
          border: computed.border,
          background: computed.background,
          padding: computed.padding,
          borderLeft: computed.borderLeft,
        };
      });
      console.log('inner styles:', JSON.stringify(innerStyles));
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
