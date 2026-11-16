import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectReleaseFiles, auditRelease, assertReleasePath, textFindings, copyRelease } from '../scripts/release-files.mjs';

test('publication paths reject runtime data, credentials, books, archives and traversal', () => {
  for (const file of ['.data/live/queue.json', '.git/config', '.local/private.md', 'src/.env', 'docs/book.epub', 'docs/book.pdf', 'src/key.pem', 'docs/archive.zip', '../README.md', '/tmp/private.md', 'src/storageState.json', 'node_modules/lib.js']) assert.throws(() => assertReleasePath(file));
  assert.equal(assertReleasePath('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
  assert.equal(assertReleasePath('src\\server.js'), 'src/server.js');
});

test('limited credential checks classify findings without returning their values', () => {
  const token = 'ghp_' + 'x'.repeat(40);
  const secret = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  assert.deepEqual(textFindings(token), ['credential-like token']);
  assert.deepEqual(textFindings(secret), ['private-key material']);
  assert.ok(textFindings(['https://', 'user:pass', '@example.test/'].join('')).includes('credentials in URL'));
  assert.ok(textFindings(['https://example.test/file?', 'signature=', 'private'].join('')).includes('signed or token-bearing URL'));
  assert.ok(textFindings(['C:', 'Users', 'person', 'project'].join('\\')).includes('personal Windows profile path'));
  assert.equal(JSON.stringify(textFindings(token)).includes(token), false);
  assert.deepEqual(textFindings('normal text with cookie/token field names and .data warnings'), []);
});

test('allowlist copying excludes runtime directories and retains dotfiles; outputs never overwritten', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zlib-release-test-'));
  try {
    await mkdir(path.join(root, 'src')); await mkdir(path.join(root, '.data'));
    await writeFile(path.join(root, 'README.md'), '# Demo\n');
    await writeFile(path.join(root, '.gitignore'), '.data/\n');
    await writeFile(path.join(root, 'src', 'a.js'), 'export const demo = true;\n');
    await writeFile(path.join(root, '.data', 'private.json'), '{"private":true}');
    const files = await collectReleaseFiles(root, ['README.md', '.gitignore', 'src']);
    assert.deepEqual(files, ['.gitignore', 'README.md', 'src/a.js']);
    assert.deepEqual(await auditRelease(root, files), []);
    const output = path.join(root, 'output');
    await copyRelease(root, output, files);
    assert.equal(await readFile(path.join(output, '.gitignore'), 'utf8'), '.data/\n');
    assert.equal((await readdir(output)).includes('.data'), false);
    await assert.rejects(copyRelease(root, output, files), /EEXIST/);
    assert.equal(await readFile(path.join(root, '.data', 'private.json'), 'utf8'), '{"private":true}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication audit rejects unsafe contents and broken relative documentation links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zlib-release-audit-'));
  try {
    await writeFile(path.join(root, 'README.md'), '# Demo\n[missing](missing.md)\n' + 'github_pat_' + 'a'.repeat(70));
    const findings = await auditRelease(root, ['README.md']);
    assert.ok(findings.some(item => item.reason === 'credential-like token'));
    assert.ok(findings.some(item => item.reason.includes('documentation link')));
    assert.ok(findings.every(item => Object.keys(item).join(',') === 'file,reason'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unexpected sensitive files inside allowed source directories fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zlib-release-block-'));
  try {
    await mkdir(path.join(root, 'src')); await writeFile(path.join(root, 'src', '.env'), 'private');
    await assert.rejects(collectReleaseFiles(root, ['src']), /Unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication refuses symlinks to outside files', { skip: process.platform === 'win32' && 'Creating symlinks may require extra Windows privileges' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zlib-release-symlink-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'private.md'), 'private');
    await symlink(path.join(root, 'private.md'), path.join(root, 'src', 'link.md'));
    await assert.rejects(collectReleaseFiles(root, ['src']), /Symlinks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
