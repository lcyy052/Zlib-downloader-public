import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { browserRequestTimeout, downloadWithBrowserNetwork } from '../src/browser-download.js';

function mockContext(chunks, resource = {}) {
  let reads = 0;
  const calls = [];
  const session = {
    async send(method) {
      calls.push(method);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } };
      if (method === 'Network.loadNetworkResource') return { resource: {
        success: true,
        httpStatusCode: 200,
        headers: { 'Content-Type': 'application/epub+zip', 'Content-Length': String(Buffer.concat(chunks).length) },
        stream: 'stream-1',
        ...resource,
      } };
      if (method === 'IO.read') {
        const data = chunks[reads++];
        return { data: data.toString('base64'), base64Encoded: true, eof: reads === chunks.length };
      }
      return {};
    },
    async detach() { calls.push('detach'); },
  };
  return { context: { async newCDPSession() { return session; } }, calls };
}

test('Chrome response timeout grows for large books but remains bounded', () => {
  assert.equal(browserRequestTimeout('313 KB'), 45000);
  assert.equal(browserRequestTimeout('34.75 MB'), 139000);
  assert.equal(browserRequestTimeout('84.79 MB'), 300000);
  assert.equal(browserRequestTimeout('500 MB'), 300000);
});

test('Chrome network stream saves binary data and reports progress', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-browser-download-'));
  const destination = path.join(directory, 'book.epub');
  const chunks = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('ebook')];
  const { context, calls } = mockContext(chunks);
  const progress = [];
  try {
    const info = await downloadWithBrowserNetwork({ context, page: {}, url: 'https://download.example/book', destination, signal: new AbortController().signal, onProgress: update => progress.push(update) });
    assert.equal(info.size, 9);
    assert.deepEqual(await readFile(destination), Buffer.concat(chunks));
    assert.equal(progress.at(-1).receivedBytes, 9);
    assert.ok(calls.includes('Network.loadNetworkResource'));
    assert.ok(calls.includes('IO.close'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Chrome network stream rejects HTML without leaving a partial file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-browser-download-'));
  const destination = path.join(directory, 'book.epub');
  const { context } = mockContext([Buffer.from('login')], { headers: { 'content-type': 'text/html' } });
  try {
    await assert.rejects(downloadWithBrowserNetwork({ context, page: {}, url: 'https://download.example/book', destination, signal: new AbortController().signal }), /网页而非电子书/);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Chrome network stream preserves the HTTP status behind response-code failures', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-browser-download-'));
  const destination = path.join(directory, 'book.epub');
  const { context } = mockContext([], {
    success: false,
    httpStatusCode: 504,
    netErrorName: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE',
    stream: undefined,
  });
  try {
    await assert.rejects(downloadWithBrowserNetwork({
      context,
      page: {},
      url: 'https://download.example/book',
      destination,
      signal: new AbortController().signal,
    }), /HTTP 504/);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Chrome network stream times out when no response headers arrive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-browser-download-'));
  const destination = path.join(directory, 'book.epub');
  const session = {
    async send(method) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } };
      if (method === 'Network.loadNetworkResource') return new Promise(() => {});
      return {};
    },
    async detach() {},
  };
  const context = { async newCDPSession() { return session; } };
  try {
    await assert.rejects(downloadWithBrowserNetwork({
      context,
      page: {},
      url: 'https://download.example/book',
      destination,
      signal: new AbortController().signal,
      requestTimeoutMs: 10,
    }), /Chrome 网络请求超时/);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
