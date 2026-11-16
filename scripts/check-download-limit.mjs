import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LibraryProvider } from '../src/provider.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-quota-browser-'));
const provider = new LibraryProvider({ getSettings: () => ({ site: 'https://quota.fixture', browser: 'chrome', downloadConcurrency: 3 }), dataDir: directory, demo: false, headless: true });
provider.downloadTimeouts = { startTimeoutMs: 5000, idleTimeoutMs: 1000, totalTimeoutMs: 10000 };
const payload = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
let clicks = 0, nativeDownloads = 0;
let probeMode = 'full', probes = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/file') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': payload.length }); res.end(payload); return; }
  if (req.url === '/quota-html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<div role="alert">今日下载额度已用完</div>'); return; }
  if (req.url === '/limited') { res.writeHead(429, { 'content-type': 'text/plain' }); res.end('Too many requests'); return; }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const book = tag => ({ title: 'Quota fixture ' + tag, format: 'PDF', url: 'https://quota.fixture/book/1/' + tag });
const results = [];
try {
  const context = await provider.browser();
  if (process.env.QUOTA_FIXTURE_DEBUG === '1') context.on('request', request => console.log('FIXTURE_REQUEST', new URL(request.url()).pathname));
  context.on('page', page => page.on('download', () => nativeDownloads++));
  await context.route('https://quota.fixture/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      probes++;
      assert.equal(route.request().headers()['cache-control'], 'no-cache');
      if (probeMode === '503') return route.fulfill({ status: 503, body: 'Unavailable' });
      if (probeMode === 'login') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Login fixture</title><form action="/login"><input type="password"></form><div>0/999 每日限额</div>' });
      const counter = probeMode === 'full' ? '999/999' : probeMode === 'missing' ? '' : '0/999';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Quota probe fixture</title><div style="display:none"><b>' + counter + '</b><span>每日限额</span></div>' + (probeMode === 'contradictory' ? '<div role="alert">今日下载额度已用完</div>' : '') });
    }
    if (url.pathname === '/quota-popup') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div role="alert">You have reached your daily download limit</div>' });
    if (url.pathname.startsWith('/clicked/')) { clicks++; return route.fulfill({ body: '' }); }
    if (url.pathname.startsWith('/dl/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script>location.href=' + JSON.stringify(origin + '/' + url.pathname.split('/').at(-1)) + '</script>' });
    const tag = url.pathname.split('/').at(-1);
    const counter = tag === 'full' ? '999/999' : '2/3';
    const script = tag === 'inline' ? "fetch('/clicked/inline');setTimeout(()=>document.querySelector('#alert').innerHTML='今日下载额度已用完',100);return false"
      : tag === 'popup' ? "fetch('/clicked/popup');window.open('/quota-popup');return false" : '';
    const destination = ['node-quota', 'chrome-quota'].includes(tag) ? 'quota-html' : ['node-429', 'chrome-429'].includes(tag) ? 'limited' : 'file';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Fixture detail</title><div style="display:none"><b>' + counter + '</b><span>每日限额</span></div><div class="bookDetailsBox"><h1>Fixture</h1></div><div class="description">You have reached your daily download limit</div><div class="alert" style="display:none">今日下载额度已用完</div><div role="alert" id="alert"></div><a class="addDownloadedBook" href="/dl/' + destination + '"' + (script ? ' onclick="' + script + '"' : '') + '>Download</a>' });
  });
  const invoke = tag => provider.download(book(tag), directory, new AbortController().signal, update => { if (process.env.QUOTA_FIXTURE_DEBUG === '1') console.log('FIXTURE_PROGRESS', tag, typeof update === 'string' ? update : update.message); });
  const start = Date.now();
  await assert.rejects(invoke('full'), error => error.code === 'DOWNLOAD_QUOTA_EXHAUSTED' && error.quota.used === 999);
  assert.equal(clicks, 0, 'Full counter must be detected before clicking');
  assert.ok(Date.now() - start < 5000); results.push('999/999 preflight blocks click');

  const pagesBefore = context.pages().length, clicksBefore = clicks;
  for (const mode of ['full', 'available', 'missing', 'contradictory', '503', 'login']) {
    probeMode = mode;
    const probe = await provider.checkDownloadQuota();
    assert.equal(probe.available, mode === 'available', mode);
    if (mode === 'full') assert.deepEqual(probe.quota, { used: 999, limit: 999 });
    if (mode === 'available') assert.deepEqual(probe.quota, { used: 0, limit: 999 });
    assert.equal(context.pages().length, pagesBefore, 'Probe closes its own page');
  }
  assert.equal(probes, 6); assert.equal(clicks, clicksBefore, 'Recovery probes never click downloads');
  assert.equal(provider.active, 0);
  results.push('fresh quota recovery probes: full, recovered, missing, contradictory, 503, login; zero download clicks');

  const saved = await invoke('available');
  assert.deepEqual(await readFile(path.join(directory, saved.filename)), payload);
  results.push('available counter ignores hidden alert and description');

  for (const tag of ['inline', 'popup', 'node-quota']) {
    const started = Date.now();
    await assert.rejects(invoke(tag), error => error.code === 'DOWNLOAD_QUOTA_EXHAUSTED');
    assert.ok(Date.now() - started < 4500, tag + ' must be detected without waiting for start timeout');
    results.push(tag + ' quota detected');
  }
  await assert.rejects(invoke('node-429'), error => error.code === 'DOWNLOAD_REQUEST_LIMITED');
  results.push('Node 429 distinct from daily quota');
  const transfer = provider.transferHttp;
  provider.transferHttp = async () => { throw Object.assign(new Error('Fixture unavailable direct path'), { code: 'ECONNREFUSED' }); };
  await assert.rejects(invoke('chrome-quota'), error => error.code === 'DOWNLOAD_QUOTA_EXHAUSTED');
  await assert.rejects(invoke('chrome-429'), error => error.code === 'DOWNLOAD_REQUEST_LIMITED');
  provider.transferHttp = transfer;
  results.push('Chrome HTML quota and 429 detected');
  assert.equal((await readdir(directory)).some(name => name.endsWith('.part')), false);
  assert.equal(nativeDownloads, 0);
  console.log(JSON.stringify({ result: 'PASS', cases: results, nativeDownloads, productionRequests: 0 }));
} finally {
  await provider.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
