import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadHttp, isDownloadNetworkError } from '../src/http-download.js';

test('downloadHttp preserves 522 status and leaves no partial file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-http-522-'));
  try {
    await assert.rejects(downloadHttp({ url: 'https://fixture.example/file', destination: path.join(directory, 'book.epub'), fetchImpl: async () => new Response('<html>Origin timeout</html>', { status: 522 }) }), error => {
      assert.equal(error.httpStatus, 522); assert.match(error.message, /网站源站连接超时/);
      assert.equal(isDownloadNetworkError(error), false, 'A server 522 is not a local connection failure');
      return true;
    });
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('downloadHttp streams a binary response and reports byte progress', async () => {
  const payload = Buffer.from('fixture ebook payload');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/epub+zip', 'content-length': payload.length });
    response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-http-download-'));
  const destination = path.join(directory, 'fixture.epub');
  const updates = [];
  try {
    const address = server.address();
    const info = await downloadHttp({ url: `http://127.0.0.1:${address.port}/fixture.epub`, destination, onProgress: update => updates.push(update) });
    assert.equal(info.size, payload.length);
    assert.deepEqual(await readFile(destination), payload);
    assert.equal(updates.at(-1).receivedBytes, payload.length);
    assert.equal(updates.at(-1).totalBytes, payload.length);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('downloadHttp rejects an HTML response without leaving a partial file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-http-download-'));
  const destination = path.join(directory, 'bad.epub');
  try {
    await assert.rejects(() => downloadHttp({
      url: 'https://fixture.example/bad',
      destination,
      fetchImpl: async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    }), /网页而非电子书/);
    await assert.rejects(() => readFile(destination), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('downloadHttp explains system certificate failures instead of returning generic fetch failed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zlib-http-cert-'));
  try {
    const destination = path.join(dir, 'book.epub');
    const certificateError = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    await assert.rejects(() => downloadHttp({
      url: 'https://download.example/book.epub', destination,
      fetchImpl: async () => { throw new TypeError('fetch failed', { cause: certificateError }); },
    }), /Windows 系统证书库/);
    await assert.rejects(access(destination));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('download network errors remain identifiable through friendly wrapper errors', async () => {
  const timeout = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  const original = new TypeError('fetch failed', { cause: timeout });
  assert.equal(isDownloadNetworkError(original), true);
  assert.equal(isDownloadNetworkError(new Error('HTTP 429')), false);
});

test('direct download stops a stalled body, removes partial data and can fall back', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '99999' });
    response.write('%PDF-1.7\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-http-stall-'));
  try {
    await assert.rejects(downloadHttp({
      url: `http://127.0.0.1:${server.address().port}/stall`, destination: path.join(directory, 'book.pdf'), idleTimeoutMs: 40,
    }), error => {
      assert.equal(error.code, 'DOWNLOAD_HTTP_TIMEOUT');
      assert.equal(isDownloadNetworkError(error), true);
      assert.match(error.message, /没有收到新数据/);
      return true;
    });
    assert.deepEqual(await readdir(directory), []);
  } finally { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); }
});
