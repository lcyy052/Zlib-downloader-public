import { createWriteStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tls from 'node:tls';
import { downloadHttpError } from './download-errors.js';
import { downloadLimitFromText, readDownloadNotice } from './download-limit.js';

function enableSystemCertificates() {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
  const certificates = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])];
  if (certificates.length) tls.setDefaultCACertificates(certificates);
}

enableSystemCertificates();

function causes(error) {
  const values = [];
  for (let current = error; current && !values.includes(current); current = current.cause) values.push(current);
  return values;
}

const networkCodes = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'DOWNLOAD_HTTP_TIMEOUT']);

export function isDownloadNetworkError(error) {
  return causes(error).some(item => networkCodes.has(item?.code));
}

function networkError(error) {
  const cause = causes(error).find(item => networkCodes.has(item?.code));
  if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(cause?.code)) return '下载服务器的证书需要使用 Windows 系统证书库验证。请重新运行 start.bat 后重试；如果仍失败，请检查本机代理或安全软件的 HTTPS 证书。';
  if (cause?.code === 'ENOTFOUND') return `无法解析下载服务器域名${cause.hostname ? ` ${cause.hostname}` : ''}，请检查 DNS、代理或网络连接。`;
  if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return '直连下载服务器超时，将尝试改用 Chrome 的网络连接下载。';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(cause?.code)) return `连接下载服务器失败（${cause.code}），将尝试改用 Chrome 的网络连接下载。`;
  return '';
}

export async function downloadHttp({ url, destination, headers = {}, signal, onProgress = () => {}, fetchImpl = fetch, requestTimeoutMs = 120000, idleTimeoutMs = 120000, totalTimeoutMs = 3600000 }) {
  const temporary = `${destination}.${randomUUID()}.part`;
  const controller = new AbortController();
  const transferSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const fail = message => controller.abort(Object.assign(new Error(message), { code: 'DOWNLOAD_HTTP_TIMEOUT' }));
  const armIdle = (timeoutMs, message) => { clearTimeout(timer); timer = setTimeout(() => fail(message), timeoutMs); };
  const idleMessage = `直连文件传输连续 ${Math.ceil(idleTimeoutMs / 1000)} 秒没有收到新数据`;
  const totalTimer = setTimeout(() => fail(`直连文件传输超过 ${Math.ceil(totalTimeoutMs / 60000)} 分钟仍未完成`), totalTimeoutMs);
  armIdle(requestTimeoutMs, `直连下载服务器超时（${Math.ceil(requestTimeoutMs / 1000)} 秒未收到响应）`);
  try {
    const response = await fetchImpl(url, { headers, redirect: 'follow', signal: transferSignal });
    const contentType = response.headers.get('content-type') || '';
    const isPage = /text\/html|application\/(?:xhtml\+xml|json)/i.test(contentType);
    if (isPage || (!response.ok && /text\/plain/i.test(contentType))) {
      const limit = downloadLimitFromText(await readDownloadNotice(response), response.status);
      if (limit) throw limit;
    }
    if (!response.ok) throw downloadHttpError(response.status);
    if (isPage) throw new Error('网站返回了网页而非电子书，请检查登录状态或下载额度');
    if (!response.body) throw new Error('下载服务器没有返回文件内容');
    armIdle(idleTimeoutMs, idleMessage);

    const totalBytes = Number(response.headers.get('content-length')) || 0;
    let receivedBytes = 0;
    let lastPercent = -1;
    let lastReport = 0;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        receivedBytes += chunk.length;
        if (chunk.length) armIdle(idleTimeoutMs, idleMessage);
        const percent = totalBytes ? Math.min(99, Math.floor(receivedBytes * 100 / totalBytes)) : null;
        const now = Date.now();
        if (percent !== lastPercent || now - lastReport >= 500 || receivedBytes === totalBytes) {
          lastPercent = percent; lastReport = now;
          onProgress({ state: 'inProgress', message: '正在传输文件…', receivedBytes, totalBytes, percent });
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' }), { signal: transferSignal });
    if (!receivedBytes) throw new Error('下载的文件为空');
    await rename(temporary, destination);
    return stat(destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (controller.signal.aborted && !signal?.aborted) throw controller.signal.reason;
    const message = networkError(error);
    if (message) throw new Error(message, { cause: error });
    throw error;
  } finally { clearTimeout(timer); clearTimeout(totalTimer); }
}
