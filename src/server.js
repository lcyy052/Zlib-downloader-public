import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { LibraryProvider } from './provider.js';
import { DownloadQueue } from './queue.js';
import { atomicJson, browserMode, downloadConcurrency, downloadDirectoryPath, parseBooklist, filtersFrom, siteUrl, validateBook } from './utils.js';
import { APP_ID, startLocalServer, openBrowser } from './startup.js';
import { browserPreference } from './browser-config.js';
import { validateBooklistUrl } from './booklist.js';
import { randomUUID } from 'node:crypto';
import { configureDownloadProxy } from './download-proxy.js';
import { startRuntimeDiagnostics } from './runtime-diagnostics.js';
import { QuotaRecovery, quotaRecoverySettings } from './quota-recovery.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv.includes('--demo');
const dataDir = path.join(root, '.data', demo ? 'demo' : 'live');
const defaultDirectory = path.join(root, 'downloads', demo ? 'demo' : 'books');
await mkdir(dataDir, { recursive: true });
const diagnostics = startRuntimeDiagnostics({ directory: path.join(dataDir, 'logs'), getStatus: () => ({ paused: queue.paused, busy: queue.busy, running: queue.controllers.size, jobs: queue.jobs.length }) });
const configFile = path.join(dataDir, 'settings.json');
async function prepareDownloadDirectory(value) {
  const target = downloadDirectoryPath(value);
  const probe = path.join(target, `.zlibrary-write-test-${randomUUID()}.tmp`);
  try {
    await mkdir(target, { recursive: true });
    await writeFile(probe, '', { flag: 'wx' });
  } catch (error) {
    throw new Error(`无法使用下载目录 ${target}：${error.message}`);
  } finally { await unlink(probe).catch(() => {}); }
  return target;
}
let settings = { site: 'https://zh.z-library.sk', browser: 'chrome', browserMode: 'background', downloadDirectory: defaultDirectory, downloadConcurrency: 2, ...quotaRecoverySettings() };
try {
  const saved = JSON.parse(await readFile(configFile, 'utf8'));
  settings = { site: siteUrl(saved.site), browser: browserPreference(saved.browser), browserMode: browserMode(saved.browserMode), downloadDirectory: downloadDirectoryPath(saved.downloadDirectory || defaultDirectory), downloadConcurrency: downloadConcurrency(saved.downloadConcurrency), ...quotaRecoverySettings(saved) };
} catch (e) { if (e.code !== 'ENOENT') throw e; }
let directory = await prepareDownloadDirectory(settings.downloadDirectory);
const downloadNetwork = demo ? { active: false, source: 'demo', message: '演示模式无需外部下载网络。' } : await configureDownloadProxy();
const provider = new LibraryProvider({ getSettings: () => settings, dataDir, demo });
const clients = new Set(); let queueEventTimer;
function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) { if (client.writableLength > 2 * 1024 * 1024) { client.destroy(); clients.delete(client); } else client.write(message); }
}
function queueChanged() {
  if (queueEventTimer) return;
  queueEventTimer = setTimeout(() => { queueEventTimer = null; broadcast('queue', queue.snapshot()); }, 150);
  queueEventTimer.unref();
}
const queue = new DownloadQueue({ file: path.join(dataDir, 'queue.json'), provider, directory, concurrency: settings.downloadConcurrency, delayMs: demo ? 150 : 2500, onChange: queueChanged });
await queue.init();
const quotaRecovery = new QuotaRecovery({ queue, provider, getSettings: () => settings, onChange: queueChanged });
let matching = null;
const websiteBooklistFile = path.join(dataDir, 'website-booklist.json');
let websiteBooklist = null, importController = null, importTask = null;
try { websiteBooklist = JSON.parse(await readFile(websiteBooklistFile, 'utf8')); websiteBooklist.running = false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
let port = Number(process.env.PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535');
let origin = `http://127.0.0.1:${port}`;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须使用 JSON');
  let chunks = [], length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 1024 * 1024) throw new Error('请求内容不能超过 1 MB'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('JSON 格式错误'); }
}
async function runMatching(job) {
  try {
    for (const entry of job.entries) {
      if (job.cancelled) break;
      entry.status = 'searching';
      try {
        const result = await provider.search(entry.query, job.filters);
        entry.candidates = result.books.slice(0, 8);
        entry.status = entry.candidates.length ? 'matched' : 'missing';
      } catch (e) { entry.status = 'failed'; entry.error = e.message; job.error = e.message; break; }
      job.done++;
      if (!demo && !job.cancelled) await new Promise(r => setTimeout(r, 1500));
    }
  } finally { job.running = false; }
}

