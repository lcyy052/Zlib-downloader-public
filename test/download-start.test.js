import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForDownloadStart } from '../src/download-start.js';
import { LibraryProvider } from '../src/provider.js';

test('waiting behind a long transfer does not start the next download timeout', async () => {
  const provider = new LibraryProvider({ getSettings: () => ({}), dataDir: '.', demo: false });
  const page = new EventEmitter();
  let release;
  const blocker = provider.runBrowserTransfer(() => new Promise(resolve => { release = resolve; }));
  let clicked = false;
  const next = provider.runBrowserTransfer(() => waitForDownloadStart({
    page, signal: new AbortController().signal, timeoutMs: 30,
    trigger: () => { clicked = true; page.emit('download', { filename: 'book.pdf' }); },
  }));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(clicked, false);
  assert.equal(page.listenerCount('download'), 0);
  release();
  await blocker;
  assert.equal((await next).download.filename, 'book.pdf');
  assert.equal(page.listenerCount('download'), 0);
});

test('cancelling a queued download returns promptly and never clicks later', async () => {
  const provider = new LibraryProvider({ getSettings: () => ({}), dataDir: '.', demo: false });
  let release, clicked = false;
  const blocker = provider.runBrowserTransfer(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const queued = provider.runBrowserTransfer(() => { clicked = true; }, controller.signal);
  const assertion = assert.rejects(queued, /已取消/);
  controller.abort();
  await assertion;
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await blocker;
  await provider.runBrowserTransfer(async () => {});
  assert.equal(clicked, false);
});

test('download-start timeout and abort remove listeners', async () => {
  const page = new EventEmitter();
  await assert.rejects(waitForDownloadStart({ page, trigger: () => {}, signal: new AbortController().signal, timeoutMs: 15 }), { code: 'DOWNLOAD_START_TIMEOUT' });
  assert.equal(page.listenerCount('download'), 0);
  const controller = new AbortController();
  const pending = waitForDownloadStart({ page, trigger: () => controller.abort(), signal: controller.signal });
  await assert.rejects(pending, /已取消/);
  assert.equal(page.listenerCount('download'), 0);
});

function popup(opener) {
  return Object.assign(new EventEmitter(), { opener: async () => opener });
}

test('captures an immediate download from a newly opened child page', async () => {
  const page = new EventEmitter(), context = new EventEmitter();
  const child = popup(page), unrelated = popup(null);
  const expected = { filename: 'child.pdf' };
  const result = await waitForDownloadStart({
    page, context, signal: new AbortController().signal, timeoutMs: 100,
    trigger() {
      context.emit('page', unrelated);
      unrelated.emit('download', { filename: 'wrong.pdf' });
      context.emit('page', child);
      page.emit('popup', child);
      child.emit('download', expected);
    },
  });
  assert.equal(result.download, expected);
  for (const target of [page, child, unrelated]) assert.equal(target.listenerCount('download'), 0);
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(page.listenerCount('popup'), 0);
});

test('concurrent tasks receive only their own popup downloads, including nested popups', async () => {
  const context = new EventEmitter();
  const first = new EventEmitter(), second = new EventEmitter();
  const firstChild = popup(first), secondChild = popup(second), nested = popup(firstChild);
  const a = waitForDownloadStart({ page: first, context, signal: new AbortController().signal, timeoutMs: 100, trigger() {} });
  const b = waitForDownloadStart({ page: second, context, signal: new AbortController().signal, timeoutMs: 100, trigger() {} });
  for (const child of [firstChild, secondChild, nested]) context.emit('page', child);
  nested.emit('download', { filename: 'first.pdf' });
  secondChild.emit('download', { filename: 'second.pdf' });
  assert.equal((await a).download.filename, 'first.pdf');
  assert.equal((await b).download.filename, 'second.pdf');
  assert.equal(context.listenerCount('page'), 0);
});

test('popup listeners are removed on abort and late events cannot enter the next task', async () => {
  const context = new EventEmitter(), page = new EventEmitter(), child = popup(page);
  const controller = new AbortController();
  const pending = waitForDownloadStart({ page, context, signal: controller.signal, trigger() { context.emit('page', child); controller.abort(); } });
  await assert.rejects(pending, /已取消/);
  assert.equal(child.listenerCount('download'), 0);
  const next = waitForDownloadStart({ page, context, signal: new AbortController().signal, timeoutMs: 15, trigger() { child.emit('download', { filename: 'late.pdf' }); } });
  await assert.rejects(next, { code: 'DOWNLOAD_START_TIMEOUT' });
  assert.equal(context.listenerCount('page'), 0);
});

test('a known download is cancelled when clicking fails after the download begins', async () => {
  const page = new EventEmitter();
  let cancelled = false;
  await assert.rejects(waitForDownloadStart({
    page, signal: new AbortController().signal,
    trigger() { page.emit('download', { async cancel() { cancelled = true; } }); throw new Error('click failed'); },
  }), /click failed/);
  assert.equal(cancelled, true);
});
