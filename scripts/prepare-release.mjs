import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { collectReleaseFiles, auditRelease, copyRelease } from './release-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = await collectReleaseFiles(root), findings = await auditRelease(root, files);
if (findings.length) { console.error(JSON.stringify({ ok: false, findings }, null, 2)); process.exit(1); }
const exportRoot = path.join(root, 'release');
await mkdir(exportRoot, { recursive: true });
const name = 'zlibrary-local-library-source-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const destination = path.join(exportRoot, name);
await copyRelease(root, destination, files);
console.log('Clean source directory: ' + destination);
if (process.platform === 'win32') {
  // Pass literal paths through process environment, never concatenate them into shell code.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:ZLIB_RELEASE_DIRECTORY, $env:ZLIB_RELEASE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)"], {
    env: { ...process.env, ZLIB_RELEASE_DIRECTORY: destination, ZLIB_RELEASE_ZIP: destination + '.zip' }, windowsHide: true, stdio: 'inherit',
  });
  console.log('Source ZIP: ' + destination + '.zip');
  const checksum = createHash('sha256').update(await readFile(destination + '.zip')).digest('hex');
  await writeFile(destination + '.zip.sha256', checksum + '  ' + name + '.zip\n', { flag: 'wx' });
  console.log('ZIP SHA-256: ' + checksum);
} else console.log('ZIP step is Windows-only; use the clean directory to publish or compress locally.');
console.log('No Git history, login session, queue, dependencies or downloaded books included. Originals and old exports are unchanged.');
