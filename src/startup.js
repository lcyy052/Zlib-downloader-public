import path from 'node:path';
import { spawn } from 'node:child_process';

export const APP_ID = 'zlibrary-local-library';

async function readLocalJson(port, endpoint) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(1200), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
}

export async function isOurServer(port, { directory, demo }) {
  const sameWorkspace = state => state && typeof state.directory === 'string' && path.resolve(state.directory) === path.resolve(directory) && state.demo === demo;
  const health = await readLocalJson(port, '/api/health');
  if (health?.app === APP_ID && sameWorkspace(health)) return true;
  // Recognize the initial release, which had no health endpoint.
  const state = await readLocalJson(port, '/api/state');
  return !!(sameWorkspace(state) && typeof state.settings?.site === 'string' && Array.isArray(state.queue?.jobs));
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { server.off('error', onError); server.off('listening', onListening); };
    const onError = error => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    server.once('error', onError); server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startLocalServer(server, { port, directory, demo, attempts = 200 }) {
  const lastPort = Math.min(65535, port + attempts - 1);
  // Look for an already-running instance before opening another one on a free port.
  for (let candidate = port; candidate <= lastPort; candidate++) {
    if (await isOurServer(candidate, { directory, demo })) return { port: candidate, reused: true };
  }
  for (let candidate = port; candidate <= lastPort; candidate++) {
    try { await listen(server, candidate); return { port: candidate, reused: false }; }
    catch (error) {
      // Windows also reserves whole port ranges (e.g. for Hyper-V/WSL).
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
      // Another launch may have won the race after the initial scan.
      if (await isOurServer(candidate, { directory, demo })) return { port: candidate, reused: true };
    }
  }
  throw new Error(`端口 ${port}–${lastPort} 均被占用或被系统保留，请设置其他 PORT 后重试`);
}

export function openBrowser(url) {
  // The URL is generated locally from a validated numeric port, never from user input.
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`请在浏览器中打开 ${url}`));
  child.unref();
}
