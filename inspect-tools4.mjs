import { chromium } from 'playwright';

const CHROME = 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Get a pair code
  const pairRes = await fetch('http://localhost:8787/api/pair/code', { method: 'POST' });
  const pairData = await pairRes.json();
  
  const reqRes = await fetch('http://localhost:8787/api/pair/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairData.code, device_name: 'test-browser' })
  });
  const reqData = await reqRes.json();
  
  // Store as auth object matching api.ts format
  const authObj = {
    device_id: reqData.device_id,
    refresh_token: reqData.refresh_token,
    access_token: reqData.access_token,
    expires_in: reqData.expires_in
  };
  
  await page.evaluate((auth) => {
    localStorage.setItem('auth', JSON.stringify(auth));
  }, authObj);
  
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('body text after auth:', bodyText);

  // Find thread items
  const threadItems = await page.$$eval('.thread-item, [class*="thread-item"]', els => els.length);
  console.log('thread items:', threadItems);

  // Try to get threads via the app's API
  const threadsRes = await fetch('http://localhost:8787/api/threads', {
    headers: { 'Authorization': `Bearer ${reqData.access_token}` }
  });
  const threadsData = await threadsRes.json();
  console.log('threads:', JSON.stringify(threadsData).slice(0, 500));

  await page.screenshot({ path: 'inspect-authed.png' });
  console.log('screenshot taken');

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
