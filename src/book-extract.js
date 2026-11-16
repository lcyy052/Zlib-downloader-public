export function extractBooksDom({ booklist = false, html } = {}) {
        const root = typeof html === 'string' ? document.createElement('div') : booklist ? document.querySelector('.readlist-view, .booklist-main') : document;
        if (typeof html === 'string') root.innerHTML = html;
        if (!root) return { books: [], hasNext: false, body: '' };
        const cards = [...root.querySelectorAll('z-bookcard')];
        const nodes = cards.length ? cards : [...root.querySelectorAll('.book-item, .resItemBox')];
        const roots = nodes.length ? nodes : [...root.querySelectorAll('a[href*="/book/"]')].map(a => a.closest('tr') || a.closest('article') || a.parentElement);
        const text = (el, selectors) => { for (const s of selectors) { const v = el.querySelector(s)?.textContent?.trim(); if (v) return v; } return ''; };
        const books = roots.map(el => {
          const link = el.getAttribute('href') || el.querySelector('a[href*="/book/"]')?.getAttribute('href');
          if (!link) return null;
          const raw = el.innerText || el.textContent || '';
          const year = el.getAttribute('year') || text(el, ['.year', '[data-field="year"]', '.property_year .property_value']) || raw.match(/(?:Year|年份|出版年)\s*:?\s*(\d{4})/i)?.[1] || '';
          const file = text(el, ['.property__file', '.property_file .property_value']);
          const img = el.querySelector('img') || el.shadowRoot?.querySelector('img');
          const coverSource = el.getAttribute('cover') || el.getAttribute('cover_url') || img?.getAttribute('data-src') || img?.getAttribute('data-original') || img?.getAttribute('data-lazy-src') || img?.getAttribute('src') || img?.currentSrc || '';
          let cover = '';
          try { const imageUrl = new URL(coverSource, location.href); if (coverSource && imageUrl.protocol === 'https:' && !imageUrl.username && !imageUrl.password) cover = imageUrl.href; } catch {}
          return {
            url: new URL(link, location.href).href,
            cover,
            title: el.getAttribute('title') || text(el, ['[slot="title"]', 'h3', '.book-title', 'a[href*="/book/"]']),
            author: el.getAttribute('author') || text(el, ['[slot="author"]', '.authors', '.author', 'a[href*="/author/"]']),
            year,
            language: el.getAttribute('language') || text(el, ['.property_language .property_value', '.property__language', '.language']),
            format: (el.getAttribute('extension') || el.getAttribute('format') || file.match(/epub|pdf|mobi|azw3|txt|djvu|fb2/i)?.[0] || raw.match(/\b(epub|pdf|mobi|azw3|txt|djvu|fb2)\b/i)?.[0] || '').toUpperCase(),
            size: el.getAttribute('filesize') || file.match(/[\d.,]+\s*[KMGT]?B/i)?.[0] || raw.match(/[\d.,]+\s*[KMGT]B/i)?.[0] || ''
          };
        }).filter(b => b && b.title && /\/book\//.test(b.url));
        const next = document.querySelector('a[rel="next"], .next a, a.next, .paginator .next');
        return { books, hasNext: !!next && !next.matches('.disabled, [aria-disabled="true"]'), body: (document.body.innerText || '').slice(0, 15000) };
}
