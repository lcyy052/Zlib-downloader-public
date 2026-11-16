// Conservative account-wide stop signals. Generic login/HTTP errors are not quota evidence.
export function downloadLimitError(kind = 'quota', { httpStatus } = {}) {
  const quota = kind === 'quota';
  return Object.assign(new Error(quota
    ? '网站明确提示下载额度已用完，已自动暂停新的下载。额度恢复后请手动继续。'
    : '网站返回 HTTP 429，已自动暂停新的下载。可能是请求过于频繁或额度限制，请检查网站提示后手动继续。'),
  { code: quota ? 'DOWNLOAD_QUOTA_EXHAUSTED' : 'DOWNLOAD_REQUEST_LIMITED', ...(httpStatus ? { httpStatus } : {}), needsUser: quota });
}

export function downloadLimitFromText(value, httpStatus, { allowCounter = true } = {}) {
  const text = String(value || '').slice(0, 65536)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|#160);/gi, ' ').replace(/\s+/g, ' ').trim();
  const daily = [
    /\b(?:reached|exceeded)\s+(?:(?:your|the)\s+)?daily\s+(?:limit|quota)\s+(?:of\s+)?\d*\s*downloads?\b/i,
    /\b(?:reached|exceeded|exhausted|used up)\s+(?:(?:your|the)\s+)?(?:daily|today'?s|24[- ]hours?)\s+(?:book\s+)?downloads?\s+(?:limit|quota|allowance)\b/i,
    /\b(?:daily|today'?s|24[- ]hours?)\s+(?:book\s+)?downloads?\s+(?:limit|quota|allowance)\s+(?:has\s+been\s+|is\s+)?(?:reached|exceeded|exhausted|used up)\b/i,
    /\b(?:downloads?\s+(?:remaining|left)|remaining\s+downloads?)\s*[:：=]\s*0\b/i,
    /(?:每日|每天|今日|今天|当日|24\s*小时)[^。.!?\n]{0,18}下载[^。.!?\n]{0,12}(?:已满|已达上限|已用完|用尽|耗尽|超出|达到上限|超过上限)/,
    /(?:已达到|已超过|已用完|已耗尽)[^。.!?\n]{0,8}(?:每日|每天|今日|今天|当日)[^。.!?\n]{0,12}下载(?:次数|额度|上限|限制)/,
    /(?:剩余(?:的)?下载(?:次数|额度)|下载(?:次数|额度)剩余)\s*[:：=]\s*0\b/,
  ];
  const counters = [
    /(\d{1,7})\s*\/\s*(\d{1,7})\s*(?:每日限额|每日下载(?:限额|次数)|daily(?:\s+downloads?)?\s+limit)/gi,
    /(?:每日限额|每日下载(?:限额|次数)|daily(?:\s+downloads?)?\s+limit)\s*[:：]?\s*(\d{1,7})\s*\/\s*(\d{1,7})/gi,
  ];
  if (allowCounter) for (const pattern of counters) for (const match of text.matchAll(pattern)) {
    const used = Number(match[1]), limit = Number(match[2]);
    // This site's labeled counter is used / allowed, not remaining / allowed.
    if (limit > 0 && used >= limit) return Object.assign(downloadLimitError('quota', { httpStatus }), { quota: { used, limit } });
  }
  if (daily.some(pattern => pattern.test(text))) return downloadLimitError('quota', { httpStatus });
  return null;
}

export function isDownloadLimit(error) {
  return ['DOWNLOAD_QUOTA_EXHAUSTED', 'DOWNLOAD_REQUEST_LIMITED'].includes(error?.code) || Number(error?.httpStatus) === 429;
}

// Positive evidence is required for recovery; absence of an exhaustion notice is not enough.
export function dailyQuotaFromText(value) {
  const text = String(value || '').slice(0, 65536).replace(/\s+/g, ' ');
  const label = '(?:每日限额|每日下载(?:限额|次数)|daily(?:\\s+downloads?)?\\s+limit)';
  const values = [];
  for (const pattern of [new RegExp('(\\d{1,7})\\s*/\\s*(\\d{1,7})\\s*' + label, 'gi'), new RegExp(label + '\\s*[:：]?\\s*(\\d{1,7})\\s*/\\s*(\\d{1,7})', 'gi')]) {
    for (const match of text.matchAll(pattern)) values.push({ used: Number(match[1]), limit: Number(match[2]) });
  }
  if (!values.length || values.some(item => item.limit <= 0 || item.used !== values[0].used || item.limit !== values[0].limit)) return null;
  return values[0];
}

// Serialized into the browser. Inspect visible alerts/download controls first,
// remove descriptions and book-card content from the fallback so book text is not a stop signal.
export function extractDownloadLimitNotice() {
  const visible = node => {
    if (!node || node.closest('[hidden]')) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  };
  const noticeSelector = '[role="alert"],[role="dialog"],[aria-modal="true"],.alert,.notification,.download-limit,.download-limit-message,#downloadLimit,.modal';
  const candidates = [...document.querySelectorAll(noticeSelector)];
  const notices = candidates
    .filter(visible).map(node => node.innerText || '');
  const counters = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.parentElement?.closest('.book-description,.description,#book-description,[slot="description"],z-bookcard')) continue;
    if (!/^(?:每日限额|每日下载(?:限额|次数)|daily(?:\s+downloads?)?\s+limit)$/i.test(walker.currentNode.nodeValue.trim())) continue;
    let parent = walker.currentNode.parentElement;
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
      const label = (parent.textContent || '').replace(/\s+/g, ' ').trim();
      if (label.length > 160) break;
      const values = label.match(/\d{1,7}\s*\/\s*\d{1,7}/g);
      if (values?.length === 1) { counters.push(values[0] + ' 每日限额'); break; }
    }
  }
  const clone = document.body?.cloneNode(true);
  if (clone) {
    [...clone.querySelectorAll(noticeSelector)].forEach((node, index) => { if (!visible(candidates[index])) node.remove(); });
    clone.querySelectorAll('script,style,[hidden],z-bookcard,.book-description,.description,#book-description,[slot="description"],[slot="title"],.book-title,.bookDetailsBox h1,[itemprop="description"],[itemprop="name"]').forEach(node => node.remove());
  }
  return [document.title, ...counters, ...notices, clone?.textContent || ''].join('\n').slice(0, 65536);
}

