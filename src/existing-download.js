import path from 'node:path';
import { open, readdir, stat } from 'node:fs/promises';
import { bookFilename, legacyBookFilename } from './download-name.js';

export function declaredBytes(value) {
  const match = String(value || '').trim().match(/^([\d.,]+)\s*([KMGT]?B)$/i);
  if (!match) return 0;
  const raw = match[1];
  const commaIsThousandsSeparator = !raw.includes('.') && /^\d{1,3}(?:,\d{3})+$/.test(raw);
  const normalized = raw.includes('.') || commaIsThousandsSeparator
    ? raw.replaceAll(',', '')
    : raw.replace(',', '.');
  const number = Number(normalized);
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return Number.isFinite(number) ? Math.round(number * 1024 ** powers[match[2].toUpperCase()]) : 0;
}

async function hasExpectedSignature(file, extension) {
  const handle = await open(file, 'r');
  try {
    if (extension === '.mobi') {
      const buffer = Buffer.alloc(8);
      if ((await handle.read(buffer, 0, 8, 60)).bytesRead !== 8) return false;
      return buffer.toString('ascii') === 'BOOKMOBI';
    }
    const signatures = { '.epub': Buffer.from([0x50, 0x4b, 0x03, 0x04]), '.pdf': Buffer.from('%PDF-') };
    const expected = signatures[extension];
    if (!expected) return true;
    const buffer = Buffer.alloc(expected.length);
    if ((await handle.read(buffer, 0, buffer.length, 0)).bytesRead !== buffer.length) return false;
    return buffer.equals(expected);
  } finally { await handle.close(); }
}

function matchesFilenameFamily(name, filename, extension) {
  if (name.toLowerCase() === filename.toLowerCase()) return true;
  const stem = filename.slice(0, -extension.length);
  const prefix = `${stem} (`;
  if (!name.toLowerCase().startsWith(prefix.toLowerCase()) || !name.toLowerCase().endsWith(extension.toLowerCase())) return false;
  const number = name.slice(prefix.length, -extension.length - 1);
  return /^\d+$/.test(number) && name.at(-extension.length - 1) === ')';
}

export async function findExistingDownload(directory, book) {
  const filename = bookFilename(book);
  const extension = path.extname(filename).toLowerCase();
  const stem = filename.slice(0, -extension.length);
  const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: \\(\\d+\\))?${extension.replace('.', '\\.')}$`, 'i');
  const legacyFilename = legacyBookFilename(book);
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries.filter(entry => entry.isFile() && (pattern.test(entry.name) || matchesFilenameFamily(entry.name, legacyFilename, extension))).sort((a, b) => {
    if (a.name === filename) return -1;
    if (b.name === filename) return 1;
    if (a.name === legacyFilename) return -1;
    if (b.name === legacyFilename) return 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });
  const expected = declaredBytes(book.size);
  for (const candidate of candidates) {
    const file = path.join(directory, candidate.name);
    const info = await stat(file);
    if (!info.size) continue;
    if (expected && Math.abs(info.size - expected) > Math.max(64 * 1024, expected * 0.03)) continue;
    if (!await hasExpectedSignature(file, extension)) continue;
    return { filename: candidate.name, bytes: info.size, reused: true };
  }
  return null;
}