async function importWebsiteBooklist(job, controller) {
  try {
    const result = await provider.importBooklist(job.url, { signal: controller.signal, onProgress: update => {
      Object.assign(job, update, { message: update.message || `已读取 ${update.books.length} 本，正在加载后续书籍…` });
      broadcast('booklist', job);
    } });
    Object.assign(job, result, { complete: true, message: `书单读取完成，共 ${result.books.length} 本` });
  } catch (error) { job.error = error.message; job.message = error.message; }
  finally {
    job.running = false;
    try { await atomicJson(websiteBooklistFile, job); } catch (error) { job.error = `保存书单失败：${error.message}`; }
    broadcast('booklist', job);
    if (importController === controller) importController = null;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    // Loopback binding + Host/Origin/JSON checks prevent external websites from controlling this local service.
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(res, 403, { error: '不允许的 Host' });
    if (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: '禁止跨站请求' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '禁止跨站请求' });
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { app: APP_ID, demo, directory, workspace: root, pid: process.pid });
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { demo, settings, directory, downloadNetwork, browserSession: provider.sessionStatus(), queue: queue.snapshot(), matching, websiteBooklist });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`event: queue\ndata: ${JSON.stringify(queue.snapshot())}\n\n`);
      if (websiteBooklist) res.write(`event: booklist\ndata: ${JSON.stringify(websiteBooklist)}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
      heartbeat.unref();
      res.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-local-client'] !== '1') return json(res, 403, { error: '缺少本地客户端标识' });
      const input = await body(req);
      switch (url.pathname) {
        case '/api/search': {
          const query = String(input.query || '').trim();
          if (!query || query.length > 300) throw new Error('请输入 1–300 字的书名、作者或 ISBN');
          if (matching?.running) throw new Error('书单正在匹配，请完成或停止匹配后搜索');
          const page = Number(input.page || 1);
          if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('页码无效');
          return json(res, 200, await provider.search(query, filtersFrom(input.filters), page));
        }
        case '/api/login': return json(res, 200, await provider.login());
        case '/api/browser/check': return json(res, 200, await provider.inspectSession());
        case '/api/quota/check': {
          if (provider.active || provider.launching) throw new Error('浏览器正在处理任务，请稍后检查额度');
          return json(res, 200, await provider.checkDownloadQuota());
        }
        case '/api/quota-recovery': {
          const updated = { ...settings, ...quotaRecoverySettings(input) };
          await atomicJson(configFile, updated);
          settings = updated; quotaRecovery.configure();
          return json(res, 200, { settings, quotaRecovery: quotaRecovery.snapshot() });
        }
        case '/api/quota-recovery/wait': {
          if (!queue.paused || queue.busy || provider.active || provider.launching) throw new Error('请先暂停下载并等待当前操作结束');
          const version = queue.controlVersion;
          const options = quotaRecoverySettings({ quotaAutoResume: true, quotaCheckMinutes: input.quotaCheckMinutes ?? settings.quotaCheckMinutes });
          const result = await provider.checkDownloadQuota();
          if (result.available || !result.quota) throw new Error(result.available ? '网站额度已可用，请确认后直接继续下载' : result.message || '未读到明确额度，保持暂停');
          await queue.waitForQuotaRecovery(result.quota, version);
          const updated = { ...settings, ...options };
          await atomicJson(configFile, updated); settings = updated; quotaRecovery.configure();
          return json(res, 200, { settings, queue: queue.snapshot() });
        }
        case '/api/settings': {
          if (queue.busy || provider.active || matching?.running || websiteBooklist?.running || provider.launching) throw new Error('请等待当前搜索、书单读取或下载结束后修改设置');
          if (queue.jobs.some(j => j.status === 'queued')) throw new Error('请先完成或取消待下载任务，再修改设置');
          const site = siteUrl(input.site);
          const browser = browserPreference(input.browser ?? settings.browser);
          const mode = browserMode(input.browserMode ?? settings.browserMode);
          const concurrency = downloadConcurrency(input.downloadConcurrency ?? settings.downloadConcurrency);
          const downloadDirectory = await prepareDownloadDirectory(input.downloadDirectory ?? settings.downloadDirectory);
          await provider.close();
          const updated = { ...settings, site, browser, browserMode: mode, downloadDirectory, downloadConcurrency: concurrency };
          await atomicJson(configFile, updated);
          settings = updated; directory = downloadDirectory; queue.setDirectory(directory); queue.setConcurrency(concurrency);
          quotaRecovery.configure();
          return json(res, 200, { settings });
        }
        case '/api/queue/add': {
          if (!Array.isArray(input.books) || !input.books.length || input.books.length > 200) throw new Error('每次请选择 1–200 本书');
          return json(res, 200, await queue.add(input.books.map(b => validateBook(b, settings.site))));
        }
        case '/api/queue/action': {
          if (!['pause', 'resume', 'clear', 'clear-selected', 'cancel', 'retry', 'batch-pause', 'batch-resume', 'batch-cancel', 'batch-delete', 'batch-delete-selected'].includes(input.action)) throw new Error('无效的队列操作');
          await queue.action(input.action, input.id, input.ids); return json(res, 200, queue.snapshot());
        }
        case '/api/shutdown': {
          json(res, 200, { message: '程序已安全退出。任务记录和下载进度已经保存，需要使用时请重新运行 start.bat。' });
          const timer = setTimeout(() => requestShutdown('api'), 100);
          timer.unref?.();
          return;
        }
        case '/api/booklist/parse': return json(res, 200, { entries: parseBooklist(input.text || '') });
        case '/api/booklist/import': {
          if (websiteBooklist?.running) throw new Error('已有网站书单正在读取');
          const url = validateBooklistUrl(input.url, settings.site);
          const job = { id: randomUUID(), url, title: '正在读取网站书单', running: true, complete: false, books: [], pages: 0, message: '正在打开书单页面…', createdAt: new Date().toISOString() };
          websiteBooklist = job;
          importController = new AbortController();
          importTask = importWebsiteBooklist(job, importController).catch(error => { job.running = false; job.error = error.message; broadcast('booklist', job); });
          return json(res, 200, job);
        }
        case '/api/booklist/import-stop': importController?.abort(); return json(res, 200, { message: '正在停止书单读取，已读取的书籍会保留' });
        case '/api/booklist/download': {
          if (!websiteBooklist || websiteBooklist.running) throw new Error('请先读取书单，或停止读取后再下载');
          if (input.booklistId !== websiteBooklist.id) throw new Error('书单已更新，请刷新页面后重试');
          const ids = input.ids;
          if (!Array.isArray(ids) || !ids.length || ids.length > 5000) throw new Error('请选择要下载的书籍');
          const selected = new Set(ids);
          const books = websiteBooklist.books.filter(book => selected.has(book.id)).map(book => validateBook(book, settings.site));
          if (!books.length || books.length !== selected.size) throw new Error('部分书籍不属于当前书单，请重新选择');
          const result = await queue.add(books, { source: { id: websiteBooklist.id, title: websiteBooklist.title, url: websiteBooklist.url, createdAt: websiteBooklist.createdAt } });
          return json(res, 200, result);
        }
        case '/api/booklist/match': {
          if (matching?.running) throw new Error('已有书单正在匹配');
          const entries = parseBooklist(input.text || '').map(e => ({ ...e, status: 'pending', candidates: [] }));
          matching = { id: Date.now().toString(), running: true, cancelled: false, done: 0, filters: filtersFrom(input.filters), entries };
          runMatching(matching).catch(e => { matching.error = e.message; matching.running = false; });
          return json(res, 200, matching);
        }
        case '/api/booklist/stop': if (matching) matching.cancelled = true; return json(res, 200, { message: '当前搜索结束后停止匹配' });
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/files/'.length));
      const job = queue.jobs.find(j => j.id === id && j.status === 'completed');
      const file = queue.filePath(job);
      if (!file) return json(res, 404, { error: '文件不存在' });
      const info = await stat(file);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.filename)}` });
      await pipeline(createReadStream(file), res); return;
    }
    const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    if (req.method === 'GET' && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(await readFile(path.join(root, 'public', file))); return;
    }
    json(res, 404, { error: '未找到请求的资源' });
  } catch (e) { if (!res.headersSent) json(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message }); else res.destroy(); }
});
server.requestTimeout = 180000;
try {
  const started = await startLocalServer(server, { port, directory, demo });
  port = started.port;
  origin = `http://127.0.0.1:${port}`;
  diagnostics.record(started.reused ? 'reused' : 'ready', { port });
  if (!started.reused) quotaRecovery.start();
  if (started.reused) console.log(`\n  本地书房已在运行，直接使用现有服务：${origin}\n`);
  else console.log(`\n  Z-Library 本地书房${demo ? ' · 演示模式' : ''}\n  ${origin}\n  下载目录: ${directory}\n  ${downloadNetwork.message}\n  按 Ctrl+C 停止\n`);
  if (process.env.OPEN_BROWSER === '1') openBrowser(origin);
} catch (error) { console.error(error.message); process.exitCode = 1; }
let stopping = false;
async function shutdown(reason) {
  if (stopping) return; stopping = true;
  diagnostics.record('shutdown_requested', { reason });
  if (matching) matching.cancelled = true;
  importController?.abort();
  for (const client of clients) client.end();
  server.close();
  await quotaRecovery.close();
  await queue.close(); await provider.close(); await importTask; process.exit(0);
}
function requestShutdown(reason) {
  void shutdown(reason).catch(error => { diagnostics.record('shutdown_failed', { code: error.code }); console.error('Failed to finish safe shutdown:', error.message); process.exit(1); });
}
process.on('SIGINT', () => requestShutdown('SIGINT')); process.on('SIGTERM', () => requestShutdown('SIGTERM'));
