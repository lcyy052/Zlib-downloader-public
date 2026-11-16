// Pure queue presentation helpers. Keep before the DOM bindings for isolated tests.
function queueControlState(queue) {
  const queued = queue.summary?.queued ?? queue.jobs.filter(job => job.status === 'queued').length;
  const running = queue.summary?.running ?? queue.jobs.filter(job => job.status === 'running').length;
  const pending = queued + running;
  if (queue.recovery) return { title: '下载记录已恢复，等待确认', description: queue.recovery.message, pending };
  if (queue.autoPause) return { title: queue.autoPause.manual ? '已手动保持暂停' : queue.autoPause.kind === 'quota' ? '下载额度已满，已自动暂停' : '网站限制请求，已自动暂停', description: (queue.autoPause.manual ? '不会自动恢复，请手动继续。' : queue.quotaRecovery?.enabled && queue.autoPause.kind === 'quota' ? (queue.quotaRecovery.message || '等待检查额度恢复') + '。' + (queue.quotaRecovery.nextCheckAt ? '下次检查：' + new Date(queue.quotaRecovery.nextCheckAt).toLocaleString() + '。' : '') : queue.autoPause.message) + (running ? '已有 ' + running + ' 本正在处理，已接收字节的文件会继续保存。' : '等待任务已保留，不会自动按本机日期恢复。'), pending };
  if (queue.paused) return { title: '总队列已暂停', description: queue.error ? '发生异常后队列已暂停，请先处理错误提示，再继续下载。' : pending ? `还有 ${pending} 本待下载。登录验证不会自动开始，请点击“开始 / 继续下载”。` : '暂无待下载任务，添加书单或书籍后即可开始。', pending };
  const runnable = queue.jobs.some(job => job.status === 'queued' && (!job.sources?.length || job.sources.some(source => (source.state || 'active') === 'active')));
  if (running) return { title: `正在下载 · ${running} 本处理中`, description: `队列已开启，最多同时处理 ${queue.concurrency || 1} 本。单独暂停的书单仍保持暂停。`, pending };
  if (queued && !runnable) return { title: '待下载书单均已暂停', description: '总队列已经开启。请在需要下载的书单上点击“继续本书单”，其他暂停书单不会启动。', pending };
  return { title: pending ? '下载队列已开启' : '暂无待下载任务', description: pending ? '待下载任务会按顺序处理；单独暂停的书单不会自动恢复。' : '可以添加新的书单或书籍。已完成的文件会保留，不会自动重新下载。', pending };
}
function batchStatus(batch, queue) {
  if (batch.state === 'cancelled') return '已取消';
  if (batch.state === 'paused') return '本书单已暂停';
  if (batch.running) return '下载中';
  if (batch.queued) return queue.autoPause ? (queue.autoPause.kind === 'quota' ? '等待额度恢复' : '等待限制解除') : queue.paused ? '随总队列暂停' : '排队中';
  return batch.failed ? '完成，有失败' : '下载完成';
}
function queueResumeState(queue) {
  const { pending } = queueControlState(queue);
  return { disabled: !queue.paused || (!pending && !queue.recovery), label: queue.recovery && !pending ? '确认恢复并开启队列' : '开始 / 继续下载' };
}
const batchResumeLabel = queue => queue.paused ? '解除本书单暂停' : '继续本书单';
function queuedJobMessage(job, batch, queue) {
  if (job.status !== 'queued') return job.message;
  if (queue.autoPause) return queue.autoPause.message + (batch?.state === 'paused' ? '本书单也保持暂停。' : '');
  if (batch?.state === 'paused') return queue.paused ? '本书单和总队列均已暂停。解除本书单暂停后，还需开启顶部总队列。' : '本书单已暂停，点击“继续本书单”即可恢复。';
  if (queue.paused) return '总队列已暂停，请在下载管理顶部点击“开始 / 继续下载”。';
  return '已加入队列，等待空闲下载位置。';
}
// End queue presentation helpers.

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { books: [], selected: new Map(), queueSelected: new Set(), batchSelected: new Set(), batchExpanded: new Set(), page: 1, hasNext: false, search: null, app: null, matchingId: null, choices: new Map(), searching: false, preview: false };
Object.assign(state, { websiteId: null, websiteSelected: new Set(), websiteKnown: new Set(), websitePage: 1 });
let websiteSignature = '', eventsConnected = false, exiting = false;
try { state.layout = localStorage.getItem('zlibrary.resultLayout') === 'list' ? 'list' : 'cards'; } catch { state.layout = 'cards'; }
let toastTimer, queueSignature = '', matchSignature = '';
const languages = { chinese: '中文', english: '英文', japanese: '日文', french: '法文', german: '德文', spanish: '西班牙文' };
const statuses = { queued: '等待下载', running: '下载中', completed: '已完成', failed: '失败', cancelled: '已取消', pending: '等待匹配', searching: '匹配中', matched: '待确认', missing: '未找到' };

