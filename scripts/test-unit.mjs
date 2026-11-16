import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Do not rediscover preserved private backups or release-validation test copies.
const directory = new URL('../test/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.test.js')).sort();
const result = spawnSync(process.execPath, ['--test', ...files.map(name => fileURLToPath(new URL(name, directory)))], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
