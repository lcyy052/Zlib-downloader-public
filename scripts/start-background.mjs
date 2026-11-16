import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { launchBackgroundProcess } from '../src/background-start.js';
import { isOurServer, openBrowser } from '../src/startup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv.includes('--demo');
const dataDir = path.join(root, '.data', demo ? 'demo' : 'live');
let directory = path.join(root, 'downloads', demo ? 'demo' : 'books');
try { directory = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).downloadDirectory || directory; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = Number(process.env.PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
const lastPort = Math.min(65535, port + 199);
const show = value => { console.log(`Local library: ${value}`); if (!process.argv.includes('--no-open') && process.env.OPEN_BROWSER !== '0') openBrowser(value); };
let existing;
for (let candidate = port; candidate <= lastPort; candidate++) {
  if (await isOurServer(candidate, { directory, demo })) { existing = candidate; break; }
}
if (existing) { console.log('Reusing the running service.'); show(`http://127.0.0.1:${existing}`); }
else {
  const launched = await launchBackgroundProcess({ args: [path.join(root, 'src/server.js'), ...(demo ? ['--demo'] : [])], cwd: root, logDirectory: path.join(dataDir, 'logs'), env: { ...process.env, NODE_USE_SYSTEM_CA: '1', OPEN_BROWSER: '0' } });
  console.log(`Background service PID: ${launched.pid}\nOutput log: ${launched.stdout}\nError log: ${launched.stderr}`);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const output = await readFile(launched.stdout, 'utf8');
    const address = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0];
    if (address && await isOurServer(Number(new URL(address).port), { directory, demo })) { show(address); ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) { console.error('Service readiness was not confirmed. Check the output and error logs; do not start duplicate instances.'); process.exitCode = 1; }
}
