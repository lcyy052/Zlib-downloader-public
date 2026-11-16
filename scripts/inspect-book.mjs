import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { LibraryProvider } from '../src/provider.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.data/live');
const settings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8').catch(() => '{"site":"https://zh.z-library.sk","browser":"chrome"}'));
const jobs = JSON.parse(await readFile(path.join(dataDir, 'queue.json'), 'utf8'));
const book = jobs.find(j => j.status === 'failed')?.book;
if (!book) throw new Error('没有可供诊断的失败下载任务');
const provider = new LibraryProvider({ getSettings: () => settings, dataDir, demo: false });
try {
  const context = await provider.browser(true);
  const page = await context.newPage();
  await page.goto(book.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await provider.checkPage(page);
  await page.locator('a.addDownloadedBook, a[href*="/dl/"], .book-details, h1').first().waitFor({ timeout: 15000 }).catch(() => {});
  console.log(JSON.stringify(await page.evaluate(() => ({
    title: document.title,
    controls: [...document.querySelectorAll('a,button,[role="button"]')].filter(el => /download|\/dl\/|reader|read.online|阅读|下载/i.test([el.className, el.textContent, el.getAttribute('href'), el.getAttribute('onclick')].join(' '))).map(el => ({
      tag: el.tagName, text: el.textContent.trim().slice(0, 220), class: el.className,
      href: (() => { const raw = el.getAttribute('href'); if (!raw) return raw; const url = new URL(raw, location.href); return url.origin + url.pathname; })(), target: el.getAttribute('target'),
      data: Object.fromEntries([...el.attributes].filter(a => ['data-book_id', 'data-isbn'].includes(a.name)).map(a => [a.name, a.value]))
    })).slice(0, 35)
  })), null, 2));
} finally { await provider.close(); }
