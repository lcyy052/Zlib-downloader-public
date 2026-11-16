import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { configureDownloadProxy, normalizeProxy, parseWindowsProxy } from '../src/download-proxy.js';

test('Windows proxy parser reads enabled shared and protocol-specific settings', () => {
  const shared = parseWindowsProxy(' ProxyEnable REG_DWORD 0x1\r\n ProxyServer REG_SZ 127.0.0.1:10808\r\n');
  assert.equal(shared.https, 'http://127.0.0.1:10808/');
  assert.equal(parseWindowsProxy(' ProxyEnable REG_DWORD 0x0\n ProxyServer REG_SZ 127.0.0.1:10808').https, '');
  const mapped = parseWindowsProxy(' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ http=127.0.0.1:8000;https=127.0.0.1:8001');
  assert.equal(mapped.http, 'http://127.0.0.1:8000/'); assert.equal(mapped.https, 'http://127.0.0.1:8001/');
  assert.throws(() => normalizeProxy('socks5://127.0.0.1:10808'));
});

test('download proxy follows Windows only inside the application and bypasses loopback', async () => {
  let applied;
  const result = await configureDownloadProxy({ env: { NO_PROXY: '.internal.example' }, platform: 'win32', readSystemProxy: async () => ({ http: 'http://127.0.0.1:10808/', https: 'http://127.0.0.1:10808/' }), applyProxy: value => { applied = value; } });
  assert.equal(result.active, true); assert.equal(result.source, 'windows');
  assert.equal(applied.https_proxy, 'http://127.0.0.1:10808/');
  assert.match(applied.no_proxy, /^\.internal.example,localhost,127.0.0.1,::1$/);
});

test('explicit environment proxy wins over Windows and credentials are not exposed', async () => {
  let applied;
  const sampleProxy = new URL('http://proxy.example:8080');
  sampleProxy.username = 'user'; sampleProxy.password = 'private'; // Synthetic credentials only.
  const result = await configureDownloadProxy({ env: { HTTPS_PROXY: sampleProxy.href }, platform: 'win32', readSystemProxy: async () => { throw new Error('must not read'); }, applyProxy: value => { applied = value; } });
  assert.equal(result.source, 'environment'); assert.match(applied.https_proxy, /user:private@/);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('disabled, PAC, unsupported proxy and old Node do not break downloads', async () => {
  const disabled = await configureDownloadProxy({ env: { NODE_USE_ENV_PROXY: '0' }, applyProxy: () => assert.fail() });
  assert.equal(disabled.active, false);
  const pac = await configureDownloadProxy({ env: {}, platform: 'win32', readSystemProxy: async () => ({ http: '', https: '', pac: true }), applyProxy: () => assert.fail() });
  assert.match(pac.message, /PAC/);
  const invalid = await configureDownloadProxy({ env: { ALL_PROXY: 'socks5://localhost:10808' }, applyProxy: () => assert.fail() });
  assert.equal(invalid.active, false);
  const old = await configureDownloadProxy({ env: { HTTPS_PROXY: 'http://localhost:10808' }, applyProxy: null });
  assert.match(old.message, /Node 24.14/);
});

test('native fetch uses configured proxy while loopback stays direct', { skip: typeof http.setGlobalProxyFromEnv !== 'function' }, async () => {
  let restore, requests = [], tunnels = [], sockets = new Set();
  const server = http.createServer((req, res) => { requests.push(req.url); res.end('fixture'); });
  server.on('connect', (req, socket, head) => {
    tunnels.push(req.url); sockets.add(socket);
    const upstream = connect(server.address().port, '127.0.0.1'); sockets.add(upstream);
    upstream.on('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    const network = await configureDownloadProxy({ env: { HTTP_PROXY: address }, applyProxy: env => { restore = http.setGlobalProxyFromEnv(env); } });
    assert.equal(network.active, true);
    assert.equal(await (await fetch('http://download-proxy-fixture.invalid/resource', { signal: AbortSignal.timeout(5000) })).text(), 'fixture');
    assert.equal(await (await fetch(`${address}/local`, { signal: AbortSignal.timeout(5000) })).text(), 'fixture');
    assert.deepEqual(tunnels, ['download-proxy-fixture.invalid:80']);
    assert.deepEqual(requests, ['/resource', '/local']);
  } finally { restore?.(); for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
