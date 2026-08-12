import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Users/kaipol/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
  headless: false
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

// Auth
const auth = JSON.stringify({device_id:'inspect2',refresh_token:'x',access_token:'x',expires_in:99999});
await page.evaluate(a => localStorage.setItem('auth', a), auth);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// Close settings if open
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// Take screenshot of current state
await page.screenshot({ path: 'inspect-state-1.png', fullPage: false });

// Check what's on the page
const pageInfo = await page.evaluate(() => {
  return {
    url: window.location.href,
    title: document.title,
    bodyText: document.body.innerText.substring(0, 500),
    sessions: document.querySelectorAll('.session-item, [class*="session"]').length,
    threads: document.querySelectorAll('[class*="thread"]').length,
    messages: document.querySelectorAll('.message-row').length,
    toolGroups: document.querySelectorAll('.tool-call-group, .tool-group-body').length,
    conversation: document.querySelector('.conversation')?.innerHTML?.substring(0, 200)
  };
});
console.log('PAGE INFO:', JSON.stringify(pageInfo, null, 2));

// Try clicking first session if any
const firstSession = await page.$('.session-item, [class*="session-item"]');
if (firstSession) {
  console.log('Clicking first session...');
  await firstSession.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'inspect-state-2.png', fullPage: false });
  
  const afterClick = await page.evaluate(() => {
    return {
      messages: document.querySelectorAll('.message-row').length,
      toolGroups: document.querySelectorAll('.tool-call-group').length,
      toolBodies: document.querySelectorAll('.tool-group-body').length,
      eventBodies: document.querySelectorAll('.event-body').length,
      conversationText: document.querySelector('.conversation')?.innerText?.substring(0, 300)
    };
  });
  console.log('AFTER CLICK:', JSON.stringify(afterClick, null, 2));
} else {
  console.log('No sessions found. Looking for thread items...');
  const threadItems = await page.$$('[class*="thread"], [class*="session"], [class*="item"]');
  console.log('Found items:', threadItems.length);
  for (const item of threadItems.slice(0, 5)) {
    const text = await item.innerText().catch(() => '');
    const cls = await item.getAttribute('class').catch(() => '');
    console.log(`  - class="${cls}" text="${text.substring(0, 80)}"`);
  }
}

// Keep browser open for a moment to see what's happening
await page.waitForTimeout(2000);
await page.screenshot({ path: 'inspect-state-3.png', fullPage: false });
await browser.close();
