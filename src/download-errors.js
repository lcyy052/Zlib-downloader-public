import { downloadLimitError } from './download-limit.js';

const retryableStatuses = new Set([410, 502, 503, 504, 522]);

export function downloadHttpStatus(error) {
  return Number(error?.httpStatus) || Number(error?.message?.match(/下载服务器返回 HTTP (\d{3})\b/)?.[1]) || 0;
}

export function isRetryableDownloadHttpError(error) {
  return retryableStatuses.has(downloadHttpStatus(error));
}

// Keep status and wording consistent for HTTP, browser navigation and CDP.
export function downloadHttpError(status) {
  if (status === 429) return downloadLimitError('request-limit', { httpStatus: status });
  const reasons = { 410: '下载链接已失效', 502: '网关错误', 503: '服务暂时不可用', 504: '网关超时', 522: '网站源站连接超时' };
  let message;
  if (status === 429) message = '下载服务器返回 HTTP 429（请求过于频繁或达到下载限制）。请暂停下载，稍后再试，并检查网站显示的下载额度。';
  else {
    const advice = status === 522 ? '网站加速节点连接源站超时，并非本地保存失败。请等待网站恢复后重试。' : status === 410 ? '请重新获取下载链接，或选择其他版本。' : status >= 500 ? '请稍后重试，或选择其他版本。' : '请检查登录状态、下载额度及该书是否仍可下载。';
    message = `下载服务器返回 HTTP ${status}（${reasons[status] || '请求失败'}）。${advice}其他书籍会继续下载。`;
  }
  return Object.assign(new Error(message), { httpStatus: status });
}
