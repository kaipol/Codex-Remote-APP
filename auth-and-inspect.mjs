import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
  headless: false
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// Step 1: Get pairing code
const codeRes = await fetch('http://localhost:8787/api/pair/code');
const codeData = await codeRes.json();
console.log('Pair code response:', JSON.stringify(codeData));

if (codeData.code) {
  // Step 2: Request pairing
  const pairRes = await fetch('http://localhost:8787/api/pair/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: codeData.code, device_name: 'playwright-inspect' })
  });
  const pairData = await pairRes.json();
  console.log('Pair request response:', JSON.stringify(pairData).substring(0, 300));
  
  if (pairData.device_id) {
    const auth = JSON.stringify({
      device_id: pairData.device_id,
      refresh_token: pairData.refresh_token,
      access_token: pairData.access_token,
      expires_in: pairData.expires_in || 99999
    });
    await page.evaluate(a => localStorage.setItem('auth', a), auth);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    
    await page.screenshot({ path: 'authed-state.png', fullPage: false });
    
    // Check for sessions
    const pageInfo = await page.evaluate(() => {
      const items = document.querySelectorAll('[class*="session"], [class*="thread"], .root-card, [class*="item"]');
      const sessions = [];
      items.forEach(item => {
        const text = item.innerText?.substring(0, 100) || '';
        const cls = item.className || '';
        if (text.trim()) sessions.push({ cls: cls.substring(0, 50), text: text.substring(0, 80) });
      });
      return {
        bodyText: document.body.innerText.substring(0, 800),
        itemCount: items.length,
        sessions: sessions.slice(0, 10)
      };
    });
    console.log('PAGE INFO:', JSON.stringify(pageInfo, null, 2));
  }
}

await browser.close();
