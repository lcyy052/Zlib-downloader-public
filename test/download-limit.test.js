import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DownloadQueue } from '../src/queue.js';
import { downloadLimitFromText, downloadLimitError, readDownloadNotice } from '../src/download-limit.js';
import { downloadHttpError } from '../src/download-errors.js';

const book = id => ({ title: 'Fixture ' + id, url: 'https://fixture.example/book/' + id + '/hash', format: 'EPUB' });
const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Fixture condition timed out'); };
async function setup(t, download, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-quota-'));
  const queue = new DownloadQueue({ file: path.join(directory, 'queue.json'), directory, provider: { download }, delayMs: 0, ...options });
  await queue.init();
  t.after(async () => { await queue.close(); await rm(directory, { recursive: true, force: true }); });
  return queue;
}

test('used / daily limit counters recognize exhaustion, not an available allowance', () => {
  for (const text of ['999/999 每日限额', '1000 / 999 每日限额', '每日限额：10/10', '10/10 Daily limit']) {
    assert.equal(downloadLimitFromText(text)?.code, 'DOWNLOAD_QUOTA_EXHAUSTED');
  }
  for (const text of ['998/999 每日限额', '0/999 每日限额', '0/0 每日限额', '10/10 books', '每日限额 999', '请检查登录状态、下载额度']) assert.equal(downloadLimitFromText(text), null);
  assert.equal(downloadLimitFromText('999/999 每日限额', undefined, { allowCounter: false }), null, 'Post-click polling must not reject the last permitted file just because its counter increased');
});

test('explicit quota notices recognize Chinese and English but not generic HTTP errors or advice', () => {
  for (const text of ['您今天的下载次数已用完', '已达到今日下载次数', '剩余下载次数：0', 'You have reached your daily downloads limit', 'Daily download limit has been exceeded', 'You have reached your daily limit of 10 downloads', '<p>Downloads remaining: 0</p>']) assert.ok(downloadLimitFromText(text));
  for (const text of ['Daily download limit: 10', 'Downloads remaining: 100', 'HTTP 522', '下载启动超时：请检查额度', '<script>You have reached your daily download limit</script>OK']) assert.equal(downloadLimitFromText(text), null);
  assert.equal(downloadHttpError(429).code, 'DOWNLOAD_REQUEST_LIMITED');
  assert.equal(downloadHttpError(429).httpStatus, 429);
});

test('notice body reads are size-bounded and time-bounded', async () => {
  assert.equal((await readDownloadNotice(new Response('x'.repeat(1000)), { maxBytes: 32 })).length, 32);
  const hanging = new Response(new ReadableStream({ start() {}, cancel() {} }));
  const started = Date.now();
  assert.equal(await readDownloadNotice(hanging, { timeoutMs: 20 }), '');
  assert.ok(Date.now() - started < 1000);
});

test('quota exhaustion leaves the whole queue pending without retrying subsequent books; manual resume works', async t => {
  let full = true, calls = 0;
  const queue = await setup(t, async () => { calls++; if (full) throw downloadLimitFromText('999/999 每日限额'); return { filename: 'fixture.epub', bytes: 42 }; });
  await queue.add([book(1), book(2), book(3)]);
  await until(() => !queue.busy);
  assert.equal(calls, 1); assert.equal(queue.paused, true);
  assert.deepEqual(queue.jobs.map(job => job.status), ['queued', 'queued', 'queued']);
  assert.equal(queue.snapshot().autoPause.kind, 'quota');
  await queue.add([book(4)]);
  assert.equal(queue.paused, true); assert.equal(calls, 1, 'Adding a book must not silently reopen an account-blocked queue');
  full = false; await queue.action('resume'); await until(() => !queue.busy);
  assert.equal(calls, 5); assert.equal(queue.autoPause, null);
  assert.ok(queue.jobs.every(job => job.status === 'completed'));
  assert.ok(queue.jobs.every(job => !job.autoPause));
});

test('HTTP 429 pauses as an ambiguous request limit rather than claiming daily quota is full', async t => {
  let calls = 0;
  const queue = await setup(t, async () => { calls++; throw downloadHttpError(429); });
  await queue.add([book(1), book(2)]);
  await until(() => !queue.busy);
  assert.equal(calls, 1); assert.equal(queue.snapshot().autoPause.kind, 'request-limit');
  assert.match(queue.lastError, /可能是/); assert.ok(queue.jobs.every(job => job.status === 'queued'));
});

