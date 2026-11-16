// Real Chrome, local fixtures only: never requests the user's website or profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryProvider } from '../src/provider.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-initiation-'));
const provider = new LibraryProvider({ getSettings: () => ({ browser: 'chrome' }), dataDir: directory, demo: false, headless: true });
provider.downloadTimeouts = { startTimeoutMs: 2000, idleTimeoutMs: 1000, totalTimeoutMs: 5000 };
const payloadFor = kind => Buffer.from(`%PDF-1.7\nLocal fixture ${kind}\n%%EOF`);
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/book/')) {
    const kind = req.url.split('/').at(-1);
    const attrs = kind === 'blank' ? 'target="_blank"' : kind === 'noopener' ? 'target="_blank" rel="noopener noreferrer"' : '';
    const click = kind.startsWith('script-popup') || kind === 'stalled' ? `onclick="window.open('/intermediate/${kind}');return false"` : '';
    res.setHeader('content-type', 'text/html');
    return res.end(`<a class="addDownloadedBook" href="/dl/${kind}" ${attrs} ${click}>Download</a>`);
  }
  if (req.url.startsWith('/intermediate/')) {
    const kind = req.url.split('/').at(-1);
    res.setHeader('content-type', 'text/html');
    return res.end(`<script>setTimeout(()=>location.href='/dl/${kind}',50)</script>`);
  }
  const kind = req.url.split('/').at(-1);
  const payload = payloadFor(kind);
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="fixture.pdf"', 'content-length': payload.length });
  if (kind === 'stalled') { res.write(payload.subarray(0, 8)); return; }
  res.end(payload);
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await provider.browser();
  let events = 0;
  context.on('page', page => page.on('download', () => events++));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // A completed orphan in Chrome's folder must never supply another book's progress.
  await mkdir(path.join(directory, 'transfers'), { recursive: true });
  await writeFile(path.join(directory, 'transfers', 'unrelated-file'), Buffer.alloc(19));
  for (const kind of ['same', 'blank', 'noopener', 'script-popup']) {
    const start = Date.now(), previousEvents = events;
    try {
      const updates = [];
      const result = await provider.download({ title: `Fixture ${kind}`, format: 'PDF', url: `${origin}/book/${kind}` }, directory, new AbortController().signal, update => updates.push(update));
      assert.deepEqual(await readFile(path.join(directory, result.filename)), payloadFor(kind));
      assert.ok(!updates.some(update => update.state === 'saving' || update.receivedBytes === 19));
      console.log('PASS', kind, Date.now() - start, 'ms; download events:', events - previousEvents);
    } catch (error) {
      console.log('FAIL', kind, Date.now() - start, 'ms; download events:', events - previousEvents, error.message);
      process.exitCode = 1;
    }
  }
  const parallel = ['script-popup-a', 'script-popup-b', 'script-popup-c'];
  const results = await Promise.all(parallel.map(kind => provider.download({ title: `Fixture ${kind}`, format: 'PDF', url: `${origin}/book/${kind}` }, directory, new AbortController().signal, () => {})));
  for (let i = 0; i < results.length; i++) assert.deepEqual(await readFile(path.join(directory, results[i].filename)), payloadFor(parallel[i]));
  console.log('PASS three concurrent popup downloads saved with the correct books');
  provider.downloadTimeouts = { startTimeoutMs: 2000, totalTimeoutMs: 200 };
  await assert.rejects(provider.download({ title: 'Fixture stalled', format: 'PDF', url: `${origin}/book/stalled` }, directory, new AbortController().signal, () => {}), /仍未完成/);
  assert.ok(!(await readdir(directory)).some(name => name.startsWith('Fixture stalled')));
  console.log('PASS stalled popup transfer times out and removes its reserved output');
} finally {
  await provider.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
