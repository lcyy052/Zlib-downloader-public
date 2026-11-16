import { extractBooksDom } from './book-extract.js';
import { chromium } from 'playwright-core';
import { mkdir, writeFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { buildSearchUrl } from './utils.js';
import { demoBooks } from './demo.js';
import { resolveBrowser, pageAccessProblem } from './browser-config.js';
import { findDownloadButton } from './download-link.js';
import { bookFilename, reserveFilename } from './download-name.js';
import { validateBooklistUrl } from './booklist.js';
import { booklistPageState, booklistResponseInfo, readBooklistResponse, booklistResponseDiagnostic, booklistDomDiagnostic, booklistApiCursor, fetchBooklistApiPage, booklistApiRecords } from './booklist-pagination.js';
import { watchDownload } from './download-watch.js';
import { downloadHttp, isDownloadNetworkError } from './http-download.js';
import { downloadWithBrowserStream } from './browser-stream-download.js';
import { waitForDownloadStart } from './download-start.js';
import { TaskLimiter } from './task-limiter.js';
import { downloadLimitOnPage, downloadLimitFromText, dailyQuotaFromText, extractDownloadLimitNotice } from './download-limit.js';
import { findExistingDownload } from './existing-download.js';

async function closePage(page, timeoutMs = 2000) {
  if (!page || page.isClosed()) return;
  let timer;
  await Promise.race([
    page.close().catch(() => {}),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

export class LibraryProvider {
  constructor({ getSettings, dataDir, demo, headless = false }) { Object.assign(this, { getSettings, dataDir, demo, headless }); this.context = null; this.launching = null; this.active = 0; this.recoveryPage = null; this.browserName = ''; this.sessionMessage = ''; this.pageCreation = Promise.resolve(); this.browserTransferQueue = Promise.resolve(); this.chromeTransfers = new TaskLimiter(() => Math.min(2, this.getSettings().downloadConcurrency || 1)); this.booklistRetryDelays = [1500, 3000, 6000, 10000, 15000]; this.visible = false; this.visibleBounds = null; }

  async runBrowserTransfer(task, signal) {
    if (signal?.aborted) throw new Error('已取消');
    const current = this.browserTransferQueue.then(() => {
      if (signal?.aborted) throw new Error('已取消');
      return task();
    });
    this.browserTransferQueue = current.catch(() => {});
    if (!signal) return current;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('已取消'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([current, aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  transferHttp(options) { return downloadHttp(options); }
  runChromeTransfer(task, signal) { return this.chromeTransfers.run(task, signal); }

  backgroundMode() { return !this.headless && (this.getSettings().browserMode || 'background') === 'background'; }

  async hideWindowWithSession(session, targetId) {
    const { windowId } = await session.send('Browser.getWindowForTarget', targetId ? { targetId } : {});
    const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
    const onScreen = Number.isFinite(bounds.left) && Number.isFinite(bounds.top) && bounds.left > -10000 && bounds.top > -10000;
    if (onScreen && bounds.width > 0 && bounds.height > 0) this.visibleBounds = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    if (bounds.windowState !== 'normal') await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: 1280, height: 900 } });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    this.visible = false;
  }

  async hideWindow(page) {
    if (this.headless || !page || page.isClosed()) return false;
    let session;
    try {
      session = await this.context.newCDPSession(page);
      await this.hideWindowWithSession(session);
      return true;
    } catch { return false; }
    finally { await session?.detach().catch(() => {}); }
  }

  async showWindow(page) {
    if (this.headless || !page || page.isClosed()) return false;
    let session;
    try {
      session = await this.context.newCDPSession(page);
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await session.send('Browser.setWindowBounds', { windowId, bounds: this.visibleBounds || { left: 100, top: 80, width: 1280, height: 900 } });
      this.visible = true;
      return true;
    } catch { return false; }
    finally { await session?.detach().catch(() => {}); }
  }

  async operationPage(context) {
    if (!this.backgroundMode()) return context.newPage();
    const create = this.pageCreation.then(async () => {
      const anchor = context.pages().find(page => !page.isClosed()) || await context.newPage();
      let session;
      try {
        session = await context.newCDPSession(anchor);
        const created = context.waitForEvent('page');
        const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true });
        const page = await created;
        await this.hideWindowWithSession(session, targetId);
        this.sessionMessage = `${this.browserName} 正在后台运行；搜索、书单读取和下载不会主动弹出窗口。`;
        return page;
      } finally { await session?.detach().catch(() => {}); }
    });
    this.pageCreation = create.catch(() => {});
    return create;
  }

  async browser(interactive = false) {
    if (this.launching) await this.launching;
    if (this.context && interactive && this.active && !this.visible) throw new Error('正在搜索或下载，请等待完成后打开登录浏览器');
    if (this.context) return this.context;
    this.launching = (async () => {
      const selected = await resolveBrowser(this.getSettings().browser || 'chrome');
      const background = this.backgroundMode() && !interactive;
      this.context = await chromium.launchPersistentContext(path.join(this.dataDir, selected.profile), { executablePath: selected.executablePath, headless: this.headless, args: background ? ['--start-minimized', '--window-position=-32000,-32000', '--window-size=1280,900', '--no-first-run', '--no-default-browser-check'] : [], acceptDownloads: true, downloadsPath: path.join(this.dataDir, 'transfers'), viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
      this.browserName = selected.name;
      this.visible = !background && !this.headless;
      this.sessionMessage = background ? `${selected.name} 正在后台运行；搜索、书单读取和下载不会主动弹出窗口。` : '浏览器已打开；请在独立窗口中登录，搜索和下载将共用此会话。';
      const context = this.context;
      context.on('close', () => { if (this.context === context) { this.context = null; this.recoveryPage = null; this.sessionMessage = '浏览器已关闭，登录状态保存在本机。'; } });
      if (background) await this.hideWindow(context.pages()[0]);
      return context;
    })();
    try { return await this.launching; } finally { this.launching = null; }
  }

  async login() {
    if (this.demo) return { message: '演示模式不需要登录' };
    const context = await this.browser(true);
    const existing = this.recoveryPage && !this.recoveryPage.isClosed() ? this.recoveryPage : context.pages().find(p => p.url().startsWith(this.getSettings().site));
    const page = existing || context.pages()[0] || await context.newPage();
    if (!existing) await page.goto(this.getSettings().site, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.showWindow(page);
    await page.bringToFront();
    this.visible = true;
    this.sessionMessage = `已显示 ${this.browserName}；请完成登录或网站验证。`;
    return { message: `已打开 ${this.browserName}。请在此独立窗口完成登录或验证，保持窗口打开，然后回到这里搜索。日常 Chrome 的登录状态不会自动共享。` };
  }

  async checkPage(page) {
    const body = (await page.locator('body').innerText()).slice(0, 20000);
    const problem = pageAccessProblem(await page.title(), body, page.url());
    if (problem) throw Object.assign(new Error(problem.message), { code: problem.code, needsUser: true });
  }

  sessionStatus() { return { open: !!this.context, browser: this.browserName, message: this.sessionMessage }; }

  async inspectSession() {
    if (!this.context) return { message: '尚未打开登录浏览器，请先点击右上角的登录按钮。' };
    const page = this.recoveryPage && !this.recoveryPage.isClosed() ? this.recoveryPage : this.context.pages().find(p => p.url().startsWith(this.getSettings().site));
    if (!page) return { message: '浏览器中没有当前站点页面，请先打开登录浏览器。' };
    try {
      await this.checkPage(page);
      const limit = await downloadLimitOnPage(page);
      if (limit) { this.sessionMessage = '网站当前下载额度已用完；检查页面不会改变队列状态。'; return { ...this.sessionStatus(), downloadLimit: { code: limit.code, quota: limit.quota } }; }
      this.sessionMessage = '当前页面未发现拒绝访问或验证提示；这不代表已确认登录，请在网站中核对账号状态。';
    }
    catch (error) { if (!error.needsUser) throw error; this.sessionMessage = error.message; }
    return { ...this.sessionStatus(), message: this.sessionMessage };
  }

  async checkDownloadQuota({ signal } = {}) {
    if (this.demo) return { available: false, message: '演示模式不检查真实网站额度' };
    if (signal?.aborted) throw new Error('额度检查已停止');
    const context = await this.browser();
    this.active++;
    let page;
    const abort = () => { void closePage(page); };
    try {
      page = await this.operationPage(context);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) throw new Error('额度检查已停止');
      await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache' });
      const response = await page.goto(this.getSettings().site, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response?.ok()) return { available: false, message: '网站暂时无法访问，保持暂停' };
      if (new URL(page.url()).origin !== new URL(this.getSettings().site).origin) return { available: false, message: '网站跳转到其他站点，未确认额度恢复，保持暂停' };
      await this.checkPage(page);
      if (/\/(?:login|signin|auth)(?:[/?#]|$)/i.test(page.url())) return { available: false, message: '需要重新登录，保持暂停' };
      if (await page.locator('form[action*="login"] input[type="password"], form[action*="signin"] input[type="password"]').count()) return { available: false, message: '需要重新登录，保持暂停' };
      await page.waitForFunction(() => /(?:每日限额|每日下载(?:限额|次数)|daily(?:\s+downloads?)?\s+limit)/i.test(document.body?.textContent || ''), undefined, { timeout: 8000 }).catch(() => {});
      const text = await page.evaluate(extractDownloadLimitNotice);
      const quota = dailyQuotaFromText(text);
      if (signal?.aborted) throw new Error('额度检查已停止');
      if (downloadLimitFromText(text)) return { available: false, quota, message: '每日下载额度仍已用完，继续等待' };
      return { available: !!quota && quota.used < quota.limit, quota, message: quota ? '已读取每日下载额度' : '未读到明确的每日额度，保持暂停；请检查登录或验证状态' };
    } finally { signal?.removeEventListener('abort', abort); await closePage(page); this.active--; }
  }

  async holdForUser(page, error) {
    if (!error.needsUser || !page || page.isClosed()) return false;
    this.recoveryPage = page;
    if (this.backgroundMode()) {
      this.sessionMessage = `${error.message} 浏览器仍保持在后台，请点击“打开登录浏览器”处理。`;
      await this.hideWindow(page);
    } else {
      this.sessionMessage = error.message;
      await page.bringToFront().catch(() => {});
    }
    return true;
  }

  async search(query, filters, pageNumber = 1) {
    const base = this.getSettings().site;
    if (this.demo) {
      const books = demoBooks(base).filter(b => (!query || `${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase())) && (!filters.format || b.format === filters.format) && (!filters.language || b.language === filters.language) && (!filters.yearFrom || +b.year >= +filters.yearFrom) && (!filters.yearTo || +b.year <= +filters.yearTo));
      return { books: pageNumber === 1 ? books : [], page: pageNumber, hasNext: false, source: 'demo' };
    }
    const context = await this.browser(); this.active++;
    let page, retained = false;
    try {
      const target = buildSearchUrl(base, query, filters, pageNumber);
      let response;
      if (this.recoveryPage && !this.recoveryPage.isClosed() && this.recoveryPage.url() === target) {
        page = this.recoveryPage; this.recoveryPage = null;
        if (this.backgroundMode()) await this.hideWindow(page);
      } else {
        page = await this.operationPage(context);
        response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
      await this.checkPage(page);
      if (response && !response.ok()) throw new Error(`网站返回 HTTP ${response.status()}，请检查站点地址或登录状态`);
      await page.locator('z-bookcard, .book-item, .resItemBox, a[href*="/book/"]').first().waitFor({ timeout: 7000 }).catch(() => {});
      const result = await page.evaluate(extractBooksDom);
      const seen = new Set();
      const books = result.books.filter(b => { const url = new URL(b.url); if (url.origin !== new URL(base).origin || seen.has(url.pathname)) return false; seen.add(url.pathname); b.id = url.pathname; return true; });
      if (!books.length && !/nothing found|no (?:books|results|matches)|未找到|没有找到|暂无结果|搜索结果.*0/i.test(result.body)) throw new Error('未能识别搜索结果：网站可能要求登录，或页面结构已变化。请打开登录浏览器检查；当前适配器需要真实站点联调。');
      this.sessionMessage = '搜索成功，正在使用当前浏览器会话。';
      return { books, page: pageNumber, hasNext: result.hasNext, source: 'website', warning: '筛选参数已传递给网站；缺失的书籍元数据请在详情页核对。' };
    } catch (error) { retained = await this.holdForUser(page, error); throw error; }
    finally { this.active--; if (!retained) await closePage(page); }
  }

  async importBooklist(value, { signal, onProgress }) {
    const url = validateBooklistUrl(value, this.getSettings().site);
    if (this.demo) {
      const books = demoBooks(this.getSettings().site);
      const slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) || '').replace(/\.html?$/i, '');
      const title = slug || '演示网站书单';
      onProgress({ title, books, pages: 1 }); return { title, books, pages: 1 };
    }
    const context = await this.browser(); this.active++;
    let page, retained = false;
    const stop = () => { void closePage(page); };
    signal.addEventListener('abort', stop, { once: true });
    const all = new Map(); let title = '网站书单', pages = 0, pageDepth = 1, apiCursor = null, finishedAfterDom = false, sourceTotal = null;
    const complete = () => ({ title: title.trim(), books: [...all.values()], pages, sourceTotal,
      warning: sourceTotal !== null && sourceTotal !== all.size ? `网站标示 ${sourceTotal} 条，实际返回 ${all.size} 本。已读取至分页末尾；数量差异来自网站返回结果，不能保证未返回的条目可访问。` : '' });
    const recoveryAttempts = new Map();
    try {
      if (signal.aborted) throw new Error('已停止读取书单');
      page = await this.operationPage(context);
      let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.checkPage(page);
      if (new URL(page.url()).pathname !== new URL(url).pathname) throw new Error('书单页面发生跳转，请确认书单可访问并已登录');
      const booklistRoot = page.locator('.booklist-main .readlist-view').first();
      if (response && !response.ok()) {
        // The site sometimes returns 503 while still rendering a complete, usable booklist page.
        const usable = await booklistRoot.waitFor({ state: 'attached', timeout: 3000 }).then(() => true).catch(() => false);
        if (!usable) throw new Error(`书单返回 HTTP ${response.status()}，请检查网站连接${[401, 403].includes(response.status()) ? '及访问权限' : '，稍后可重试读取'}`);
      }
      await booklistRoot.waitFor({ state: 'attached', timeout: 12000 });
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      title = await page.locator('.booklist-header__title-value').first().textContent().catch(() => null) || (await page.title()).split(/—|\|/)[0].trim();
      const listId = new URL(url).pathname.split('/')[2];
      booklistLoop: for (let round = 0; round < 1500; round++) {
        if (signal.aborted) throw new Error('已停止读取书单');
        await this.checkPage(page);
        const result = await page.evaluate(extractBooksDom, { booklist: true });
        for (const book of result.books) {
          const bookUrl = new URL(book.url);
          if (bookUrl.origin !== new URL(url).origin || !/^\/book\//.test(bookUrl.pathname)) continue;
          book.id = bookUrl.pathname; all.set(book.id, book);
        }
        pages = Math.max(pages, pageDepth);
        onProgress({ title: title.trim(), books: [...all.values()], pages });
        if (all.size >= 5000) throw new Error('书单已读取 5000 本，达到单次上限；可下载已读取部分');
        if (finishedAfterDom) return complete();
        const more = page.locator('.booklist-main .page-load-more').first();
        if (!apiCursor) {
          if (!await more.count()) return complete();
          if (!await more.isVisible()) await more.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
          if (!await more.isVisible()) return complete();
        }
        const before = (await page.evaluate(booklistPageState)).count;
        let loaded, loadError;
        try {
          if (apiCursor) {
            const raw = await page.evaluate(fetchBooklistApiPage, { ...apiCursor, timeoutMs: this.booklistPageTimeoutMs || 30000 });
            loaded = { ok: () => raw.status >= 200 && raw.status < 300, status: () => raw.status, text: async () => raw.text, url: () => apiCursor.url };
          } else {
            const pending = page.waitForResponse(r => new URL(r.url()).pathname.startsWith(`/papi/booklist/${listId}/get-books/`), { timeout: 25000 });
            [loaded] = await Promise.all([pending, more.click({ timeout: 10000 })]);
          }
          if (loaded.ok()) {
            const responseText = await readBooklistResponse(loaded, this.booklistPageTimeoutMs || 30000);
            const info = booklistResponseInfo(responseText);
            if (process.env.BOOKLIST_DIAGNOSTICS === '1') console.log('BOOKLIST_RESPONSE', JSON.stringify({ before, books: all.size, info, shape: booklistResponseDiagnostic(responseText) }));
            if (info.error) throw new Error(`分页接口返回错误：${info.error}，已保留读取结果`);
            if (info.pagination?.totalItems !== null && info.pagination?.totalItems !== undefined) sourceTotal = info.pagination.totalItems;
            if (apiCursor && info.pagination?.current !== apiCursor.page) throw new Error('分页接口未推进到指定页，已保留读取结果');
            if (info.emptyEnd) { pages = Math.max(pages, info.pagination?.current || pages); return complete(); }
            if (apiCursor || info.emptyPage) {
              if (!info.pagination || (!info.pagination.lastPage && !info.pagination.nextPage)) throw new Error('后续分页缺少有效的页码信息，已保留读取结果');
              const records = booklistApiRecords(responseText, url);
              const htmlBooks = records.html ? (await page.evaluate(extractBooksDom, { html: records.html })).books : [];
              const returnedBooks = [...records.books, ...htmlBooks];
              if (returnedBooks.length !== records.expected) throw new Error('后续分页的部分书籍无法识别，已保留读取结果');
              for (const book of returnedBooks) {
                const bookUrl = new URL(book.url);
                if (bookUrl.origin !== new URL(url).origin || !/^\/book\//.test(bookUrl.pathname)) throw new Error('后续分页返回了无效书籍链接，已保留读取结果');
                book.id = bookUrl.pathname; all.set(book.id, book);
              }
              if (all.size >= 5000) throw new Error('书单已读取 5000 本，达到单次上限；可下载已读取部分');
              pages = Math.max(pages, info.pagination.current); pageDepth = info.pagination.current;
              if (info.pagination.lastPage) return complete();
              const request = apiCursor || { method: loaded.request().method(), body: loaded.request().postData(), headers: await loaded.request().allHeaders() };
              apiCursor = booklistApiCursor(loaded.url(), request, info.pagination.current, info.pagination.nextPage);
              await page.waitForTimeout(this.headless ? 0 : 600);
              continue booklistLoop;
            }
            try {
              await page.waitForFunction(booklistPageState, { before, requireGrowth: info.requireGrowth }, { timeout: this.booklistPageTimeoutMs || 30000 });
            } catch (error) {
              if (error.name !== 'TimeoutError') throw error;
              if (process.env.BOOKLIST_DIAGNOSTICS === '1') console.log('BOOKLIST_DOM_TIMEOUT', JSON.stringify(await page.evaluate(booklistDomDiagnostic).catch(() => null)));
              throw Object.assign(new Error('分页响应已收到，但书籍内容未正常更新，已保留读取结果'), { code: 'BOOKLIST_PAGE_TIMEOUT' });
            }
            finishedAfterDom = Boolean(info.pagination?.lastPage);
          }
        } catch (error) { loadError = error; }
        if (loadError || !loaded?.ok()) {
          const status = loaded?.status();
          const transient = (status >= 300 && status <= 399)
            || [408, 425, 429].includes(status)
            || (status >= 500 && status <= 599)
            || loadError?.code === 'BOOKLIST_PAGE_TIMEOUT'
            || /Timeout/i.test(loadError?.name || loadError?.message || '');
          const checkpoint = `${all.size}:${pageDepth}`;
          const attempt = recoveryAttempts.get(checkpoint) || 0;
          if (!transient || attempt >= this.booklistRetryDelays.length) {
            if (loadError) throw loadError;
            if (status) throw new Error(`加载后续书籍失败（HTTP ${status}），已保留读取结果`);
            throw loadError || new Error('加载后续书籍失败，已保留读取结果');
          }
          recoveryAttempts.set(checkpoint, attempt + 1);
          const delay = this.booklistRetryDelays[attempt];
          const reason = loadError?.code === 'BOOKLIST_PAGE_TIMEOUT' ? '分页页面更新超时' : status ? `HTTP ${status}` : '分页请求超时';
          onProgress({
            title: title.trim(),
            books: [...all.values()],
            pages,
            message: `网站暂时出现${reason}，${Math.ceil(delay / 1000)} 秒后重新载入并续读（${attempt + 1}/${this.booklistRetryDelays.length}）…`,
          });
          await page.waitForTimeout(delay);
          if (signal.aborted) throw new Error('已停止读取书单');
          response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
          await this.checkPage(page);
          await booklistRoot.waitFor({ state: 'attached', timeout: 12000 });
          await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
          pageDepth = 1; apiCursor = null; finishedAfterDom = false;
          continue booklistLoop;
        }
        pageDepth++;
        await new Promise(resolve => setTimeout(resolve, this.headless ? 0 : 600));
      }
      throw new Error('书单加载次数达到上限，已保留读取结果');
    } catch (error) {
      if (signal.aborted) throw new Error('已停止读取书单');
      retained = await this.holdForUser(page, error); throw error;
    } finally { signal.removeEventListener('abort', stop); this.active--; if (!retained) await closePage(page); }
  }

  async download(book, directory, signal, onProgress) {
    await mkdir(directory, { recursive: true });
    if (signal.aborted) throw new Error('已取消');
    if (!this.demo) {
      const existing = await findExistingDownload(directory, book);
      if (existing) {
        onProgress({ state: 'completed', message: '文件已存在，已跳过下载', receivedBytes: existing.bytes, totalBytes: existing.bytes, percent: 100 });
        return existing;
      }
    }
    if (this.demo) {
      const filename = await reserveFilename(directory, bookFilename(book, '', { demo: true }));
      try {
        await writeFile(path.join(directory, filename), `演示下载占位文件（不是电子书）\n${book.title}\n${book.author}\n此文件仅用于验证下载队列和保存流程。\n`);
      } catch (error) { await unlink(path.join(directory, filename)).catch(() => {}); throw error; }
      onProgress('演示文件已保存');
      return { filename, bytes: (await stat(path.join(directory, filename))).size };
    }
    const context = await this.browser(); this.active++;
    let page, download, savedPath, saveTask, watch, retained = false, directRoute, chromeFallback = false;
    const cancel = () => { download?.cancel().catch(() => {}); void closePage(page); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) throw new Error('已取消');
      page = await this.operationPage(context);
      let response = await page.goto(book.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const initialLimit = await downloadLimitOnPage(page);
      if (initialLimit) throw initialLimit;
      await this.checkPage(page);
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      let button;
      try { button = await findDownloadButton(page, { timeoutMs: 15000 }); }
      catch (error) {
        const limit = await downloadLimitOnPage(page);
        if (limit) throw limit;
        if (response?.status() !== 503) throw error;
        await page.waitForTimeout(1500);
        response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
        const refreshedLimit = await downloadLimitOnPage(page);
        if (refreshedLimit) throw refreshedLimit;
        await this.checkPage(page);
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        button = await findDownloadButton(page, { timeoutMs: 15000 });
      }
      // Start download-response monitoring only after the usable detail page is ready.
      // The site may render a valid detail page with an anomalous HTTP 503 status.
      const requestHeaders = {
        'user-agent': await page.evaluate(() => navigator.userAgent),
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        referer: page.url(),
      };
      let armDirectRoute = false, resolveDirect;
      const directTransfer = new Promise(resolve => { resolveDirect = resolve; });
      directRoute = async route => {
        const request = route.request();
        try {
          if (armDirectRoute && request.isNavigationRequest() && new URL(request.url()).origin !== new URL(book.url).origin) {
            armDirectRoute = false;
            resolveDirect({ url: request.url(), headers: request.headers() });
            await route.abort('aborted');
            return;
          }
        } catch { /* Let malformed or closing requests continue normally. */ }
        await route.fallback().catch(() => {});
      };
      await page.route('**/*', directRoute);
      onProgress('正在排队等待请求文件…');
      const outcome = await this.runBrowserTransfer(async () => {
        if (signal.aborted) throw new Error('已取消');
        const limit = await downloadLimitOnPage(page);
        if (limit) throw limit;
        watch = watchDownload(context, page, { ...this.downloadTimeouts, checkLimit: tab => downloadLimitOnPage(tab, { allowCounter: false }) });
        // Directory-wide file polling cannot associate a GUID with this book.
        // In particular, a late download from a timed-out attempt can otherwise
        // make a new request incorrectly display "saving" and someone else's bytes.
        armDirectRoute = true;
        onProgress('正在请求文件…');
        return waitForDownloadStart({
          page, context, signal, watch, directTransfer,
          timeoutMs: this.downloadTimeouts?.startTimeoutMs,
          trigger: () => button.click({ noWaitAfter: true, timeout: 120000 }),
        });
      }, signal);
      download = outcome.download;
      if (signal.aborted) { await download?.cancel(); throw new Error('已取消'); }
      onProgress('正在传输文件…');
      watch.startTransfer();
      const suggested = download?.suggestedFilename() || '';
      if (/\.(html?|aspx?|php)$/i.test(suggested)) throw new Error('网站返回了网页而非电子书，请检查登录或下载额度');
      const filename = await reserveFilename(directory, bookFilename(book, suggested));
      savedPath = path.join(directory, filename);
      await page.unroute('**/*', directRoute).catch(() => {}); directRoute = null;
      let info;
      if (outcome.direct) {
        Object.assign(requestHeaders, outcome.direct.headers || {});
        for (const name of Object.keys(requestHeaders)) if (!['accept', 'accept-language', 'cookie', 'referer', 'user-agent'].includes(name.toLowerCase())) delete requestHeaders[name];
        await watch.dispose(); watch = null;
        let directFailure;
        try {
          saveTask = this.transferHttp({ url: outcome.direct.url, destination: savedPath, headers: requestHeaders, signal, onProgress });
          info = await saveTask;
        } catch (error) {
          if (!isDownloadNetworkError(error) || signal.aborted) throw error;
          directFailure = error;
        }
        if (!info) {
          chromeFallback = true;
          const code = directFailure?.cause?.cause?.code || directFailure?.cause?.code || directFailure?.code;
          const diagnostic = /^[A-Z][A-Z0-9_]{1,80}$/.test(code || '') ? code : '网络连接异常';
          onProgress(`直连失败（${diagnostic}），正在排队通过 Chrome 稳定传输文件…`);
          if (process.env.DOWNLOAD_DIAGNOSTICS === '1') console.log('DOWNLOAD_DIRECT_FALLBACK', JSON.stringify({ host: new URL(outcome.direct.url).hostname, code: diagnostic }));
          info = await this.runChromeTransfer(async () => {
            if (signal.aborted) throw new Error('已取消');
            saveTask = downloadWithBrowserStream({
              context,
              page,
              url: outcome.direct.url,
              destination: savedPath,
              signal,
              onProgress,
              timeouts: this.downloadTimeouts,
            });
            return saveTask;
          }, signal);
        }
      } else {
        onProgress({ state: 'inProgress', message: 'Chrome 正在传输文件，等待浏览器报告完成…', transferStarted: true, receivedBytes: 0, totalBytes: 0, percent: null });
        saveTask = download.saveAs(savedPath);
        await watch.race(saveTask);
        const failure = await watch.race(download.failure());
        if (failure) throw new Error(failure);
        info = await stat(savedPath);
      }
      if (!info.size) throw new Error('下载的文件为空');
      const completed = { state: 'completed', message: '文件已保存', receivedBytes: info.size, totalBytes: info.size, percent: 100 };
      onProgress(completed);
      return { filename, bytes: info.size };
    } catch (error) {
      const failure = watch?.error || error;
      await download?.cancel().catch(() => {});
      await saveTask?.catch(() => {});
      if (savedPath) await unlink(savedPath).catch(() => {});
      if (signal.aborted) throw new Error('已取消');
      if (/Target page, context or browser has been closed/.test(failure.message)) {
        const phase = chromeFallback ? 'Chrome 兜底传输' : '下载页面处理';
        throw new Error(`${phase}期间页面意外关闭，文件未保存（原始错误：${failure.message}）。请重新打开登录浏览器后重试。`);
      }
      retained = await this.holdForUser(page, failure);
      if (/Timeout/.test(failure.name)) throw new Error('下载等待超时：请在登录浏览器中检查额度、验证页面或下载按钮是否跳转到其他页面');
      throw failure;
    } finally { if (directRoute) await page?.unroute('**/*', directRoute).catch(() => {}); await watch?.dispose(); signal.removeEventListener('abort', cancel); this.active--; if (!retained) await closePage(page); }
  }

  async close() { await this.context?.close(); this.context = null; }
}
