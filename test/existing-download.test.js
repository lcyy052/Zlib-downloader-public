import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { declaredBytes, findExistingDownload } from '../src/existing-download.js';
import { bookFilename } from '../src/download-name.js';
import { LibraryProvider } from '../src/provider.js';

const book = { title: 'Fixture Book', author: 'Test Author', year: '2020', format: 'EPUB', size: '1 MB' };

test('bookFilename uses title(author)-year and omits missing metadata cleanly', () => {
  assert.equal(bookFilename(book), 'Fixture Book(Test Author)-2020.epub');
  assert.equal(bookFilename({ title: '红楼梦', author: '曹雪芹', format: 'PDF' }), '红楼梦(曹雪芹).pdf');
  assert.equal(bookFilename({ title: '红楼梦', year: '1791', format: 'PDF' }), '红楼梦-1791.pdf');
  assert.equal(bookFilename({ title: '红楼梦', format: 'PDF' }), '红楼梦.pdf');
});

test('declaredBytes parses common website sizes', () => {
  assert.equal(declaredBytes('4.28 MB'), Math.round(4.28 * 1024 ** 2));
  assert.equal(declaredBytes('1,024 KB'), 1024 * 1024);
  assert.equal(declaredBytes(''), 0);
});

test('findExistingDownload reuses a valid current canonical or numbered file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-existing-'));
  try {
    const payload = Buffer.alloc(1024 * 1024); payload.set([0x50, 0x4b, 0x03, 0x04]);
    await writeFile(path.join(directory, 'Fixture Book(Test Author)-2020 (2).epub'), payload);
    assert.deepEqual(await findExistingDownload(directory, book), { filename: 'Fixture Book(Test Author)-2020 (2).epub', bytes: payload.length, reused: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('findExistingDownload rejects a wrong signature or implausible size', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-existing-'));
  try {
    await writeFile(path.join(directory, 'Fixture Book(Test Author)-2020.epub'), Buffer.alloc(1024 * 1024));
    await writeFile(path.join(directory, 'Fixture Book(Test Author)-2020 (2).epub'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    assert.equal(await findExistingDownload(directory, book), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('provider skips the website and browser when a verified file already exists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-existing-'));
  try {
    const payload = Buffer.alloc(1024 * 1024); payload.set([0x50, 0x4b, 0x03, 0x04]);
    await writeFile(path.join(directory, 'Fixture Book - Test Author.epub'), payload);
    const provider = new LibraryProvider({
      getSettings: () => { throw new Error('website should not be opened'); },
      dataDir: directory,
      demo: false,
      headless: true,
    });
    const updates = [];
    const result = await provider.download(book, directory, new AbortController().signal, update => updates.push(update));
    assert.deepEqual(result, { filename: 'Fixture Book - Test Author.epub', bytes: payload.length, reused: true });
    assert.equal(provider.context, null);
    assert.equal(updates.at(-1).message, '文件已存在，已跳过下载');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
