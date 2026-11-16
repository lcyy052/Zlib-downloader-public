import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { atomicJson } from '../src/utils.js';

const apply = process.argv.includes('--apply');
const workspace = path.resolve('.');
const booksDirectory = path.resolve('downloads/books');
const queueFile = path.resolve('.data/live/queue.json');
const archiveRoot = path.resolve('downloads/duplicates-archive');

function assertInsideWorkspace(target) {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`路径不在项目目录内：${target}`);
}

function normalizedName(filename) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension).replace(/ \(\d+\)$/, '');
  return `${stem}${extension.toLowerCase()}`;
}

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', resolve).on('error', reject));
  return hash.digest('hex');
}

for (const target of [booksDirectory, queueFile, archiveRoot]) assertInsideWorkspace(target);

const entries = await readdir(booksDirectory, { withFileTypes: true });
const files = [];
for (const entry of entries) {
  if (!entry.isFile()) continue;
  const file = path.join(booksDirectory, entry.name);
  const info = await stat(file);
  files.push({ name: entry.name, normalized: normalizedName(entry.name), bytes: info.size, hash: await sha256(file) });
}

const groups = new Map();
for (const file of files) {
  const key = `${file.normalized}\0${file.hash}`;
  const group = groups.get(key) || [];
  group.push(file); groups.set(key, group);
}

const moves = [];
for (const group of groups.values()) {
  if (group.length < 2) continue;
  group.sort((a, b) => {
    if (a.name === a.normalized) return -1;
    if (b.name === b.normalized) return 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });
  const [keeper, ...duplicates] = group;
  for (const duplicate of duplicates) moves.push({ from: duplicate.name, to: keeper.name, bytes: keeper.bytes, hash: keeper.hash });
}

if (!apply || !moves.length) {
  console.log(JSON.stringify({ applied: false, duplicateFiles: moves.length, moves }, null, 2));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const archiveDirectory = path.join(archiveRoot, stamp);
assertInsideWorkspace(archiveDirectory);
await mkdir(archiveDirectory, { recursive: true });
await copyFile(queueFile, path.join(archiveDirectory, 'queue.before.json'));

const completedMoves = [];
try {
  for (const move of moves) {
    const source = path.join(booksDirectory, move.from);
    const destination = path.join(archiveDirectory, move.from);
    assertInsideWorkspace(source); assertInsideWorkspace(destination);
    await rename(source, destination);
    completedMoves.push({ source, destination });
  }
  const jobs = JSON.parse(await readFile(queueFile, 'utf8'));
  for (const job of jobs) {
    const move = moves.find(item => item.from === job.filename);
    if (!move) continue;
    job.filename = move.to;
    job.bytes = move.bytes;
    if (job.status === 'completed') job.message = '已存在文件，重复副本已归档';
  }
  await atomicJson(queueFile, jobs);
} catch (error) {
  for (const move of completedMoves.reverse()) await rename(move.destination, move.source).catch(() => {});
  throw error;
}

await atomicJson(path.join(archiveDirectory, 'manifest.json'), { createdAt: new Date().toISOString(), booksDirectory, queueFile, moves });
console.log(JSON.stringify({ applied: true, archiveDirectory, duplicateFiles: moves.length, moves }, null, 2));
