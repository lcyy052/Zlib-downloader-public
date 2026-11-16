import path from 'node:path';
import { open } from 'node:fs/promises';
import { safeFilename } from './utils.js';

function cleanMetadata(value) {
  return String(value || '').replace(/[（(\[]([^）)\]]+)[）)\]]/g, (whole, content) => {
    const parts = content.trim().split(/[,;\s]+/);
    return parts.every(p => /^(?:z-library|z-lib|1lib|b-ok)(?:\.[a-z0-9-]+)+$/i.test(p)) ? '' : whole;
  }).replace(/\s+/g, ' ').trim();
}

export function bookFilename(book, suggested = '', { demo = false } = {}) {
  const suggestedExt = path.extname(suggested).slice(1).toLowerCase();
  const format = String(book.format || '').toLowerCase();
  const extension = /^[a-z0-9]{1,10}$/.test(suggestedExt) ? suggestedExt : /^[a-z0-9]{1,10}$/.test(format) ? format : 'bin';
  const suffix = demo ? '.demo.txt' : `.${extension}`;
  const title = safeFilename(cleanMetadata(book.title) || '未命名书籍');
  const rawAuthor = cleanMetadata(book.author);
  const author = rawAuthor ? safeFilename(rawAuthor).slice(0, 64).replace(/[. ]+$/g, '') : '';
  const rawYear = cleanMetadata(book.year);
  const year = rawYear ? safeFilename(rawYear).slice(0, 24).replace(/[. ]+$/g, '') : '';
  const authorPart = author ? `(${author})` : '';
  const yearPart = year ? `-${year}` : '';
  // Reserve room for author, year and extension when a long title must be shortened.
  const titlePart = title.slice(0, 180 - suffix.length - authorPart.length - yearPart.length).replace(/[. ]+$/g, '');
  return `${titlePart}${authorPart}${yearPart}${suffix}`;
}

export function legacyBookFilename(book, suggested = '', { demo = false } = {}) {
  const suggestedExt = path.extname(suggested).slice(1).toLowerCase();
  const format = String(book.format || '').toLowerCase();
  const extension = /^[a-z0-9]{1,10}$/.test(suggestedExt) ? suggestedExt : /^[a-z0-9]{1,10}$/.test(format) ? format : 'bin';
  const suffix = demo ? '.demo.txt' : `.${extension}`;
  const title = safeFilename(cleanMetadata(book.title) || '未命名书籍');
  const rawAuthor = cleanMetadata(book.author);
  const author = rawAuthor ? safeFilename(rawAuthor).slice(0, 64).replace(/[. ]+$/g, '') : '';
  const authorPart = author ? ` - ${author}` : '';
  const titlePart = title.slice(0, 180 - suffix.length - authorPart.length).replace(/[. ]+$/g, '');
  return `${titlePart}${authorPart}${suffix}`;
}

export async function reserveFilename(directory, filename) {
  const extension = filename.endsWith('.demo.txt') ? '.demo.txt' : path.extname(filename);
  const stem = filename.slice(0, -extension.length);
  for (let n = 1; n <= 10000; n++) {
    const name = n === 1 ? filename : `${stem} (${n})${extension}`;
    try {
      // Reserve atomically so existing files are never overwritten by a new download.
      const handle = await open(path.join(directory, name), 'wx');
      await handle.close();
      return name;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名文件过多，请整理下载目录后重试');
}