function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').className = error ? 'error' : ''; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 9000 : 5000);
}
function notice(id, message, error = false) { const el = $(id); el.textContent = message || ''; el.hidden = !message; el.classList.toggle('danger', error); }
async function api(route, input) {
  const response = await fetch(`/api/${route}`, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Client': '1' }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function task(button, fn) {
  button.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { button.disabled = false; syncControls(); }
}
function syncControls() {
  $('#download-matches').disabled = !state.choices.size;
  $('#match-list').disabled = $('#parse-list').disabled = !!state.app?.matching?.running;
  if (state.app) { $('#pause-queue').disabled = state.app.queue.paused && !state.app.queue.jobs.some(job => job.status === 'running') && !(state.app.queue.autoPause?.kind === 'quota' && !state.app.queue.autoPause.manual && state.app.queue.quotaRecovery?.enabled); $('#resume-queue').disabled = queueResumeState(state.app.queue).disabled; }
  selection();
  websiteControls();
}
function view(name) {
  $$('.view').forEach(el => el.hidden = el.id !== `view-${name}`);
  $$('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  $('#breadcrumb').textContent = '工作空间 / ' + ({ search: '搜索书籍', booklist: '书单导入', queue: '下载管理', settings: '站点设置' }[name]);
}
$$('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));

const listFilters = $('#search-filters').cloneNode(true);
listFilters.querySelector('#reset-filters').remove();
$('#list-filters').replaceChildren(...listFilters.children);
function filters(container) { return Object.fromEntries([...$(container).querySelectorAll('[name]')].map(el => [el.name, el.value])); }
$('#reset-filters').onclick = () => $$('#search-filters [name]').forEach(el => el.value = '');

function selection() {
  $('#selected-count').textContent = state.selected.size;
  $('#download-selected').disabled = !state.selected.size;
  const checked = state.books.filter(b => state.selected.has(b.id)).length;
  $('#select-all').checked = !!state.books.length && checked === state.books.length;
  $('#select-all').indeterminate = checked > 0 && checked < state.books.length;
  $('#select-all').disabled = !state.books.length;
}
function coverUrl(value) {
  try { const url = new URL(value, location.origin); return value && !url.username && !url.password && (url.protocol === 'https:' || url.origin === location.origin) ? url.href : ''; } catch { return ''; }
}
function applyLayout() {
  $('#book-grid').classList.toggle('list-view', state.layout === 'list');
  $$('[data-layout]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layout === state.layout)));
}
$$('[data-layout]').forEach(button => button.onclick = () => {
  state.layout = button.dataset.layout;
  try { localStorage.setItem('zlibrary.resultLayout', state.layout); } catch {}
  applyLayout();
});
function renderBooks() {
  $('#book-grid').innerHTML = state.books.map((b, i) => `<article role="listitem" class="book-card tone-${i % 4} ${state.selected.has(b.id) ? 'selected' : ''}">
    <div class="cover"><input type="checkbox" class="cover-check" data-book-index="${i}" aria-label="选择 ${escapeHtml(b.title)}" ${state.selected.has(b.id) ? 'checked' : ''}><div class="cover-book" aria-hidden="true"><strong>${escapeHtml(b.title)}</strong><small>暂无封面</small></div>${coverUrl(b.cover) ? `<img class="book-cover-image" src="${escapeHtml(coverUrl(b.cover))}" alt="${escapeHtml(b.title)} 的封面" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</div>
    <div class="book-content"><h3 title="${escapeHtml(b.title)}"><a href="${escapeHtml(b.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(b.title)}</a></h3><div class="book-author">${escapeHtml(b.author || '作者未知')}</div><div class="book-meta">${[b.year, languages[b.language] || b.language, b.size].filter(Boolean).map(escapeHtml).join(' · ') || '元数据待核对'}</div><div class="book-bottom"><span class="format-tag">${escapeHtml(b.format || '未知格式')}</span><button class="text-button" data-download-index="${i}">↓ 下载</button></div></div></article>`).join('');
  $$('#book-grid .book-cover-image').forEach(img => {
    const loaded = () => img.closest('.cover').classList.add('has-image');
    const failed = () => img.remove();
    img.addEventListener('load', loaded, { once: true });
    img.addEventListener('error', failed, { once: true });
    if (img.complete) { if (img.naturalWidth) loaded(); else failed(); }
  });
  applyLayout(); selection();
}
$('#book-grid').addEventListener('change', event => {
  const index = event.target.dataset.bookIndex;
  if (index === undefined) return;
  const b = state.books[+index];
  if (event.target.checked) state.selected.set(b.id, b); else state.selected.delete(b.id);
  event.target.closest('.book-card').classList.toggle('selected', event.target.checked); selection();
});
$('#book-grid').addEventListener('click', event => {
  const button = event.target.closest('[data-download-index]');
  if (button) task(button, () => addBooks([state.books[+button.dataset.downloadIndex]]));
});
$('#select-all').onchange = event => {
  state.books.forEach(b => { if (event.target.checked) state.selected.set(b.id, b); else state.selected.delete(b.id); }); renderBooks();
};
async function search(page = 1, fresh = false) {
  if (state.searching) return;
  state.searching = true;
  const request = fresh ? { query: $('#query').value.trim(), filters: filters('#search-filters') } : state.search;
  if (fresh) { state.selected.clear(); state.books = []; renderBooks(); }
  $('#search-submit').disabled = true; $('#search-submit').textContent = '正在搜索…';
  $('#prev-page').disabled = $('#next-page').disabled = true;
  notice('#search-message', '正在连接网站并查找书籍…');
  try {
    const result = await api('search', { ...request, page });
    state.search = request; state.books = result.books; state.page = result.page; state.hasNext = result.hasNext;
    renderBooks();
    $('#results-title').textContent = `“${request.query}” 的搜索结果`;
    $('#results-meta').textContent = `本页 ${result.books.length} 个版本`;
    $('#search-empty').hidden = !!result.books.length;
    if (!result.books.length) $('#search-empty').innerHTML = '<div class="empty-art">⌕</div><h3>没有找到符合条件的书籍</h3><p>试试缩短关键词，或调整文件格式、语言和年份。</p>';
    $('#pagination').hidden = !result.books.length && page === 1;
    $('#page-number').textContent = `第 ${page} 页`;
    notice('#search-message', result.warning || '');
  } catch (e) { notice('#search-message', e.message, true); }
  finally {
    state.searching = false; $('#search-submit').disabled = false; $('#search-submit').textContent = '搜索书籍 ↗';
    $('#prev-page').disabled = state.page <= 1; $('#next-page').disabled = !state.hasNext;
  }
}
$('#search-form').onsubmit = event => { event.preventDefault(); search(1, true); };
$('#prev-page').onclick = () => search(state.page - 1);
$('#next-page').onclick = () => search(state.page + 1);
async function addBooks(books) {
  const result = await api('queue/add', { books });
  toast(`已加入 ${result.added} 本${result.skipped ? `，跳过 ${result.skipped} 个重复任务` : ''}`);
  await refresh();
}
$('#download-selected').onclick = () => task($('#download-selected'), async () => { await addBooks([...state.selected.values()]); state.selected.clear(); renderBooks(); }).finally(selection);
$('#login').onclick = () => task($('#login'), async () => { $('#login').textContent = '正在打开…'; try { const result = await api('login', {}); toast(result.message); } finally { $('#login').textContent = '打开登录浏览器 ↗'; } });
$('#check-browser').onclick = () => task($('#check-browser'), async () => { const result = await api('browser/check', {}); toast(result.message); await refresh(); });

$('#booklist-file').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 1024 * 1024) return toast('书单不能超过 1 MB', true);
  try { $('#booklist-text').value = await file.text(); toast('已读取书单，点击预览或匹配候选版本'); } catch (e) { toast(e.message, true); }
};
$('#parse-list').onclick = () => task($('#parse-list'), async () => {
  const data = await api('booklist/parse', { text: $('#booklist-text').value });
  state.preview = true;
  notice('#match-message', `已识别 ${data.entries.length} 本（已去重）。点击「匹配候选版本」开始查找。`);
  state.choices.clear(); $('#download-matches').disabled = true;
  $('#match-meta').textContent = `已导入 ${data.entries.length} 本，等待匹配`;
  $('#match-results').innerHTML = data.entries.map((entry, i) => `<div class="match-row"><span class="row-number">${String(i + 1).padStart(2, '0')}</span><div class="row-body"><h3>${escapeHtml(entry.title || entry.isbn)}</h3><p>${escapeHtml([entry.author, entry.isbn].filter(Boolean).join(' · '))}</p></div><span class="status-pill">待匹配</span></div>`).join('');
});
$('#match-list').onclick = () => task($('#match-list'), async () => {
  const result = await api('booklist/match', { text: $('#booklist-text').value, filters: filters('#list-filters') });
  state.preview = false; state.choices.clear(); state.matchingId = result.id; matchSignature = ''; renderMatching(result); await refresh();
});
$('#stop-match').onclick = () => task($('#stop-match'), async () => { const result = await api('booklist/stop', {}); toast(result.message); });
function renderMatching(job) {
  if (!job || state.preview) return;
  if (job.id !== state.matchingId) { state.choices.clear(); state.matchingId = job.id; }
  $('#match-list').disabled = job.running;
  $('#parse-list').disabled = job.running;
  $('#stop-match').hidden = !job.running;
  $('#match-meta').textContent = `${job.running ? '正在匹配' : job.cancelled ? '匹配已停止' : '本轮匹配结束'} · ${job.done} / ${job.entries.length} 本 · 已确认 ${state.choices.size} 本`;
  notice('#match-message', job.error || (job.cancelled ? '已停止后续匹配，已找到的候选版本仍可选择。' : ''), !!job.error);
  const signature = JSON.stringify(job);
  if (signature !== matchSignature) {
    matchSignature = signature;
    $('#match-results').innerHTML = job.entries.map((entry, i) => `<div class="match-row"><span class="row-number">${String(i + 1).padStart(2, '0')}</span><div class="row-body"><h3>${escapeHtml(entry.title || entry.isbn)}</h3><p>${escapeHtml(entry.error || [entry.author, entry.isbn].filter(Boolean).join(' · '))}</p></div><span class="status-pill status-${entry.status}">${statuses[entry.status]}</span>${entry.candidates.length ? `<select data-match-id="${entry.id}" aria-label="选择 ${escapeHtml(entry.title || entry.isbn)} 的版本"><option value="">请选择一个版本（不自动下载）</option>${entry.candidates.map((book, index) => `<option value="${index}" ${state.choices.get(entry.id)?.url === book.url ? 'selected' : ''}>${escapeHtml([book.title, book.author, book.format, book.language, book.year, book.size].filter(Boolean).join(' / '))}</option>`).join('')}</select>` : ''}</div>`).join('');
  }
  $('#download-matches').disabled = !state.choices.size;
}
$('#match-results').onchange = event => {
  const id = event.target.dataset.matchId; if (!id) return;
  const entry = state.app.matching.entries.find(e => e.id === id);
  if (event.target.value === '') state.choices.delete(id); else state.choices.set(id, entry.candidates[+event.target.value]);
  renderMatching(state.app.matching);
};
$('#download-matches').onclick = () => task($('#download-matches'), async () => { await addBooks([...state.choices.values()]); view('queue'); });

function bytes(value) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)} MB` : `${(value / 1024).toFixed(1)} KB`; }
function fileProgress(job) {
  if (job.status !== 'running') return '';
  const p = job.progress;
  const percent = Number.isFinite(p?.percent) ? Math.max(0, Math.min(100, p.percent)) : null;
  const text = p?.transferStarted && !p.receivedBytes ? '文件传输已开始，等待 Chrome 报告完成…' : p ? `${bytes(p.receivedBytes || 0)}${p.totalBytes ? ` / ${bytes(p.totalBytes)}` : ' · 总大小未知'}${percent === null ? '' : ` · ${percent}%`}` : '等待文件传输…';
  return `<div class="file-progress"><progress max="100" ${percent === null ? '' : `value="${percent}"`} aria-label="当前文件下载进度"></progress><span>${escapeHtml(text)}</span></div>`;
}
function overallProgress(summary, title) {
  if (!summary?.total) return '';
  return `<div class="progress-panel"><div class="progress-heading"><strong>${escapeHtml(title)}</strong><span>已处理 ${summary.finished} / ${summary.total} · ${summary.percent}%</span></div><progress max="${summary.total}" value="${summary.finished}" aria-label="${escapeHtml(title)}处理进度"></progress><p>成功 ${summary.completed} · 失败 ${summary.failed} · 等待 ${summary.queued} · 正在下载 ${summary.running}${summary.cancelled ? ` · 已取消 ${summary.cancelled}` : ''}</p></div>`;
}
function websiteControls() {
  const job = state.app?.websiteBooklist;
  const queue = state.app?.queue;
  const batch = queue?.batches?.find(item => item.id === job?.id);
  const pending = (batch?.queued || 0) + (batch?.running || 0);
  $('#import-website-booklist').disabled = !!job?.running;
  $('#stop-website-booklist').hidden = !job?.running;
  $('#pause-website-downloads').hidden = !pending || batch?.state !== 'active';
  $('#resume-website-downloads').hidden = batch?.state !== 'paused';
  $('#resume-website-downloads').textContent = queue ? batchResumeLabel(queue) : '继续本书单';
  $('#website-download-gate').hidden = !queue?.paused || !pending;
  $('#website-download-gate span').textContent = queue?.autoPause?.message || '总队列已暂停：登录验证不会自动开始下载。请到下载管理顶部开启总队列。';
  $('#cancel-website-downloads').hidden = !pending || batch?.state === 'cancelled';
  $('#download-website-all').disabled = !job?.books.length || job.running;
  $('#download-website-selected').disabled = !state.websiteSelected.size || !!job?.running;
  $('#download-website-selected').textContent = `下载所选 (${state.websiteSelected.size})`;
  $('#website-booklist-select-all').disabled = !job?.books.length;
  $('#website-booklist-select-all').checked = !!job?.books.length && state.websiteSelected.size === job.books.length;
  $('#website-booklist-select-all').indeterminate = !!state.websiteSelected.size && state.websiteSelected.size < (job?.books.length || 0);
}
function renderWebsiteBooklist(job) {
  if (!job) { websiteControls(); return; }
  if (job.id !== state.websiteId) { state.websiteId = job.id; state.websiteSelected.clear(); state.websiteKnown.clear(); state.websitePage = 1; }
  for (const book of job.books) if (!state.websiteKnown.has(book.id)) { state.websiteKnown.add(book.id); state.websiteSelected.add(book.id); }
  $('#website-booklist-title').textContent = job.title;
  $('#website-booklist-meta').textContent = `${job.running ? '正在读取' : job.complete ? '读取完成' : '已保留读取结果'} · ${job.books.length} 本 · 已加载 ${job.pages} 批`;
  notice('#website-booklist-message', job.error || job.warning || (job.running ? job.message : ''), !!job.error);
  const pages = Math.max(1, Math.ceil(job.books.length / 50));
  state.websitePage = Math.min(state.websitePage, pages);
  const current = job.books.slice((state.websitePage - 1) * 50, state.websitePage * 50);
  const queue = state.app?.queue;
  const batch = queue?.batches?.find(batch => batch.id === job.id);
  const jobs = queue?.jobs || [];
  const relevant = new Map();
  for (const item of jobs) if (item.sources?.some(source => source.id === job.id)) relevant.set(item.book.url, item);
  const signature = JSON.stringify([job.id, job.books.length, queue?.paused, batch?.state, state.websitePage, [...state.websiteSelected], current.map(book => { const item = relevant.get(book.url); return [item?.status, item?.message, item?.progress]; })]);
  if (signature !== websiteSignature) {
    websiteSignature = signature;
    $('#website-booklist-books').innerHTML = current.length ? current.map((book, i) => {
      const task = relevant.get(book.url);
      return `<article class="website-book-row"><input type="checkbox" data-website-book="${escapeHtml(book.id)}" aria-label="选择 ${escapeHtml(book.title)}" ${state.websiteSelected.has(book.id) ? 'checked' : ''}><span class="row-number">${(state.websitePage - 1) * 50 + i + 1}</span><div class="row-body"><h3><a href="${escapeHtml(book.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(book.title)}</a></h3><p>${escapeHtml([book.author, book.format, book.year, languages[book.language] || book.language, book.size].filter(Boolean).join(' · '))}</p>${task ? `<p class="task-detail">${escapeHtml(queuedJobMessage(task, batch, queue))}</p>${fileProgress(task)}` : ''}</div><span class="status-pill status-${task?.status || 'pending'}">${task ? task.status === 'queued' ? batchStatus({ ...batch, queued: 1, running: 0 }, queue) : statuses[task.status] : '未加入队列'}</span></article>`;
    }).join('') : '<div class="empty-inline">尚未读取到书籍</div>';
  }
  $('#website-booklist-progress').innerHTML = overallProgress(batch, '本书单下载进度');
  $('#website-booklist-pagination').hidden = pages <= 1;
  $('#website-booklist-page').textContent = `${state.websitePage} / ${pages} 页`;
  $('#website-booklist-prev').disabled = state.websitePage <= 1; $('#website-booklist-next').disabled = state.websitePage >= pages;
  websiteControls();
}
$('#website-booklist-form').onsubmit = event => { event.preventDefault(); task($('#import-website-booklist'), async () => {
  const job = await api('booklist/import', { url: $('#website-booklist-url').value.trim() });
  state.app.websiteBooklist = job; renderWebsiteBooklist(job);
}); };
$('#stop-website-booklist').onclick = () => task($('#stop-website-booklist'), async () => { const result = await api('booklist/import-stop', {}); toast(result.message); });
$('#website-booklist-books').onchange = event => {
  const id = event.target.dataset.websiteBook; if (!id) return;
  if (event.target.checked) state.websiteSelected.add(id); else state.websiteSelected.delete(id);
  websiteControls();
};
$('#website-booklist-select-all').onchange = event => {
  state.websiteSelected = new Set(event.target.checked ? state.app.websiteBooklist.books.map(book => book.id) : []);
  renderWebsiteBooklist(state.app.websiteBooklist);
};
for (const [id, delta] of [['#website-booklist-prev', -1], ['#website-booklist-next', 1]]) $(id).onclick = () => { state.websitePage += delta; renderWebsiteBooklist(state.app.websiteBooklist); $('#website-booklist-title').scrollIntoView({ block: 'start' }); };
async function downloadWebsiteBooks(all) {
  const job = state.app.websiteBooklist;
  const ids = all ? job.books.map(book => book.id) : [...state.websiteSelected];
  const result = await api('booklist/download', { booklistId: job.id, ids });
  toast(`已加入 ${result.added} 本，跳过 ${result.skipped} 本已有任务；单本失败后会继续下载`);
  await refresh();
}
$('#download-website-all').onclick = () => task($('#download-website-all'), () => downloadWebsiteBooks(true));
$('#download-website-selected').onclick = () => task($('#download-website-selected'), () => downloadWebsiteBooks(false));
$('#pause-website-downloads').onclick = () => task($('#pause-website-downloads'), async () => { await queueAction('batch-pause', state.app.websiteBooklist.id); toast(batchActionMessage('batch-pause')); });
$('#resume-website-downloads').onclick = () => task($('#resume-website-downloads'), async () => { await queueAction('batch-resume', state.app.websiteBooklist.id); toast(batchActionMessage('batch-resume')); });
$('#cancel-website-downloads').onclick = () => task($('#cancel-website-downloads'), async () => { await queueAction('batch-cancel', state.app.websiteBooklist.id); toast('已取消当前书单，下载记录仍保留'); });