test('plain failures that mention checking quota never stop other books', async t => {
  const queue = await setup(t, async b => { if (b.title.endsWith('1')) throw new Error('请检查下载额度或该版本是否允许下载'); return { filename: 'fixture.epub', bytes: 42 }; });
  await queue.add([book(1), book(2)]); await until(() => !queue.busy);
  assert.deepEqual(queue.jobs.map(job => job.status), ['failed', 'completed']);
  assert.equal(queue.autoPause, null); assert.equal(queue.paused, false);
});

test('in-flight bytes finish, unopened requests abort, and no further jobs start after quota block', async t => {
  const requests = [];
  const queue = await setup(t, async (b, directory, signal, progress) => {
    if (signal.aborted) throw new Error('cancelled before request');
    requests.push(b.title);
    if (b.title.endsWith('1')) {
      progress({ receivedBytes: 5, totalBytes: 42, percent: 12, message: '正在传输文件…' });
      await until(() => queue.autoPause);
      return { filename: 'preserved.epub', bytes: 42 };
    }
    if (b.title.endsWith('2')) throw downloadLimitError();
    return new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('cancelled'));
      else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  }, { concurrency: 3 });
  await queue.add([book(1), book(2), book(3), book(4), book(5)]);
  await until(() => !queue.busy);
  assert.equal(queue.jobs[0].status, 'completed'); assert.equal(queue.jobs[0].bytes, 42);
  assert.ok(queue.jobs.slice(1).every(job => job.status === 'queued'));
  assert.ok(!requests.includes('Fixture 4') && !requests.includes('Fixture 5'));
  assert.equal(queue.paused, true); assert.equal(queue.controllers.size, 0);
});

test('auto pause metadata survives restart even if the triggering record was removed', async t => {
  let calls = 0;
  const queue = await setup(t, async () => { calls++; throw downloadLimitError(); });
  await queue.add([book(1), book(2)]); await until(() => !queue.busy);
  await queue.action('cancel', queue.jobs[0].id); await queue.action('clear');
  assert.equal(queue.jobs.length, 1); assert.ok(!queue.jobs[0].autoPause);
  const restarted = new DownloadQueue({ file: queue.file, directory: queue.directory, provider: queue.provider, delayMs: 0 });
  await restarted.init();
  assert.equal(restarted.paused, true); assert.equal(restarted.autoPause.kind, 'quota');
  assert.match(restarted.lastError, /额度已用完/);
  await restarted.add([book(3)]); assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(queue.file + '.state.json', 'utf8')).autoPause.kind, 'quota');
  await restarted.close();
});

test('quota pause preserves a confirmed native download with unavailable byte progress', async t => {
  const queue = await setup(t, async (b, directory, signal, progress) => {
    if (b.title.endsWith('1')) {
      progress({ message: '等待 Chrome 完成', transferStarted: true, receivedBytes: 0, totalBytes: 0, percent: null });
      await until(() => queue.autoPause);
      assert.equal(signal.aborted, false);
      return { filename: 'native.pdf', bytes: 42 };
    }
    throw downloadLimitError();
  }, { concurrency: 2 });
  await queue.add([book(1), book(2), book(3)]);
  await until(() => !queue.busy);
  assert.equal(queue.jobs[0].status, 'completed');
  assert.ok(queue.jobs.slice(1).every(job => job.status === 'queued'));
  assert.equal(queue.paused, true);
});

test('local resume and retry cannot override an account-wide auto pause', async t => {
  const source = { id: 'list', title: 'Fixture list' };
  const queue = await setup(t, async () => { throw downloadLimitError(); });
  await queue.add([book(1), book(2)], { source }); await until(() => !queue.busy);
  await queue.action('batch-pause', 'list'); await queue.action('batch-resume', 'list');
  assert.equal(queue.paused, true); assert.match(queue.lastError, /额度已用完/);
  await queue.action('cancel', queue.jobs[0].id); await queue.action('retry', queue.jobs[0].id);
  assert.equal(queue.paused, true); assert.equal(queue.jobs[0].status, 'queued');
  assert.ok(queue.jobs.every(job => job.sources[0].state === 'active'));
});
