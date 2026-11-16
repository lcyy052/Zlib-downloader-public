import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDownloadProgress } from '../src/download-progress.js';

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for progress update');
}

test('observes transfer files without taking over Playwright download events', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zlib-progress-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const transferDir = path.join(dataDir, 'transfers');
  await mkdir(transferDir);
  await writeFile(path.join(transferDir, 'old.crdownload'), Buffer.alloc(99));
  const monitor = await createDownloadProgress(dataDir, { pollMs: 10 });
  const updates = [];
  const stop = await monitor.observe(update => updates.push(update));

  const partial = path.join(transferDir, 'new-guid.crdownload');
  const completed = path.join(transferDir, 'new-guid');
  await writeFile(partial, Buffer.alloc(10));
  await waitFor(() => updates.some(update => update.receivedBytes === 10));
  await appendFile(partial, Buffer.alloc(15));
  await waitFor(() => updates.some(update => update.receivedBytes === 25));
  await rename(partial, completed);
  await waitFor(() => updates.some(update => update.state === 'saving'));

  assert.equal(updates.some(update => update.receivedBytes === 99), false);
  assert.ok(updates.every(update => update.totalBytes === 0 && update.percent === null));
  await stop();
  await monitor.close();
});

test('concurrent observers claim different transfer files', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zlib-progress-concurrent-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const transferDir = path.join(dataDir, 'transfers');
  await mkdir(transferDir);
  const monitor = await createDownloadProgress(dataDir, { pollMs: 10 });
  const first = [], second = [];
  const stopFirst = await monitor.observe(update => first.push(update));
  const stopSecond = await monitor.observe(update => second.push(update));

  await writeFile(path.join(transferDir, 'first.crdownload'), Buffer.alloc(11));
  await waitFor(() => [first, second].filter(updates => updates.some(update => update.receivedBytes === 11)).length === 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(path.join(transferDir, 'second.crdownload'), Buffer.alloc(22));
  await waitFor(() => first.some(update => update.receivedBytes === 22) || second.some(update => update.receivedBytes === 22));

  assert.equal(first.some(update => update.receivedBytes === 11) && second.some(update => update.receivedBytes === 11), false);
  assert.equal(first.some(update => update.receivedBytes === 22) && second.some(update => update.receivedBytes === 22), false);
  assert.ok(first.length && second.length);
  await stopFirst(); await stopSecond(); await monitor.close();
});
