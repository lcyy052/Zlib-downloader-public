import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicJson } from '../src/utils.js';
import { loadQueueFile, loadQueueState, recoverQueuePrefix } from '../src/queue-storage.js';
import { DownloadQueue } from '../src/queue.js';
import { QuotaRecovery } from '../src/quota-recovery.js';

const job = (id, status = 'completed') => ({ id, book: { title: `Book ${id}`, url: `https://example.test/book/${id}` }, status, sources: [], attempts: 1 });
async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'queue.json') };
}
function queueFor({ directory, file }, download = async () => { throw new Error('Unexpected download'); }) {
  return new DownloadQueue({ file, directory, provider: { download }, delayMs: 0 });
}

test('durable writes preserve the prior generation, and serialization failure leaves both untouched', async t => {
  const { file, directory } = await workspace(t);
  await atomicJson(file, [job('old')], { backup: true });
  await atomicJson(file, [job('new')], { backup: true });
  assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].id, 'new');
  assert.equal(JSON.parse(await readFile(file + '.bak', 'utf8'))[0].id, 'old');
  const circular = {}; circular.self = circular;
  await assert.rejects(atomicJson(file, circular, { backup: true }));
  assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].id, 'new');
  assert.equal(JSON.parse(await readFile(file + '.bak', 'utf8'))[0].id, 'old');
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('a backup rotation error retains the committed primary and removes its temporary file', async t => {
  const { file, directory } = await workspace(t);
  await atomicJson(file, [job('old')]);
  await mkdir(file + '.bak');
  await assert.rejects(atomicJson(file, [job('new')], { backup: true }));
  assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].id, 'old');
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('ordinary and first-time queues load without recovery or archive side effects', async t => {
  const { file, directory } = await workspace(t);
  assert.deepEqual(await loadQueueFile(file), { value: [], recovery: null });
  await atomicJson(file, []);
  assert.deepEqual(await loadQueueFile(file), { value: [], recovery: null });
  await atomicJson(file, [job('a')]);
  assert.deepEqual((await loadQueueFile(file)).value, [job('a')]);
  assert.equal((await readdir(directory)).some(name => name.includes('.corrupt-')), false);
});

test('prefix recovery respects escaped strings, nested arrays and valid record boundaries', () => {
  const first = job('a'); first.book.title = 'Quoted " text \\ { ] 中文\nnext';
  first.sources = [{ id: 'list', title: '[list]', state: 'paused' }];
  const second = job('b');
  const prefix = '[\n' + JSON.stringify(first) + ',\n' + JSON.stringify(second);
  for (const tail of ['', ',{"id":"cut', ',{"id":"cut\0\0', ',invalid', ']trailing garbage']) {
    assert.deepEqual(recoverQueuePrefix(prefix + tail), [first, second]);
  }
});

test('prefix recovery never skips damage or accepts malformed, duplicate or fabricated records', () => {
  const a = JSON.stringify(job('a')), b = JSON.stringify(job('b'));
  assert.deepEqual(recoverQueuePrefix(`[${a},null,${b}]`), [job('a')]);
  assert.deepEqual(recoverQueuePrefix(`[${a},${a},${b}]`), [job('a')]);
  assert.deepEqual(recoverQueuePrefix(`[${a}, {"id": "bad", "book": {]},${b}]`), [job('a')]);
  assert.deepEqual(recoverQueuePrefix(`{"jobs":[${a}]}`), []);
  assert.deepEqual(recoverQueuePrefix('[{"id":"cut\0'), []);
});

test('a valid backup takes priority over a longer damaged primary and original bytes are archived', async t => {
  const { file } = await workspace(t);
  const corrupt = Buffer.from(`[${JSON.stringify(job('a'))},${JSON.stringify(job('b'))},\0\0`);
  await writeFile(file, corrupt);
  await atomicJson(file + '.bak', [job('backup')]);
  const loaded = await loadQueueFile(file);
  assert.deepEqual(loaded.value, [job('backup')]);
  assert.equal(loaded.recovery.source, 'backup');
  assert.deepEqual(await readFile(loaded.recovery.archives[0]), corrupt);
  // Reading/archiving must not overwrite data before the caller commits its hold.
  assert.deepEqual(await readFile(file), corrupt);
});

test('both corrupt generations are preserved and only the primary contiguous prefix is recovered', async t => {
  const { file } = await workspace(t);
  const corrupt = Buffer.from(`[${JSON.stringify(job('a'))},{"book":{"title":"cut\0\0`);
  await writeFile(file, corrupt); await writeFile(file + '.bak', 'unreadable backup');
  const loaded = await loadQueueFile(file);
  assert.deepEqual(loaded.value, [job('a')]);
  assert.equal(loaded.recovery.source, 'prefix');
  assert.equal(loaded.recovery.archives.length, 2);
  assert.deepEqual(await readFile(loaded.recovery.archives[0]), corrupt);
  assert.equal(await readFile(loaded.recovery.archives[1], 'utf8'), 'unreadable backup');
  assert.match(loaded.recovery.message, /尾部未恢复/);
});

test('unrecoverable records return an explicit empty recovery, not a silent first start', async t => {
  const { file } = await workspace(t);
  await writeFile(file, Buffer.alloc(100));
  const loaded = await loadQueueFile(file);
  assert.deepEqual(loaded.value, []); assert.equal(loaded.recovery.source, 'empty');
  assert.match(loaded.recovery.message, /没有可用/);
  assert.equal((await readFile(loaded.recovery.archives[0])).length, 100);
});

