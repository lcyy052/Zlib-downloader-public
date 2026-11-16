// Read-only real-site diagnosis. Stop the local service before using its profile.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LibraryProvider } from '../src/provider.js';

if (await fetch('http://127.0.0.1:3210/api/state', { signal: AbortSignal.timeout(1000) }).catch(() => null)) throw new Error('Stop the local service first');
const dataDir = path.resolve('.data/live');
const settings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
const previous = JSON.parse(await readFile(path.join(dataDir, 'website-booklist.json'), 'utf8'));
const provider = new LibraryProvider({ getSettings: () => settings, dataDir, demo: false });
const started = Date.now(), responses = [];
const log = detail => console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), ...detail }));
function shape(value, depth = 0) {
  if (typeof value === 'string') return { length: value.length, cards: (value.match(/<z-bookcard\b/g) || []).length };
  if (Array.isArray(value)) return { items: value.length };
  if (value && typeof value === 'object') return depth < 2 ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)])) : { keys: Object.keys(value) };
  return value;
}
try {
  const context = await provider.browser();
  context.on('response', response => {
    if (!new URL(response.url()).pathname.startsWith('/papi/booklist/')) return;
    void response.json().then(body => { responses.push({ status: response.status(), shape: shape(body) }); if (responses.length > 3) responses.shift(); }).catch(() => {});
  });
  const operationPage = provider.operationPage.bind(provider);
  provider.operationPage = async (...args) => {
    const page = await operationPage(...args), wait = page.waitForFunction.bind(page);
    page.waitForFunction = async (...waitArgs) => {
      try { return await wait(...waitArgs); }
      catch (error) {
        const dom = await page.evaluate(() => {
          const more = document.querySelector('.booklist-main .page-load-more'), ancestors = [];
          for (let node = more, i = 0; node && i < 5; node = node.parentElement, i++) {
            const style = getComputedStyle(node), rect = node.getBoundingClientRect();
            ancestors.push({ class: node.className, display: style.display, visibility: style.visibility, hidden: node.hidden, width: rect.width, height: rect.height });
          }
          return { cards: document.querySelectorAll('.readlist-view z-bookcard').length, more: Boolean(more), ancestors };
        }).catch(() => null);
        log({ waitError: error.message, dom, lastResponses: responses });
        throw error;
      }
    };
    return page;
  };
  let lastCount = -1;
  const result = await provider.importBooklist(process.argv[2] || previous.url, { signal: new AbortController().signal, onProgress: update => {
    if (update.books.length !== lastCount || update.message) { lastCount = update.books.length; log({ count: lastCount, pages: update.pages, message: update.message }); }
  } });
  log({ result: 'COMPLETE', title: result.title, count: result.books.length, unique: new Set(result.books.map(book => book.url)).size, pages: result.pages, lastResponses: responses });
} finally { await provider.close(); }
