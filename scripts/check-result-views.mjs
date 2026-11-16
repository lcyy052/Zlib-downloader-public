import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:3210';
const live = process.argv.includes('--live');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = []; let submitted = null;
  page.on('pageerror', error => errors.push(error.message));
  // Never create real download jobs in a display test, including --live.
  await page.route('**/api/queue/add', route => { submitted = route.request().postDataJSON().books; return route.fulfill({ json: { added: submitted.length, skipped: 0 } }); });
  if (!live) {
    await page.route('**/api/search', route => route.fulfill({ json: { books: [
      { id: '/book/1/test', url: 'https://zh.z-library.sk/book/1/test', title: '有封面的书', author: '作者甲', format: 'EPUB', year: '2020', language: '中文', size: '1 MB', cover: 'https://covers.example/good.png' },
      { id: '/book/2/test', url: 'https://zh.z-library.sk/book/2/test', title: '封面加载失败的书', author: '作者乙', format: 'PDF', cover: 'https://covers.example/missing.png' },
      { id: '/book/3/test', url: 'https://zh.z-library.sk/book/3/test', title: '没有封面的书', author: '作者丙', format: 'PDF' }
    ], page: 1, hasNext: false } }));
    await page.route('https://covers.example/good.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') }));
    await page.route('https://covers.example/missing.png', route => route.fulfill({ status: 404, body: 'not found' }));
  }
  await page.goto(origin);
  await page.locator('#query').fill(live ? 'Pride and Prejudice' : 'test');
  await page.locator('#search-submit').click();
  await page.waitForSelector('.book-card', { timeout: 60000 });
  await page.waitForSelector('.cover.has-image', { timeout: 30000 });
  assert.ok(await page.locator('.has-image .book-cover-image').first().evaluate(img => img.naturalWidth > 0));
  if (!live) {
    await page.waitForFunction(() => document.querySelectorAll('.book-card')[1].querySelector('.book-cover-image') === null);
    assert.equal(await page.locator('.book-card').nth(1).locator('.cover-book').isVisible(), true);
    assert.equal(await page.locator('.book-card').nth(2).locator('.cover-book').isVisible(), true);
  }
  await page.locator('.cover-check').first().check();
  await page.locator('[data-layout="list"]').click();
  assert.equal(await page.locator('#book-grid').evaluate(el => el.classList.contains('list-view')), true);
  assert.equal(await page.locator('.cover-check').first().isChecked(), true);
  assert.equal(await page.locator('#selected-count').innerText(), '1');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/results-${live ? 'live' : 'fixture'}-list.png` });
  await page.locator('[data-layout="cards"]').click();
  assert.equal(await page.locator('.cover-check').first().isChecked(), true);
  await page.screenshot({ path: `test-results/results-${live ? 'live' : 'fixture'}-cards.png` });
  await page.locator('[data-layout="list"]').click();
  await page.locator('#download-selected').click();
  await page.waitForFunction(() => document.querySelector('#selected-count').textContent === '0');
  assert.equal(submitted?.length, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'List must fit mobile width');
  await page.locator('.book-card').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/results-${live ? 'live' : 'fixture'}-mobile.png` });
  await page.reload();
  assert.equal(await page.locator('[data-layout="list"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  console.log(`PASS (${live ? 'real website + real covers' : 'fixtures'}): cover display, card/list switch, selection retained, batch selection payload, remembered layout, mobile width, no script errors. No books downloaded.`);
} finally { await browser.close(); }
