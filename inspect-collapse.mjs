import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

// Auth
const auth = JSON.stringify({device_id:'inspect',refresh_token:'x',access_token:'x',expires_in:99999});
await page.evaluate(a => localStorage.setItem('auth', a), auth);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// Close settings if open
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// Take screenshot
await page.screenshot({ path: 'inspect-current-state.png', fullPage: false });

// Find tool-group-body elements and check their computed styles
const info = await page.evaluate(() => {
  const bodies = document.querySelectorAll('.tool-group-body');
  const results = [];
  bodies.forEach((b, i) => {
    const cs = getComputedStyle(b);
    const rect = b.getBoundingClientRect();
    const inner = b.querySelector('.tool-group-inner');
    const innerCS = inner ? getComputedStyle(inner) : null;
    const innerRect = inner ? inner.getBoundingClientRect() : null;
    const events = b.querySelectorAll('.event-card, .event-body, .event-inner, pre, .event-result');
    const visibleChildren = [];
    events.forEach(c => {
      const r = c.getBoundingClientRect();
      if (r.height > 0 || r.width > 0) visibleChildren.push({
        cls: c.className, h: r.height, w: r.width
      });
    });
    results.push({
      idx: i,
      height: rect.height,
      width: rect.width,
      gridRows: cs.gridTemplateRows,
      overflow: cs.overflow,
      hasVisibleClass: b.classList.contains('tool-group-body-visible'),
      innerHeight: innerRect?.height,
      innerPadding: innerCS?.paddingLeft,
      innerBorder: innerCS?.borderLeft,
      visibleChildren: visibleChildren.slice(0, 5)
    });
  });

  // Also check event-body
  const eventBodies = document.querySelectorAll('.event-body');
  const eventResults = [];
  eventBodies.forEach((b, i) => {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    if (r.height > 0) {
      eventResults.push({
        idx: i,
        height: r.height,
        gridRows: cs.gridTemplateRows,
        hasVisible: b.classList.contains('event-body-visible')
      });
    }
  });

  return { toolBodies: results, eventBodiesWithHeight: eventResults };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
