import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryProvider } from '../src/provider.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provider = new LibraryProvider({ getSettings: () => ({ site: 'https://zh.z-library.sk', browser: 'chrome' }), dataDir: path.join(root, '.data/live'), demo: false });
try {
  const context = await provider.browser(true);
  const page = await context.newPage();
  await page.goto('https://zh.z-library.sk/booklist/3803973/ddd1f7/ai8.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await provider.checkPage(page);
  await page.locator('z-bookcard, .book-item, .resItemBox').first().waitFor({ timeout: 15000 }).catch(() => {});
  console.log(JSON.stringify(await page.evaluate(() => {
    const first = document.querySelector('z-bookcard, .resItemBox, .book-item');
    const copy = first?.cloneNode(true);
    if (copy) for (const el of [copy, ...copy.querySelectorAll('*')]) for (const attr of [...el.attributes]) if (/token|signature|user|read/i.test(attr.name)) el.removeAttribute(attr.name);
    const ancestors = []; let el = first;
    while (el && ancestors.length < 7) { ancestors.push({ tag: el.tagName, id: el.id, class: el.className }); el = el.parentElement; }
    return { title: document.title, headings: [...document.querySelectorAll('h1,h2')].map(el => el.textContent.trim()).slice(0, 12), counts: { cards: document.querySelectorAll('z-bookcard').length, books: document.querySelectorAll('.book-item').length }, ancestors, first: copy?.outerHTML.slice(0, 4500), pagination: [...document.querySelectorAll('.paginator, .pagination, [class*="booklist-info"], [class*="booklistInfo"], [class*="booklist-details"]')].map(el => el.outerHTML.slice(0, 6000)), controls: [...document.querySelectorAll('a,button')].filter(el => /[?&]page=|3803973|load.?more|下一|更多|next/i.test([el.getAttribute('href'), el.className, el.textContent].join(' '))).map(el => ({ text: el.textContent.trim().slice(0, 100), href: el.getAttribute('href'), class: el.className })).slice(0, 30) };
  }), null, 2));
  console.log('BOOKLIST LAYOUT', await page.evaluate(() => {
    const main = document.querySelector('.booklist-main')?.cloneNode(true);
    main?.querySelectorAll('z-bookcard,script').forEach(el => el.remove());
    if (main) for (const el of [main, ...main.querySelectorAll('*')]) for (const attr of [...el.attributes]) if (/token|signature|user|onclick/i.test(attr.name)) el.removeAttribute(attr.name);
    return { header: document.querySelector('.booklist-header')?.innerText, layout: main?.outerHTML.slice(0, 14000), scripts: [...document.scripts].map(s => s.src).filter(s => /booklist|readlist/i.test(s)) };
  }));
  const requests = [];
  page.on('request', request => { if (['xhr', 'fetch'].includes(request.resourceType())) { const url = new URL(request.url()); requests.push({ path: url.pathname, query: [...url.searchParams].filter(([k]) => !/token|key|sign/i.test(k)), method: request.method(), data: request.postData()?.slice(0, 1500) }); } });
  await page.locator('z-bookcard').last().scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  if (await page.locator('.page-load-more').isVisible()) await page.locator('.page-load-more').click();
  await page.waitForFunction(() => document.querySelectorAll('z-bookcard').length > 20, { }, { timeout: 10000 }).catch(() => {});
  console.log('AFTER SCROLL', JSON.stringify({ cards: await page.locator('z-bookcard').count(), requests }));
} finally { await provider.close(); }
