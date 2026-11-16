import { randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, downloadConcurrency, safeFilename } from './utils.js';
import { summarizeJobs, summarizeBatches } from './booklist.js';
import { findExistingDownload } from './existing-download.js';
import { downloadHttpStatus, isRetryableDownloadHttpError } from './download-errors.js';
import { isDownloadLimit, downloadLimitError } from './download-limit.js';
import { loadQueueFile, loadQueueState, recoverySummary } from './queue-storage.js';

function folderForSource(source) {
  return source ? safeFilename(String(source.title || '').trim() || '未命名书单') : '';
}

function normalizedSource(source) {
  return { ...source, state: ['active', 'paused', 'cancelled'].includes(source?.state) ? source.state : 'active' };
}

function runnable(job) {
  return !job.sources?.length || job.sources.some(source => (source.state || 'active') === 'active');
}

function hasRemainingBatch(job) {
  return job.sources?.some(source => (source.state || 'active') !== 'cancelled');
}

export function isRetryableDownloadError(error) {
  return isRetryableDownloadHttpError(error) || ['DOWNLOAD_START_TIMEOUT', 'DOWNLOAD_HTTP_TIMEOUT'].includes(error?.code) || /Chrome (?:网络请求|文件传输|下载页面连接)超时|文件传输连续 \d+ 秒没有收到新数据|Chrome 文件传输中断|Chrome 网络请求失败（[^）]*(?:TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|HTTP_RESPONSE_CODE_FAILURE|ConnectionReset|ConnectionClosed|TimedOut)[^）]*）/i.test(error?.message || '');
}

