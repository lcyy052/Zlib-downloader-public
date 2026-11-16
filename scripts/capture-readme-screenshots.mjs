import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readmeScreenshotState } from './readme-screenshot-data.mjs';

// No production state is read, including saved files or running local services.
// Keep the user-selected search image unchanged; regenerate the other views.
const snapshot = readmeScreenshotState();
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = createServer(async (req, res) => {
  const asset = assets[new URL(req.url, 'http://localhost').pathname];
  if (req.method !== 'GET' || !asset) { res.writeHead(404); res.end(); return; }
  try {
    res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
    res.end(await readFile(new URL('../public/' + asset[0], import.meta.url)));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const previewOrigin = 'http://127.0.0.1:' + server.address().port;
let browser, mutationAttempts = 0, externalRequests = 0;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== previewOrigin) { externalRequests++; return route.abort(); }
    if (request.method() !== 'GET') { mutationAttempts++; return route.abort(); }
    if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
    if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fictional screenshot\n\n' });
    if (url.pathname.startsWith('/api/')) throw new Error('Unexpected screenshot API request');
    return route.continue();
  });
  await page.goto(previewOrigin);
  await page.waitForFunction(() => document.querySelector('#queue-control-title').textContent !== '正在读取队列状态…');
  const output = new URL('../docs/images/', import.meta.url);
  await mkdir(output, { recursive: true });
  for (const [view, filename] of [['booklist', 'readme-booklist.png'], ['queue', 'readme-download-manager.png']]) {
    await page.locator('.nav[data-view="' + view + '"]').click();
    if (view === 'queue') await page.locator('#queue-control-panel').scrollIntoViewIfNeeded();
    else await page.evaluate(() => scrollTo(0, 0));
    await page.evaluate(() => document.fonts.ready);
    const visibleText = await page.locator('body').innerText();
    const visibleInputs = await page.locator('input:visible').evaluateAll(inputs => inputs.map(input => input.value).join('\n'));
    assert.doesNotMatch(visibleText + '\n' + visibleInputs, /(?:gh[pousr]_[a-z\d]{30,}|github_pat_[a-z\d_]{50,}|Bearer\s+[a-z\d._-]{20,}|[?&](?:token|signature|x-amz-signature)=[^\s]+|[a-z]:[\\/]+Users[\\/]+)/i, 'Visible credentials or personal machine paths must not be published');
    assert.equal(await page.locator('#connection-error').isVisible(), false);
    assert.equal(await page.locator('#demo-banner').isVisible(), true);
    assert.match(visibleText, /示例书单/);
    assert.doesNotMatch(visibleInputs, /https?:\/\/(?!demo\.example(?:\/|$))/i);
    await page.screenshot({ path: fileURLToPath(new URL(filename, output)), fullPage: false });
  }
  assert.equal(mutationAttempts, 0);
  assert.equal(externalRequests, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', files: ['readme-booklist.png', 'readme-download-manager.png'], source: 'fixed fictional data', searchImage: 'unchanged', productionStateReads: 0, mutationAttempts, externalRequests, realDownloads: 0 }));
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
