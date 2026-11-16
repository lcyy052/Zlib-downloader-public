// Self-contained: Playwright serializes this function into the page.
export function booklistPageState(wait) {
  const root = document.querySelector('.booklist-main .readlist-view');
  const cards = root?.querySelectorAll('z-bookcard') || [];
  const items = cards.length ? cards : root?.querySelectorAll('.book-item, .resItemBox') || [];
  const count = items.length || new Set([...(root?.querySelectorAll('a[href*="/book/"]') || [])].map(link => link.getAttribute('href'))).size;
  const more = document.querySelector('.booklist-main .page-load-more');
  const rect = more?.getBoundingClientRect();
  const style = more && getComputedStyle(more);
  // A parent with display:none gives this child a zero-size bounding box even
  // when its own computed display is still block. Match actual visibility.
  const visible = Boolean(more && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse');
  if (wait) return count > wait.before || (!wait.requireGrowth && !visible);
  return { count, visible };
}

export function booklistResponseInfo(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { /* Some sites return HTML fragments. */ }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (payload?.success === false || payload?.success === 0 || payload?.status === 'error' || payload?.error) {
    const message = typeof payload.message === 'string' ? payload.message.slice(0, 200) : '分页接口未返回正常结果';
    return { error: message, emptyEnd: false, requireGrowth: false };
  }
  const books = Array.isArray(data?.books) ? data.books : null;
  const raw = data?.pagination || payload?.pagination;
  const valid = books && Number.isInteger(raw?.current) && raw.current > 0 && Number.isInteger(raw.total_pages) && raw.total_pages >= raw.current;
  const pagination = valid ? {
    current: raw.current, totalPages: raw.total_pages,
    totalItems: Number.isInteger(raw.total_items) && raw.total_items >= 0 ? raw.total_items : null,
    lastPage: raw.current === raw.total_pages,
    nextPage: Number.isInteger(raw.next) && raw.next > raw.current && raw.next <= raw.total_pages ? raw.next : null,
  } : null;
  const end = pagination?.lastPage || [payload, data, payload?.pagination, data?.pagination].some(value => value && (value.hasMore === false || value.hasNext === false));
  return {
    // Do not infer completion from an empty body, duplicates, or a timeout.
    emptyEnd: Boolean(end && books && books.length === 0),
    emptyPage: Boolean(books && books.length === 0 && pagination?.nextPage && !end),
    pagination,
    requireGrowth: Boolean(books?.length || /<z-bookcard\b|class=["'][^"']*\b(?:book-item|resItemBox)\b|href=["'][^"']*\/book\//i.test(text)),
  };
}

export function booklistApiCursor(responseUrl, request, current, nextPage) {
  const url = new URL(responseUrl);
  const match = url.pathname.match(/\/get-books\/(\d+)\/?$/);
  if (!match || Number(match[1]) !== current || !Number.isInteger(nextPage) || nextPage <= current || !['GET', 'POST'].includes(request.method)) throw new Error('无法确认后续书单分页地址，已保留读取结果');
  url.pathname = url.pathname.replace(/\/get-books\/\d+\/?$/, `/get-books/${nextPage}`);
  const headers = Object.fromEntries(Object.entries(request.headers || {}).filter(([key]) => ['accept', 'content-type', 'x-requested-with'].includes(key.toLowerCase())));
  return { url: url.href, method: request.method, body: request.body, headers, page: nextPage };
}

// Executed in the already-verified browser: same origin/cookies, no new window.
export async function fetchBooklistApiPage({ url, method, body, headers, timeoutMs }) {
  if (new URL(url).origin !== location.origin) throw new Error('拒绝跨站书单分页请求');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, body: method === 'GET' ? undefined : body, headers, credentials: 'same-origin', signal: controller.signal });
    if (new URL(response.url).origin !== location.origin) throw new Error('书单分页发生跨站跳转');
    return { status: response.status, text: await response.text() };
  } finally { clearTimeout(timer); }
}

export function booklistApiRecords(text, site) {
  const payload = JSON.parse(text), data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!Array.isArray(data?.books)) throw new Error('后续分页未返回书籍数组，已保留读取结果');
  const books = [], fragments = [];
  const str = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  for (const item of data.books) {
    const html = typeof item === 'string' ? item : item?.html;
    if (typeof html === 'string') { fragments.push(html); continue; }
    const link = item?.url || item?.href || (item?.id && item?.hash ? `/book/${item.id}/${item.hash}` : '');
    let url;
    try { url = new URL(link, site); } catch {}
    if (!link || !str(item?.title) || !url || url.origin !== new URL(site).origin || !/^\/book\//.test(url.pathname) || url.username || url.password) throw new Error('后续分页中有无法识别的书籍，已保留读取结果');
    books.push({ id: url.pathname, url: url.href, title: str(item.title), author: str(item.author) || (Array.isArray(item.authors) ? item.authors.map(author => str(author?.name || author)).filter(Boolean).join(', ') : ''), year: str(item.year), language: str(item.language), format: str(item.extension || item.format).toUpperCase(), size: str(item.filesizeString || item.filesize || item.size), cover: str(item.cover || item.cover_url) });
  }
  return { books, html: fragments.join(''), expected: data.books.length };
}

export async function readBooklistResponse(response, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      response.text(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('分页响应正文接收超时'), { code: 'BOOKLIST_PAGE_TIMEOUT' })), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Opt-in diagnostics expose structure/counts, never book text, cookies or URLs.
export function booklistResponseDiagnostic(text) {
  function shape(value, depth = 0) {
    if (typeof value === 'string') return { length: value.length, cards: (value.match(/<z-bookcard\b/g) || []).length };
    if (Array.isArray(value)) return { items: value.length };
    if (value && typeof value === 'object') return depth < 3 ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)])) : { keys: Object.keys(value) };
    return typeof value === 'number' || typeof value === 'boolean' ? value : null;
  }
  try { return shape(JSON.parse(text)); } catch { return shape(text); }
}

export function booklistDomDiagnostic() {
  const more = document.querySelector('.booklist-main .page-load-more'), ancestors = [];
  for (let node = more, i = 0; node && i < 5; node = node.parentElement, i++) {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    ancestors.push({ class: node.className, display: style.display, visibility: style.visibility, hidden: node.hidden, disabled: node.disabled, ariaDisabled: node.getAttribute('aria-disabled'), width: rect.width, height: rect.height });
  }
  return { cards: document.querySelectorAll('.booklist-main .readlist-view z-bookcard').length, more: Boolean(more), ancestors };
}
