import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryProvider } from '../src/provider.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-parallel-stream-'));
const provider = new LibraryProvider({ getSettings: () => ({ browser: 'chrome', downloadConcurrency: 3 }), dataDir: directory, demo: false, headless: true });
provider.transferHttp = async () => { throw Object.assign(new Error('Fixture direct failure'), { code: 'ECONNREFUSED' }); };
const payloads = [1, 2, 3].map(id => { const bytes = Buffer.alloc(4 * 1024 * 1024, 64 + id); bytes.write('%PDF-1.7\n'); bytes.write('\n%%EOF', bytes.length - 6); return bytes; });
let phase = 'parallel', active = 0, peak = 0, nativeDownloads = 0;
const server = http.createServer((req, res) => {
  const id = Number(req.url.split('/').at(-1));
  if (req.url.startsWith('/book/')) { res.end(`<a class="addDownloadedBook" href="/dl/${id}">Download</a>`); return; }
  if (req.url.startsWith('/dl/')) { res.setHeader('content-type', 'text/html'); res.end(`<script>location.href='http://localhost:${server.address().port}/file/${id}'</script>`); return; }
  if (!req.url.startsWith('/file/')) { res.end('<title>Fixture</title>'); return; }
  if (phase === 'failure' && id === 2) { res.writeHead(522); res.end('Origin timeout'); return; }
  active++; peak = Math.max(peak, active);
  let offset = 0;
  const payload = payloads[id - 1];
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': payload.length });
  const timer = setInterval(() => { res.write(payload.subarray(offset, offset + 64 * 1024)); offset += 64 * 1024; if (offset >= payload.length) { clearInterval(timer); res.end(); } }, 20);
  res.on('close', () => { clearInterval(timer); active--; });
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await provider.browser();
  context.on('page', page => page.on('download', () => nativeDownloads++));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const book = (id, tag) => ({ title: `${tag} ${id}`, format: 'PDF', size: '4 MB', url: `${origin}/book/${id}` });
  const clicks = new Map(), done = new Map(), progress = new Map();
  const started = Date.now();
  const results = await Promise.all([1, 2, 3].map(id => provider.download(book(id, 'parallel'), directory, new AbortController().signal, update => {
    if (update === '正在请求文件…') clicks.set(id, Date.now());
    if (typeof update === 'object' && update.receivedBytes > 0) { progress.set(id, (progress.get(id) || 0) + 1); if (update.state === 'completed') done.set(id, Date.now()); }
  })));
  assert.equal(peak, 2); assert.ok(clicks.get(3) < done.get(1), 'Long body must not block another book initiation');
  for (let i = 0; i < results.length; i++) { assert.deepEqual(await readFile(path.join(directory, results[i].filename)), payloads[i]); assert.ok(progress.get(i + 1) >= 2); }
  console.log(JSON.stringify({ phase, result: 'PASS', maxSimultaneousFiles: peak, files: results.length, seconds: (Date.now() - started) / 1000, bytesPerFile: payloads[0].length }));
  phase = 'failure';
  const failures = await Promise.allSettled([1, 2].map(id => provider.download(book(id, phase), directory, new AbortController().signal, () => {})));
  assert.equal(failures[0].status, 'fulfilled'); assert.equal(failures[1].status, 'rejected'); assert.equal(failures[1].reason.httpStatus, 522);
  assert.deepEqual(await readFile(path.join(directory, failures[0].value.filename)), payloads[0]);
  phase = 'cancel';
  const controller = new AbortController();
  const cancelResults = await Promise.allSettled([
    provider.download(book(1, phase), directory, new AbortController().signal, () => {}),
    provider.download(book(2, phase), directory, controller.signal, update => { if (typeof update === 'object' && update.receivedBytes > 0) controller.abort(); }),
    provider.download(book(3, phase), directory, new AbortController().signal, () => {}),
  ]);
  assert.deepEqual(cancelResults.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  for (const index of [0, 2]) assert.deepEqual(await readFile(path.join(directory, cancelResults[index].value.filename)), payloads[index]);
  assert.equal(nativeDownloads, 0); assert.ok(!(await readdir(directory)).some(name => name.endsWith('.part') || name.startsWith('cancel 2')));
  console.log(JSON.stringify({ result: 'PASS', independentHttp522: true, cancelOnePreservesOthers: true, nativeDownloads }));
} finally {
  await provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const target = path.resolve(directory); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('zlib-parallel-stream-'));
  await rm(target, { recursive: true, force: true });
}