$('#go-download-controls').onclick = () => { view('queue'); $('#queue-control-panel').scrollIntoView({ block: 'start' }); };

function batchActionMessage(action) {
  if (action === 'batch-resume') return state.app.queue.paused ? '已解除本书单暂停；总队列仍暂停，请点击顶部“开始 / 继续下载”。' : '已继续本书单，其他暂停书单不受影响。';
  if (action === 'batch-pause') return '仅本书单已暂停，其他书单状态不变。';
  if (action === 'batch-delete') return '书单记录已删除，已下载文件仍保留';
  return '书单状态已更新';
}
function jobControls(job, batch) {
  if (job.status === 'completed') return `<a class="text-button" href="/api/files/${job.id}">另存文件 ↗</a>`;
  if (['queued', 'running'].includes(job.status)) return `<button class="text-button" data-action="cancel" data-id="${job.id}">取消本书</button>`;
  const retry = batch.state === 'active' ? `<button class="text-button" data-action="retry" data-id="${job.id}">重试</button>` : '';
  return `<a class="text-button" href="${escapeHtml(job.book.url)}" target="_blank" rel="noopener noreferrer">查看原页面 ↗</a><button class="text-button" data-search-title="${escapeHtml(job.book.title)}">搜索同名</button>${retry}`;
}
function renderBatch(batch, queue) {
  const jobs = queue.jobs.filter(job => job.sources?.some(source => source.id === batch.id));
  const pending = batch.queued + batch.running;
  const actions = [
    batch.state === 'active' && pending ? `<button class="text-button" data-batch-action="batch-pause" data-batch-id="${batch.id}">暂停本书单</button>` : '',
    batch.state === 'paused' ? `<button class="text-button" data-batch-action="batch-resume" data-batch-id="${batch.id}">${batchResumeLabel(queue)}</button>` : '',
    batch.state !== 'cancelled' && pending ? `<button class="text-button danger-text" data-batch-action="batch-cancel" data-batch-id="${batch.id}">取消本书单</button>` : '',
    `<button class="text-button danger-text" data-batch-action="batch-delete" data-batch-id="${batch.id}">删除记录</button>`,
  ].join('');
  const rows = jobs.map((job, index) => `<div class="batch-book-row"><span class="row-number">${index + 1}</span><span class="format-tag">${escapeHtml(job.book.format || 'FILE')}</span><div class="row-body"><h3>${escapeHtml(job.book.title)}</h3><p>${escapeHtml([job.book.author, job.book.year, queuedJobMessage(job, batch, queue), job.filename].filter(Boolean).join(' · '))}</p>${fileProgress(job)}</div><div class="queue-controls"><span class="status-pill status-${job.status}">${job.status === 'queued' ? batchStatus({ ...batch, running: 0, queued: 1 }, queue) : statuses[job.status]}</span>${jobControls(job, batch)}</div></div>`).join('');
  return `<details class="batch-record" data-batch-details="${batch.id}" ${state.batchExpanded.has(batch.id) ? 'open' : ''}><summary><input type="checkbox" data-batch-select="${batch.id}" aria-label="选择书单 ${escapeHtml(batch.title)}" ${state.batchSelected.has(batch.id) ? 'checked' : ''}><div class="batch-summary-main"><strong>${escapeHtml(batch.title)}</strong><span>${batch.completed} / ${batch.total} 本成功 · ${batch.failed} 本失败 · ${batch.percent}%</span>${pending && queue.paused && batch.state === 'active' ? '<span class="batch-scope-hint">本书单已就绪，请在顶部开启总队列。</span>' : ''}</div><span class="status-pill batch-state-${batch.state}">${batchStatus(batch, queue)}</span><div class="batch-actions">${actions}</div></summary><div class="batch-progress"><progress max="${batch.total}" value="${batch.finished}" aria-label="${escapeHtml(batch.title)}处理进度"></progress></div><div class="batch-books">${rows || '<div class="empty-inline">没有书籍记录</div>'}</div></details>`;
}
function renderQueue(queue) {
  const batches = queue.batches || [];
  const batchIds = new Set(batches.map(batch => batch.id));
  for (const id of state.batchSelected) if (!batchIds.has(id)) state.batchSelected.delete(id);
  for (const id of state.batchExpanded) if (!batchIds.has(id)) state.batchExpanded.delete(id);
  $('#batch-selected-count').textContent = state.batchSelected.size;
  $('#delete-selected-batches').disabled = !state.batchSelected.size;
  $('#select-all-batches').disabled = !batches.length;
  $('#select-all-batches').checked = !!batches.length && state.batchSelected.size === batches.length;
  $('#select-all-batches').indeterminate = !!state.batchSelected.size && state.batchSelected.size < batches.length;
  const standalone = queue.jobs.filter(job => !job.sources?.length);
  const clearable = new Set(standalone.filter(job => ['completed', 'failed', 'cancelled'].includes(job.status)).map(job => job.id));
  for (const id of state.queueSelected) if (!clearable.has(id)) state.queueSelected.delete(id);
  $('#queue-selected-count').textContent = state.queueSelected.size;
  $('#clear-selected-queue').disabled = !state.queueSelected.size;
  const signature = JSON.stringify(queue); if (signature === queueSignature) return; queueSignature = signature;
  const count = status => queue.jobs.filter(j => j.status === status).length;
  $('#queue-count').textContent = count('queued') + count('running');
  const controls = queueControlState(queue);
  const recovery = queue.quotaRecovery;
  const canHold = queue.autoPause?.kind === 'quota' && !queue.autoPause.manual && recovery?.enabled;
  $('#quota-recovery-status').textContent = recovery ? recovery.message + (recovery.nextCheckAt ? ' · 下次检查：' + new Date(recovery.nextCheckAt).toLocaleString() : '') : '新功能需要重启服务后生效';
  $('#queue-control-title').textContent = controls.title;
  $('#queue-control-description').textContent = controls.description;
  $('#queue-control-panel').dataset.paused = queue.paused;
  $('#resume-queue').hidden = !queue.paused;
  $('#resume-queue').textContent = queueResumeState(queue).label;
  $('#pause-queue').hidden = queue.paused && !count('running') && !canHold;
  $('#pause-queue').textContent = canHold ? '保持暂停（不自动恢复）' : queue.paused && count('running') ? '暂停剩余传输' : '暂停全部下载';
  $('#queue-stats').innerHTML = [['queued', '等待下载'], ['running', '正在下载'], ['completed', '已完成'], ['failed', '需要处理']].map(([status, label]) => `<div class="stat"><span>${label}</span><strong>${count(status)}</strong></div>`).join('');
  $('#queue-meta').textContent = `${standalone.length} 个单本任务 · 与书单共用顶部下载总控`;
  $('#pause-queue').disabled = queue.paused && !count('running') && !canHold; $('#resume-queue').disabled = queueResumeState(queue).disabled;
  notice('#queue-error', queue.error || (count('failed') ? `${count('failed')} 本下载失败，已保留原因；可在书单详情中查看或搜索同名资源。` : ''), !!queue.error);
  $('#queue-progress').innerHTML = overallProgress(queue.summary, '全部任务处理进度');
  $('#booklist-queue-list').innerHTML = batches.length ? [...batches].reverse().map(batch => renderBatch(batch, queue)).join('') : '<div class="empty-inline">还没有书单下载记录</div>';
  $('#queue-list').innerHTML = standalone.length ? [...standalone].reverse().map(job => `<div class="queue-row">${clearable.has(job.id) ? `<input class="queue-history-check" type="checkbox" data-queue-select="${job.id}" aria-label="选择 ${escapeHtml(job.book.title)}" ${state.queueSelected.has(job.id) ? 'checked' : ''}>` : '<span class="queue-history-check-spacer"></span>'}<span class="format-tag">${escapeHtml(job.book.format || 'FILE')}</span><div class="row-body"><h3>${escapeHtml(job.book.title)}</h3><p>${escapeHtml(queuedJobMessage(job, null, queue))}${job.bytes ? ` · ${(job.bytes / 1024).toFixed(1)} KB` : ''}${job.filename ? ` · ${escapeHtml(job.filename)}` : ''}</p>${fileProgress(job)}</div><div class="queue-controls"><span class="status-pill status-${job.status}">${statuses[job.status]}</span>${jobControls(job, { state: 'active' })}</div></div>`).join('') : '<div class="empty-inline">没有单本下载任务</div>';
}
async function queueAction(action, id) { await api('queue/action', { action, id }); await refresh(); }
$('#queue-list').onclick = event => { const searchButton = event.target.closest('[data-search-title]'); if (searchButton) { $('#query').value = searchButton.dataset.searchTitle; view('search'); search(1, true); return; } const button = event.target.closest('[data-action]'); if (button) task(button, () => queueAction(button.dataset.action, button.dataset.id)); };
$('#queue-list').onchange = event => { const checkbox = event.target.closest('[data-queue-select]'); if (!checkbox) return; if (checkbox.checked) state.queueSelected.add(checkbox.dataset.queueSelect); else state.queueSelected.delete(checkbox.dataset.queueSelect); $('#queue-selected-count').textContent = state.queueSelected.size; $('#clear-selected-queue').disabled = !state.queueSelected.size; };
$('#booklist-queue-list').addEventListener('toggle', event => { const details = event.target.closest('[data-batch-details]'); if (!details) return; if (details.open) state.batchExpanded.add(details.dataset.batchDetails); else state.batchExpanded.delete(details.dataset.batchDetails); }, true);
$('#booklist-queue-list').onclick = event => {
  const selection = event.target.closest('[data-batch-select]'); if (selection) { event.stopPropagation(); return; }
  const searchButton = event.target.closest('[data-search-title]'); if (searchButton) { event.preventDefault(); $('#query').value = searchButton.dataset.searchTitle; view('search'); search(1, true); return; }
  const batchButton = event.target.closest('[data-batch-action]'); if (batchButton) { event.preventDefault(); event.stopPropagation(); task(batchButton, async () => { await queueAction(batchButton.dataset.batchAction, batchButton.dataset.batchId); toast(batchActionMessage(batchButton.dataset.batchAction)); }); return; }
  const button = event.target.closest('[data-action]'); if (button) task(button, () => queueAction(button.dataset.action, button.dataset.id));
};
$('#booklist-queue-list').onchange = event => { const checkbox = event.target.closest('[data-batch-select]'); if (!checkbox) return; if (checkbox.checked) state.batchSelected.add(checkbox.dataset.batchSelect); else state.batchSelected.delete(checkbox.dataset.batchSelect); $('#batch-selected-count').textContent = state.batchSelected.size; $('#delete-selected-batches').disabled = !state.batchSelected.size; };
$('#select-all-batches').onchange = event => { state.batchSelected = new Set(event.target.checked ? (state.app.queue.batches || []).map(batch => batch.id) : []); queueSignature = ''; renderQueue(state.app.queue); };
$('#delete-selected-batches').onclick = () => task($('#delete-selected-batches'), async () => { const count = state.batchSelected.size; await api('queue/action', { action: 'batch-delete-selected', ids: [...state.batchSelected] }); state.batchSelected.clear(); await refresh(); toast(`已删除 ${count} 条书单下载记录，已下载文件仍保留`); });
$('#pause-queue').onclick = () => task($('#pause-queue'), async () => { await queueAction('pause'); toast('总队列已暂停；点击顶部“开始 / 继续下载”恢复。'); });
$('#resume-queue').onclick = () => {
  if (state.app.queue.autoPause && !confirm('队列因下载额度或网站请求限制自动暂停。请先确认网站额度已恢复或限制已解除。\n\n现在继续下载吗？若仍受限制，会再次自动暂停。')) return;
  task($('#resume-queue'), async () => { await queueAction('resume'); toast('总队列已开启；单独暂停的书单仍保持暂停。'); });
};
$('#clear-selected-queue').onclick = () => task($('#clear-selected-queue'), async () => { await api('queue/action', { action: 'clear-selected', ids: [...state.queueSelected] }); const count = state.queueSelected.size; state.queueSelected.clear(); await refresh(); toast(`已清理 ${count} 条所选单本记录，本地文件仍保留`); });
$('#clear-queue').onclick = () => task($('#clear-queue'), async () => { await queueAction('clear'); state.queueSelected.clear(); toast('已清理全部结束的单本记录，书单记录和本地文件仍保留'); });
$('#settings-form').onsubmit = event => { event.preventDefault(); task($('#settings-form button'), async () => { const result = await api('settings', { site: $('#site-url').value, browser: $('#browser-choice').value, browserMode: $('#browser-mode').value, downloadDirectory: $('#download-directory-input').value, downloadConcurrency: Number($('#download-concurrency').value) }); $('#download-directory-input').value = result.settings.downloadDirectory; $('#download-concurrency').value = result.settings.downloadConcurrency; $('#browser-mode').value = result.settings.browserMode; state.books = []; state.selected.clear(); renderBooks(); toast('设置已保存，新任务将使用新的下载目录、并发数和浏览器运行方式'); await refresh(); }); };
$('#quota-recovery-form').onsubmit = event => { event.preventDefault(); task($('#quota-recovery-form button'), async () => { await api('quota-recovery', { quotaAutoResume: $('#quota-auto-resume').value === 'on', quotaCheckMinutes: Number($('#quota-check-minutes').value) }); await refresh(); toast('额度自动恢复设置已保存；手动暂停不会被自动解除'); }); };
$('#quota-check-now').onclick = () => task($('#quota-check-now'), async () => { const result = await api('quota/check', {}); notice('#quota-check-result', (result.quota ? '已用 ' + result.quota.used + ' / 每日限额 ' + result.quota.limit + '。' : '') + result.message + '。本次只检查，不改变队列状态。'); });
$('#quota-wait-current').onclick = () => { if (!confirm('确认将当前队列设为等待额度恢复，并开启定时检查？\n\n读取到每日额度恢复后会自动继续；单独暂停的书单不变。')) return; task($('#quota-wait-current'), async () => { const result = await api('quota-recovery/wait', { quotaCheckMinutes: Number($('#quota-check-minutes').value) }); $('#quota-auto-resume').value = result.settings.quotaAutoResume ? 'on' : 'off'; await refresh(); toast('当前队列已等待额度恢复，定时检查已开启'); }); };

