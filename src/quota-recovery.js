export function quotaRecoverySettings(input = {}) {
  const enabled = input.quotaAutoResume ?? false;
  const minutes = input.quotaCheckMinutes ?? 30;
  if (typeof enabled !== 'boolean') throw new Error('额度自动恢复选项必须为布尔值');
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error('额度检查间隔必须为 5–1440 分钟');
  return { quotaAutoResume: enabled, quotaCheckMinutes: minutes };
}

export class QuotaRecovery {
  constructor({ queue, provider, getSettings, onChange = () => {}, now = Date.now }) {
    Object.assign(this, { queue, provider, getSettings, onChange, now });
    queue.quotaRecovery = this;
    this.state = { enabled: false, intervalMinutes: 30, message: '未开启额度恢复后自动继续', nextCheckAt: null };
    this.generation = 0;
  }
  snapshot() { return { ...this.state }; }
  eligible() {
    return this.getSettings().quotaAutoResume && this.queue.paused && this.queue.autoPause?.kind === 'quota' && !this.queue.autoPause.manual && this.queue.lastError === this.queue.autoPause.message && !this.queue.closing && this.queue.jobs.some(job => job.status === 'queued' && (!job.sources?.length || job.sources.some(source => (source.state || 'active') === 'active')));
  }
  publish() { this.onChange(); }
  configure() {
    this.generation++;
    this.controller?.abort();
    this.state.nextCheckAt = null;
    this.tick();
  }
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 60000);
    this.timer.unref?.();
  }
  tick() {
    if (this.closed) return;
    const settings = this.getSettings();
    this.state.enabled = settings.quotaAutoResume;
    this.state.intervalMinutes = settings.quotaCheckMinutes;
    if (!this.eligible()) {
      this.state.nextCheckAt = null;
      this.state.message = !settings.quotaAutoResume ? '未开启额度恢复后自动继续' : this.queue.autoPause?.manual ? '已手动保持暂停，不会自动恢复' : '仅在因每日额度用完而自动暂停时检查';
      this.publish(); return;
    }
    if (this.pending) return;
    if (!this.state.nextCheckAt) {
      this.state.nextCheckAt = new Date(this.now() + settings.quotaCheckMinutes * 60000).toISOString();
      this.state.message = '等待定时检查；确认额度恢复后将自动继续';
      this.publish(); return;
    }
    if (this.now() >= Date.parse(this.state.nextCheckAt)) {
      this.pending = this.check().catch(() => { this.state.message = '额度检查失败，保持暂停'; }).finally(() => { this.pending = null; this.publish(); });
    }
  }
  async check() {
    const reason = this.queue.autoPause, generation = this.generation;
    this.controller = new AbortController();
    this.state.message = '正在后台检查每日下载额度…'; this.publish();
    try {
      if (this.provider.active || this.provider.launching) { this.state.message = '浏览器正在处理其他任务，稍后再检查'; return; }
      const result = await this.provider.checkDownloadQuota({ signal: this.controller.signal });
      if (this.closed || generation !== this.generation || !this.eligible() || this.queue.autoPause !== reason) return;
      this.state.lastCheckedAt = new Date(this.now()).toISOString();
      this.state.quota = result.quota || null;
      if (result.available === true && await this.queue.resumeAfterQuotaCheck(reason, result.quota)) this.state.message = '已确认每日额度恢复，已自动继续下载';
      else this.state.message = result.available ? '新额度与原账号限额无法核对，保持暂停；请确认账号后手动继续' : result.message || '未确认额度恢复，保持暂停';
    } catch {
      if (!this.closed && generation === this.generation) this.state.message = '网站无法访问或需要登录验证，保持暂停；请打开登录浏览器检查';
    } finally {
      this.controller = null;
      if (!this.closed && generation === this.generation) this.state.nextCheckAt = this.eligible() ? new Date(this.now() + this.getSettings().quotaCheckMinutes * 60000).toISOString() : null;
    }
  }
  async close() { this.closed = true; this.generation++; clearInterval(this.timer); this.controller?.abort(); await this.pending; }
}
