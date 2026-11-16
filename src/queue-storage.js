import { constants } from 'node:fs';
import { copyFile, open, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const statuses = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validJob(job) {
  return object(job) && typeof job.id === 'string' && !!job.id && object(job.book)
    && typeof job.book.title === 'string' && typeof job.book.url === 'string'
    && statuses.has(job.status) && (job.sources == null || Array.isArray(job.sources) && job.sources.every(object));
}
function invalidFormat() { return Object.assign(new Error('下载记录格式错误'), { code: 'INVALID_QUEUE' }); }
function parseJobs(text) {
  const jobs = JSON.parse(text);
  if (!Array.isArray(jobs) || !jobs.every(validJob) || new Set(jobs.map(job => job.id)).size !== jobs.length) throw invalidFormat();
  return jobs;
}
function parseState(text) {
  const state = JSON.parse(text);
  if (!object(state) || state.autoPause != null && !object(state.autoPause)
    || state.recovery != null && (!object(state.recovery) || typeof state.recovery.message !== 'string'
      || !Array.isArray(state.recovery.archives) || !state.recovery.archives.every(file => typeof file === 'string'))) throw invalidFormat();
  return state;
}

// Recover only complete, individually valid objects in the contiguous array prefix.
// Never guess the missing string/record, strip NULs, or join fragments after damage.
export function recoverQueuePrefix(text) {
  let index = 0;
  const whitespace = () => { while (index < text.length && /[\t\n\r ]/.test(text[index])) index++; };
  whitespace();
  if (text[index++] !== '[') return [];
  const jobs = [], ids = new Set();
  while (index < text.length) {
    whitespace();
    if (text[index] !== '{') break;
    const start = index, stack = [];
    let quoted = false, escaped = false, complete = false;
    for (; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        if (stack.pop() !== (character === '}' ? '{' : '[')) return jobs;
        if (!stack.length) { index++; complete = true; break; }
      }
    }
    if (!complete) break;
    let job;
    try { job = JSON.parse(text.slice(start, index)); } catch { break; }
    if (!validJob(job) || ids.has(job.id)) break;
    ids.add(job.id); jobs.push(job);
    whitespace();
    if (text[index++] !== ',') break;
  }
  return jobs;
}

async function readSnapshot(file, parse) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { missing: true }; throw error; }
  try { return { value: parse(text) }; }
  catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'INVALID_QUEUE') throw error;
    // Do not include JSON.parse's excerpt of private book data in startup logs.
    return { invalid: true, text };
  }
}

async function archiveCorrupt(file) {
  const archive = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  await copyFile(file, archive, constants.COPYFILE_EXCL);
  const handle = await open(archive, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  return archive;
}

async function loadWithRecovery(file, { parse, empty, salvage, label }) {
  const primary = await readSnapshot(file, parse);
  if ('value' in primary) return { value: primary.value, recovery: null };
  const backup = await readSnapshot(file + '.bak', parse);
  if (primary.missing && backup.missing) return { value: empty(), recovery: null };
  const archives = [];
  // Copy exact originals before replacing anything, including a damaged backup.
  if (primary.invalid) archives.push(await archiveCorrupt(file));
  if (backup.invalid) archives.push(await archiveCorrupt(file + '.bak'));
  const fromBackup = 'value' in backup;
  const value = fromBackup ? backup.value : salvage && primary.invalid ? salvage(primary.text) : empty();
  const count = Array.isArray(value) ? value.length : undefined;
  const source = fromBackup ? 'backup' : count ? 'prefix' : 'empty';
  const message = `${label}损坏或缺失，${fromBackup ? '已从上一版备份恢复' : count ? '已恢复完整前缀中的 ' + count + ' 条记录，损坏尾部未恢复' : '没有可用的完整备份或记录，已保留损坏原件'}。${fromBackup ? '最近变更可能未包含在备份中。' : ''}队列保持暂停，请检查记录后在下载管理顶部手动继续。`;
  const recovery = { source, ...(count === undefined ? {} : { recoveredJobs: count }), archives, detectedAt: new Date().toISOString(), message };
  // The caller must persist the manual recovery hold before replacing the primary.
  return { value, recovery };
}

export const loadQueueFile = file => loadWithRecovery(file, { parse: parseJobs, empty: () => [], salvage: recoverQueuePrefix, label: '下载记录文件' });
export const loadQueueState = file => loadWithRecovery(file, { parse: parseState, empty: () => ({ version: 1, autoPause: null }), label: '队列状态文件' });

export function recoverySummary(recovery) {
  return recovery ? { ...recovery, archives: recovery.archives.map(file => path.basename(file)) } : null;
}
