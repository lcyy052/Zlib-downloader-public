import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBooklistUrl, summarizeJobs } from '../src/booklist.js';

test('booklist import accepts only same-site booklists and strips search filters', () => {
  const base = 'https://zh.z-library.sk';
  assert.equal(validateBooklistUrl(`${base}/booklist/3803973/ddd1f7/ai8.html?search=foo#top`, base), `${base}/booklist/3803973/ddd1f7/ai8.html`);
  for (const value of ['https://other.example/booklist/1/x/test', `${base}/s/books`, `${base}/book/1/hash`]) assert.throws(() => validateBooklistUrl(value, base));
});
test('processed progress counts failures separately from successful downloads', () => {
  const summary = summarizeJobs([{ status: 'completed' }, { status: 'failed' }, { status: 'running' }, { status: 'queued' }]);
  assert.equal(summary.percent, 50); assert.equal(summary.completed, 1); assert.equal(summary.failed, 1); assert.equal(summary.finished, 2);
});
