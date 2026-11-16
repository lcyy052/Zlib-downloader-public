import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const pureSource = appSource.split('// End queue presentation helpers.')[0];
const { queueControlState, queueResumeState, batchStatus, batchResumeLabel, queuedJobMessage } = await import('data:text/javascript,' + encodeURIComponent(pureSource + '\nexport { queueControlState, queueResumeState, batchStatus, batchResumeLabel, queuedJobMessage };'));

const queued = (state = 'active') => ({ status: 'queued', sources: [{ id: 'list', state }], message: '书单已暂停' });
const batch = { state: 'active', queued: 1, running: 0, failed: 0 };

test('recovered history explains its manual hold ahead of quota automation messages', () => {
  const queue = { jobs: [queued()], paused: true, recovery: { message: '已恢复记录，损坏尾部未恢复，请核对后手动继续。' }, autoPause: { kind: 'quota', manual: true } };
  assert.equal(queueControlState(queue).title, '下载记录已恢复，等待确认');
  assert.match(queueControlState(queue).description, /损坏尾部未恢复/);
});

test('recovered history without pending jobs can still be explicitly acknowledged', () => {
  const queue = { jobs: [{ status: 'completed' }], paused: true, recovery: { message: 'recovered' } };
  assert.equal(queueResumeState(queue).disabled, false);
  assert.equal(queueResumeState(queue).label, '确认恢复并开启队列');
  assert.equal(queueResumeState({ ...queue, recovery: null }).disabled, true);
  assert.equal(queueResumeState({ ...queue, paused: false }).disabled, true);
});

test('quota UI distinguishes exhaustion from rate limits and explains existing transfers', () => {
  const queue = { paused: true, jobs: [queued(), { status: 'running' }], autoPause: { kind: 'quota', message: '额度已满' } };
  assert.equal(queueControlState(queue).title, '下载额度已满，已自动暂停');
  assert.match(queueControlState(queue).description, /继续保存/);
  assert.equal(batchStatus(batch, queue), '等待额度恢复');
  assert.equal(queuedJobMessage(queued(), batch, queue), '额度已满');
  queue.autoPause = { kind: 'request-limit', message: 'HTTP 429，暂时限制请求' };
  assert.equal(queueControlState(queue).title, '网站限制请求，已自动暂停');
  assert.equal(batchStatus(batch, queue), '等待限制解除');
});

test('quota recovery UI shows next check and a manual hold overrides automation', () => {
  const queue = { paused: true, jobs: [queued()], autoPause: { kind: 'quota', message: '额度已满' }, quotaRecovery: { enabled: true, message: '等待定时检查', nextCheckAt: '2026-10-15T04:00:00.000Z' } };
  assert.match(queueControlState(queue).description, /下次检查/);
  assert.match(queueControlState(queue).description, /等待定时检查/);
  queue.autoPause.manual = true;
  assert.equal(queueControlState(queue).title, '已手动保持暂停');
  assert.match(queueControlState(queue).description, /不会自动恢复/);
});

test('global pause names the blocking gate rather than generic waiting', () => {
  const queue = { paused: true, jobs: [queued()] };
  assert.equal(queueControlState(queue).title, '总队列已暂停');
  assert.match(queueControlState(queue).description, /登录验证不会自动开始/);
  assert.equal(batchStatus(batch, queue), '随总队列暂停');
  assert.equal(batchResumeLabel(queue), '解除本书单暂停');
  assert.match(queuedJobMessage(queued(), batch, queue), /顶部/);
  assert.match(queuedJobMessage(queued('paused'), { ...batch, state: 'paused' }, queue), /均已暂停/);
});

test('an open global queue never implies individually paused booklists resumed', () => {
  const queue = { paused: false, jobs: [queued('paused')] };
  assert.equal(queueControlState(queue).title, '待下载书单均已暂停');
  assert.match(queueControlState(queue).description, /继续本书单/);
  assert.equal(batchStatus({ ...batch, state: 'paused' }, queue), '本书单已暂停');
  assert.equal(batchResumeLabel(queue), '继续本书单');
  assert.match(queuedJobMessage(queued(), batch, queue), /等待空闲/);
});

test('running, standalone, empty, failed and cancelled states remain meaningful', () => {
  const queue = { paused: false, concurrency: 3, jobs: [{ status: 'running' }, { status: 'queued' }] };
  assert.match(queueControlState(queue).title, /正在下载/);
  assert.match(queueControlState(queue).description, /3 本/);
  assert.equal(queueControlState({ paused: false, jobs: [{ status: 'queued' }] }).title, '下载队列已开启');
  assert.equal(queueControlState({ paused: false, jobs: [] }).title, '暂无待下载任务');
  assert.equal(queueControlState({ paused: true, jobs: [] }).pending, 0);
  assert.match(queueControlState({ paused: true, error: '503', jobs: [] }).description, /先处理/);
  assert.equal(batchStatus({ ...batch, queued: 0, failed: 1 }, queue), '完成，有失败');
  assert.equal(batchStatus({ ...batch, state: 'cancelled' }, queue), '已取消');
  assert.equal(batchStatus({ ...batch, queued: 0 }, queue), '下载完成');
  assert.equal(queuedJobMessage({ status: 'failed', message: 'HTTP 522' }, batch, queue), 'HTTP 522');
});
