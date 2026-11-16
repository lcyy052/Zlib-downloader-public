import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:3210';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = await (await fetch(`${origin}/api/state`)).json();
const books = [1, 2, 3].map(id => ({ id: `/book/${id}/fixture`, url: `https://zh.z-library.sk/book/${id}/fixture`, title: `测试书籍 ${id}`, author: '测试作者', format: 'PDF', size: '1 MB' }));
const source = { id: 'test-list', title: '批量下载测试书单', url: 'https://zh.z-library.sk/booklist/123/test/list.html' };
const list = { ...source, books, pages: 2, complete: true, running: false };
let current = { ...base, websiteBooklist: null, queue: { jobs: [], batches: [], paused: true, summary: { total: 0 } } }, submitted;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/state', route => route.fulfill({ json: current }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/booklist/import', route => { current.websiteBooklist = list; return route.fulfill({ json: list }); });
  await page.route('**/api/booklist/download', route => {
    submitted = route.request().postDataJSON();
    current.queue = { paused: false, busy: true, error: '', jobs: books.map((book, i) => ({ id: `job${i}`, book, sources: [source], status: ['completed', 'failed', 'running'][i], message: ['已保存', '测试：此书不可下载', '正在传输文件…'][i], progress: i === 2 ? { receivedBytes: 512000, totalBytes: 1024000, percent: 50 } : null })), summary: { total: 3, finished: 2, percent: 67, completed: 1, failed: 1, running: 1, queued: 0, cancelled: 0 } };
    current.queue.batches = [{ ...source, ...current.queue.summary }];
    return route.fulfill({ json: { added: 3, skipped: 0 } });
  });
  await page.goto(origin);
  await page.locator('.nav[data-view="booklist"]').click();
  await page.locator('#website-booklist-url').fill(source.url);
  await page.locator('#import-website-booklist').click();
  await page.waitForSelector('.website-book-row');
  assert.equal(await page.locator('.website-book-row').count(), 3);
  assert.equal(await page.locator('#website-booklist-select-all').isChecked(), true);
  await page.locator('#download-website-all').click();
  await page.waitForFunction(() => document.querySelector('#website-booklist-progress').textContent.includes('失败 1'));
  assert.equal(submitted.ids.length, 3); assert.equal(submitted.booklistId, source.id);
  assert.equal(await page.locator('.website-book-row .status-failed').count(), 1);
  assert.equal(await page.locator('.website-book-row .status-running').count(), 1);
  assert.equal(await page.locator('.file-progress progress').first().getAttribute('value'), '50');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/website-booklist-progress.png', fullPage: true });
  current.queue.jobs[2].status = 'completed'; current.queue.jobs[2].message = '已保存';
  Object.assign(current.queue.summary, { finished: 3, percent: 100, completed: 2, running: 0 });
  current.queue.batches = [{ ...source, ...current.queue.summary }];
  await page.waitForFunction(() => document.querySelector('#website-booklist-progress').textContent.includes('100%'), { }, { timeout: 10000 });
  assert.equal(await page.locator('.website-book-row .status-completed').count(), 2);
  await page.locator('.nav[data-view="queue"]').click();
  assert.match(await page.locator('#queue-progress').innerText(), /成功 2.*失败 1/);
  assert.equal(await page.locator('#pause-queue').isEnabled(), true);
  assert.deepEqual(errors, []);
  const live = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  await live.goto(origin); await live.locator('.nav[data-view="booklist"]').click();
  const savedList = base.websiteBooklist;
  if (savedList?.books?.length) {
    await live.waitForSelector('.website-book-row');
    assert.equal(await live.locator('#website-booklist-title').innerText(), savedList.title);
    assert.ok((await live.locator('#website-booklist-meta').innerText()).includes(String(savedList.books.length)));
    assert.equal(await live.locator('.website-book-row').count(), Math.min(50, savedList.books.length));
    if (savedList.books.length > 50) {
      await live.locator('#website-booklist-next').click();
      assert.equal(await live.locator('.website-book-row .row-number').first().innerText(), '51');
    }
  }
  await live.screenshot({ path: 'test-results/website-booklist-live.png' });
  await live.setViewportSize({ width: 390, height: 844 });
  assert.ok(await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log(`PASS: website link import, all/selected controls, failure + ongoing download shown together, byte percentage, automatic refresh to completion, restored saved list (${savedList?.books?.length || 0} books), mobile width. No website books downloaded.`);
} finally { await browser.close(); }