test('non-array and invalid-shape JSON use recovery instead of crashing queue consumers', async t => {
  const { file } = await workspace(t);
  for (const value of [{}, [null], [{ id: 'bad' }]]) {
    await writeFile(file, JSON.stringify(value));
    const loaded = await loadQueueFile(file);
    assert.deepEqual(loaded.value, []); assert.ok(loaded.recovery);
  }
});

test('missing primary after rotation recovers from .bak and persists the confirmation hold', async t => {
  const options = await workspace(t);
  await atomicJson(options.file + '.bak', [job('a', 'running')]);
  const queue = queueFor(options); await queue.init();
  assert.equal(queue.jobs[0].status, 'queued'); assert.equal(queue.paused, true);
  assert.equal(queue.recovery.source, 'backup');
  assert.equal(JSON.parse(await readFile(options.file, 'utf8')).length, 1);
  assert.ok(JSON.parse(await readFile(options.file + '.state.json', 'utf8')).recovery);
  await queue.close();
});

test('state damage alone restores records, archives metadata and blocks quota auto-resume', async t => {
  const options = await workspace(t);
  const quota = { kind: 'quota', message: 'quota full', quota: { used: 10, limit: 10 } };
  await atomicJson(options.file, [{ ...job('a', 'queued'), autoPause: quota }]);
  await writeFile(options.file + '.state.json', '{"autoPause":\0');
  const queue = queueFor(options); await queue.init();
  assert.equal(queue.jobs.length, 1); assert.equal(queue.autoPause.manual, true);
  const recovery = new QuotaRecovery({ queue, provider: {}, getSettings: () => ({ quotaAutoResume: true, quotaCheckMinutes: 5 }) });
  assert.equal(recovery.eligible(), false); await recovery.close(); await queue.close();
});

test('state backup is preferred and inaccessible paths are never treated as corrupt data', async t => {
  const { file } = await workspace(t);
  await writeFile(file, 'broken');
  await atomicJson(file + '.bak', { version: 1, autoPause: { kind: 'quota' } });
  const loaded = await loadQueueState(file);
  assert.equal(loaded.value.autoPause.kind, 'quota'); assert.equal(loaded.recovery.source, 'backup');
  const directory = file + '.directory'; await mkdir(directory);
  await assert.rejects(loadQueueFile(directory));
});

test('recovery survives restart and neither add, batch resume nor retry starts downloads before global confirmation', async t => {
  const options = await workspace(t);
  let downloads = 0;
  const download = async () => { downloads++; return { filename: 'demo.epub', bytes: 1 }; };
  const savedJob = { ...job('a', 'failed'), sources: [{ id: 'list', title: 'Demo list', state: 'paused' }], folder: 'Demo list', downloadRoot: options.directory };
  await writeFile(options.file, `[${JSON.stringify(savedJob)},{"cut":\0`);
  const first = queueFor(options, download); await first.init(); await first.close();
  const queue = queueFor(options, download); await queue.init();
  assert.ok(queue.snapshot().recovery); assert.match(queue.lastError, /损坏/);
  await queue.action('batch-resume', 'list');
  await queue.action('retry', 'a');
  await queue.add([{ title: 'New', url: 'https://example.test/book/new' }]);
  assert.equal(downloads, 0); assert.equal(queue.paused, true); assert.ok(queue.recovery);
  assert.equal(queue.snapshot().recovery.archives.some(file => path.isAbsolute(file)), false);
  await queue.action('resume'); await queue.pumpTask;
  assert.equal(downloads, 2); assert.equal(queue.recovery, null);
  assert.equal(JSON.parse(await readFile(options.file + '.state.json', 'utf8')).recovery, null);
  await queue.close();
});

test('repair and archival leave downloaded book contents untouched', async t => {
  const options = await workspace(t);
  const bookFile = path.join(options.directory, 'saved.epub');
  const payload = Buffer.from('existing downloaded book'); await writeFile(bookFile, payload);
  await writeFile(options.file, `[${JSON.stringify({ ...job('a'), filename: 'saved.epub' })},\0`);
  const queue = queueFor(options); await queue.init(); await queue.close();
  assert.deepEqual(await readFile(bookFile), payload);
});

test('simultaneous queue/state damage is archived and repaired with immediate valid backups', async t => {
  const options = await workspace(t);
  const raw = Buffer.from(`[${JSON.stringify(job('a'))},{"cut":\0`);
  const stateRaw = Buffer.alloc(39);
  await writeFile(options.file, raw); await writeFile(options.file + '.state.json', stateRaw);
  const queue = queueFor(options); await queue.init();
  assert.equal(queue.recovery.archives.length, 2);
  assert.deepEqual(await readFile(queue.recovery.archives[0]), raw);
  assert.deepEqual(await readFile(queue.recovery.archives[1]), stateRaw);
  assert.equal(JSON.parse(await readFile(options.file + '.bak', 'utf8')).length, 1);
  assert.ok(JSON.parse(await readFile(options.file + '.state.json.bak', 'utf8')).recovery);
  assert.equal(queue.paused, true);
  await queue.action('resume'); await queue.pumpTask;
  assert.equal(queue.recovery, null); await queue.close();
});
