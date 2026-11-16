// Controlled live verification: run only explicitly named existing jobs while
// the local service is stopped. Uses the production queue, profile and paths.
import { readFile, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { LibraryProvider } from '../src/provider.js';
import { DownloadQueue } from '../src/queue.js';
import { downloadHttp } from '../src/http-download.js';
import { configureDownloadProxy } from '../src/download-proxy.js';

const ids = process.argv.slice(2);
if (!ids.length || ids.length > 3) throw new Error('Provide 1–3 existing job IDs');
const state = await fetch('http://127.0.0.1:3210/api/state', { signal: AbortSignal.timeout(1000) }).catch(() => null);
if (state) throw new Error('Stop the local service before running live verification');
console.log('DOWNLOAD_NETWORK', JSON.stringify(await configureDownloadProxy()));
const dataDir = path.resolve('.data/live');
const settings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
const provider = new LibraryProvider({ getSettings: () => settings, dataDir, demo: false });
if (process.env.VERIFY_CHROME_FALLBACK === '1') {
  // Diagnostic injection only; no persistent setting or production preference.
  provider.transferHttp = async () => { throw Object.assign(new Error('Diagnostic direct-connect failure'), { code: 'ECONNREFUSED' }); };
}
const started = Date.now();
const log = detail => console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), ...detail }));
if (process.env.VERIFY_HTTP_DIAGNOSTICS === '1' && process.env.VERIFY_CHROME_FALLBACK !== '1') {
  provider.transferHttp = options => downloadHttp({ ...options, fetchImpl: async (...args) => {
    const response = await fetch(...args);
    // Never log signed URLs, cookies or authentication headers.
    log({ httpStatus: response.status, host: new URL(response.url).hostname, server: response.headers.get('server'), cfRay: response.headers.get('cf-ray') });
    return response;
  } });
}
const queue = new DownloadQueue({ file: path.join(dataDir, 'queue.json'), directory: settings.downloadDirectory, provider, onChange: changed });
const reports = new Map();
function changed() {
  for (const job of queue.jobs.filter(job => ids.includes(job.id))) {
    const last = reports.get(job.id);
    const now = Date.now();
    if (!last || last.message !== job.message || (job.status === 'running' && now - last.time > 5000)) {
      log({ title: job.book.title, size: job.book.size, status: job.status, attempts: job.attempts, message: job.message, ...job.progress });
      reports.set(job.id, { time: now, message: job.message });
    }
  }
}
try {
  await queue.init();
  const jobs = ids.map(id => {
    const job = queue.jobs.find(job => job.id === id);
    if (!job || !['failed', 'queued', 'completed'].includes(job.status)) throw new Error(`Job unavailable: ${id}`);
    return job;
  });
  if (process.env.VERIFY_HTTP_DIAGNOSTICS === '1') {
    const context = await provider.browser();
    context.on('response', response => {
      if (response.status() >= 500 && response.request().isNavigationRequest()) {
        const headers = response.headers();
        log({ navigationStatus: response.status(), host: new URL(response.url()).hostname, server: headers.server, cfRay: headers['cf-ray'] });
      }
    });
  }
  await Promise.all(jobs.map(job => queue.run(job)));
  for (const job of jobs) {
    if (job.status !== 'completed') { log({ title: job.book.title, result: 'FAIL', message: job.message }); process.exitCode = 1; continue; }
    const file = queue.filePath(job);
    const handle = await open(file, 'r');
    const signature = Buffer.alloc(5);
    const bytes = (await stat(file)).size;
    try {
      await handle.read(signature, 0, 5, 0);
      if (String(job.book.format).toLowerCase() === 'epub') {
        const tail = Buffer.alloc(Math.min(65557, bytes));
        await handle.read(tail, 0, tail.length, bytes - tail.length);
        if (!signature.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) || !tail.includes(Buffer.from([0x50, 0x4b, 5, 6]))) throw new Error(`Invalid EPUB ZIP: ${job.book.title}`);
      }
    } finally { await handle.close(); }
    if (String(job.book.format).toLowerCase() === 'pdf' && signature.toString() !== '%PDF-') throw new Error(`Invalid PDF: ${job.book.title}`);
    log({ title: job.book.title, result: 'PASS', bytes, signature: signature.toString(), file });
  }
} finally { await queue.close(); await provider.close(); }
