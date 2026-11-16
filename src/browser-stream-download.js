import { randomUUID } from 'node:crypto';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { watchDownload } from './download-watch.js';
import { downloadHttpError } from './download-errors.js';
import { downloadLimitFromText } from './download-limit.js';

async function settle(promise, timeoutMs = 2000) {
  let timer;
  try { await Promise.race([promise.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

const header = (entries, name) => entries?.find(entry => entry.name.toLowerCase() === name)?.value || '';

// Read at response headers, before Chrome's crash-prone native download manager.
// loadNetworkResource, in contrast, returns only after receiving the whole file.
export async function downloadWithBrowserStream({ context, page, url, destination, signal = new AbortController().signal, onProgress = () => {}, timeouts = {} }) {
  const temporary = `${destination}.${randomUUID()}.part`;
  const watch = watchDownload(context, page, { totalTimeoutMs: 3600000, requireProgress: true, ...timeouts });
  let session, file, stream, rejectResponse, responseTimer, onPaused;
  const intercepted = new Set();
  const interrupted = new Promise((_, reject) => { rejectResponse = reject; });
  interrupted.catch(() => {});
  const onAbort = () => rejectResponse(new Error('已取消'));
  signal.addEventListener('abort', onAbort, { once: true });
  const race = task => watch.race(Promise.race([task, interrupted]));
  try {
    if (signal.aborted) throw new Error('已取消');
    responseTimer = setTimeout(() => rejectResponse(Object.assign(new Error(`Chrome 网络请求超时（${Math.ceil((timeouts.startTimeoutMs || 120000) / 1000)} 秒未收到下载响应）`), { code: 'DOWNLOAD_START_TIMEOUT' })), timeouts.startTimeoutMs || 120000);
    session = await race(context.newCDPSession(page));
    const { frameTree } = await race(session.send('Page.getFrameTree'));
    const response = new Promise((resolve, reject) => {
      onPaused = event => {
        intercepted.add(event.requestId);
        void (async () => {
          if (event.frameId !== frameTree.frame.id || (event.responseStatusCode >= 300 && event.responseStatusCode < 400 && header(event.responseHeaders, 'location'))) {
            await session.send('Fetch.continueRequest', { requestId: event.requestId });
            intercepted.delete(event.requestId);
            return;
          }
          const isPage = /text\/html|application\/(?:xhtml\+xml|json)/i.test(header(event.responseHeaders, 'content-type'));
          if (isPage) {
            const noticeBody = await session.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
            stream = noticeBody.stream;
            const chunks = []; let count = 0;
            while (count < 65536) {
              const part = await race(session.send('IO.read', { handle: stream, size: Math.min(16384, 65536 - count) }));
              const bytes = Buffer.from(part.data || '', part.base64Encoded ? 'base64' : 'utf8');
              chunks.push(bytes); count += bytes.length;
              if (part.eof || !bytes.length) break;
            }
            const limit = downloadLimitFromText(Buffer.concat(chunks).toString('utf8'), event.responseStatusCode);
            if (limit) throw limit;
          }
          if (event.responseStatusCode >= 400) throw downloadHttpError(event.responseStatusCode);
          if (event.responseErrorReason) throw new Error(`Chrome 网络请求失败（${event.responseErrorReason}）`);
          if (isPage) throw new Error('网站返回了网页而非电子书，请检查登录状态或下载额度');
          const body = await session.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
          stream = body.stream;
          resolve({ stream, totalBytes: Number(header(event.responseHeaders, 'content-length')) || 0, encoded: Boolean(header(event.responseHeaders, 'content-encoding')) });
        })().catch(reject);
      };
      session.on('Fetch.requestPaused', onPaused);
    });
    response.catch(() => {});
    await race(session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }));
    onProgress('正在请求 Chrome 文件响应…');
    // Do not await navigation: it remains paused until the body has been read.
    void session.send('Page.navigate', { url, referrer: page.url() }).then(result => {
      if (result.errorText && !/ERR_ABORTED/.test(result.errorText)) rejectResponse(new Error(`Chrome 网络请求失败（${result.errorText}）`));
    }).catch(rejectResponse);
    const resource = await race(response);
    clearTimeout(responseTimer);
    watch.startTransfer();
    onProgress('正在通过 Chrome 分块传输文件…');
    file = await open(temporary, 'wx');
    let receivedBytes = 0;
    let lastReport = 0, lastPercent = -1;
    while (true) {
      if (signal.aborted) throw new Error('已取消');
      const chunk = await race(session.send('IO.read', { handle: resource.stream, size: 64 * 1024 }));
      const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      if (bytes.length) {
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await file.write(bytes, written, bytes.length - written);
          if (!bytesWritten) throw new Error('无法继续写入下载文件，请检查磁盘空间');
          written += bytesWritten;
        }
        receivedBytes += bytes.length;
        const update = { state: 'inProgress', message: '正在通过 Chrome 分块传输文件…', receivedBytes, totalBytes: resource.totalBytes, percent: resource.totalBytes ? Math.min(99, Math.floor(receivedBytes * 100 / resource.totalBytes)) : null };
        watch.progress(update);
        const now = Date.now();
        if (update.percent !== lastPercent || now - lastReport >= 500) {
          lastReport = now; lastPercent = update.percent;
          onProgress(update);
        }
      }
      if (chunk.eof) break;
    }
    if (!receivedBytes) throw new Error('下载的文件为空');
    if (!resource.encoded && resource.totalBytes && receivedBytes !== resource.totalBytes) throw new Error('Chrome 文件传输中断：接收字节数与文件大小不符，请稍后重试');
    if (signal.aborted) throw new Error('已取消');
    watch.progress({ state: 'completed', receivedBytes });
    await file.close(); file = null;
    await rename(temporary, destination);
    return await stat(destination);
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw watch.error || error;
  } finally {
    clearTimeout(responseTimer);
    signal.removeEventListener('abort', onAbort);
    // Never continue an intercepted attachment into the native download manager.
    if (stream) await settle(session.send('IO.close', { handle: stream }));
    if (session) {
      await Promise.all([...intercepted].map(requestId => settle(session.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }))));
      // Also cancel requests which have not received headers yet. Disabling
      // interception alone could otherwise let a late attachment download.
      await settle(session.send('Page.stopLoading'));
      if (onPaused) session.off('Fetch.requestPaused', onPaused);
      await settle(session.send('Fetch.disable'));
      await settle(session.detach());
    }
    await watch.dispose();
  }
}
