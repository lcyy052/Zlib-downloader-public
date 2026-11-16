// Browser adapter contract checks against local fixtures, not the real website.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryProvider } from '../src/provider.js';
const dir = await mkdtemp(path.join(os.tmpdir(), 'zlib-adapter-'));
const provider = new LibraryProvider({ getSettings: () => ({ site: 'https://fixture.example', browser: 'chrome' }), dataDir: dir, demo: false, headless: true });
try {
  const context = await provider.browser();
  const requests = [];
  await context.route('https://fixture.example/**', async route => {
    const url = new URL(route.request().url()); requests.push(url);
    if (url.pathname.startsWith('/s/')) {
      const query = decodeURIComponent(url.pathname.slice(3));
      if (query === 'denied') return route.fulfill({ contentType: 'text/html', body: '<title>Access Denied | DiamWall</title><body>Denied</body>' });
      if (query === 'empty') return route.fulfill({ contentType: 'text/html', body: '<body>No books found</body>' });
      return route.fulfill({ contentType: 'text/html', body: `<body><div class="book-item"><z-bookcard href="/book/1/hash" title="Fixture Book" author="Test Author" year="2020" language="english" extension="epub" filesize="1 MB"><img src="/placeholder.gif" data-src="https://covers.example/real-cover.jpg"></z-bookcard></div><z-bookcard href="/book/1/hash" title="duplicate"></z-bookcard><a rel="next" href="?page=2">Next</a></body>` });
    }
    if (url.pathname === '/book/reader-only/hash') return route.fulfill({ contentType: 'text/html', body: '<body><a class="btn dlButton reader-link" target="_blank" href="/read/only?download_location=/dl/1/hash">线上阅读</a></body>' });
    if (url.pathname.startsWith('/book/gateway')) return route.fulfill({ contentType: 'text/html', body: `<a class="addDownloadedBook" ${url.pathname.includes('popup') ? 'target="_blank"' : ''} href="/dl/gateway${url.pathname.includes('522') ? 522 : 504}">Download</a>` });
    if (url.pathname.startsWith('/book/')) return route.fulfill({ contentType: 'text/html', body: '<body><a class="btn btn-primary dlButton reader-link" target="_blank" href="/read/1?download_location=/dl/1/hash">线上阅读</a><a class="btn btn-default dlButton addDownloadedBook" href="/dl/1/hash">epub, 1 MB</a></body>' });
    if (/^\/dl\/gateway(?:504|522)$/.test(url.pathname)) return route.fulfill({ status: Number(url.pathname.slice(-3)), contentType: 'text/html', body: '<title>Gateway time-out</title><h1>Gateway time-out</h1>' });
    if (url.pathname.startsWith('/dl/')) return route.fulfill({ headers: { 'content-type': 'application/epub+zip', 'content-disposition': 'attachment; filename="fixture.epub"' }, body: Buffer.from('Fixture download payload, not an ebook.') });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  const result = await provider.search('Fixture', { format: 'EPUB', language: 'english', yearFrom: '2000', yearTo: '2025' }, 2);
  console.log('PASS: search fixture');
  assert.equal(result.books.length, 1);
  assert.equal(result.books[0].title, 'Fixture Book');
  assert.equal(result.books[0].format, 'EPUB');
  assert.equal(result.books[0].cover, 'https://covers.example/real-cover.jpg');
  assert.equal(result.hasNext, true);
  assert.equal(requests[0].searchParams.get('page'), '2');
  assert.equal(requests[0].searchParams.get('extensions[]'), 'epub');
  assert.equal(requests[0].searchParams.get('yearFrom'), '2000');
  const download = await provider.download(result.books[0], dir, new AbortController().signal, () => {});
  console.log('PASS: file saved');
  assert.equal(download.filename, 'Fixture Book(Test Author)-2020.epub');
  assert.equal(await readFile(path.join(dir, download.filename), 'utf8'), 'Fixture download payload, not an ebook.');
  assert.ok(!requests.some(url => url.pathname.startsWith('/read/')), 'Must never open the online reader, even when it precedes the download link');
  await assert.rejects(() => provider.download({ ...result.books[0], url: 'https://fixture.example/book/reader-only/hash' }, dir, new AbortController().signal, () => {}), /已排除线上阅读/);
  assert.ok(!requests.some(url => url.pathname.startsWith('/read/')), 'Reader-only pages must fail without clicking anything');
  for (const kind of ['gateway', 'gateway-popup', 'gateway522', 'gateway522-popup']) {
    const status = kind.includes('522') ? 522 : 504;
    console.log(`Checking HTTP ${status}: ${kind}`);
    const started = Date.now();
    await assert.rejects(() => provider.download({ ...result.books[0], url: `https://fixture.example/book/${kind}/hash` }, dir, new AbortController().signal, () => {}), new RegExp(`HTTP ${status}`));
    assert.ok(Date.now() - started < 15000, 'HTTP errors must not wait for the 90-second download timeout');
  }
  await assert.rejects(() => provider.search('denied', {}), /拒绝/);
  // Simulate the visible-session lifecycle while keeping the test browser headless.
  provider.visible = true;
  await context.addCookies([{ name: 'fixture_session', value: 'logged-in', url: 'https://fixture.example' }]);
  await assert.rejects(() => provider.search('denied', {}), /已保留/);
  const retained = provider.recoveryPage;
  assert.ok(retained && !retained.isClosed(), 'Blocked search page must remain open for the user');
  const requestCount = requests.length;
  await provider.login();
  assert.equal(provider.context, context, 'Login and search must share the same browser context');
  assert.equal(requests.length, requestCount, 'Opening login must not navigate away from the blocked page');
  await retained.setContent('<title>Books</title><z-bookcard href="/book/2/verified" title="Verified Book" extension="pdf"></z-bookcard>');
  const recovered = await provider.search('denied', {});
  assert.equal(recovered.books[0].title, 'Verified Book');
  assert.equal(requests.length, requestCount, 'Retry should read the manually recovered page without reloading');
  assert.equal((await context.cookies()).find(c => c.name === 'fixture_session').value, 'logged-in');
  assert.deepEqual((await provider.search('empty', {})).books, []);
  console.log('PASS: Chrome extraction, metadata, deduplication, filter URL, pagination, download event + saveAs, preserved blocked page, login/search shared session, retry after manual recovery without reload, empty search. Fixtures only; live website remains unverified.');
} finally { await provider.close(); await rm(dir, { recursive: true, force: true }); }