async function waitForRetry(delayMs, signal) {
  if (signal.aborted || delayMs <= 0) return;
  await new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    timer = setTimeout(done, delayMs);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

export class DownloadQueue {
  constructor({ file, provider, directory, concurrency = 1, delayMs = 2500, retryDelays = [5000, 15000, 30000], originRetryDelays = [30000, 60000, 120000], onChange = () => {} }) {
    Object.assign(this, { file, provider, delayMs, retryDelays, originRetryDelays, onChange });
    this.setDirectory(directory);
    this.setConcurrency(concurrency);
    this.jobs = []; this.paused = true; this.busy = false; this.controllers = new Map(); this.tasks = new Map(); this.pumpTask = null; this.saves = Promise.resolve(); this.lastError = ''; this.autoPause = null;
    this.controlVersion = 0;
    this.recovery = null;
  }
  async init() {
    const loaded = await loadQueueFile(this.file);
    const metadata = await loadQueueState(this.file + '.state.json');
    this.jobs = loaded.value;
    this.paused = true;
    this.recovery = loaded.recovery || metadata.recovery || metadata.value.recovery || null;
    if (loaded.recovery && metadata.recovery) {
      this.recovery = { ...loaded.recovery, archives: [...loaded.recovery.archives, ...metadata.recovery.archives], message: loaded.recovery.message + '队列状态文件也已恢复。' };
    }
    for (const job of this.jobs) if (job.status === 'running') { job.status = 'queued'; job.message = '上次运行中断，等待继续'; }
    this.autoPause = this.jobs.find(job => job.status === 'queued' && job.autoPause)?.autoPause || null;
    if (['quota', 'request-limit'].includes(metadata.value.autoPause?.kind)) this.autoPause = metadata.value.autoPause;
    if (this.autoPause) this.lastError = this.autoPause.message;
    if (this.recovery) {
      if (this.autoPause) this.autoPause = { ...this.autoPause, manual: true };
      this.lastError = this.recovery.message;
      // Commit the hold first: a crash during repair must not enable quota auto-resume.
      await atomicJson(this.file + '.state.json', { version: 1, autoPause: this.autoPause, recovery: this.recovery }, { backup: !metadata.recovery });
      // Exact corrupt originals have already been archived; don't overwrite good .bak files.
      await atomicJson(this.file, this.jobs, { backup: !loaded.recovery });
      // Establish a usable backup immediately if no intact previous generation exists.
      if (loaded.recovery && loaded.recovery.source !== 'backup') await atomicJson(this.file + '.bak', this.jobs);
      if (metadata.recovery && metadata.recovery.source !== 'backup') {
        await atomicJson(this.file + '.state.json.bak', { version: 1, autoPause: this.autoPause, recovery: this.recovery });
      }
    }
    await this.migrateLegacyBooklistFiles();
  }
  setDirectory(directory) {
    if (!path.isAbsolute(directory)) throw new Error('下载目录必须是绝对路径');
    this.directory = path.resolve(directory);
  }
  setConcurrency(value) { this.concurrency = downloadConcurrency(value, 1); }
  rootFor(job) {
    const root = job?.downloadRoot || this.directory;
    if (!path.isAbsolute(root)) throw new Error('任务下载目录无效');
    return path.resolve(root);
  }
  directoryFor(job) {
    const root = this.rootFor(job);
    if (!job?.folder) return root;
    if (path.basename(job.folder) !== job.folder || safeFilename(job.folder) !== job.folder) throw new Error('书单文件夹名称无效');
    return path.join(root, job.folder);
  }
  filePath(job) {
    if (!job?.filename || path.basename(job.filename) !== job.filename) return null;
    return path.join(this.directoryFor(job), job.filename);
  }
  async migrateLegacyBooklistFiles() {
    let changed = false;
    for (const job of this.jobs) {
      if (!Array.isArray(job.sources)) { job.sources = []; changed = true; }
      for (let index = 0; index < job.sources.length; index++) {
        const normalized = normalizedSource(job.sources[index]);
        if (normalized.state !== job.sources[index].state) changed = true;
        job.sources[index] = normalized;
      }
      if (!job.downloadRoot) { job.downloadRoot = this.directory; changed = true; }
      if (job.folder || !job.sources?.length) continue;
      const folder = folderForSource(job.sources[0]);
      if (job.status !== 'completed' || !job.filename || path.basename(job.filename) !== job.filename) {
        job.folder = folder; changed = true; continue;
      }
      const root = this.rootFor(job);
      const targetDirectory = path.join(root, folder);
      await mkdir(targetDirectory, { recursive: true });
      const source = path.join(root, job.filename);
      const destination = path.join(targetDirectory, job.filename);
      try {
        const info = await stat(source);
        try {
          await stat(destination);
          const exact = await findExistingDownload(targetDirectory, job.book);
          if (exact?.filename === job.filename) { Object.assign(job, exact, { folder }); changed = true; }
          continue;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(source, destination);
        Object.assign(job, { folder, bytes: info.size }); changed = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const existing = await findExistingDownload(targetDirectory, job.book);
        if (existing) { Object.assign(job, existing, { folder }); changed = true; }
      }
    }
    if (changed) await atomicJson(this.file, this.jobs, { backup: true });
  }
  save() {
    this.onChange();
    const snapshot = structuredClone(this.jobs);
    const metadata = { version: 1, autoPause: structuredClone(this.autoPause), recovery: structuredClone(this.recovery) };
    const promise = this.saves.then(async () => { await atomicJson(this.file, snapshot, { backup: true }); await atomicJson(this.file + '.state.json', metadata, { backup: true }); });
    this.saves = promise.catch(error => { this.lastError = `任务记录保存失败：${error.message}`; this.paused = true; });
    return promise;
  }
  async add(books, { source } = {}) {
    const folder = folderForSource(source);
    const batchSource = source ? normalizedSource({ ...source, createdAt: source.createdAt || new Date().toISOString(), state: 'active' }) : null;
    let added = 0;
    for (const book of books) {
      const sameDestination = job => path.relative(this.rootFor(job), this.directory) === '' && (job.folder || '') === folder;
      const existing = this.jobs.find(j => j.book.url === book.url && sameDestination(j) && ['queued', 'running', 'completed'].includes(j.status));
      if (existing) {
        const linked = batchSource && existing.sources?.find(item => item.id === batchSource.id);
        if (linked) linked.state = 'active'; else if (batchSource) (existing.sources ||= []).push({ ...batchSource });
        continue;
      }
      const previous = this.jobs.find(j => j.book.url === book.url && sameDestination(j) && ['failed', 'cancelled'].includes(j.status));
      if (previous) {
        if (this.controllers.has(previous.id)) continue;
        const linked = batchSource && previous.sources?.find(item => item.id === batchSource.id);
        if (linked) linked.state = 'active'; else if (batchSource) (previous.sources ||= []).push({ ...batchSource });
        previous.status = 'queued'; previous.progress = null; previous.message = '等待重试'; added++; continue;
      }
      this.jobs.push({ id: randomUUID(), book, status: 'queued', message: '等待下载', attempts: 0, sources: batchSource ? [{ ...batchSource }] : [], downloadRoot: this.directory, ...(folder ? { folder } : {}), createdAt: new Date().toISOString() }); added++;
    }
    await this.save();
    if (!this.autoPause && !this.recovery) this.paused = false;
    this.onChange(); this.kick();
    return { added, skipped: books.length - added };
  }
  kick() {
    if (this.pumpTask || this.paused) return;
    this.pumpTask = this.pump().catch(error => { this.lastError = error.message; this.paused = true; }).finally(() => {
      this.pumpTask = null; this.busy = false; this.onChange();
      if (!this.paused && this.jobs.some(job => job.status === 'queued' && runnable(job))) this.kick();
    });
  }
  async action(action, id, ids = []) {
    if (action === 'pause') {
      this.controlVersion++;
      this.paused = true;
      if (this.autoPause) this.autoPause = { ...this.autoPause, manual: true };
      for (const [jobId, controller] of this.controllers) {
        const job = this.jobs.find(item => item.id === jobId);
        if (job?.status === 'running') { job.status = 'queued'; job.message = '已暂停，等待继续'; job.progress = null; }
        controller.abort();
      }
    }
    else if (action === 'resume') {
      this.controlVersion++;
      this.paused = false; this.lastError = ''; this.autoPause = null; this.recovery = null;
      for (const job of this.jobs) if (job.autoPause) { delete job.autoPause; if (job.status === 'queued') job.message = '等待继续下载'; }
    }
    else if (action === 'clear') this.jobs = this.jobs.filter(j => j.sources?.length || ['queued', 'running'].includes(j.status));
    else if (action === 'clear-selected') {
      if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || ids.some(value => typeof value !== 'string')) throw new Error('请选择要清理的下载记录');
      const selected = new Set(ids);
      this.jobs = this.jobs.filter(job => job.sources?.length || !selected.has(job.id) || ['queued', 'running'].includes(job.status));
    }
    else if (['batch-pause', 'batch-resume', 'batch-cancel', 'batch-delete', 'batch-delete-selected'].includes(action)) {
      const batchIds = action === 'batch-delete-selected' ? ids : [id];
      if (!Array.isArray(batchIds) || !batchIds.length || batchIds.length > 1000 || batchIds.some(value => typeof value !== 'string')) throw new Error('请选择要操作的书单记录');
      const selected = new Set(batchIds);
      const matched = this.jobs.filter(job => job.sources?.some(source => selected.has(source.id)));
      if (!matched.length) throw new Error('书单下载记录不存在');
      if (action === 'batch-pause') {
        for (const job of matched) for (const source of job.sources) if (selected.has(source.id) && source.state !== 'cancelled') source.state = 'paused';
        for (const job of matched) if (!runnable(job) && ['queued', 'running'].includes(job.status)) {
          if (job.status === 'running') this.controllers.get(job.id)?.abort();
          job.status = 'queued'; job.message = '书单已暂停，等待继续'; job.progress = null;
        }
      } else if (action === 'batch-resume') {
        let resumed = false;
        for (const job of matched) for (const source of job.sources) if (selected.has(source.id) && source.state === 'paused') { source.state = 'active'; resumed = true; }
        if (!resumed) throw new Error('该书单当前不能继续');
        if (!this.autoPause && !this.recovery) this.lastError = '';
      } else if (action === 'batch-cancel') {
        for (const job of matched) for (const source of job.sources) if (selected.has(source.id)) source.state = 'cancelled';
        for (const job of matched) if (['queued', 'running'].includes(job.status) && !runnable(job)) {
          const cancelled = !hasRemainingBatch(job);
          if (job.status === 'running') this.controllers.get(job.id)?.abort();
          job.status = cancelled ? 'cancelled' : 'queued';
          job.message = cancelled ? '书单下载已取消' : '等待其他书单继续';
          job.progress = null;
        }
      } else {
        const removeJobs = new Set();
        const waitFor = [];
        for (const job of matched) {
          job.sources = job.sources.filter(source => !selected.has(source.id));
          if (!job.sources.length) {
            removeJobs.add(job.id);
            if (['queued', 'running'].includes(job.status)) {
              job.status = 'cancelled'; job.message = '书单记录已删除';
              this.controllers.get(job.id)?.abort();
              if (this.tasks.has(job.id)) waitFor.push(this.tasks.get(job.id));
            }
          } else if (!runnable(job) && job.status === 'running') {
            job.status = 'queued'; job.message = '等待其他书单继续'; job.progress = null;
            this.controllers.get(job.id)?.abort();
          }
        }
        if (waitFor.length) await Promise.allSettled(waitFor);
        this.jobs = this.jobs.filter(job => !removeJobs.has(job.id));
      }
    }
    else {
      const job = this.jobs.find(j => j.id === id);
      if (!job) throw new Error('任务不存在');
      if (action === 'cancel' && ['queued', 'running'].includes(job.status)) {
        job.status = 'cancelled'; job.message = '已取消';
        this.controllers.get(id)?.abort();
      } else if (action === 'retry' && ['failed', 'cancelled'].includes(job.status)) {
        if (this.controllers.has(id)) throw new Error('任务正在取消，请稍后重试');
        job.status = 'queued'; job.message = '等待重试'; job.progress = null; this.paused = Boolean(this.autoPause || this.recovery);
      } else throw new Error('当前任务状态不支持此操作');
    }
    await this.save(); this.kick();
  }
  run(job) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = 'running'; job.attempts++; job.message = '正在打开书籍页面…'; job.progress = null;
    const task = (async () => {
      try {
        await this.save();
        const jobDirectory = this.directoryFor(job);
        let result;
        for (let retry = 0; ; retry++) {
          try {
            result = await this.provider.download(job.book, jobDirectory, controller.signal, update => {
              if (job.status !== 'running') return;
              if (typeof update === 'string') job.message = update;
              else { job.message = update.message; job.progress = { receivedBytes: update.receivedBytes, totalBytes: update.totalBytes, percent: update.percent, ...(update.transferStarted ? { transferStarted: true } : {}) }; }
              this.onChange();
            });
            break;
          } catch (error) {
            if (isDownloadLimit(error)) throw error;
            const delays = downloadHttpStatus(error) === 522 ? this.originRetryDelays : this.retryDelays;
            if (controller.signal.aborted || !isRetryableDownloadError(error) || retry >= delays.length) throw error;
            const delay = delays[retry];
            job.message = `${error.message} ${Math.ceil(delay / 1000)} 秒后自动重试（${retry + 1}/${delays.length}）…`;
            job.progress = null;
            await this.save();
            await waitForRetry(delay, controller.signal);
            if (controller.signal.aborted) throw new Error('已取消');
            job.attempts++;
            job.message = '正在重新打开书籍页面…';
            await this.save();
          }
        }
        if (job.status === 'cancelled') await unlink(path.join(jobDirectory, result.filename)).catch(() => {});
        else { Object.assign(job, result); job.status = 'completed'; job.message = result.reused ? '文件已存在，已跳过下载' : '已保存'; job.progress = { receivedBytes: result.bytes, totalBytes: result.bytes, percent: 100 }; job.finishedAt = new Date().toISOString(); }
      } catch (e) {
        if (isDownloadLimit(e) && !controller.signal.aborted && job.status !== 'cancelled') {
          this.pauseForDownloadLimit(job, e);
        } else if (this.closing && job.status !== 'cancelled') {
          job.status = 'queued'; job.message = '服务已停止，等待继续';
        } else if (controller.signal.aborted && job.status === 'queued') {
          job.message = '已暂停，等待继续'; job.progress = null;
        } else if (job.status !== 'cancelled') {
          job.status = 'failed'; job.message = e.message;
          job.finishedAt = new Date().toISOString();
        }
      } finally {
        this.controllers.delete(job.id);
        await this.save();
      }
    })();
    this.tasks.set(job.id, task);
    void task.finally(() => this.tasks.delete(job.id)).catch(() => {});
    return task;
  }
  pauseForDownloadLimit(job, error) {
    const quota = error.code === 'DOWNLOAD_QUOTA_EXHAUSTED';
    const message = (quota ? error : downloadLimitError('request-limit', { httpStatus: 429 })).message;
    const reason = { kind: quota ? 'quota' : 'request-limit', message, detectedAt: new Date().toISOString(), ...(error.quota ? { quota: error.quota } : {}) };
    // A definite quota signal is stronger than an ambiguous rate-limit response.
    if (!this.autoPause || quota) this.autoPause = reason;
    this.paused = true; this.lastError = this.autoPause.message;
    job.status = 'queued'; job.message = this.autoPause.message; job.progress = null; job.autoPause = this.autoPause;
    delete job.finishedAt;
    for (const [id, controller] of this.controllers) {
      if (id === job.id) continue;
      const other = this.jobs.find(item => item.id === id);
      // Preserve already-received bytes: these files may finish despite the next-request limit.
      if (other?.status === 'running' && !other.progress?.receivedBytes && !other.progress?.transferStarted) {
        other.status = 'queued'; other.message = this.autoPause.message; other.autoPause = this.autoPause; other.progress = null;
        controller.abort();
      }
    }
  }
  async resumeAfterQuotaCheck(reason, quota) {
    if (this.closing || !this.paused || this.autoPause !== reason || reason?.kind !== 'quota' || reason.manual || this.lastError !== reason.message) return false;
    if (!Number.isInteger(quota?.used) || !Number.isInteger(quota?.limit) || quota.used < 0 || quota.limit <= 0 || quota.used >= quota.limit) return false;
    // A changed allowance could mean the login expired and the page belongs to a guest.
    if (!reason.quota?.limit || reason.quota.limit !== quota.limit) return false;
    await this.action('resume'); return true;
  }
  async waitForQuotaRecovery(quota, controlVersion = this.controlVersion) {
    if (this.closing || !this.paused || this.busy || this.controllers.size || controlVersion !== this.controlVersion) throw new Error('队列状态已变化，请先暂停下载后重新设置');
    if (this.lastError && this.lastError !== this.autoPause?.message) throw new Error('请先处理队列错误，再设置额度等待');
    if (!Number.isInteger(quota?.used) || !Number.isInteger(quota?.limit) || quota.limit <= 0 || quota.used < quota.limit) throw new Error('未确认每日额度已满，保持原队列状态');
    if (!this.jobs.some(job => job.status === 'queued' && runnable(job))) throw new Error('没有可自动继续的待下载任务，单独暂停的书单需手动解除');
    this.controlVersion++;
    this.autoPause = { kind: 'quota', message: downloadLimitError().message, quota: { used: quota.used, limit: quota.limit }, detectedAt: new Date().toISOString() };
    this.lastError = this.autoPause.message;
    await this.save();
  }
  async pump() {
    if (this.busy || this.paused) return;
    this.busy = true; this.onChange();
    while (true) {
      if (!this.paused) {
        while (this.tasks.size < this.concurrency) {
          const job = this.jobs.find(item => item.status === 'queued' && runnable(item));
          if (!job) break;
          this.run(job);
        }
      }
      if (!this.tasks.size) break;
      await Promise.race([...this.tasks.values()]);
      if (!this.paused && this.jobs.some(job => job.status === 'queued' && runnable(job)) && this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
  }
  snapshot() { return { jobs: this.jobs, paused: this.paused, busy: this.busy, concurrency: this.concurrency, error: this.lastError, recovery: recoverySummary(this.recovery), autoPause: this.autoPause, quotaRecovery: this.quotaRecovery?.snapshot(), summary: summarizeJobs(this.jobs), batches: summarizeBatches(this.jobs) }; }
  async close() {
    this.closing = true;
    this.paused = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.pumpTask;
    await this.saves;
  }
}
