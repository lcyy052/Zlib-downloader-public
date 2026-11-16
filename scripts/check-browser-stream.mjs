import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryProvider } from '../src/provider.js';
import { downloadWithBrowserStream } from '../src/browser-stream-download.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-stream-check-'));
const provider = new LibraryProvider({ getSettings: () => ({ browser: 'chrome' }), dataDir: directory, demo: false, headless: true });
async function closePage(page) {
  let timer;
  await Promise.race([page.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
  clearTimeout(timer);
}
const payload = Buffer.alloc(3 * 1024 * 1024, 65);
payload.write('%PDF-1.7\n');
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.end('<title>Download fixture</title>'); return; }
  if (req.url === '/book/fixture') { res.end('<a class="addDownloadedBook" href="/dl/fixture">Download PDF</a>'); return; }
  if (req.url === '/dl/fixture') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<script>location.href='http://localhost:${server.address().port}/file'</script>`); return; }
  if (req.url === '/gone') { res.writeHead(410, { 'content-type': 'text/html' }); res.end('Gone'); return; }
  if (req.url === '/origin-timeout') { res.writeHead(522, { 'content-type': 'text/html' }); res.end('Origin connection timed out'); return; }
  if (req.url === '/headers-stall') return;
  if (req.url === '/redirect') { res.writeHead(302, { location: '/file' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="fixture.pdf"', 'content-length': payload.length });
  let offset = 0;
  const timer = setInterval(() => {
    if (req.url === '/stall' && offset) return;
    res.write(payload.subarray(offset, offset + 64 * 1024));
    offset += 64 * 1024;
    if (offset >= payload.length) { clearInterval(timer); res.end(); }
  }, 25);
  res.on('close', () => clearInterval(timer));
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await provider.browser();
  let page = await context.newPage();
  await page.goto(origin);
  const updates = [];
  const destination = path.join(directory, 'saved.pdf');
  let nativeDownloads = 0;
  context.on('page', opened => opened.on('download', () => nativeDownloads++));
  page.on('download', () => nativeDownloads++);
  const info = await downloadWithBrowserStream({ context, page, url: `${origin}/redirect`, destination, signal: new AbortController().signal, onProgress: update => updates.push(update) });
  assert.equal(info.size, payload.length);
  assert.deepEqual(await readFile(destination), payload);
  const byteUpdates = updates.filter(update => typeof update === 'object' && update.receivedBytes > 0 && update.receivedBytes < payload.length);
  assert.ok(byteUpdates.length >= 2, 'Response streaming must report advancing bytes before completion');
  console.log('PASS: response streaming and intermediate byte progress');
  await closePage(page);
  provider.transferHttp = async () => { throw Object.assign(new Error('Fixture direct-connect failure'), { code: 'ECONNREFUSED' }); };
  const fullProgress = [];
  const recovered = await provider.download({ title: 'Fallback fixture', format: 'PDF', size: '3 MB', url: `${origin}/book/fixture` }, directory, new AbortController().signal, update => fullProgress.push(update));
  assert.deepEqual(await readFile(path.join(directory, recovered.filename)), payload);
  assert.ok(fullProgress.some(update => typeof update === 'string' && update.includes('直连失败')));
  assert.ok(fullProgress.some(update => typeof update === 'object' && update.receivedBytes > 0 && update.receivedBytes < payload.length));
  console.log('PASS: production provider switches from failed HTTP to streaming Chrome');
  page = await context.newPage();
  await page.goto(origin);
  await assert.rejects(downloadWithBrowserStream({ context, page, url: `${origin}/gone`, destination: path.join(directory, 'gone.pdf'), signal: new AbortController().signal }), /HTTP 410/);
  console.log('PASS: HTTP 410 is reported');
  await closePage(page);
  page = await context.newPage();
  await page.goto(origin);
  await assert.rejects(downloadWithBrowserStream({ context, page, url: `${origin}/origin-timeout`, destination: path.join(directory, 'origin.pdf') }), error => {
    assert.equal(error.httpStatus, 522); assert.match(error.message, /网站源站连接超时/); return true;
  });
  console.log('PASS: Chrome response streaming preserves HTTP 522');
  await closePage(page);
  page = await context.newPage();
  await page.goto(origin);
  await assert.rejects(downloadWithBrowserStream({ context, page, url: `${origin}/headers-stall`, destination: path.join(directory, 'headers.pdf'), timeouts: { startTimeoutMs: 150 } }), /网络请求超时/);
  console.log('PASS: request without response headers times out');
  await closePage(page);
  page = await context.newPage();
  await page.goto(origin);
  await assert.rejects(downloadWithBrowserStream({ context, page, url: `${origin}/stall`, destination: path.join(directory, 'stall.pdf'), signal: new AbortController().signal, timeouts: { startTimeoutMs: 2000, idleTimeoutMs: 500, totalTimeoutMs: 5000 } }), /没有收到新数据/);
  console.log('PASS: stalled transfer is stopped');
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.part') || name === 'stall.pdf'));
  await closePage(page);
  page = await context.newPage();
  await page.goto(origin);
  const controller = new AbortController();
  const cancelled = downloadWithBrowserStream({ context, page, url: `${origin}/file`, destination: path.join(directory, 'cancelled.pdf'), signal: controller.signal, onProgress: update => { if (typeof update === 'object' && update.receivedBytes > 0) controller.abort(); } });
  await assert.rejects(cancelled);
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.part') || name === 'cancelled.pdf'));
  assert.equal(nativeDownloads, 0, 'No request may reach the native download manager');
  console.log(JSON.stringify({ result: 'PASS', bytes: info.size, intermediateBytes: byteUpdates.map(update => update.receivedBytes), http410: 'reported', stalled: 'cancelled', pause: 'cancelled-without-final-file' }));
} finally {
  await provider.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
