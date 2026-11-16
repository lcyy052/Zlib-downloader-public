import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink, lstat } from 'node:fs/promises';

export async function atomicJson(file, value, { backup = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    // Finish and flush the new file before touching either committed generation.
    await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', flush: true });
    if (backup) {
      try {
        if (!(await lstat(file)).isFile()) throw Object.assign(new Error('JSON 数据路径不是普通文件'), { code: 'EISDIR' });
        await rename(file, file + '.bak');
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // A crash between the two renames leaves the previous generation in .bak.
    await rename(temp, file);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function safeFilename(value) {
  const clean = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180).replace(/[. ]+$/g, '');
  return !clean || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean) ? `book_${clean || 'download'}` : clean;
}

export function downloadDirectoryPath(value) {
  const directory = String(value || '').trim();
  if (!directory || directory.includes('\0') || !path.isAbsolute(directory)) throw new Error('下载目录必须是完整的绝对路径，例如 D:\\Books');
  return path.normalize(directory);
}

export function downloadConcurrency(value, fallback = 2) {
  const concurrency = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('同时下载数必须是 1–3');
  return concurrency;
}

export function browserMode(value = 'background') {
  if (!['background', 'visible'].includes(value)) throw new Error('浏览器运行方式必须是后台静默或显示窗口');
  return value;
}

export function siteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('站点地址必须为 HTTPS 网站根地址，例如 https://zh.z-library.sk/');
  if (url.hostname === 'localhost' || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') || /\.(local|internal|localhost)$/.test(url.hostname)) throw new Error('请使用公开网站域名');
  return url.origin;
}

export function validateBook(book, base) {
  if (!book || typeof book.title !== 'string' || !book.title.trim()) throw new Error('书籍缺少标题');
  const url = new URL(book.url);
  if (url.origin !== new URL(base).origin || !/^\/book\/[\w-]+(?:\/|$)/.test(url.pathname) || url.username || url.password) throw new Error('只能处理当前站点的书籍详情链接');
  return { id: url.pathname, title: book.title.slice(0, 500), author: String(book.author || '').slice(0, 500), year: String(book.year || '').slice(0, 12), language: String(book.language || '').slice(0, 80), format: String(book.format || '').slice(0, 20), size: String(book.size || '').slice(0, 40), url: url.href };
}

export function parseBooklist(input) {
  const text = String(input).replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('书单内容为空');
  // RFC 4180 fields, including quoted commas and multiline cells.
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && quoted && text[i + 1] === '"') { field += '"'; i++; }
    else if (c === '"' && (quoted || field === '')) quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(field.trim()); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  const aliases = { title: ['title', '书名', '名称'], author: ['author', '作者'], isbn: ['isbn', 'isbn13', 'isbn-13'] };
  const header = rows[0].map(x => x.toLowerCase());
  const columns = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, header.findIndex(h => v.includes(h))]));
  const hasHeader = columns.title >= 0 || columns.isbn >= 0;
  if (hasHeader) rows.shift();
  const seen = new Set();
  const entries = rows.map((r) => {
    const title = r[hasHeader ? columns.title : 0] || '';
    const author = r[hasHeader ? columns.author : 1] || '';
    const isbn = (r[hasHeader ? columns.isbn : 2] || '').replace(/[\s-]/g, '');
    return { id: randomUUID(), title, author, isbn, query: isbn || [title, author].filter(Boolean).join(' ') };
  }).filter(e => { const key = e.query.toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; });
  if (!entries.length) throw new Error('书单中没有有效书名或 ISBN');
  if (entries.length > 200) throw new Error('每次最多导入 200 本书，请分批处理');
  return entries;
}

export function filtersFrom(input = {}) {
  const yearFrom = String(input.yearFrom || ''), yearTo = String(input.yearTo || '');
  for (const year of [yearFrom, yearTo]) if (year && !/^\d{4}$/.test(year)) throw new Error('年份必须为四位数字');
  if (yearFrom && yearTo && +yearFrom > +yearTo) throw new Error('起始年份不能大于结束年份');
  const format = String(input.format || '').toUpperCase();
  if (format && !['EPUB', 'PDF', 'MOBI', 'AZW3', 'TXT', 'DJVU', 'FB2'].includes(format)) throw new Error('不支持的文件格式');
  const language = String(input.language || '');
  if (language && !['chinese', 'english', 'japanese', 'french', 'german', 'spanish'].includes(language)) throw new Error('不支持的语言');
  return { format, language, yearFrom, yearTo };
}

export function buildSearchUrl(base, query, filters, page = 1) {
  const url = new URL(`/s/${encodeURIComponent(query)}`, base);
  if (filters.format) url.searchParams.set('extensions[]', filters.format.toLowerCase());
  if (filters.language) url.searchParams.set('languages[]', filters.language);
  if (filters.yearFrom) url.searchParams.set('yearFrom', filters.yearFrom);
  if (filters.yearTo) url.searchParams.set('yearTo', filters.yearTo);
  url.searchParams.set('page', String(page));
  return url.href;
}
