// dlButton is shared by the website's online reader and file download controls.
// Match the actual URL pathname, never a substring in a reader's query string.
export function downloadCandidates(links, pageUrl) {
  const origin = new URL(pageUrl).origin;
  return links.filter(link => {
    if (link.disabled || /(?:^|\s)reader-link(?:\s|$)/i.test(link.className || '') || /线上阅读|在线阅读|在线打开|read\s+online|open\s+(?:in\s+)?reader/i.test(link.label || '')) return false;
    try {
      const url = new URL(link.href, pageUrl);
      return url.origin === origin && !url.username && !url.password && /^\/(?:dl|download)\/[^/]+/i.test(url.pathname);
    } catch { return false; }
  }).sort((a, b) => Number(/(?:^|\s)addDownloadedBook(?:\s|$)/.test(b.className || '')) - Number(/(?:^|\s)addDownloadedBook(?:\s|$)/.test(a.className || '')));
}

export async function findDownloadButton(page, { timeoutMs = 10000, pollMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const anchors = page.locator('a[href]');
    const links = await anchors.evaluateAll(elements => elements.map((el, index) => ({ index, href: el.getAttribute('href'), className: el.className, label: el.textContent.trim(), disabled: el.matches('[aria-disabled="true"], .disabled') })));
    for (const link of downloadCandidates(links, page.url())) {
      const button = anchors.nth(link.index);
      if (await button.isVisible()) return button;
    }
    if (Date.now() < deadline) await page.waitForTimeout(pollMs);
  } while (Date.now() < deadline);
  throw new Error('未找到可用的文件下载链接（已排除线上阅读按钮）。请检查登录状态、下载额度或该版本是否允许下载。');
}
