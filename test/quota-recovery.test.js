import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DownloadQueue } from '../src/queue.js';
import { QuotaRecovery, quotaRecoverySettings } from '../src/quota-recovery.js';
import { dailyQuotaFromText, downloadLimitFromText } from '../src/download-limit.js';

test('recovery settings are opt-in and intervals are bounded', () => {
  assert.deepEqual(quotaRecoverySettings(), { quotaAutoResume: false, quotaCheckMinutes: 30 });
  assert.deepEqual(quotaRecoverySettings({ quotaAutoResume: true, quotaCheckMinutes: 5 }), { quotaAutoResume: true, quotaCheckMinutes: 5 });
  for (const value of [0, 4, 1441, '30', 5.5]) assert.throws(() => quotaRecoverySettings({ quotaCheckMinutes: value }));
  assert.throws(() => quotaRecoverySettings({ quotaAutoResume: 'true' }));
});

test('positive quota parsing rejects missing, conflicting and zero allowance counters', () => {
  assert.deepEqual(dailyQuotaFromText('0/999 每日限额'), { used: 0, limit: 999 });
  assert.deepEqual(dailyQuotaFromText('Daily limit: 998 / 999'), { used: 998, limit: 999 });
  assert.deepEqual(dailyQuotaFromText('999/999 每日限额'), { used: 999, limit: 999 });
  for (const text of ['website OK', '每日限额：999', '0/0 每日限额', '0/999 books', '0/999 每日限额 999/999 每日限额']) assert.equal(dailyQuotaFromText(text), null);
});

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zlib-recovery-'));
  let clock = 1000000, checks = 0, downloads = 0;
  const settings = { quotaAutoResume: true, quotaCheckMinutes: 30 };
  const provider = { active: 0, checkDownloadQuota: async () => { checks++; return { available: false, quota: { used: 999, limit: 999 }, message: '仍已满' }; }, download: async () => { downloads++; return { filename: 'fixture.pdf', bytes: 42 }; } };
  const queue = new DownloadQueue({ file: path.join(directory, 'queue.json'), directory, provider, delayMs: 0 });
  await queue.init();
  queue.jobs = ['active', 'paused'].map((state, id) => ({ id: String(id), status: 'queued', attempts: 0, book: { title: 'Fixture ' + id, format: 'PDF', url: 'https://fixture.example/book/' + id }, sources: [{ id: String(id), title: 'Fixture list', state }], downloadRoot: directory }));
  const error = downloadLimitFromText('999/999 每日限额');
  queue.pauseForDownloadLimit(queue.jobs[0], error);
  const monitor = new QuotaRecovery({ queue, provider, getSettings: () => settings, now: () => clock });
  t.after(async () => { await monitor.close(); await queue.close(); await rm(directory, { recursive: true, force: true }); });
  return { queue, provider, monitor, settings, get checks() { return checks; }, get downloads() { return downloads; }, due: async () => { clock += settings.quotaCheckMinutes * 60000 + 1; monitor.tick(); await monitor.pending; } };
}

test('periodic checks wait for fresh positive evidence then resume only active sources', async t => {
  const fixture = await setup(t); const { monitor, provider, queue } = fixture;
  monitor.tick(); assert.equal(fixture.checks, 0); assert.ok(monitor.snapshot().nextCheckAt);
  await fixture.due(); assert.equal(fixture.checks, 1); assert.equal(queue.paused, true); assert.equal(fixture.downloads, 0);
  provider.checkDownloadQuota = async () => ({ available: false, quota: null });
  await fixture.due(); assert.equal(queue.paused, true);
  provider.checkDownloadQuota = async () => ({ available: true, quota: { used: 0, limit: 999 } });
  await fixture.due(); await queue.pumpTask;
  assert.equal(queue.paused, false); assert.equal(queue.autoPause, null);
  assert.equal(fixture.downloads, 1); assert.equal(queue.jobs[0].status, 'completed');
  assert.equal(queue.jobs[1].status, 'queued'); assert.equal(queue.jobs[1].sources[0].state, 'paused');
  assert.match(monitor.state.message, /自动继续/);
});

test('manual pause, disabled option, request limits and local-only paused lists never get checked', async t => {
  const fixture = await setup(t); const { monitor, settings, queue } = fixture;
  settings.quotaAutoResume = false; monitor.tick(); await fixture.due(); assert.equal(fixture.checks, 0);
  settings.quotaAutoResume = true; queue.autoPause.kind = 'request-limit'; monitor.tick(); await fixture.due(); assert.equal(fixture.checks, 0);
  queue.autoPause.kind = 'quota'; await queue.action('pause'); monitor.tick(); await fixture.due(); assert.equal(fixture.checks, 0);
  assert.equal(queue.autoPause.manual, true);
  const restarted = new DownloadQueue({ file: queue.file, directory: queue.directory, provider: queue.provider });
  await restarted.init(); assert.equal(restarted.autoPause.manual, true); await restarted.close();
  queue.autoPause.manual = false; queue.jobs[0].sources[0].state = 'paused'; monitor.tick(); await fixture.due(); assert.equal(fixture.checks, 0);
});

