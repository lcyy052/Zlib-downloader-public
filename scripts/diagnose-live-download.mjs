import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LibraryProvider } from '../src/provider.js';

const dataDir = path.resolve('.data/live');
const settings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '{"site":"https://zh.z-library.sk","browser":"chrome"}'; }));
if (process.env.DIAG_BROWSER) settings.browser = process.env.DIAG_BROWSER;
const list = JSON.parse(await readFile('test-results/live-booklist-test-source.json', 'utf8'));
const provider = new LibraryProvider({ getSettings: () => settings, dataDir, demo: false });
const start = Date.now();
const log = (event, detail) => console.log(JSON.stringify({ seconds: (Date.now() - start) / 1000, event, detail }));
try {
  const context = await provider.browser();
  const browser = context.browser();
  const watched = new WeakSet();
  const pageInfo = page => ({
    host: (() => { try { return new URL(page.url()).host; } catch { return ''; } })(),
    path: (() => { try { return new URL(page.url()).pathname; } catch { return ''; } })(),
    pages: context.pages().length,
  });
  const watchPage = page => {
    if (watched.has(page)) return;
    watched.add(page);
    log('page attached', pageInfo(page));
    page.on('close', () => log('page closed', pageInfo(page)));
    page.on('crash', () => log('page crashed', pageInfo(page)));
    page.on('download', download => {
      log('download event', { filename: download.suggestedFilename() });
      download.failure().then(failure => log('browser failure', failure)).catch(error => log('failure query error', error.message));
    });
  };
  log('context opened', { pages: context.pages().length, browserConnected: browser?.isConnected() ?? null });
  context.on('close', () => log('context closed', { pages: context.pages().length, browserConnected: browser?.isConnected() ?? null }));
  browser?.on('disconnected', () => log('browser disconnected', { pages: context.pages().length }));
  context.pages().forEach(watchPage);
  context.on('page', watchPage);
  context.on('response', response => {
    if (response.request().isNavigationRequest()) log('navigation response', { host: new URL(response.url()).host, status: response.status(), contentType: response.headers()['content-type'] });
  });
  const book = list.books[Number(process.argv[2] || 0)];
  log('book', { title: book.title, format: book.format });
  const result = await provider.download(book, path.resolve('downloads/books'), new AbortController().signal, update => log('progress', update));
  log('saved', result);
} catch (error) { log('error', error.message); process.exitCode = 1; }
finally { log('closing diagnostic browser'); await provider.close(); }
