import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { LibraryProvider } from '../src/provider.js';
const dir = await mkdtemp(path.join(os.tmpdir(), 'zlib-list-test-'));
const provider = new LibraryProvider({ getSettings: () => ({ site: 'https://fixture.example', browser: 'chrome' }), dataDir: dir, demo: false, headless: true });
provider.booklistRetryDelays = [0, 0];
let booklistPageAttempts = 0;
const stream = http.createServer((req, res) => {
  const chunk = Buffer.alloc(128 * 1024, 65); let sent = 0;
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="progress.pdf"', 'Content-Length': chunk.length * 24 });
  if (req.url === '/stalled') { res.write(chunk); return; }
  const timer = setInterval(() => { res.write(chunk); if (++sent === 24) { clearInterval(timer); res.end(); } }, 100);
  res.on('close', () => clearInterval(timer));
});
await new Promise(resolve => stream.listen(0, '127.0.0.1', resolve));
try {
  const context = await provider.browser();
  const card = id => `<z-bookcard href="/book/${id}/hash" extension="pdf" filesize="3 MB"><div slot="title">Book ${id}</div><div slot="author">Author</div></z-bookcard>`;
  await context.route('https://fixture.example/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/booklist/')) return route.fulfill({ status: 503, contentType: 'text/html; charset=utf-8', body: `<title>测试书单</title><a class="booklist-header__title-value">测试书单</a><div class="booklist-main"><div class="readlist-view">${card(1)}</div><div class="page-load-more" style="display:none" onclick="fetch('/papi/booklist/123/get-books/2',{method:'POST'}).then(async r=>{if(!r.ok)return;document.querySelector('.readlist-view').insertAdjacentHTML('beforeend',await r.text());this.style.display='none'})">显示更多</div></div><aside>${card(999)}</aside><script>setTimeout(()=>document.querySelector('.page-load-more').style.display='block',100)</script>` });
    if (url.pathname === '/papi/booklist/123/get-books/2') {
      booklistPageAttempts++;
      if (booklistPageAttempts === 1) return route.fulfill({ status: 502, contentType: 'text/plain', body: 'temporary gateway error' });
      if (booklistPageAttempts === 2) return route.fulfill({ status: 307, contentType: 'text/plain', body: 'temporary redirect' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: card(1) + card(2) });
    }
    if (url.pathname === '/book/stalled/hash') return route.fulfill({ contentType: 'text/html', body: '<a class="addDownloadedBook" href="/dl/stalled">Download</a>' });
    if (url.pathname.startsWith('/book/')) return route.fulfill({ status: 503, contentType: 'text/html; charset=utf-8', body: '<div id="download"></div><script>setTimeout(()=>document.querySelector("#download").innerHTML="<a class=\\"addDownloadedBook\\" href=\\"/dl/progress\\">Download</a>",100)</script>' });
    if (url.pathname === '/dl/stalled') return route.fulfill({ status: 302, headers: { Location: `http://127.0.0.1:${stream.address().port}/stalled` } });
    if (url.pathname === '/dl/progress') return route.fulfill({ status: 302, headers: { Location: `http://127.0.0.1:${stream.address().port}/file` } });
    return route.fulfill({ status: 404 });
  });
  const updates = [];
  const result = await provider.importBooklist('https://fixture.example/booklist/123/hash/test.html', { signal: new AbortController().signal, onProgress: update => updates.push(update) });
  assert.equal(result.title, '测试书单');
  assert.deepEqual(result.books.map(book => book.title), ['Book 1', 'Book 2']);
  assert.deepEqual(updates.map(update => update.books.length), [1, 1, 1, 1, 1, 2]);
  assert.match(updates[1].message, /HTTP 502.*重新载入并续读/);
  assert.match(updates[3].message, /HTTP 307.*重新载入并续读/);
  assert.equal(booklistPageAttempts, 3);
  const progress = [];
  const file = await provider.download(result.books[0], dir, new AbortController().signal, update => { if (typeof update === 'object') progress.push(update); });
  assert.equal(file.bytes, 128 * 1024 * 24);
  assert.ok(progress.some(p => p.receivedBytes > 0 && p.state === 'inProgress'), 'Must receive real intermediate byte progress, not only completion');
  assert.ok(progress.some(p => p.receivedBytes > 0 && p.percent === null), 'Unknown totals must report bytes without inventing a percentage');
  provider.downloadTimeouts = { idleTimeoutMs: 1200, totalTimeoutMs: 10000 };
  await assert.rejects(() => provider.download({ ...result.books[0], title: 'Stalled', url: 'https://fixture.example/book/stalled/hash' }, dir, new AbortController().signal, () => {}), /没有收到新数据/);
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('Stalled')), 'Failed transfer must remove its reserved output file');
  console.log(JSON.stringify({ result: 'PASS', imported: result.books.length, pages: result.pages, intermediateBytes: progress.filter(p => p.state === 'inProgress').map(p => p.receivedBytes), bytes: file.bytes }));
} finally { await provider.close(); stream.closeAllConnections(); await new Promise(resolve => stream.close(resolve)); await rm(dir, { recursive: true, force: true }); }