test('network errors, changed guest allowance, nonpositive and unknown quota cannot resume', async t => {
  const fixture = await setup(t); const { monitor, provider, queue } = fixture;
  monitor.tick(); provider.checkDownloadQuota = async () => { throw new Error('HTTP 503'); };
  await fixture.due(); assert.equal(queue.paused, true); assert.match(monitor.state.message, /保持暂停/);
  for (const quota of [null, { used: 0, limit: 10 }, { used: 999, limit: 999 }, { used: -1, limit: 999 }]) {
    provider.checkDownloadQuota = async () => ({ available: true, quota });
    await fixture.due(); assert.equal(queue.paused, true); assert.equal(fixture.downloads, 0);
  }
  delete queue.autoPause.quota;
  provider.checkDownloadQuota = async () => ({ available: true, quota: { used: 0, limit: 999 } });
  await fixture.due(); assert.equal(queue.paused, true);
});

test('no overlapping checks and manual pause while a probe is in flight wins', async t => {
  const fixture = await setup(t); const { monitor, provider, queue } = fixture;
  let release, calls = 0;
  provider.checkDownloadQuota = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  monitor.tick(); const pending = fixture.due(); await new Promise(resolve => setImmediate(resolve));
  monitor.tick(); assert.equal(calls, 1);
  await queue.action('pause'); release({ available: true, quota: { used: 0, limit: 999 } });
  await pending; assert.equal(queue.paused, true); assert.equal(fixture.downloads, 0);
});

test('disabling, changing settings or shutting down during a probe prevents automatic resume', async t => {
  const fixture = await setup(t); const { monitor, provider, queue, settings } = fixture;
  for (const mode of ['disable', 'configure', 'close']) {
    settings.quotaAutoResume = true; monitor.configure();
    let release;
    provider.checkDownloadQuota = () => new Promise(resolve => { release = resolve; });
    const pending = fixture.due(); await new Promise(resolve => setImmediate(resolve));
    if (mode === 'disable') { settings.quotaAutoResume = false; monitor.configure(); }
    if (mode === 'configure') monitor.configure();
    const closing = mode === 'close' ? monitor.close() : null;
    release({ available: true, quota: { used: 0, limit: 999 } });
    await pending; await closing;
    assert.equal(queue.paused, true); assert.equal(fixture.downloads, 0);
  }
});

test('browser busy and persistence errors keep the queue paused', async t => {
  const fixture = await setup(t); const { monitor, provider, queue } = fixture;
  provider.active = 1; monitor.tick(); await fixture.due(); assert.equal(fixture.checks, 0);
  provider.active = 0; queue.lastError = '任务记录保存失败'; monitor.tick(); await fixture.due(); assert.equal(fixture.checks, 0);
  assert.equal(queue.paused, true);
});

test('explicit quota waiting arms a manually paused queue without a single download attempt', async t => {
  const fixture = await setup(t); const { queue, monitor } = fixture;
  queue.autoPause = null; queue.lastError = '';
  const jobs = structuredClone(queue.jobs);
  await queue.waitForQuotaRecovery({ used: 999, limit: 999 });
  monitor.configure();
  assert.deepEqual(queue.jobs, jobs); assert.equal(fixture.downloads, 0);
  assert.equal(queue.paused, true); assert.equal(queue.autoPause.kind, 'quota');
  assert.ok(monitor.state.nextCheckAt);
  const restarted = new DownloadQueue({ file: queue.file, directory: queue.directory, provider: queue.provider });
  await restarted.init(); assert.deepEqual(restarted.autoPause.quota, { used: 999, limit: 999 }); await restarted.close();
});

test('quota waiting rejects available, unknown and stale results without overriding manual pause', async t => {
  const fixture = await setup(t); const { queue } = fixture;
  for (const quota of [null, { used: 0, limit: 999 }, { used: 0, limit: 0 }]) await assert.rejects(queue.waitForQuotaRecovery(quota));
  const version = queue.controlVersion;
  await queue.action('pause');
  await assert.rejects(queue.waitForQuotaRecovery({ used: 999, limit: 999 }, version), /状态已变化/);
  assert.equal(queue.autoPause.manual, true); assert.equal(fixture.downloads, 0);
});

test('account recovery resumes multiple active booklists together but preserves individually paused ones', async t => {
  const fixture = await setup(t); const { queue, provider, monitor } = fixture;
  queue.jobs.push({ ...structuredClone(queue.jobs[0]), id: 'third', book: { title: 'Third fixture', format: 'PDF', url: 'https://fixture.example/book/third' }, sources: [{ id: 'third-list', title: 'Third fixture list', state: 'active' }] });
  monitor.tick();
  await fixture.due();
  assert.equal(queue.paused, true); assert.equal(fixture.downloads, 0);
  assert.ok(queue.jobs.every(job => job.status === 'queued'));
  provider.checkDownloadQuota = async () => ({ available: true, quota: { used: 0, limit: 999 } });
  await fixture.due(); await queue.pumpTask;
  assert.equal(fixture.downloads, 2);
  assert.deepEqual(queue.jobs.map(job => job.status), ['completed', 'queued', 'completed']);
  assert.equal(queue.jobs[1].sources[0].state, 'paused');
  assert.equal(queue.autoPause, null);
});
