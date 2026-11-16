import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { demoBooks } from '../src/demo.js';
import { summarizeJobs, summarizeBatches } from '../src/booklist.js';

// Isolated fake session only. Never connect to the running application or website.
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = createServer(async (req, res) => {
  const asset = assets[new URL(req.url, 'http://localhost').pathname];
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
  res.end(await readFile(new URL('../public/' + asset[0], import.meta.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const books = demoBooks('https://demo.example');
  const source = { id: 'demo-list', title: '示例书单 · 文学阅读', state: 'active' };
  const jobs = books.slice(0, 3).map((book, i) => ({
    id: 'demo-job-' + i, book, sources: [source],
    status: ['completed', 'failed', 'queued'][i],
    message: ['演示占位文件已保存', '模拟网络错误：示例状态，不会请求真实网站', '等待下载'][i],
    filename: i === 0 ? 'Pride and Prejudice.demo.txt' : undefined,
  }));
  const fixture = {
    demo: true, directory: 'downloads/demo（示例目录）',
    settings: { site: 'https://demo.example', browser: 'chrome', browserMode: 'background', downloadDirectory: 'downloads/demo（示例目录）', downloadConcurrency: 2 },
    browserSession: { open: false, browser: 'Chrome', message: '演示会话，无真实登录信息。' },
    matching: null,
    websiteBooklist: { ...source, url: 'https://demo.example/booklist/1/demo/list.html', books: books.slice(0, 3), running: false, complete: true, pages: 1 },
    queue: { paused: true, concurrency: 2, busy: false, error: null, jobs, summary: summarizeJobs(jobs), batches: summarizeBatches(jobs) },
  };
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/state') return route.fulfill({ json: fixture });
    if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': demo\n\n' });
    if (pathname === '/api/search') return route.fulfill({ json: { books, page: 1, hasNext: false } });
    throw new Error('Unexpected screenshot API request: ' + pathname);
  });
  await page.route('https://demo.example/**', route => route.abort());
  await page.goto('http://127.0.0.1:' + server.address().port);
  assert.equal(await page.locator('#connection-error').isVisible(), false);
  await page.locator('#query').fill('示例书籍');
  await page.locator('#search-submit').click();
  await page.waitForSelector('.book-card');
  const directory = new URL('../docs/images/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('app-search.png', directory)), fullPage: false });
  for (const [view, filename] of [['queue', 'app-download-manager.png'], ['booklist', 'app-booklist-progress.png'], ['settings', 'app-settings.png']]) {
    await page.locator('.nav[data-view="' + view + '"]').click();
    await page.evaluate(() => scrollTo(0, 0));
    // fileURLToPath handles spaces, Unicode and Windows drive syntax correctly.
    await page.screenshot({ path: fileURLToPath(new URL(filename, directory)), fullPage: false });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: four fresh public screenshots from isolated demo fixtures; no real service, accounts, files or website accessed.');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
