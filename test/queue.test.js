import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DownloadQueue, isRetryableDownloadError } from '../src/queue.js';
import { downloadHttpError } from '../src/download-errors.js';

async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for queue');
}
async function setup(t, download, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zlib-queue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const queue = new DownloadQueue({ file: path.join(dir, 'queue.json'), directory: dir, provider: { download }, delayMs: 0, ...options });
  await queue.init(); t.after(() => queue.close()); return queue;
}
const book = (id = 1) => ({ title: `Book ${id}`, url: `https://example.com/book/${id}/hash` });

test('initial persistence failure pauses the pump and releases active controllers', async t => {
  let downloads = 0;
  const queue = await setup(t, async () => { downloads++; return { filename: 'unused', bytes: 1 }; });
  await mkdir(queue.file);
  queue.jobs.push({ id: 'blocked-save', book: book(), sources: [], status: 'queued', attempts: 0 });
  queue.paused = false; queue.kick();
  await until(() => !queue.busy && queue.paused);
  assert.equal(downloads, 0); assert.equal(queue.controllers.size, 0); assert.equal(queue.tasks.size, 0);
  assert.equal(queue.jobs[0].status, 'failed'); assert.ok(queue.lastError);
});

test('downloads serially, skips duplicates and persists completion', async t => {
  let active = 0, peak = 0;
  const queue = await setup(t, async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); active--; return { filename: 'book.epub', bytes: 10 }; });
  const result = await queue.add([book(), book(), book(2)]);
  assert.deepEqual(result, { added: 2, skipped: 1 });
  await until(() => !queue.busy);
  assert.equal(peak, 1); assert.ok(queue.jobs.every(j => j.status === 'completed'));
  assert.equal(JSON.parse(await readFile(queue.file, 'utf8')).length, 2);
  assert.equal((await queue.add([book()])).skipped, 1);
});
test('runs up to the configured number of downloads concurrently', async t => {
  let active = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = await setup(t, async b => {
    active++; peak = Math.max(peak, active);
    await gate; active--;
    return { filename: `${b.title}.epub`, bytes: 1 };
  }, { concurrency: 3 });
  await queue.add([book(), book(2), book(3), book(4)]);
  await until(() => peak === 3);
  assert.equal(queue.snapshot().concurrency, 3);
  assert.equal(queue.jobs.filter(job => job.status === 'running').length, 3);
  release(); await until(() => !queue.busy);
  assert.equal(peak, 3); assert.ok(queue.jobs.every(job => job.status === 'completed'));
});
test('a failed book does not interrupt later downloads and can be retried separately', async t => {
  let fail = true;
  const queue = await setup(t, async () => { if (fail) { fail = false; throw new Error('额度不足'); } return { filename: 'x', bytes: 10 }; });
  await queue.add([book(), book(2)]); await until(() => !queue.busy);
  assert.equal(queue.paused, false); assert.deepEqual(queue.jobs.map(j => j.status), ['failed', 'completed']);
  await queue.action('retry', queue.jobs[0].id); await until(() => !queue.busy);
  assert.deepEqual(queue.jobs.map(j => j.status), ['completed', 'completed']);
  assert.equal(queue.jobs[0].attempts, 2);
});

test('transient download gateway failures retry automatically with a fresh attempt', async t => {
  let calls = 0;
  const queue = await setup(t, async () => {
    calls++;
    if (calls < 3) throw new Error('下载服务器返回 HTTP 504（网关超时）。请稍后重试，或选择其他版本。其他书籍会继续下载。');
    return { filename: 'recovered.epub', bytes: 42 };
  }, { retryDelays: [0, 0, 0] });
  await queue.add([book()]);
  await until(() => !queue.busy);
  assert.equal(calls, 3);
  assert.equal(queue.jobs[0].status, 'completed');
  assert.equal(queue.jobs[0].attempts, 3);
  assert.equal(queue.jobs[0].filename, 'recovered.epub');
});

test('Chrome response-code failures are classified as retryable when no HTTP status is exposed', () => {
  assert.equal(isRetryableDownloadError(new Error('Chrome 网络请求失败（net::ERR_HTTP_RESPONSE_CODE_FAILURE）')), true);
  assert.equal(isRetryableDownloadError(Object.assign(new Error('下载启动超时'), { code: 'DOWNLOAD_START_TIMEOUT' })), true);
  assert.equal(isRetryableDownloadError(new Error('下载服务器返回 HTTP 410。请重新获取链接或选择其他版本。')), true);
  assert.equal(isRetryableDownloadError(new Error('下载服务器返回 HTTP 429')), false);
  assert.equal(isRetryableDownloadError(new Error('下载服务器返回 HTTP 522（请求失败）')), true);
  assert.equal(isRetryableDownloadError(downloadHttpError(522)), true);
  assert.equal(isRetryableDownloadError(downloadHttpError(403)), false);
});

