import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskLimiter } from '../src/task-limiter.js';
import { LibraryProvider } from '../src/provider.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Chrome transfer pool runs two tasks and queues the third in FIFO order', async () => {
  const provider = new LibraryProvider({ getSettings: () => ({ downloadConcurrency: 3 }) });
  const started = [], release = [];
  const tasks = [0, 1, 2].map(id => provider.runChromeTransfer(() => new Promise(resolve => { started.push(id); release[id] = resolve; })));
  await tick(); assert.deepEqual(started, [0, 1]);
  release[0](); await tasks[0]; await tick(); assert.deepEqual(started, [0, 1, 2]);
  release[1](); release[2](); await Promise.all(tasks);
});

test('Chrome transfer pool respects serial setting and does not block initiation', async () => {
  const provider = new LibraryProvider({ getSettings: () => ({ downloadConcurrency: 1 }) });
  let release, secondStarted = false;
  const first = provider.runChromeTransfer(() => new Promise(resolve => { release = resolve; }));
  const second = provider.runChromeTransfer(() => { secondStarted = true; });
  await tick(); await provider.runBrowserTransfer(async () => {});
  assert.equal(secondStarted, false); release(); await Promise.all([first, second]); assert.equal(secondStarted, true);
});

test('queued cancellation removes task without running it later', async () => {
  const pool = new TaskLimiter(1); let release, ran = false;
  const first = pool.run(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController(); const next = pool.run(() => { ran = true; }, controller.signal);
  controller.abort(); await assert.rejects(next, /已取消/); await tick(); release(); await first; await tick(); assert.equal(ran, false); assert.equal(pool.pending.length, 0);
});

test('active cancellation does not release a permit until underlying cleanup settles', async () => {
  const pool = new TaskLimiter(1); let finish, second = false;
  const controller = new AbortController();
  const first = pool.run(() => new Promise(resolve => { finish = resolve; }), controller.signal);
  const next = pool.run(() => { second = true; });
  await tick(); controller.abort(); await assert.rejects(first, /已取消/); await tick(); assert.equal(second, false);
  finish(); await next; assert.equal(second, true);
});

test('one failed transfer does not block another or leak a permit', async () => {
  const pool = new TaskLimiter(2);
  const tasks = [pool.run(() => { throw new Error('HTTP 522'); }), pool.run(async () => 2), pool.run(async () => 3)];
  assert.deepEqual((await Promise.allSettled(tasks)).map(result => result.status), ['rejected', 'fulfilled', 'fulfilled']);
  await tick(); assert.equal(pool.active, 0);
});
