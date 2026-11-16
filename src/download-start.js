// Call this only after acquiring the download-start slot: queueing is not a
// network timeout. Remove the event listener on every completion/cancellation.
export async function waitForDownloadStart({ page, context = page.context?.(), trigger, directTransfer, signal, watch, timeoutMs = 120000 }) {
  if (signal.aborted) throw new Error('已取消');
  let timer, onDownload, onAbort, onPage, disposed = false, claimed;
  const listeners = new Map();
  async function belongsToTask(candidate) {
    const seen = new Set();
    while (candidate && !seen.has(candidate)) {
      if (candidate === page) return true;
      seen.add(candidate);
      candidate = await candidate.opener();
    }
    return false;
  }
  const started = new Promise((resolve, reject) => {
    onDownload = download => { if (!disposed && !claimed) { claimed = download; resolve({ download }); } };
    onAbort = () => reject(new Error('已取消'));
    page.on('download', onDownload);
    // An initialized popup emits its download on that popup, not the opener.
    // Attach synchronously, then check ancestry: awaiting opener() first can
    // miss a fast response. Only pages created during this attempt qualify.
    onPage = popup => {
      if (disposed || popup === page || listeners.has(popup)) return;
      const listener = download => {
        void belongsToTask(popup).then(owned => {
          if (owned && !disposed && !claimed) onDownload(download);
        }).catch(() => {});
      };
      listeners.set(popup, listener);
      popup.on('download', listener);
    };
    context?.on('page', onPage);
    page.on('popup', onPage);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(Object.assign(new Error(`下载启动超时：点击下载后 ${Math.ceil(timeoutMs / 1000)} 秒未收到文件响应，将重新获取下载链接。`), { code: 'DOWNLOAD_START_TIMEOUT' })), timeoutMs);
  });
  const outcome = directTransfer ? Promise.race([started, directTransfer.then(direct => ({ direct }))]) : started;
  try {
    const pending = Promise.all([outcome, Promise.resolve().then(trigger)]);
    const [result] = await (watch ? watch.race(pending) : pending);
    return result;
  } catch (error) {
    // A click can fail after Chrome has already accepted the download.
    // Do not leave that recognized transfer running behind the retry.
    if (claimed) void claimed.cancel().catch(() => {});
    throw error;
  } finally {
    disposed = true;
    clearTimeout(timer);
    page.off('download', onDownload);
    page.off('popup', onPage);
    context?.off('page', onPage);
    for (const [popup, listener] of listeners) popup.off('download', listener);
    signal.removeEventListener('abort', onAbort);
  }
}
