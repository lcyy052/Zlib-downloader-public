import test from 'node:test';
import assert from 'node:assert/strict';
import { booklistResponseInfo, readBooklistResponse, booklistResponseDiagnostic, booklistApiCursor, booklistApiRecords } from '../src/booklist-pagination.js';

test('booklist: only explicit empty end is complete', () => {
  for (const body of ['', '{}', '{"books":[]}', '{"hasMore":false}', '<div>temporary error</div>']) {
    assert.equal(booklistResponseInfo(body).emptyEnd, false, body);
  }
  assert.equal(booklistResponseInfo('{"data":{"books":[],"hasMore":false}}').emptyEnd, true);
  assert.equal(booklistResponseInfo('{"books":[],"pagination":{"hasNext":false}}').emptyEnd, true);
  const lastPage = booklistResponseInfo('{"data":{"books":[{"id":2}],"hasMore":false}}');
  assert.equal(lastPage.emptyEnd, false);
  assert.equal(lastPage.requireGrowth, true);
});

test('booklist: returned cards must reach the DOM before a hidden button ends reading', () => {
  for (const body of ['<z-bookcard href="/book/2/hash"></z-bookcard>', '<div class="book-item"></div>', '{"html":"<z-bookcard></z-bookcard>"}', '<a href="/book/2/hash">Book</a>']) {
    assert.equal(booklistResponseInfo(body).requireGrowth, true, body);
  }
  assert.equal(booklistResponseInfo('').requireGrowth, false);
});

test('booklist: logical API errors are not empty completion', () => {
  const info = booklistResponseInfo('{"success":false,"message":"Please log in","data":{"books":[],"hasMore":false}}');
  assert.equal(info.error, 'Please log in');
  assert.equal(info.emptyEnd, false);
});

test('booklist: response body has a bounded wait', async () => {
  assert.equal(await readBooklistResponse({ text: async () => 'cards' }, 100), 'cards');
  await assert.rejects(readBooklistResponse({ text: () => new Promise(() => {}) }, 10), { code: 'BOOKLIST_PAGE_TIMEOUT' });
  await assert.rejects(readBooklistResponse({ text: async () => { throw new Error('connection closed'); } }, 100), /connection closed/);
});

test('booklist: diagnostics contain counts and structure, not private string values', () => {
  const diagnostic = booklistResponseDiagnostic(JSON.stringify({ data: { books: ['private title'], html: '<z-bookcard></z-bookcard>', token: 'secret-token', total: 539, hasMore: false } }));
  assert.equal(diagnostic.data.books.items, 1);
  assert.equal(diagnostic.data.html.cards, 1);
  assert.equal(diagnostic.data.total, 539);
  assert.equal(diagnostic.data.hasMore, false);
  assert.ok(!JSON.stringify(diagnostic).includes('secret-token'));
  assert.ok(!JSON.stringify(diagnostic).includes('private title'));
});

test('booklist: real empty intermediate page advances rather than completing', () => {
  const body = { success: 1, books: [], pagination: { current: 28, next: 29, total_items: 626, total_pages: 32 } };
  const info = booklistResponseInfo(JSON.stringify(body));
  assert.equal(info.emptyPage, true); assert.equal(info.emptyEnd, false);
  assert.equal(info.pagination.nextPage, 29);
  const last = booklistResponseInfo(JSON.stringify({ ...body, pagination: { ...body.pagination, current: 32, next: null } }));
  assert.equal(last.emptyPage, false); assert.equal(last.emptyEnd, true);
  const invalid = booklistResponseInfo(JSON.stringify({ ...body, pagination: { current: 28, next: 27, total_pages: 32 } }));
  assert.equal(invalid.emptyPage, false); assert.equal(invalid.emptyEnd, false);
  assert.ok(booklistResponseInfo(JSON.stringify({ ...body, success: 0 })).error);
});

test('booklist: API continuation uses a strictly advancing page and filters headers', () => {
  const cursor = booklistApiCursor('https://fixture.example/papi/booklist/1/get-books/28?limit=20', { method: 'GET', headers: { accept: 'application/json', cookie: 'private' } }, 28, 29);
  assert.equal(cursor.url, 'https://fixture.example/papi/booklist/1/get-books/29?limit=20');
  assert.deepEqual(cursor.headers, { accept: 'application/json' });
  for (const [current, next] of [[28, 28], [27, 29], [28, 27]]) assert.throws(() => booklistApiCursor('https://fixture.example/papi/booklist/1/get-books/28', { method: 'GET' }, current, next));
});

test('booklist: API records preserve metadata or original HTML and reject unknown books', () => {
  const parsed = booklistApiRecords(JSON.stringify({ books: [{ id: 2, hash: 'hash', title: 'Book 2', author: 'Author', year: 2020, extension: 'pdf', filesize: '2 MB' }, '<z-bookcard></z-bookcard>'] }), 'https://fixture.example/booklist/1/hash/test.html');
  assert.equal(parsed.books[0].url, 'https://fixture.example/book/2/hash');
  assert.equal(parsed.books[0].format, 'PDF'); assert.equal(parsed.books[0].year, '2020');
  assert.equal(parsed.expected, 2); assert.match(parsed.html, /z-bookcard/);
  assert.throws(() => booklistApiRecords('{"books":[{"title":"Unknown"}]}', 'https://fixture.example'), /无法识别/);
  assert.throws(() => booklistApiRecords('{"books":[{"title":"External","url":"https://other.example/book/1/hash"}]}', 'https://fixture.example'), /无法识别/);
});
