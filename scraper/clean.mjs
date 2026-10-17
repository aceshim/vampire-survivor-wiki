// In-browser article cleaner shared by scrape.mjs (at extraction) and build.mjs (post-processing).
// namu.wiki obfuscates class names, so everything here keys off structure, not classes.
// Runs inside Playwright via page.evaluate(cleanArticle, { rootSelector }). Idempotent.

export function cleanArticle({ rootSelector }) {
  const doc = document;
  let root = rootSelector ? doc.querySelector(rootSelector) : doc.body;
  if (!root) root = doc.body;

  // 1. Article root = tightest common ancestor of all numbered headings (a[id^="s-"]).
  const isHeading = (el) => /^H[1-6]$/.test(el.tagName) && el.querySelector('a[id^="s-"]');
  const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(isHeading);
  //    namu nests each section in wrappers, so a page with one heading would otherwise resolve to
  //    that heading alone: climb until the candidate holds at least half of the page text.
  let article = root;
  if (headings.length) {
    article = headings[0].parentElement || root;
    while (article !== root && !headings.every((h) => article.contains(h))) article = article.parentElement;
    const rootLen = root.textContent.length;
    while (article !== root && article.parentElement && article.textContent.length < rootLen * 0.5) article = article.parentElement;
  }

  // 2. Drop page chrome / ads / scripts.
  const kill = (sel) => article.querySelectorAll(sel).forEach((n) => n.remove());
  kill('script, style, iframe, noscript, link, ins, button, [id^="google_ads"], .vm-dynamic-placement, [class*="adsbygoogle"]');
  kill('a[href^="/edit/"], a[href^="/history/"], a[href^="/discuss/"], a[href^="/raw/"], a[href^="/backlink/"], .wiki-edit-section');

  // 3. Lazy-load placeholders: empty data:svg images next to the real image.
  article.querySelectorAll('img[src^="data:image/svg+xml"]').forEach((img) => {
    if (!img.getAttribute('alt')) img.remove();
  });
  // Empty anchors (image "jump" links) and empty inline wrappers left behind.
  article.querySelectorAll('a').forEach((a) => {
    if (!a.textContent.trim() && !a.querySelector('img, video, picture')) a.remove();
  });

  // 4. Legacy folded blocks (old DOM) -> <details>; hidden blocks visible.
  article.querySelectorAll('dl.wiki-folding').forEach((dl) => {
    const dt = dl.querySelector('dt'), dd = dl.querySelector('dd');
    const d = doc.createElement('details'); d.className = 'wiki-folding'; d.open = true;
    const s = doc.createElement('summary'); s.innerHTML = dt ? dt.innerHTML : '펼치기'; d.appendChild(s);
    const body = doc.createElement('div'); body.className = 'wiki-folding-text'; body.innerHTML = dd ? dd.innerHTML : ''; d.appendChild(body);
    dl.replaceWith(d);
  });
  // In-article TOC macro: a <details> with an empty summary holding #s-x links.
  article.querySelectorAll('details').forEach((d) => {
    const sum = d.querySelector(':scope > summary');
    if (sum && !sum.textContent.trim() && d.querySelector('a[href^="#s-"]')) { d.classList.add('wiki-toc'); sum.textContent = '목차'; }
  });
  // Native <details> (current namu DOM): open everything so nothing is hidden offline.
  article.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
  article.querySelectorAll('[style]').forEach((el) => {
    const st = el.getAttribute('style') || '';
    if (/display\s*:\s*none/i.test(st)) {
      const cleaned = st.replace(/display\s*:\s*none\s*;?/gi, '').trim();
      if (cleaned) el.setAttribute('style', cleaned); else el.removeAttribute('style');
    }
  });

  // 5. Blank-line spacer divs (&nbsp; only). namu nests sections in wrappers that each start with
  //    one, so collapse every run of spacers with no real content in between (document order).
  const isSpacer = (el) => el.tagName === 'DIV' && el.children.length === 0 && !el.id && (el.innerHTML === '&nbsp;' || el.textContent.trim() === '');
  Array.from(article.querySelectorAll('div')).filter(isSpacer).forEach((d) => { const sp = doc.createElement('div'); sp.className = 'sp'; d.replaceWith(sp); });
  {
    const walker = doc.createTreeWalker(article, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let contentSince = false; // real content seen since the last kept spacer / heading
    const drop = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) { if (n.textContent.trim()) contentSince = true; continue; }
      if (n.classList.contains('sp')) { if (contentSince) { contentSince = false; } else drop.push(n); continue; }
      if (/^H[1-6]$/.test(n.tagName)) { contentSince = false; continue; }
      if (/^(IMG|VIDEO|TABLE|HR|BR|LI|DETAILS)$/.test(n.tagName)) contentSince = true;
    }
    drop.forEach((n) => n.remove());
  }

  // 5b. Videos that were not downloaded (still remote) become online-only links.
  article.querySelectorAll('video').forEach((v) => {
    const src = v.getAttribute('src') || v.querySelector('source')?.getAttribute('src') || '';
    if (/^https?:/.test(src)) {
      const a = doc.createElement('a'); a.href = src; a.setAttribute('data-online', '1'); a.target = '_blank'; a.rel = 'noopener'; a.textContent = '▶ 동영상 (온라인 전용)';
      v.replaceWith(a);
    } else v.removeAttribute('poster');
  });

  // 6. Headings: normalise to .wiki-heading, drop empty trailing spans, keep the s-x anchor.
  article.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    if (!isHeading(h)) return;
    h.classList.add('wiki-heading');
    h.querySelectorAll('span, a').forEach((s) => {
      if (/^\s*\[편집\]\s*$/.test(s.textContent)) s.remove();
      else if (!s.textContent.trim() && !s.children.length && !s.id) s.remove();
    });
  });

  // 7. Inline image boxes: namu sizes images via a span with inline width/height that its CSS
  //    makes inline-block. We have no namu CSS, so mark them.
  article.querySelectorAll('span[style*="width"], span[style*="height"]').forEach((s) => s.classList.add('wiki-img-box'));

  // 8. Strip Vue scoping attributes (noise, no effect).
  article.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-v-')) el.removeAttribute(a.name);
  });

  // 9. Section index.
  const sections = Array.from(article.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(isHeading).map((h) => {
    const anchor = h.querySelector('a[id^="s-"]');
    const level = Number(h.tagName[1]);
    const text = h.textContent.replace(/\s+/g, ' ').trim();
    return { id: anchor.id, level, text };
  });

  return { html: article.innerHTML, headings: sections };
}