$('#exit-app').onclick = async () => {
  const active = state.app?.queue?.busy || state.app?.websiteBooklist?.running || state.app?.matching?.running;
  const warning = active ? '当前仍有任务运行。退出会安全暂停任务并保存进度，下次启动后可以继续。\n\n确定退出程序吗？' : '退出后后台服务和专用浏览器都会关闭。\n\n确定退出程序吗？';
  if (!confirm(warning)) return;
  const button = $('#exit-app'); button.disabled = true; button.textContent = '正在退出…';
  try {
    const result = await api('shutdown', {});
    exiting = true; events.close(); clearInterval(refreshTimer);
    notice('#connection-error', result.message || '程序已安全退出。需要使用时请重新运行 start.bat。');
  } catch (error) { button.disabled = false; button.textContent = '退出程序'; toast(error.message, true); }
};

let refreshing = false;
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const data = await api('state');
    const first = !state.app; state.app = data;
    notice('#connection-error', '');
    $('#demo-banner').hidden = !data.demo; $('#mode').textContent = data.demo ? '演示模式' : '本地模式';
    if (first) { $('#site-url').value = data.settings.site; $('#browser-choice').value = data.settings.browser || 'chrome'; $('#browser-mode').value = data.settings.browserMode || 'background'; $('#download-directory-input').value = data.settings.downloadDirectory || data.directory; $('#download-concurrency').value = data.settings.downloadConcurrency || 2; }
    if (first) { $('#quota-auto-resume').value = data.settings.quotaAutoResume ? 'on' : 'off'; $('#quota-check-minutes').value = data.settings.quotaCheckMinutes || 30; }
    $('#download-directory').textContent = data.directory;
    if (first && data.websiteBooklist) $('#website-booklist-url').value = data.websiteBooklist.url;
    $('#browser-session').textContent = data.browserSession ? `${data.browserSession.browser || '浏览器'} · ${data.browserSession.open ? '已打开' : '未打开'}。${data.browserSession.message || '点击右上角打开登录浏览器。'}` : '服务版本已更新，请重启本地服务以启用 Chrome 会话。';
    renderQueue(data.queue); renderMatching(data.matching); renderWebsiteBooklist(data.websiteBooklist);
  } catch (e) { if (!exiting) notice('#connection-error', `无法连接本地服务：${e.message}。请确认服务仍在运行；可重新运行 start.bat，异常日志位于 .data/live/logs。`, true); }
  finally { refreshing = false; }
}
applyLayout(); selection(); await refresh();
const events = new EventSource('/api/events');
events.onopen = () => eventsConnected = true;
events.onerror = () => eventsConnected = false;
events.addEventListener('queue', event => { if (!state.app) return; state.app.queue = JSON.parse(event.data); renderQueue(state.app.queue); renderWebsiteBooklist(state.app.websiteBooklist); });
events.addEventListener('booklist', event => { if (!state.app) return; state.app.websiteBooklist = JSON.parse(event.data); renderWebsiteBooklist(state.app.websiteBooklist); });
let refreshTicks = 0;
const refreshTimer = setInterval(() => { if (!eventsConnected || ++refreshTicks % 7 === 0) refresh(); }, 1500);
