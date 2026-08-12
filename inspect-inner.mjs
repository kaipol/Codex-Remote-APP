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
  body: JSON.stringify({ code: pairData.code, device_name: 'inspect-inner' })
});
const reqData = await reqRes.json();
await page.evaluate((auth) => { localStorage.setItem('auth', JSON.stringify({
  device_id: auth.device_id, refresh_token: auth.refresh_token, access_token: auth.access_token, expires_in: auth.expires_in
})); }, reqData);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// Check collapsed tool-group-inner height
const info = await page.evaluate(() => {
  const bodies = document.querySelectorAll('.tool-group-body');
  const first3 = [];
  for (let i = 0; i < Math.min(3, bodies.length); i++) {
    const b = bodies[i];
    if (b.classList.contains('tool-group-body-visible')) continue;
    const inner = b.querySelector('.tool-group-inner');
    const bodyCS = getComputedStyle(b);
    const innerCS = inner ? getComputedStyle(inner) : null;
    const bodyRect = b.getBoundingClientRect();
    const innerRect = inner ? inner.getBoundingClientRect() : null;
    
    // Check the event-card inside
    const card = inner?.querySelector('.event-card');
    const cardCS = card ? getComputedStyle(card) : null;
    const cardRect = card ? card.getBoundingClientRect() : null;
    
    // Check event-body inside the card
    const eventBody = card?.querySelector('.event-body');
    const eventBodyCS = eventBody ? getComputedStyle(eventBody) : null;
    const eventBodyRect = eventBody ? eventBody.getBoundingClientRect() : null;
    
    first3.push({
      bodyRect: { h: bodyRect.height, w: bodyRect.width },
      bodyCS: { gridRows: bodyCS.gridTemplateRows, overflow: bodyCS.overflow, display: bodyCS.display },
      innerRect: innerRect ? { h: innerRect.height, w: innerRect.width } : null,
      innerCS: innerCS ? { overflow: innerCS.overflow, minHeight: innerCS.minHeight, padding: innerCS.padding, borderLeft: innerCS.borderLeft } : null,
      cardRect: cardRect ? { h: cardRect.height, w: cardRect.width } : null,
      cardCS: cardCS ? { overflow: cardCS.overflow, margin: cardCS.margin, bg: cardCS.background } : null,
      eventBodyRect: eventBodyRect ? { h: eventBodyRect.height, w: eventBodyRect.width } : null,
      eventBodyCS: eventBodyCS ? { gridRows: eventBodyCS.gridTemplateRows, overflow: eventBodyCS.overflow } : null,
    });
  }
  return first3;
});
console.log('COLLAPSED INFO:', JSON.stringify(info, null, 2));

// Now take a screenshot focusing on the first few tool groups
await page.evaluate(() => {
  const group = document.querySelector('.tool-call-group');
  if (group) group.scrollIntoView();
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'inspect-collapsed-inner.png' });

await browser.close();
