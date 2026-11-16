import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryProvider } from '../src/provider.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'zlib-pagination-test-'));
const provider = new LibraryProvider({ getSettings: () => ({ site: 'https://fixture.example', browser: 'chrome' }), dataDir: dir, demo: false, headless: true });
provider.booklistRetryDelays = [0, 0];
provider.booklistPageTimeoutMs = 400;
const attempts = new Map();
const requestedPages = new Map();
const card = id => `<z-bookcard href="/book/${id}/hash" extension="pdf"><div slot="title">Book ${id}</div><div slot="author">Author</div></z-bookcard>`;
const results = [];
try {
  const context = await provider.browser();
  await context.route('https://fixture.example/**', async route => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/')[url.pathname.startsWith('/papi/') ? 3 : 2];
    if (url.pathname.startsWith('/booklist/')) {
      const script = `fetch('/papi/booklist/${id}/get-books/'+(this.dataset.page||2)).then(async r=>{
        const body=await r.text();
        if(['108','110','111'].includes('${id}')){
          const data=JSON.parse(body);
          if(data.books.length){document.querySelector('.readlist-view').insertAdjacentHTML('beforeend',data.books.join(''));this.dataset.page=data.pagination.next;}
          return;
        }
        if('${id}'==='107'){
          const current=Number(this.dataset.page||2);this.dataset.page=current+1;
          document.querySelector('.readlist-view').insertAdjacentHTML('beforeend',body);
          if(current===27)this.parentElement.style.display='none';
          return;
        }
        if('${id}'==='103')return;
        if('${id}'==='104' && body==='stalled')return;
        if('${id}'==='105')return;
        this.parentElement.style.display='none';
        if('${id}'==='102'){setTimeout(()=>document.querySelector('.readlist-view').insertAdjacentHTML('beforeend',body),180);return;}
        document.querySelector('.readlist-view').insertAdjacentHTML('beforeend',body);
      })`;
      const initial = ['107','111'].includes(id) ? Array.from({ length: 20 }, (_, i) => card(i + 1)).join('') : card(1);
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<title>Pagination ${id}</title><div class="booklist-header__title-value">Pagination ${id}</div><div class="booklist-main"><div class="readlist-view">${initial}</div><div><button class="page-load-more" onclick="${script}">More</button></div></div>` });
    }
    if (url.pathname.startsWith('/papi/')) {
      const attempt = (attempts.get(id) || 0) + 1; attempts.set(id, attempt);
      const batch = Number(url.pathname.split('/').at(-1));
      requestedPages.set(id, [...(requestedPages.get(id) || []), batch]);
      if (['108','110','111'].includes(id)) {
        const current = id === '110' ? 2 : batch;
        const total = id === '111' ? 32 : 4;
        const books = id === '111' ? batch >= 28 ? [] : Array.from({ length: batch === 27 ? 19 : 20 }, (_, i) => card((batch - 1) * 20 + i + 1)) : batch === 2 ? [] : batch === 3 ? [card(2)] : [{ id: 3, hash: 'hash', title: 'Book 3', author: 'Author', extension: 'pdf' }];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: 1, books, pagination: { current, next: current === total ? null : current + 1, total_items: id === '111' ? 626 : 3, total_pages: total } }) });
      }
      const body = id === '107' ? Array.from({ length: batch === 27 ? 19 : 20 }, (_, i) => card((batch - 1) * 20 + i + 1)).join('') : id === '101' ? '' : id === '103' ? '{"success":true,"data":{"books":[],"hasMore":false}}' : id === '104' && attempt === 1 ? 'stalled' : card(2);
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    }
    return route.fulfill({ status: 404 });
  });
  async function read(id, options = {}) {
    const updates = [];
    const result = await provider.importBooklist(`https://fixture.example/booklist/${id}/hash/test.html`, { signal: options.signal || new AbortController().signal, onProgress: update => { updates.push(update); options.onProgress?.(update); } });
    return { result, updates };
  }
  // Empty last page hides only the parent, not the button itself.
  const hidden = await read('101');
  assert.equal(hidden.result.books.length, 1); assert.equal(attempts.get('101'), 1);
  results.push('parent-hidden EOF');
  // Button hides before a delayed DOM update: do not lose the final card.
  const delayed = await read('102');
  assert.deepEqual(delayed.result.books.map(book => book.title), ['Book 1', 'Book 2']);
  results.push('delayed final card retained');
  const empty = await read('103');
  assert.equal(empty.result.books.length, 1); assert.equal(attempts.get('103'), 1);
  results.push('explicit empty EOF');
  // HTTP 200 but no DOM change is transient, reload and keep already-read cards.
  const recovered = await read('104');
  assert.equal(attempts.get('104'), 2);
  assert.deepEqual(recovered.result.books.map(book => book.title), ['Book 1', 'Book 2']);
  assert.ok(recovered.updates.some(update => /分页页面更新超时.*重新载入并续读/.test(update.message)));
  results.push('stalled 200 recovered without duplicates');
  const partial = [];
  await assert.rejects(provider.importBooklist('https://fixture.example/booklist/105/hash/test.html', { signal: new AbortController().signal, onProgress: update => partial.push(update) }), /书籍内容未正常更新，已保留读取结果/);
  assert.equal(attempts.get('105'), 3);
  assert.ok(partial.every(update => update.books.length === 1));
  results.push('persistent stall bounded and partial retained');
  const long = await read('107');
  assert.equal(long.result.books.length, 539);
  assert.equal(long.result.pages, 27);
  assert.equal(new Set(long.result.books.map(book => book.id)).size, 539);
  assert.equal(attempts.get('107'), 26);
  results.push('539 books across 27 batches complete without duplicates');
  const afterEmpty = await read('108');
  assert.deepEqual(afterEmpty.result.books.map(book => book.title), ['Book 1', 'Book 2', 'Book 3']);
  assert.deepEqual(requestedPages.get('108'), [2, 3, 4]);
  assert.equal(afterEmpty.result.pages, 4); assert.equal(afterEmpty.result.warning, '');
  results.push('empty intermediate page followed by HTML and metadata books');
  const realShape = await read('111');
  assert.equal(realShape.result.books.length, 539); assert.equal(realShape.result.pages, 32);
  assert.equal(realShape.result.sourceTotal, 626); assert.match(realShape.result.warning, /626.*539/);
  assert.deepEqual(requestedPages.get('111'), Array.from({ length: 31 }, (_, i) => i + 2));
  results.push('real 539/626 shape: pages 28-32 empty, all pages visited and discrepancy disclosed');
  await assert.rejects(read('110'), /未推进到指定页/);
  results.push('repeated API page rejected instead of false completion');
  const controller = new AbortController();
  await assert.rejects(read('106', { signal: controller.signal, onProgress: () => setTimeout(() => controller.abort(), 20) }), /已停止读取书单/);
  assert.equal(provider.active, 0);
  results.push('cancel cleans up operation');
  console.log(JSON.stringify({ result: 'PASS', cases: results }));
} finally {
  await provider.close();
  const target = path.resolve(dir);
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('zlib-pagination-test-'));
  await rm(target, { recursive: true, force: true });
}
