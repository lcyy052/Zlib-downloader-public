import { summarizeJobs, summarizeBatches } from '../src/booklist.js';

// Fixed, fictional data only. Do not sample a user's library or runtime files.
export function readmeScreenshotState() {
  const sources = [
    { id: 'showcase-literature', title: '示例书单 · 文学阅读', url: 'https://demo.example/booklist/1/demo/literature.html', state: 'active' },
    { id: 'showcase-science', title: '示例书单 · 科学探索', url: 'https://demo.example/booklist/2/demo/science.html', state: 'active' },
  ];
  const books = Array.from({ length: 8 }, (_, index) => ({
    id: 'showcase-book-' + index,
    title: '示例书籍 ' + String.fromCharCode(65 + index),
    author: '演示作者', year: '2024', language: '中文',
    format: index % 2 ? 'EPUB' : 'PDF', size: '1.20 MB',
    url: 'https://demo.example/book/' + (index + 1) + '/demo',
  }));
  const statuses = ['completed', 'failed', 'queued', 'completed', 'completed', 'completed', 'queued', 'completed'];
  const jobs = books.map((book, index) => ({
    id: 'showcase-job-' + index, book, status: statuses[index],
    sources: [{ ...sources[index < 4 ? 0 : 1] }], attempts: 0,
    message: statuses[index] === 'completed' ? '演示任务已完成' : statuses[index] === 'failed' ? '模拟失败：示例状态，不代表实际网络错误' : '演示状态：等待额度恢复',
    ...(statuses[index] === 'completed' ? { filename: book.title + '.demo.txt' } : {}),
  }));
  return {
    demo: true, directory: 'downloads/demo（示例目录）',
    settings: { site: 'https://demo.example', browser: 'chrome', browserMode: 'background', downloadDirectory: 'downloads/demo（示例目录）', downloadConcurrency: 2, quotaAutoResume: true, quotaCheckMinutes: 30 },
    browserSession: { open: false, browser: 'Chrome', message: '演示会话，无真实登录信息。' },
    matching: null,
    websiteBooklist: { ...sources[0], books: books.slice(0, 4), running: false, complete: true, pages: 1 },
    queue: {
      jobs, paused: true, busy: false, concurrency: 2, error: null,
      autoPause: { kind: 'quota', message: '演示状态：下载额度已满，任务暂停等待恢复。' },
      quotaRecovery: { enabled: true, intervalMinutes: 30, message: '演示状态：定时检查额度，恢复后自动继续', nextCheckAt: null },
      summary: summarizeJobs(jobs), batches: summarizeBatches(jobs),
    },
  };
}
