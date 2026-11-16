import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadWithBrowserStream } from '../src/browser-stream-download.js';

function fixture({ status = 200, type = 'application/pdf', length = 9, noHeaders = false } = {}) {
  const context = new EventEmitter(), session = new EventEmitter();
  const page = { url: () => 'https://library.example/book/1' };
  const calls = [];
  let read = 0;
  session.send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.navigate' && !noHeaders) queueMicrotask(() => session.emit('Fetch.requestPaused', {
      requestId: 'request-1', frameId: 'main', responseStatusCode: status,
      responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Content-Length', value: String(length) }],
    }));
    if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'stream-1' };
    if (method === 'IO.read') {
      const bytes = read++ ? Buffer.from('book') : Buffer.from('%PDF-');
      return { data: bytes.toString('base64'), base64Encoded: true, eof: read === 2 };
    }
    return {};
  };
  session.detach = async () => calls.push({ method: 'detach' });
  context.newCDPSession = async () => session;
  return { context, page, calls, session };
}

async function temporary(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-response-stream-test-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('response stream writes bytes and cancels navigation without the native download manager', () => temporary(async directory => {
  const mock = fixture();
  const destination = path.join(directory, 'book.pdf');
  const info = await downloadWithBrowserStream({ ...mock, url: 'https://cdn.example/file', destination });
  assert.equal(info.size, 9);
  assert.equal((await readFile(destination)).toString(), '%PDF-book');
  assert.ok(mock.calls.some(call => call.method === 'Fetch.takeResponseBodyAsStream'));
  assert.ok(mock.calls.some(call => call.method === 'Fetch.failRequest' && call.params.errorReason === 'Aborted'));
  assert.ok(!mock.calls.some(call => /setDownloadBehavior|loadNetworkResource/.test(call.method)));
  assert.equal(mock.session.listenerCount('Fetch.requestPaused'), 0);
}));

test('response stream rejects truncated content and removes the partial file', () => temporary(async directory => {
  const mock = fixture({ length: 100 });
  await assert.rejects(downloadWithBrowserStream({ ...mock, url: 'https://cdn.example/file', destination: path.join(directory, 'book.pdf') }), /接收字节数与文件大小不符/);
  assert.deepEqual(await readdir(directory), []);
}));

test('response stream reports concrete HTTP status and refuses HTML', () => temporary(async directory => {
  await assert.rejects(downloadWithBrowserStream({ ...fixture({ status: 504 }), url: 'https://cdn.example/file', destination: path.join(directory, 'book.pdf') }), /HTTP 504/);
  await assert.rejects(downloadWithBrowserStream({ ...fixture({ status: 522 }), url: 'https://cdn.example/file', destination: path.join(directory, 'book.pdf') }), error => {
    assert.equal(error.httpStatus, 522); assert.match(error.message, /网站源站连接超时/); return true;
  });
  await assert.rejects(downloadWithBrowserStream({ ...fixture({ type: 'text/html' }), url: 'https://cdn.example/file', destination: path.join(directory, 'book.pdf') }), /网页而非电子书/);
  assert.deepEqual(await readdir(directory), []);
}));

test('response stream abort removes partial data and cancels intercepted request', () => temporary(async directory => {
  const mock = fixture(), controller = new AbortController();
  await assert.rejects(downloadWithBrowserStream({ ...mock, signal: controller.signal, url: 'https://cdn.example/file', destination: path.join(directory, 'book.pdf'), onProgress: update => { if (update.receivedBytes) controller.abort(); } }), /已取消/);
  assert.deepEqual(await readdir(directory), []);
  assert.ok(mock.calls.some(call => call.method === 'Fetch.failRequest'));
}));

test('response stream bounds the wait for headers and stops pending navigation', () => temporary(async directory => {
  const mock = fixture({ noHeaders: true });
  await assert.rejects(downloadWithBrowserStream({ ...mock, url: 'https://cdn.example/file', destination: path.join(directory, 'book.pdf'), timeouts: { startTimeoutMs: 20 } }), /网络请求超时/);
  assert.ok(mock.calls.some(call => call.method === 'Page.stopLoading'));
  assert.equal(mock.session.listenerCount('Fetch.requestPaused'), 0);
  assert.deepEqual(await readdir(directory), []);
}));
