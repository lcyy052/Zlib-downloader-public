import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { summarizeJobs, summarizeBatches } from '../src/booklist.js';

// All API requests are intercepted. This server serves only local UI assets:
// no production port, queue files, website account or downloaded files are used.
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = createServer(async (req, res) => {
  const asset = assets[new URL(req.url, 'http://localhost').pathname];
  if (!asset) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }); res.end(await readFile(new URL('../public/' + asset[0], import.meta.url))); }
  catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const book = id => ({ id, title: id === 'a1' ? '书单中的第一本书' : '设计与阅读 ' + id, author: '示例作者', year: '2025', format: 'EPUB', size: '2 MB', url: 'https://example.test/book/' + id });
  const jobs = [
    { id: 'a1', book: book('a1'), status: 'queued', message: '书单已暂停', sources: [{ id: 'a', title: 'How-To · Home', state: 'active' }] },
    { id: 'a2', book: book('a2'), status: 'queued', message: '等待下载', sources: [{ id: 'a', title: 'How-To · Home', state: 'active' }] },
    { id: 'b1', book: book('b1'), status: 'queued', message: '书单已暂停', sources: [{ id: 'b', title: 'Graphic Design · AI Art', state: 'paused' }] },
    { id: 'single', book: book('single'), status: 'queued', message: '等待下载', sources: [] },
  ];
  const fixture = {
    demo: true, directory: 'D:\\示例书库',
    settings: { site: 'https://example.test/', browser: 'chrome', browserMode: 'background', downloadDirectory: 'D:\\示例书库', downloadConcurrency: 3 },
    browserSession: { open: true, browser: 'Chrome', message: '示例会话：已登录验证' },
    matching: null,
    websiteBooklist: { id: 'a', title: 'How-To · Home', url: 'https://example.test/booklist/1/test/list.html', books: jobs.slice(0, 2).map(job => job.book), running: false, complete: true, pages: 1 },
    queue: { paused: true, concurrency: 3, jobs, error: null, busy: false },
  };
  const update = () => {
    fixture.queue.summary = summarizeJobs(jobs);
    fixture.queue.batches = summarizeBatches(jobs);
    fixture.queue.busy = jobs.some(job => job.status === 'running');
  };
  const startEligible = () => {
    if (fixture.queue.paused) return;
    const next = jobs.find(job => job.status === 'queued' && (!job.sources.length || job.sources.some(source => source.state === 'active')));
    if (next) { next.status = 'running'; next.message = '正在传输文件…'; }
  };
  update();
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/state') return route.fulfill({ json: fixture });
    if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (pathname === '/api/queue/action') {
      const { action, id } = route.request().postDataJSON();
      if (action === 'pause') {
        fixture.queue.paused = true;
        if (fixture.queue.autoPause) fixture.queue.autoPause.manual = true;
        jobs.filter(job => job.status === 'running').forEach(job => job.status = 'queued');
      } else if (action === 'resume') {
        fixture.queue.paused = false; fixture.queue.autoPause = null; fixture.queue.error = null; startEligible();
      } else if (action === 'batch-pause' || action === 'batch-resume') {
        for (const job of jobs) for (const source of job.sources) if (source.id === id) {
          source.state = action === 'batch-pause' ? 'paused' : 'active';
          if (action === 'batch-pause' && job.status === 'running') job.status = 'queued';
        }
        if (action === 'batch-resume') startEligible();
      } else throw new Error('Unexpected fixture action: ' + action);
      update(); return route.fulfill({ json: { ok: true } });
    }
    if (pathname === '/api/quota-recovery') {
      const input = route.request().postDataJSON();
      Object.assign(fixture.settings, input);
      fixture.queue.quotaRecovery = { enabled: input.quotaAutoResume, intervalMinutes: input.quotaCheckMinutes, message: '等待定时检查', nextCheckAt: '2026-10-15T04:00:00.000Z' };
      return route.fulfill({ json: { settings: fixture.settings } });
    }
    if (pathname === '/api/quota/check') return route.fulfill({ json: { available: false, quota: { used: 999, limit: 999 }, message: '每日下载额度仍已用完，继续等待' } });
    if (pathname === '/api/quota-recovery/wait') {
      fixture.settings.quotaAutoResume = true;
      fixture.queue.autoPause = { kind: 'quota', message: '每日下载额度已满', quota: { used: 999, limit: 999 } };
      fixture.queue.error = fixture.queue.autoPause.message;
      return route.fulfill({ json: { settings: fixture.settings, queue: fixture.queue } });
    }
    throw new Error('Unexpected API call: ' + pathname);
  });
  const list = id => page.locator('[data-batch-details="' + id + '"]');
  const action = (id, name) => page.locator('[data-batch-id="' + id + '"][data-batch-action="' + name + '"]');
  const waitTitle = title => page.waitForFunction(title => document.querySelector('#queue-control-title').textContent === title, title);
  const waitBatch = (id, state) => page.waitForFunction(({ id, state }) => {
    const el = document.querySelector('[data-batch-details="' + id + '"] .status-pill');
    return el?.textContent === state;
  }, { id, state });

  await page.goto(origin);
  await page.locator('.nav[data-view="queue"]').click();
  await waitTitle('总队列已暂停');
  assert.equal(await page.locator('#resume-queue').isEnabled(), true);
  assert.equal(await page.locator('#pause-queue').isVisible(), false);
  assert.match(await page.locator('#queue-control-description').innerText(), /登录验证不会自动开始/);
  assert.equal(await list('a').locator('summary .status-pill').innerText(), '随总队列暂停');
  assert.equal(await list('b').locator('summary .status-pill').innerText(), '本书单已暂停');
  assert.equal(await action('b', 'batch-resume').innerText(), '解除本书单暂停');
  const panel = await page.locator('#queue-control-panel').boundingBox();
  const stats = await page.locator('#queue-stats').boundingBox();
  assert.ok(panel.y + panel.height <= stats.y, 'Master control must precede the statistics and booklist records');
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await page.screenshot({ path: 'test-results/queue-controls-desktop.png', fullPage: false });
  // Booklist import page links directly to the master control.
  await page.locator('.nav[data-view="booklist"]').click();
  assert.equal(await page.locator('#website-download-gate').isVisible(), true);
  assert.match(await page.locator('.website-book-row').first().innerText(), /总队列已暂停/);
  await page.locator('#pause-website-downloads').click();
  await page.waitForFunction(() => !document.querySelector('#resume-website-downloads').hidden);
  assert.equal(await page.locator('#resume-website-downloads').innerText(), '解除本书单暂停');
  await page.locator('#resume-website-downloads').click();
  await page.waitForFunction(() => document.querySelector('#resume-website-downloads').hidden);
  assert.equal(fixture.queue.paused, true, 'Import-page local resume must also preserve global pause');
  assert.match(await page.locator('#toast').innerText(), /总队列仍暂停/);
  await page.locator('#go-download-controls').click();
  assert.equal(await page.locator('#view-queue').isVisible(), true);
  assert.ok((await page.locator('#queue-control-panel').boundingBox()).y < 150);

  // Local resume never secretly opens the global queue.
  await action('b', 'batch-resume').click();
  await waitBatch('b', '随总队列暂停');
  assert.equal(fixture.queue.paused, true);
  assert.equal(jobs[2].sources[0].state, 'active');
  assert.match(await page.locator('#toast').innerText(), /总队列仍暂停/);
  await action('b', 'batch-pause').click();
  await waitBatch('b', '本书单已暂停');
  // Global resume must preserve the other booklist's individual pause.
  await page.locator('#resume-queue').click();
  await page.waitForFunction(() => document.querySelector('#queue-control-title').textContent.startsWith('正在下载'));
  assert.equal(fixture.queue.paused, false);
  assert.equal(jobs[2].sources[0].state, 'paused');
  assert.equal(await action('b', 'batch-resume').innerText(), '继续本书单');
  assert.equal(await page.locator('#pause-queue').isVisible(), true);
  await page.locator('.nav[data-view="booklist"]').click();
  assert.equal(await page.locator('#website-download-gate').isVisible(), false);
  await page.locator('.nav[data-view="queue"]').click();

  // Explicit explanation when every remaining booklist is individually paused.
  await page.locator('#pause-queue').click();
  await waitTitle('总队列已暂停');
  await action('a', 'batch-pause').click();
  await waitBatch('a', '本书单已暂停');
  jobs[3].status = 'completed'; update(); // No standalone pending job in this state.
  await page.locator('#resume-queue').click();
  await waitTitle('待下载书单均已暂停');
  await action('a', 'batch-resume').click();
  await page.waitForFunction(() => document.querySelector('#queue-control-title').textContent.startsWith('正在下载'));
  assert.equal(jobs[0].sources[0].state, 'active');
  assert.equal(jobs[2].sources[0].state, 'paused');

  await page.locator('#pause-queue').click();
  await waitTitle('总队列已暂停');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#queue-control-panel').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout must not overflow');
  const mobileButton = await page.locator('#resume-queue').boundingBox();
  assert.ok(mobileButton.width > 200 && mobileButton.x >= 0 && mobileButton.x + mobileButton.width <= 390);
  await page.locator('#toast').evaluate(el => el.hidden = true);
  await page.screenshot({ path: 'test-results/queue-controls-mobile.png', fullPage: false });
  await page.locator('.nav[data-view="booklist"]').click();
  await page.locator('#website-download-gate').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/queue-controls-booklist-mobile.png' });
  await page.setViewportSize({ width: 1360, height: 1000 });
  fixture.queue.autoPause = { kind: 'quota', message: '网站明确提示下载额度已用完，已自动暂停新的下载。额度恢复后请手动继续。' };
  fixture.queue.error = fixture.queue.autoPause.message;
  fixture.queue.paused = true;
  jobs[1].status = 'running'; jobs[1].progress = { receivedBytes: 5, totalBytes: 42, percent: 12 };
  update(); await page.reload();
  await page.locator('.nav[data-view="queue"]').click();
  await waitTitle('下载额度已满，已自动暂停');
  assert.equal(await page.locator('#pause-queue').innerText(), '暂停剩余传输');
  assert.equal(await page.locator('#pause-queue').isEnabled(), true);
  assert.match(await page.locator('#queue-control-description').innerText(), /继续保存/);
  await page.screenshot({ path: 'test-results/queue-controls-quota.png' });
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#resume-queue').click();
  assert.equal(fixture.queue.paused, true, 'Dismissed quota confirmation must not resume');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#resume-queue').click();
  await page.waitForFunction(() => document.querySelector('#queue-control-title').textContent.startsWith('正在下载'));
  assert.equal(fixture.queue.autoPause, null);
  fixture.queue.autoPause = { kind: 'quota', message: '每日下载额度已满' };
  fixture.queue.paused = true;
  jobs.forEach(job => { job.status = 'queued'; job.progress = null; });
  update(); await page.reload();
  await page.locator('.nav[data-view="settings"]').click();
  await page.locator('#quota-auto-resume').selectOption('on');
  await page.locator('#quota-check-minutes').fill('15');
  await page.locator('#quota-recovery-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#quota-recovery-status').textContent.includes('下次检查'));
  assert.equal(fixture.settings.quotaAutoResume, true); assert.equal(fixture.settings.quotaCheckMinutes, 15);
  await page.locator('#quota-check-now').click();
  await page.waitForFunction(() => document.querySelector('#quota-check-result').textContent.includes('每日限额 999'));
  assert.equal(fixture.queue.paused, true, 'Read-only quota check never resumes');
  await page.screenshot({ path: 'test-results/quota-recovery-settings.png', fullPage: true });
  await page.locator('.nav[data-view="queue"]').click();
  assert.match(await page.locator('#queue-control-description').innerText(), /下次检查/);
  assert.equal(await page.locator('#pause-queue').isVisible(), true);
  assert.equal(await page.locator('#pause-queue').innerText(), '保持暂停（不自动恢复）');
  await page.screenshot({ path: 'test-results/quota-recovery-queue.png' });
  await page.locator('#pause-queue').click();
  await waitTitle('已手动保持暂停');
  assert.match(await page.locator('#queue-control-description').innerText(), /不会自动恢复/);
  const beforeWait = JSON.stringify(jobs);
  await page.locator('.nav[data-view="settings"]').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#quota-wait-current').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('当前队列已等待额度恢复'));
  await page.locator('.nav[data-view="queue"]').click();
  await waitTitle('下载额度已满，已自动暂停');
  assert.equal(JSON.stringify(jobs), beforeWait, 'Arming quota wait must not attempt or change any book');
  assert.equal(fixture.queue.paused, true); assert.equal(fixture.queue.autoPause.manual, undefined);
  fixture.queue.autoPause = null;
  fixture.queue.error = null;
  jobs.forEach(job => job.status = 'completed'); update();
  fixture.queue.paused = true;
  await page.reload();
  await page.locator('.nav[data-view="queue"]').click();
  await waitTitle('总队列已暂停');
  assert.equal(await page.locator('#resume-queue').isEnabled(), false);
  assert.match(await page.locator('#queue-control-description').innerText(), /暂无待下载/);
  assert.deepEqual(errors, []);
  console.log('PASS: queue controls, quota recovery settings and next-check display, manual hold, desktop/mobile layout, no script errors. Isolated fixtures only; no production mutations or downloads.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
