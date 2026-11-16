import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchDownload } from '../src/download-watch.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('browser navigation preserves HTTP 522 status and origin timeout message', async t => {
  const { context, frame, watch } = setup(t);
  context.emit('response', { url: () => 'https://download.example/file', status: () => 522, request: () => ({ isNavigationRequest: () => true }), frame: () => frame });
  await assert.rejects(watch.race(delay(100)), error => {
    assert.equal(error.httpStatus, 522); assert.match(error.message, /522（网站源站连接超时）/); return true;
  });
});
function setup(t, options = {}) {
  const context = new EventEmitter();
  const frame = {};
  const page = { mainFrame: () => frame };
  frame.page = () => page;
  const watch = watchDownload(context, page, options);
  t.after(() => watch.dispose());
  return { context, page, frame, watch };
}

test('repeated unchanged progress cannot keep a stalled transfer alive', async t => {
  const { watch } = setup(t, { idleTimeoutMs: 30 });
  watch.progress({ receivedBytes: 44 }); watch.startTransfer();
  const result = watch.race(delay(250));
  const assertion = assert.rejects(result, /没有收到新数据/);
  for (let i = 0; i < 5; i++) { await delay(10); watch.progress({ receivedBytes: 44 }); }
  await assertion;
});

test('advancing bytes reset the inactivity deadline and completion stops it', async t => {
  const { watch } = setup(t, { idleTimeoutMs: 100 });
  watch.startTransfer();
  for (let bytes = 1; bytes < 5; bytes++) { watch.progress({ receivedBytes: bytes }); await watch.race(delay(40)); }
  watch.progress({ state: 'completed', receivedBytes: 5 });
  await watch.race(delay(140));
  assert.equal(watch.error, undefined);
});

test('missing progress events still have a bounded overall timeout', async t => {
  const { watch } = setup(t, { idleTimeoutMs: 10, totalTimeoutMs: 50 });
  watch.startTransfer();
  await assert.rejects(watch.race(delay(200)), /仍未完成/);
});

test('ignores unrelated tabs and subresources, reports a download popup HTTP 504', async t => {
  const { context, page, frame, watch } = setup(t);
  const response = (responseFrame, navigation = true) => ({ url: () => 'https://download.example/file', status: () => 504, request: () => ({ isNavigationRequest: () => navigation }), frame: () => responseFrame });
  context.emit('response', response(frame, false));
  const unrelatedFrame = {};
  unrelatedFrame.page = () => ({ mainFrame: () => unrelatedFrame, opener: async () => null });
  context.emit('response', response(unrelatedFrame));
  await watch.race(delay(10));
  let closed = false;
  const popupFrame = {};
  popupFrame.page = () => ({ mainFrame: () => popupFrame, opener: async () => page, close: async () => { closed = true; } });
  context.emit('response', response(popupFrame));
  await assert.rejects(watch.race(delay(100)), /HTTP 504（网关超时）/);
  await watch.dispose();
  assert.equal(closed, true);
  assert.equal(context.listenerCount('response'), 0);
});
