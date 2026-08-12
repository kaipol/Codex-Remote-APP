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
  console.log('pair code:', pairData.code);
  
  const reqRes = await fetch('http://localhost:8787/api/pair/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairData.code, device_name: 'test-browser' })
  });
  const reqData = await reqRes.json();
  const token = reqData.access_token;
  console.log('got token:', !!token);

  // Set token in localStorage and reload
  await page.evaluate((t) => {
    localStorage.setItem('codex_remote_token', t);
    localStorage.setItem('codex_remote_server', 'http://localhost:8787');
  }, token);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Check what's on screen now
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('body text:', bodyText);

  // Try to find threads
  const threadsRes = await fetch('http://localhost:8787/api/threads', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const threadsData = await threadsRes.json();
  console.log('threads:', JSON.stringify(threadsData).slice(0, 800));

  // Look for thread items in sidebar
  const items = await page.$$eval('[class*="thread"], [class*="conv"], [class*="session"]', els =>
    els.map(el => ({ text: el.textContent?.slice(0, 60), class: el.className }))
  );
  console.log('thread items found:', items.length);
  if (items.length) console.log('first items:', JSON.stringify(items.slice(0, 5)));

  await page.screenshot({ path: 'inspect-paired.png' });
  console.log('screenshot taken');

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
