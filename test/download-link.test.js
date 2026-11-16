import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadCandidates } from '../src/download-link.js';
const base = 'https://zh.z-library.sk/book/123/hash';

test('excludes the first dlButton when it is the online reader', () => {
  const reader = { href: 'https://reader.z-library.sk/read/hash?download_location=https://zh.z-library.sk/dl/123', label: '线上阅读', className: 'btn btn-primary dlButton reader-link' };
  const file = { href: '/dl/123', label: 'pdf, 4.87 MB', className: 'btn btn-default dlButton addDownloadedBook' };
  assert.deepEqual(downloadCandidates([reader, file], base), [file]);
});
test('does not confuse download URLs in query strings with file endpoints', () => {
  assert.deepEqual(downloadCandidates([{ href: '/read/1?next=/download/file' }, { href: '/access-info?next=/dl/file', label: '下载访问文件' }], base), []);
});
test('accepts same-site relative and absolute download links, prioritizing the dedicated control', () => {
  const fallback = { href: 'https://zh.z-library.sk/download/file' };
  const main = { href: '/dl/123', className: 'addDownloadedBook' };
  assert.deepEqual(downloadCandidates([fallback, main], base), [main, fallback]);
});
test('excludes disabled, external, reader-labelled and non-HTTP controls', () => {
  assert.deepEqual(downloadCandidates([
    { href: '/dl/file', disabled: true },
    { href: 'https://other.example/dl/file' },
    { href: '/dl/file', label: 'Read online' },
    { href: 'javascript:download()' },
    { href: '/dl/file', className: 'reader-link addDownloadedBook' }
  ], base), []);
});
