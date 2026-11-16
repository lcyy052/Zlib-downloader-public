import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readmeScreenshotState } from '../scripts/readme-screenshot-data.mjs';

test('README fixtures have fixed invented records and no account, real quota or timestamp', () => {
  const state = readmeScreenshotState();
  assert.equal(state.demo, true);
  assert.deepEqual(state.queue.summary, { total: 8, queued: 2, running: 0, completed: 5, failed: 1, cancelled: 0, finished: 6, percent: 75 });
  assert.equal(state.browserSession.open, false);
  assert.equal(state.queue.batches.length, 2);
  assert.equal(state.websiteBooklist.books.length, 4);
  assert.equal(state.queue.quotaRecovery.nextCheckAt, null);
  assert.equal(state.queue.autoPause.quota, undefined);
  assert.equal(state.queue.autoPause.detectedAt, undefined);
  assert.match(state.queue.autoPause.message, /演示状态/);
  assert.match(state.queue.quotaRecovery.message, /演示状态/);
  for (const job of state.queue.jobs) {
    assert.match(job.book.title, /^示例书籍 [A-H]$/);
    assert.equal(job.book.author, '演示作者');
    assert.equal(new URL(job.book.url).hostname, 'demo.example');
    assert.equal(new URL(job.sources[0].url).hostname, 'demo.example');
    assert.match(job.sources[0].title, /^示例书单/);
  }
  state.queue.jobs[0].book.title = 'Changed';
  assert.equal(readmeScreenshotState().queue.jobs[0].book.title, '示例书籍 A');
});

test('README capture does not read production state or overwrite the selected search image', async () => {
  const source = await readFile(new URL('../scripts/capture-readme-screenshots.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|SCREENSHOT_ORIGIN|\.data[\\/]|test-results|copyFile/);
  assert.match(source, /const snapshot = readmeScreenshotState\(\)/);
  assert.match(source, /assert\.equal\(externalRequests, 0\)/);
});
