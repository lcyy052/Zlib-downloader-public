// Optional live connectivity check. Does not log in or download books.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('https://zh.z-library.sk/s/Pride%20and%20Prejudice', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('z-bookcard, .book-item, .resItemBox').first().waitFor({ timeout: 20000 }).catch(() => {});
  console.log(JSON.stringify(await page.evaluate(() => ({ title: document.title, url: location.href, summary: document.body.innerText.slice(0, 2500), cards: [...document.querySelectorAll('z-bookcard, .book-item, .resItemBox')].slice(0, 1).map(el => el.outerHTML.slice(0, 9000)) })), null, 2));
} finally { await browser.close(); }
