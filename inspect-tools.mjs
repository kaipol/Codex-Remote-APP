import { chromium } from 'playwright';

const CHROME = 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Try to pair
  try {
    const pairRes = await fetch('http://localhost:8787/api/pair/code', { method: 'POST' });
    const pairData = await pairRes.json();
    console.log('pair code:', pairData);
    if (pairData.code) {
      const reqRes = await fetch('http://localhost:8787/api/pair/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairData.code, device_name: 'test-browser' })
      });
      const reqData = await reqRes.json();
      console.log('pair request:', reqData);
      if (reqData.access_token) {
        await page.evaluate((token) => {
          localStorage.setItem('codex_remote_token', token);
          localStorage.setItem('codex_remote_server', 'http://localhost:8787');
        }, reqData.access_token);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
      }
    }
  } catch (e) {
    console.log('pair error:', e.message);
  }

  await page.screenshot({ path: 'inspect-1-home.png', fullPage: false });
  console.log('screenshot 1 taken');

  // Check for any existing threads
  const threads = await page.$$('.thread-item, .thread-card');
  console.log('threads found:', threads.length);

  // Try clicking a thread if available
  if (threads.length > 0) {
    await threads[0].click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'inspect-2-thread.png', fullPage: false });
    console.log('screenshot 2 taken');

    // Check for tool groups
    const toolGroups = await page.$$('.tool-call-group');
    console.log('tool groups found:', toolGroups.length);

    if (toolGroups.length > 0) {
      // Check if any are expanded
      const openGroups = await page.$$('.tool-group-open');
      console.log('open tool groups:', openGroups.length);

      // Screenshot the first tool group
      await toolGroups[0].screenshot({ path: 'inspect-3-tool-group.png' });
      console.log('screenshot 3 taken');

      // Expand the first tool group
      const header = await toolGroups[0].$('.tool-group-header');
      if (header) {
        await header.click();
        await page.waitForTimeout(500);
        await toolGroups[0].screenshot({ path: 'inspect-4-expanded.png' });
        console.log('screenshot 4 taken');
      }
    }

    // Look for event cards
    const eventCards = await page.$$('.event-card');
    console.log('event cards found:', eventCards.length);

    // Look for collapsed event bodies that may show background
    const eventBodies = await page.$$('.event-body');
    console.log('event bodies found:', eventBodies.length);
  }

  await browser.close();
  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