test('HTTP 522 retries with origin-specific backoff and can recover', async t => {
  let calls = 0;
  const queue = await setup(t, async () => {
    if (++calls < 3) throw downloadHttpError(522);
    return { filename: 'recovered.epub', bytes: 42 };
  }, { originRetryDelays: [0, 0, 0] });
  await queue.add([book()]); await until(() => !queue.busy);
  assert.equal(calls, 3); assert.equal(queue.jobs[0].status, 'completed');
  assert.deepEqual(queue.retryDelays, [5000, 15000, 30000]);
});

test('permanent HTTP 522 exhausts bounded retries without blocking the next book', async t => {
  let failures = 0;
  const queue = await setup(t, async b => {
    if (b.url === book().url) { failures++; throw downloadHttpError(522); }
    return { filename: 'next.epub', bytes: 42 };
  }, { originRetryDelays: [0, 0, 0] });
  await queue.add([book(), book(2)]); await until(() => !queue.busy);
  assert.equal(failures, 4);
  assert.deepEqual(queue.jobs.map(job => job.status), ['failed', 'completed']);
  assert.match(queue.jobs[0].message, /522（网站源站连接超时）/);
});

test('pause interrupts HTTP 522 backoff and resume starts a fresh attempt', async t => {
  let calls = 0;
  const queue = await setup(t, async () => {
    if (++calls === 1) throw downloadHttpError(522);
    return { filename: 'recovered.epub', bytes: 42 };
  });
  assert.deepEqual(queue.originRetryDelays, [30000, 60000, 120000]);
  await queue.add([book()]); await until(() => queue.jobs[0]?.message.includes('30 秒后自动重试'));
  await queue.action('pause'); await until(() => !queue.busy);
  assert.equal(calls, 1); assert.equal(queue.jobs[0].status, 'queued');
  await queue.action('resume'); await until(() => !queue.busy);
  assert.equal(calls, 2); assert.equal(queue.jobs[0].status, 'completed');
});

test('clear-selected removes only selected finished records', async t => {
  const queue = await setup(t, async b => ({ filename: `${b.title}.epub`, bytes: 1 }));
  await queue.add([book(), book(2), book(3)]); await until(() => !queue.busy);
  const [first, second, third] = queue.jobs;
  await queue.action('clear-selected', null, [first.id, third.id]);
  assert.deepEqual(queue.jobs.map(job => job.id), [second.id]);
  await assert.rejects(() => queue.action('clear-selected', null, []), /请选择/);
});

test('booklist batch counts include skipped completed files and live byte progress', async t => {
  let events = 0, sawProgress = false;
  const queue = await setup(t, async (b, dir, signal, update) => {
    update({ message: '传输中', receivedBytes: 25, totalBytes: 100, percent: 25 });
    await new Promise(resolve => setTimeout(resolve, 10));
    return { filename: 'book.pdf', bytes: 100 };
  });
  queue.onChange = () => { events++; if (queue.jobs.some(j => j.progress?.percent === 25)) sawProgress = true; };
  const source = { id: 'list1', title: '书单' };
  await queue.add([book()], { source }); await until(() => !queue.busy);
  const result = await queue.add([book(), book(2)], { source });
  await until(() => !queue.busy);
  assert.deepEqual(result, { added: 1, skipped: 1 });
  assert.equal(queue.snapshot().batches[0].total, 2);
  assert.equal(queue.snapshot().batches[0].completed, 2);
  assert.equal(queue.snapshot().batches[0].percent, 100);
  assert.ok(events > 3 && sawProgress);
});

test('booklist batches pause and resume independently', async t => {
  const attempts = new Map();
  const queue = await setup(t, async (b, dir, signal) => {
    const attempt = (attempts.get(b.url) || 0) + 1; attempts.set(b.url, attempt);
    if (b.title.startsWith('Paused') && attempt === 1) return new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('abort'));
      else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
    });
    return { filename: `${b.title}.epub`, bytes: 1 };
  }, { concurrency: 2 });
  const pausedBooks = [
    { ...book(11), title: 'Paused 1' },
    { ...book(12), title: 'Paused 2' },
  ];
  await queue.add(pausedBooks, { source: { id: 'paused-list', title: '暂停书单' } });
  await until(() => queue.jobs.filter(job => job.status === 'running').length === 2);
  await queue.action('batch-pause', 'paused-list');
  await until(() => !queue.busy);
  assert.equal(queue.paused, false, 'pausing one booklist must not pause the global queue');
  assert.ok(queue.jobs.every(job => job.status === 'queued'));
  assert.equal(queue.snapshot().batches[0].state, 'paused');

  await queue.add([{ ...book(13), title: 'Other list' }], { source: { id: 'other-list', title: '其他书单' } });
  await until(() => queue.jobs.some(job => job.book.title === 'Other list' && job.status === 'completed'));
  assert.ok(queue.jobs.filter(job => job.book.title.startsWith('Paused')).every(job => job.status === 'queued'));

  await queue.action('batch-resume', 'paused-list');
  await until(() => !queue.busy);
  assert.ok(queue.jobs.every(job => job.status === 'completed'));
  assert.equal(queue.snapshot().batches.find(batch => batch.id === 'paused-list').state, 'active');
});

