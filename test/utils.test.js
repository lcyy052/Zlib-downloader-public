import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { browserMode, downloadConcurrency, downloadDirectoryPath, parseBooklist, filtersFrom, buildSearchUrl, safeFilename, siteUrl, validateBook } from '../src/utils.js';

test('TXT handles BOM, CRLF, empty lines, and duplicate titles', () => {
  const books = parseBooklist('\uFEFF红楼梦\r\n\r\n西游记\r\n红楼梦');
  assert.deepEqual(books.map(b => b.title), ['红楼梦', '西游记']);
});
test('CSV handles quotes, multiline fields, author, and ISBN', () => {
  const [book] = parseBooklist('书名,作者,ISBN\n"A, \"\"Book\"\"\nTitle",Author,978-1-234567-89-0');
  assert.equal(book.title, 'A, "Book"\nTitle');
  assert.equal(book.author, 'Author');
  assert.equal(book.query, '9781234567890');
  assert.equal(parseBooklist('ISBN\n9781234567890')[0].title, '');
});
test('rejects malformed/oversized/empty booklists', () => {
  assert.throws(() => parseBooklist('title\n"unfinished'), /引号/);
  assert.throws(() => parseBooklist('书名,作者,ISBN'), /没有有效/);
  assert.throws(() => parseBooklist(Array.from({ length: 201 }, (_, i) => `Book${i}`).join('\n')), /200/);
});
test('formats and year ranges are validated and encoded as separate query parameters', () => {
  const filters = filtersFrom({ format: 'epub', yearFrom: '2000', yearTo: '2025', language: 'chinese' });
  const url = new URL(buildSearchUrl('https://zh.z-library.sk', 'a/b & 中文', filters, 2));
  assert.equal(url.pathname, '/s/a%2Fb%20%26%20%E4%B8%AD%E6%96%87');
  assert.equal(url.searchParams.get('extensions[]'), 'epub');
  assert.equal(url.searchParams.get('languages[]'), 'chinese');
  assert.equal(url.searchParams.get('page'), '2');
  assert.throws(() => filtersFrom({ yearFrom: '2025', yearTo: '2000' }), /不能大于/);
  assert.throws(() => filtersFrom({ format: 'exe' }), /格式/);
});
test('filenames cannot escape the download directory or use reserved Windows names', () => {
  assert.equal(safeFilename('../bad\\name:book.pdf'), '.._bad_name_book.pdf');
  assert.equal(safeFilename('CON.txt'), 'book_CON.txt');
  assert.equal(safeFilename('a.pdf. '), 'a.pdf');
});
test('download directory must be an absolute local path', () => {
  const absolute = path.resolve('downloads', 'custom');
  assert.equal(downloadDirectoryPath(`  ${absolute}  `), path.normalize(absolute));
  assert.throws(() => downloadDirectoryPath('downloads/custom'), /绝对路径/);
  assert.throws(() => downloadDirectoryPath(''), /绝对路径/);
});
test('download concurrency is limited to a conservative range', () => {
  assert.equal(downloadConcurrency(undefined), 2);
  assert.equal(downloadConcurrency('1'), 1);
  assert.equal(downloadConcurrency(3), 3);
  for (const value of [0, 4, 1.5, 'many']) assert.throws(() => downloadConcurrency(value), /1–3/);
});
test('browser mode defaults to background and only accepts known modes', () => {
  assert.equal(browserMode(), 'background');
  assert.equal(browserMode('visible'), 'visible');
  assert.throws(() => browserMode('headless'), /后台静默/);
});
test('only current-site book URLs and HTTPS public roots are accepted', () => {
  assert.equal(siteUrl('https://zh.z-library.sk/'), 'https://zh.z-library.sk');
  const sampleAuthUrl = new URL('https://example.com/'); sampleAuthUrl.username = 'user'; sampleAuthUrl.password = 'pass';
  for (const url of ['http://example.com/', 'https://127.0.0.1/', 'https://example.com/path', sampleAuthUrl.href]) assert.throws(() => siteUrl(url));
  const book = { title: 'Book', url: 'https://zh.z-library.sk/book/123/hash' };
  assert.equal(validateBook(book, 'https://zh.z-library.sk').id, '/book/123/hash');
  assert.throws(() => validateBook({ ...book, url: 'https://evil.example/book/123/hash' }, 'https://zh.z-library.sk'));
});
