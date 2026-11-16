// FIFO permits: an aborted caller cannot release a running task's slot early.
export class TaskLimiter {
  constructor(limit = 1) { this.limit = typeof limit === 'function' ? limit : () => limit; this.active = 0; this.pending = []; }
  run(task, signal) {
    if (signal?.aborted) return Promise.reject(new Error('已取消'));
    return new Promise((resolve, reject) => {
      const item = { task, signal, resolve, reject, started: false, cancelled: false };
      item.abort = () => {
        item.cancelled = true; reject(new Error('已取消'));
        if (!item.started) { this.pending = this.pending.filter(value => value !== item); signal.removeEventListener('abort', item.abort); this.pump(); }
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.pending.push(item); this.pump();
    });
  }
  pump() {
    const limit = Math.max(1, Math.floor(Number(this.limit())) || 1);
    while (this.active < limit && this.pending.length) {
      const item = this.pending.shift();
      if (item.cancelled || item.signal?.aborted) { item.reject(new Error('已取消')); item.signal?.removeEventListener('abort', item.abort); continue; }
      this.active++; item.started = true;
      void Promise.resolve().then(item.task).then(
        result => item.cancelled ? item.reject(new Error('已取消')) : item.resolve(result),
        error => item.reject(error),
      ).finally(() => { this.active--; item.signal?.removeEventListener('abort', item.abort); this.pump(); }).catch(() => {});
    }
  }
}