test('booklist batches can be cancelled and selected records can be deleted', async t => {
  const queue = await setup(t, async (b, directory) => {
    const filename = `${b.title}.epub`;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, filename), 'downloaded');
    return { filename, bytes: 10 };
  });
  await queue.add([book(21)], { source: { id: 'keep-list', title: '保留书单' } });
  await queue.add([book(22)], { source: { id: 'remove-list', title: '删除书单' } });
  await until(() => !queue.busy);
  await queue.action('batch-cancel', 'keep-list');
  assert.equal(queue.snapshot().batches.find(batch => batch.id === 'keep-list').state, 'cancelled');
  await queue.action('batch-delete-selected', null, ['remove-list']);
  assert.deepEqual(queue.snapshot().batches.map(batch => batch.id), ['keep-list']);
  assert.equal(queue.jobs.length, 1);
  assert.equal(queue.jobs[0].book.title, 'Book 21');
  await access(path.join(queue.directory, '删除书单', 'Book 22.epub'));
});

test('booklists use sanitized independent folders and dedupe within each folder', async t => {
  const directories = [];
  const queue = await setup(t, async (b, directory) => { directories.push(directory); return { filename: `${b.title}.epub`, bytes: 1 }; });
  const first = { id: 'list-a', title: '财经/周刊' };
  await queue.add([book()], { source: first }); await until(() => !queue.busy);
  assert.equal(queue.jobs[0].folder, '财经_周刊');
  assert.equal(directories[0], path.join(queue.directory, '财经_周刊'));

  const repeated = await queue.add([book()], { source: { id: 'list-a-new', title: '财经/周刊' } });
  assert.deepEqual(repeated, { added: 0, skipped: 1 });
  assert.equal(queue.jobs.length, 1);

  await queue.add([book()], { source: { id: 'list-b', title: '另一个书单' } }); await until(() => !queue.busy);
  await queue.add([book()]); await until(() => !queue.busy);
  assert.equal(queue.jobs.length, 3);
  assert.deepEqual(directories.slice(1), [path.join(queue.directory, '另一个书单'), queue.directory]);
});

test('changing the configured root affects new jobs while old jobs keep their path', async t => {
  const directories = [];
  const queue = await setup(t, async (b, directory) => { directories.push(directory); return { filename: `${b.title}.epub`, bytes: 1 }; });
  const originalRoot = queue.directory;
  await queue.add([book()]); await until(() => !queue.busy);
  const originalJob = queue.jobs[0];

  const newRoot = path.join(originalRoot, 'custom-library');
  queue.setDirectory(newRoot);
  await queue.add([book(2)]); await until(() => !queue.busy);

  assert.deepEqual(directories, [originalRoot, newRoot]);
  assert.equal(originalJob.downloadRoot, originalRoot);
  assert.equal(queue.jobs[1].downloadRoot, newRoot);
  assert.equal(queue.filePath(originalJob), path.join(originalRoot, originalJob.filename));
  assert.equal(queue.filePath(queue.jobs[1]), path.join(newRoot, queue.jobs[1].filename));
});

