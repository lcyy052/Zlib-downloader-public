import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { APP_ID, startLocalServer } from '../src/startup.js';

const directory = path.resolve('downloads/books');
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}
function unusedServer(t) {
  const server = http.createServer((req, res) => res.end('new instance'));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server;
}
function respond(res, value) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }

test('reuses the same application and workspace without binding another port', async t => {
  const port = await fixture(t, (req, res) => respond(res, { app: APP_ID, demo: false, directory }));
  const server = unusedServer(t);
  assert.deepEqual(await startLocalServer(server, { port, directory, demo: false, attempts: 1 }), { port, reused: true });
  assert.equal(server.listening, false);
});
test('recognizes the already-running initial release via its state endpoint', async t => {
  const port = await fixture(t, (req, res) => {
    if (req.url !== '/api/state') { res.statusCode = 404; return res.end(); }
    respond(res, { demo: false, directory, settings: { site: 'https://zh.z-library.sk' }, queue: { jobs: [] } });
  });
  assert.equal((await startLocalServer(unusedServer(t), { port, directory, demo: false, attempts: 1 })).reused, true);
});
test('moves to a free port when another application occupies the requested port', async t => {
  const port = await fixture(t, (req, res) => { res.statusCode = 404; res.end('other app'); });
  const server = unusedServer(t);
  const result = await startLocalServer(server, { port, directory, demo: false, attempts: 10 });
  assert.equal(result.reused, false);
  assert.ok(result.port > port);
  assert.equal(server.address().port, result.port);
});
test('does not reuse a demo session or a different workspace', async t => {
  for (const state of [{ app: APP_ID, demo: true, directory }, { app: APP_ID, demo: false, directory: path.resolve('another-project/downloads') }]) {
    const port = await fixture(t, (req, res) => respond(res, state));
    await assert.rejects(() => startLocalServer(unusedServer(t), { port, directory, demo: false, attempts: 1 }), /均被占用/);
  }
});

test('skips a system-reserved port when Windows rejects binding with EACCES', async t => {
  const port = await fixture(t, (req, res) => { res.statusCode = 404; res.end(); });
  const server = unusedServer(t);
  const originalListen = server.listen.bind(server);
  let rejected = false;
  t.mock.method(server, 'listen', (candidate, host) => {
    if (!rejected) {
      rejected = true;
      process.nextTick(() => server.emit('error', Object.assign(new Error('reserved port'), { code: 'EACCES' })));
      return server;
    }
    return originalListen(candidate, host);
  });
  const result = await startLocalServer(server, { port, directory, demo: false, attempts: 10 });
  assert.ok(result.port > port);
  assert.equal(server.address().port, result.port);
});