export async function downloadLimitOnPage(page, options) {
  try { return downloadLimitFromText(await page.evaluate(extractDownloadLimitNotice), undefined, options); }
  catch { return null; } // Closing tabs cannot establish account quota exhaustion.
}

export async function downloadLimitOnResponse(response, timeoutMs = 2000) {
  if (typeof response.headers !== 'function' || typeof response.text !== 'function') return null;
  const type = response.headers()['content-type'] || '';
  if (!/text\/html|application\/(?:xhtml\+xml|json)|text\/plain/i.test(type)) return null;
  let timer;
  try {
    const text = await Promise.race([response.text(), new Promise(resolve => { timer = setTimeout(() => resolve(''), timeoutMs); })]);
    return downloadLimitFromText(text, response.status(), { allowCounter: false });
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// Fetch error/HTML responses: read only a bounded notice, never buffer a file.
export async function readDownloadNotice(response, { timeoutMs = 2000, maxBytes = 65536 } = {}) {
  if (!response.body?.getReader) return '';
  const reader = response.body.getReader(), chunks = [];
  let size = 0, timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    while (size < maxBytes) {
      const part = await Promise.race([reader.read(), timeout]);
      if (!part || part.done) break;
      const bytes = Buffer.from(part.value).subarray(0, maxBytes - size);
      chunks.push(bytes); size += bytes.length;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch { return ''; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
}
