import { randomUUID } from 'node:crypto';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { declaredBytes } from './existing-download.js';
import { downloadHttpError } from './download-errors.js';

export function browserRequestTimeout(size) {
  const megabytes = declaredBytes(size) / (1024 * 1024);
  return Math.min(300000, Math.max(45000, Math.ceil(megabytes * 4000)));
}

function header(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] || '';
}

async function command(session, method, params, { signal, timeoutMs, timeoutMessage }) {
  let timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('已取消'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try { return await Promise.race([session.send(method, params), interrupted]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

async function settle(promise, timeoutMs = 2000) {
  let timer;
  await Promise.race([promise.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(timer);
}

export async function downloadWithBrowserNetwork({ context, page, url, destination, signal, onProgress = () => {}, requestTimeoutMs = 45000, idleTimeoutMs = 60000 }) {
  const temporary = `${destination}.${randomUUID()}.part`;
  const session = await context.newCDPSession(page);
  let file, stream;
  try {
    if (signal.aborted) throw new Error('已取消');
    const { frameTree } = await command(session, 'Page.getFrameTree', {}, {
      signal, timeoutMs: 5000, timeoutMessage: 'Chrome 下载页面连接超时',
    });
    const { resource } = await command(session, 'Network.loadNetworkResource', {
      frameId: frameTree.frame.id,
      url,
      options: { disableCache: true, includeCredentials: true },
    }, {
      signal, timeoutMs: requestTimeoutMs, timeoutMessage: `Chrome 网络请求超时（${Math.ceil(requestTimeoutMs / 1000)} 秒未收到下载响应）`,
    });
    // Chrome often reports HTTP 5xx responses as both success=false and
    // ERR_HTTP_RESPONSE_CODE_FAILURE. Preserve the concrete status first so
    // the queue can classify temporary gateway failures and retry them.
    if (resource.httpStatusCode >= 400) throw downloadHttpError(resource.httpStatusCode);
    if (!resource.success) throw new Error(`Chrome 网络请求失败${resource.netErrorName ? `（${resource.netErrorName}）` : ''}`);
    const contentType = header(resource.headers, 'content-type');
    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error('网站返回了网页而非电子书，请检查登录状态或下载额度');
    if (!resource.stream) throw new Error('Chrome 未返回文件数据流');

    stream = resource.stream;
    file = await open(temporary, 'wx');
    const totalBytes = Number(header(resource.headers, 'content-length')) || 0;
    let receivedBytes = 0;
    while (true) {
      if (signal.aborted) throw new Error('已取消');
      const chunk = await command(session, 'IO.read', { handle: stream, size: 256 * 1024 }, {
        signal, timeoutMs: idleTimeoutMs, timeoutMessage: `Chrome 文件传输超时（连续 ${Math.ceil(idleTimeoutMs / 1000)} 秒没有新数据）`,
      });
      const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      if (bytes.length) {
        await file.write(bytes);
        receivedBytes += bytes.length;
        onProgress({
          state: 'inProgress',
          message: '正在通过 Chrome 传输文件…',
          receivedBytes,
          totalBytes,
          percent: totalBytes ? Math.min(99, Math.floor(receivedBytes * 100 / totalBytes)) : null,
        });
      }
      if (chunk.eof) break;
    }
    if (!receivedBytes) throw new Error('下载的文件为空');
    await settle(session.send('IO.close', { handle: stream })); stream = null;
    await file.close(); file = null;
    await rename(temporary, destination);
    return stat(destination);
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    if (stream) await settle(session.send('IO.close', { handle: stream }));
    await settle(session.detach());
  }
}
