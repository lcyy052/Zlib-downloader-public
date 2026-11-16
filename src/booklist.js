export function validateBooklistUrl(value, base) {
  const url = new URL(value);
  if (url.origin !== new URL(base).origin || url.username || url.password || !/^\/booklist\/\d+\/[\w-]+(?:\/|$)/.test(url.pathname)) throw new Error('请粘贴当前站点的完整书单链接，例如 /booklist/3803973/ddd1f7/ai8.html');
  url.hash = ''; url.search = '';
  return url.href;
}

export function summarizeJobs(jobs) {
  const counts = Object.fromEntries(['queued', 'running', 'completed', 'failed', 'cancelled'].map(status => [status, jobs.filter(j => j.status === status).length]));
  const finished = counts.completed + counts.failed + counts.cancelled;
  return { total: jobs.length, ...counts, finished, percent: jobs.length ? Math.round(finished / jobs.length * 100) : 0 };
}

export function summarizeBatches(jobs) {
  const groups = new Map();
  for (const job of jobs) for (const source of job.sources || []) {
    if (!groups.has(source.id)) groups.set(source.id, { ...source, states: [], jobs: [] });
    const group = groups.get(source.id);
    group.states.push(source.state || 'active');
    group.jobs.push(job);
  }
  return [...groups.values()].map(({ jobs, states, ...source }) => ({
    ...source,
    state: states.every(state => state === 'cancelled') ? 'cancelled' : states.some(state => state === 'active') ? 'active' : 'paused',
    ...summarizeJobs(jobs),
  }));
}