test('re-adding a failed booklist retries its existing entry without inflating the batch total', async t => {
  let fail = true;
  const queue = await setup(t, async () => { if (fail) throw new Error('test failure'); return { filename: 'book.pdf', bytes: 1 }; });
  const options = { source: { id: 'same-list', title: 'Same list' } };
  await queue.add([book()], options); await until(() => !queue.busy);
  fail = false;
  await queue.add([book()], options); await until(() => !queue.busy);
  assert.equal(queue.jobs.length, 1); assert.equal(queue.jobs[0].attempts, 2);
  assert.equal(queue.snapshot().batches[0].total, 1); assert.equal(queue.snapshot().batches[0].completed, 1);
});
test('cancelling an active download aborts it without marking it failed', async t => {
  const queue = await setup(t, async (b, dir, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('abort'));
    else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
  }));
  await queue.add([book()]); await until(() => queue.jobs[0].status === 'running');
  await queue.action('cancel', queue.jobs[0].id); await until(() => !queue.busy);
  assert.equal(queue.jobs[0].status, 'cancelled');
});
test('cancelling one concurrent download does not abort its neighbour', async t => {
  const queue = await setup(t, async (b, dir, signal) => {
    if (b.title === 'Book 1') return new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('abort'));
      else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    return { filename: `${b.title}.epub`, bytes: 1 };
  }, { concurrency: 2 });
  await queue.add([book(), book(2)]); await until(() => queue.jobs.every(job => job.status === 'running'));
  await queue.action('cancel', queue.jobs[0].id); await until(() => !queue.busy);
  assert.deepEqual(queue.jobs.map(job => job.status), ['cancelled', 'completed']);
});
test('pause aborts active concurrent downloads and resume continues them', async t => {
  const attempts = new Map();
  const queue = await setup(t, async (b, dir, signal) => {
    const attempt = (attempts.get(b.url) || 0) + 1; attempts.set(b.url, attempt);
    if (attempt > 1 || b.title === 'Book 3') return { filename: `${b.title}.epub`, bytes: 1 };
    return new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('abort'));
      else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
    });
  }, { concurrency: 2 });
  await queue.add([book(), book(2), book(3)]);
  await until(() => queue.jobs.filter(job => job.status === 'running').length === 2);
  await queue.action('pause'); await until(() => !queue.busy);
  assert.equal(queue.paused, true);
  assert.deepEqual(queue.jobs.map(job => job.status), ['queued', 'queued', 'queued']);
  assert.ok(queue.jobs.every(job => job.message === '已暂停，等待继续' || job.message === '等待下载'));
  await queue.action('resume'); await until(() => !queue.busy);
  assert.deepEqual(queue.jobs.map(job => job.status), ['completed', 'completed', 'completed']);
});
test('restart recovers running jobs but waits for explicit resume', async t => {
  const queue = await setup(t, async () => ({ filename: 'x', bytes: 1 }));
  await writeFile(queue.file, JSON.stringify([{ id: 'test', book: book(), status: 'running', attempts: 1 }]));
  await queue.init();
  assert.equal(queue.jobs[0].status, 'queued'); assert.equal(queue.paused, true); assert.equal(queue.busy, false);
});

test('startup migrates completed legacy booklist files into their named folder', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zlib-queue-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const queueFile = path.join(dir, 'queue.json');
  const filename = 'Legacy Book.epub', variantFilename = 'Legacy Book (2).epub';
  const payload = Buffer.alloc(1024); payload.set([0x50, 0x4b, 0x03, 0x04]);
  const variantPayload = Buffer.from(payload); variantPayload[100] = 1;
  const legacyBook = { title: 'Legacy Book', format: 'EPUB', size: '1 KB', url: 'https://example.com/book/legacy/hash' };
  await writeFile(path.join(dir, filename), payload);
  await writeFile(path.join(dir, variantFilename), variantPayload);
  await writeFile(queueFile, JSON.stringify([
    { id: 'legacy', book: legacyBook, status: 'completed', filename, bytes: payload.length, sources: [{ id: 'old-list', title: '旧/书单' }] },
    { id: 'variant', book: { ...legacyBook, url: 'https://example.com/book/variant/hash' }, status: 'completed', filename: variantFilename, bytes: variantPayload.length, sources: [{ id: 'old-list', title: '旧/书单' }] },
  ]));
  const queue = new DownloadQueue({ file: queueFile, directory: dir, provider: { download: async () => {} }, delayMs: 0 });
  await queue.init(); t.after(() => queue.close());
  assert.equal(queue.jobs[0].folder, '旧_书单');
  assert.equal(queue.filePath(queue.jobs[0]), path.join(dir, '旧_书单', filename));
  assert.equal(queue.filePath(queue.jobs[1]), path.join(dir, '旧_书单', variantFilename));
  await access(path.join(dir, '旧_书单', filename));
  await access(path.join(dir, '旧_书单', variantFilename));
  await assert.rejects(access(path.join(dir, filename)));
  await assert.rejects(access(path.join(dir, variantFilename)));
  assert.equal(JSON.parse(await readFile(queueFile, 'utf8'))[0].folder, '旧_书单');
});

test('graceful shutdown preserves an interrupted download for resume', async t => {
  const queue = await setup(t, async (b, dir, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('abort'));
    else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
  }));
  await queue.add([book()]); await until(() => queue.jobs[0].status === 'running');
  await queue.close();
  assert.equal(queue.jobs[0].status, 'queued');
  assert.equal(JSON.parse(await readFile(queue.file, 'utf8'))[0].status, 'queued');
});
