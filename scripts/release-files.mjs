import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, readdir, readFile, mkdir, copyFile } from 'node:fs/promises';

export const releaseEntries = [
  '.gitignore', 'LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'start.bat',
  '.github', 'src', 'public', 'scripts', 'test', 'examples', 'docs',
];
const blockedNames = new Set(['.git', '.data', '.local', 'node_modules', 'downloads', 'test-results', 'release', '.npmrc', 'cookies', 'login data']);
const allowedExtensions = new Set(['.js', '.mjs', '.json', '.md', '.svg', '.png', '.css', '.html', '.txt', '.csv', '.bat', '.yml', '.yaml']);

export function assertReleasePath(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (!normalized || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe release path');
  if (parts.some(part => blockedNames.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /storage[-_]?state/i.test(part))) throw new Error('Sensitive path is not allowed');
  if (normalized !== 'LICENSE' && normalized !== '.gitignore' && !allowedExtensions.has(path.extname(normalized).toLowerCase())) throw new Error('Unexpected file type');
  return normalized;
}

export async function collectReleaseFiles(root, entries = releaseEntries) {
  const files = [];
  async function visit(relative) {
    const normalized = relative.replaceAll('\\', '/');
    // Validate directory components before descending, without extension restriction.
    if (normalized.split('/').some(part => blockedNames.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part)) || normalized.includes('..') || path.isAbsolute(relative)) throw new Error('Unsafe release entry');
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error('Symlinks are not allowed in publication files');
    if (info.isDirectory()) {
      for (const item of (await readdir(path.join(root, relative))).sort()) await visit(path.join(relative, item));
    } else if (info.isFile()) files.push(assertReleasePath(relative));
    else throw new Error('Unsupported publication entry');
  }
  for (const entry of entries) await visit(entry);
  return [...new Set(files)].sort();
}

export function textFindings(text) {
  const rules = [
    ['credential-like token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})\b/],
    ['private-key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['credentials in URL', /https?:\/\/[^\s"'<>/@]+:[^\s"'<>/@]+@/i],
    ['signed or token-bearing URL', /https?:\/\/[^\s"'<>]+[?&](?:token|signature|x-amz-signature|x-goog-signature)=[^\s"'<>]+/i],
    ['literal authorization header', /\bAuthorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._-]{20,}/i],
    ['personal Windows profile path', /\b[A-Z]:[\\/]+Users[\\/]+(?!Public[\\/]|Default[\\/]|<)[^\\/\s"'<>]+/i],
    ['local project path', /\b[A-Z]:[\\/]+Code[\\/]+codex[\\/]/i],
  ];
  // Findings contain categories only. Never echo matched secret text.
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export async function auditRelease(root, files) {
  const findings = [];
  for (const file of files) {
    try { assertReleasePath(file); }
    catch (error) { findings.push({ file, reason: error.message }); continue; }
    const full = path.join(root, file), info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink()) { findings.push({ file, reason: 'Not a regular file' }); continue; }
    if (info.size > 8 * 1024 * 1024) { findings.push({ file, reason: 'File exceeds publication size limit' }); continue; }
    if (path.extname(file).toLowerCase() === '.png') continue; // Images require human review.
    const text = await readFile(full, 'utf8');
    for (const reason of textFindings(text)) findings.push({ file, reason });
    if (file.endsWith('.md')) for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].split('#')[0].trim();
      if (!link || /^(?:https?:|mailto:)/i.test(link) || link.includes(' ')) continue;
      const target = path.resolve(path.dirname(full), link);
      const relative = path.relative(root, target).replaceAll('\\', '/');
      if (relative.startsWith('..') || !files.some(entry => entry === relative || entry.startsWith(relative.replace(/\/$/, '') + '/'))) findings.push({ file, reason: 'Local documentation link is outside the release file list' });
    }
  }
  return findings;
}

export async function copyRelease(root, destination, files) {
  // Refuse existing output, even if empty. This tool never deletes or overwrites old exports.
  await mkdir(destination);
  for (const file of files) {
    assertReleasePath(file);
    const source = path.join(root, file), target = path.join(destination, file);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Source changed during export');
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}
