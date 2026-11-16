import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { collectReleaseFiles, auditRelease, assertReleasePath } from './release-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = await collectReleaseFiles(root);
const findings = await auditRelease(root, files);
let historyChecked = false;
try {
  const tracked = execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), 'ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  historyChecked = true;
  for (const file of tracked.split('\0').filter(Boolean)) {
    try { assertReleasePath(file); }
    catch { findings.push({ file, reason: 'Sensitive or unexpected path is already tracked by Git' }); }
  }
} catch { /* Clean export can be checked without Git. */ }
if (findings.length) { console.error(JSON.stringify({ ok: false, findings }, null, 2)); process.exitCode = 1; }
else console.log(JSON.stringify({ ok: true, files: files.length, trackedPathsChecked: historyChecked, note: 'Limited content/path checks only. Review PNGs manually. Git history is NOT sanitized; publish from a clean export.' }, null, 2));
