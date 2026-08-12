import { chromium } from 'playwright';

const CHROME = 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Pair
  try {
    const pairRes = await fetch('http://localhost:8787/api/pair/code', { method: 'POST' });
    const pairData = await pairRes.json();
    if (pairData.code) {
      const reqRes = await fetch('http://localhost:8787/api/pair/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairData.code, device_name: 'test-browser' })
      });
      const reqData = await reqRes.json();
      if (reqData.access_token) {
        await page.evaluate((token) => {
          localStorage.setItem('codex_remote_token', token);
          localStorage.setItem('codex_remote_server', 'http://localhost:8787');
        }, reqData.access_token);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
      }
    }
  } catch (e) { console.log('pair error:', e.message); }

  // List threads from API
  try {
    const token = await page.evaluate(() => localStorage.getItem('codex_remote_token'));
    const threadsRes = await fetch('http://localhost:8787/api/threads');
    const threadsData = await threadsRes.json();
    console.log('threads API result:', JSON.stringify(threadsData).slice(0, 500));
  } catch(e) { console.log('threads API error:', e.message); }

  // Check the sidebar for thread items
  const sidebarHTML = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar, .thread-list, .conversation-list, [class*="thread"], [class*="sidebar"]');
    return sidebar ? sidebar.innerHTML.slice(0, 1000) : 'no sidebar found';
  });
  console.log('sidebar HTML:', sidebarHTML.slice(0, 500));

  // Look for any clickable thread items
  const allButtons = await page.$$eval('button, [role="button"], .thread-item, .thread-card', els => 
    els.map(el => ({ text: el.textContent?.slice(0, 80), class: el.className }))
  );
  console.log('clickable elements:', JSON.stringify(allButtons.slice(0, 15)));

  await page.screenshot({ path: 'inspect-home-2.png', fullPage: false });
  console.log('screenshot taken');

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
