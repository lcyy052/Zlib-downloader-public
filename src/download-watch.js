import { downloadHttpError } from './download-errors.js';
import { downloadLimitOnResponse } from './download-limit.js';

// Watch only this download's navigation, including a download opened in a new tab.
export function watchDownload(context, page, { idleTimeoutMs = 120000, totalTimeoutMs = 900000, requireProgress = false, checkLimit, limitPollMs = 500 } = {}) {
  let rejectFailure, failureError, idleTimer, totalTimer, disposed = false;
  let received = -1, transferring = false, sawProgress = false, completed = false;
  const popups = new Set();
  const navigationErrors = new Map();
  let limitTimer;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  function fail(message) {
    if (disposed || failureError) return;
    failureError = message instanceof Error ? message : new Error(message);
    rejectFailure(failureError);
  }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(`文件传输连续 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到新数据，已停止此任务；可稍后重试，其他书籍会继续下载。`), idleTimeoutMs);
    idleTimer.unref?.();
  }
  function failHttp(status) {
    fail(downloadHttpError(status));
  }
  async function onPage(popup) {
    try {
      if (disposed || await popup.opener() !== page || disposed) return;
      popups.add(popup);
      await popup.waitForLoadState('domcontentloaded', { timeout: 15000 });
      if (checkLimit) { const limit = await checkLimit(popup); if (limit && !disposed) { fail(limit); return; } }
      const status = navigationErrors.get(popup.url());
      if (status && !disposed) failHttp(status);
    } catch { /* Closing or attachment-download popups need no document check. */ }
  }
  async function onResponse(response) {
    try {
      if (disposed || !response.request().isNavigationRequest()) return;
      // The first popup response can arrive before Playwright has assigned its frame.
      if (response.status() >= 400) navigationErrors.set(response.url(), response.status());
      const frame = response.frame(), responsePage = frame.page();
      if (frame !== responsePage.mainFrame()) return;
      if (responsePage !== page && await responsePage.opener() !== page) return;
      if (disposed) return;
      if (responsePage !== page) popups.add(responsePage);
      const limit = await downloadLimitOnResponse(response);
      if (limit) fail(limit);
      else if (response.status() >= 400) failHttp(response.status());
    } catch { /* A response may belong to a tab that has already closed. */ }
  }
  context.on('response', onResponse);
  context.on('page', onPage);
  async function pollLimit() {
    if (disposed || transferring || failureError) return;
    try {
      for (const tab of [page, ...popups]) { const limit = await checkLimit(tab); if (limit) { fail(limit); break; } }
    } catch { /* A closing page is not evidence of an exhausted quota. */ }
    if (!disposed && !transferring && !failureError) { limitTimer = setTimeout(pollLimit, limitPollMs); limitTimer.unref?.(); }
  }
  if (checkLimit) { limitTimer = setTimeout(pollLimit, limitPollMs); limitTimer.unref?.(); }
  return {
    race: task => Promise.race([task, failure]),
    get error() { return failureError; },
    progress(update) {
      if (disposed || failureError) return;
      sawProgress = true;
      if (update.state === 'completed') { completed = true; clearTimeout(idleTimer); return; }
      if (update.state === 'canceled') { fail('浏览器报告文件传输已取消或中断，请稍后重试。其他书籍会继续下载。'); return; }
      if (update.receivedBytes > received) {
        received = update.receivedBytes;
        if (transferring && !completed) armIdle();
      }
    },
    startTransfer() {
      transferring = true;
      clearTimeout(limitTimer);
      // Without byte events, use a bounded overall timeout instead of guessing inactivity.
      if ((sawProgress || requireProgress) && !completed) armIdle();
      totalTimer = setTimeout(() => fail(`文件传输超过 ${Math.ceil(totalTimeoutMs / 60000)} 分钟仍未完成，已停止此任务，请稍后重试。其他书籍会继续下载。`), totalTimeoutMs);
      totalTimer.unref?.();
    },
    async dispose() {
      disposed = true; clearTimeout(idleTimer); clearTimeout(totalTimer); clearTimeout(limitTimer);
      context.off('response', onResponse);
      context.off('page', onPage);
      await Promise.all([...popups].map(async popup => {
        let timer;
        await Promise.race([
          popup.close().catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, 2000); }),
        ]);
        clearTimeout(timer);
      }));
    },
  };
}
