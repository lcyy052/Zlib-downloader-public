import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryProvider } from '../src/provider.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provider = new LibraryProvider({ getSettings: () => ({ site: 'https://zh.z-library.sk', browser: 'chrome' }), dataDir: path.join(root, '.data/live'), demo: false });
try {
  const context = await provider.browser(true);
  const page = await context.newPage();
  await page.goto('https://zh.z-library.sk/s/Pride%20and%20Prejudice', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await provider.checkPage(page);
  await page.locator('z-bookcard, .book-item, .resItemBox').first().waitFor({ timeout: 15000 });
  console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('z-bookcard')].slice(0, 2).map(el => ({ href: el.getAttribute('href'), title: el.querySelector('[slot="title"]')?.textContent, images: [...el.querySelectorAll('img')].map(img => ({ src: img.getAttribute('src'), lazy: img.getAttribute('data-src') })) }))), null, 2));
} finally { await provider.close(); }
