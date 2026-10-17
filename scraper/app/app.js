(() => {
  const root = document.documentElement.dataset.root || './';
  const $ = (id) => document.getElementById(id);
  const pill = $('offlinePill');

  // --- service worker / offline status --------------------------------------
  if ('serviceWorker' in navigator) {
    const setPill = (text, cls) => { if (!pill) return; pill.textContent = text; pill.className = 'offline-pill ' + (cls || ''); };
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'progress') setPill(`저장 중 ${Math.round(m.done / m.total * 100)}%`, 'warn');
      if (m.type === 'installed' || m.type === 'ready') askStatus();
      if (m.type === 'status') {
        if (m.cached >= m.total) setPill('오프라인 OK', 'ok');
        else setPill(`캐시 ${m.cached}/${m.total}`, m.cached > m.total * 0.9 ? 'warn' : 'err');
      }
    });
    const askStatus = () => navigator.serviceWorker.controller?.postMessage({ type: 'status' });
    navigator.serviceWorker.register(root + 'sw.js').then((reg) => {
      if (navigator.serviceWorker.controller) askStatus(); else setPill('준비 중…', 'warn');
      reg.addEventListener('updatefound', () => setPill('업데이트 중…', 'warn'));
    }).catch(() => setPill('캐시 불가', 'err'));
    if (!navigator.onLine) setPill('오프라인', navigator.serviceWorker.controller ? 'ok' : 'err');
  } else if (pill) {
    pill.textContent = 'SW 미지원'; pill.className = 'offline-pill err';
  }

  // --- drawer / toc -----------------------------------------------------------
  const drawer = $('drawer'), toc = $('tocPanel'), scrim = $('scrim');
  const open = (el) => { if (!el) return; el.hidden = false; scrim && (scrim.hidden = false); if (el === drawer) setTimeout(() => $('searchBox')?.focus(), 50); };
  const closeAll = () => { for (const el of [drawer, toc, scrim]) if (el) el.hidden = true; };
  $('menuBtn')?.addEventListener('click', () => open(drawer));
  $('tocBtn')?.addEventListener('click', () => open(toc));
  $('closeDrawer')?.addEventListener('click', closeAll);
  $('closeToc')?.addEventListener('click', closeAll);
  scrim?.addEventListener('click', closeAll);
  toc?.addEventListener('click', (e) => { if (e.target.tagName === 'A') closeAll(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  // --- search -----------------------------------------------------------------
  const box = $('searchBox'), results = $('results'), pageList = $('pageList');
  if (box) {
    let index = null;
    const load = async () => { if (!index) index = await (await fetch(root + 'search.json')).json(); return index; };
    const siteDir = (e) => root + e.site + '/' + encodeURIComponent(e.slug) + '.html';
    const render = (items) => {
      results.innerHTML = items.slice(0, 60).map((r) =>
        `<li><a href="${r.href}">${esc(r.title)}<small>${esc(r.sub)}</small></a></li>`).join('');
      results.hidden = items.length === 0;
      if (pageList) pageList.hidden = items.length > 0;
    };
    box.addEventListener('input', async () => {
      const q = box.value.trim().toLowerCase();
      if (!q) { results.hidden = true; if (pageList) pageList.hidden = false; return; }
      const idx = await load();
      const out = [];
      for (const e of idx) {
        if ((e.short + ' ' + e.title).toLowerCase().includes(q)) out.push({ href: siteDir(e), title: e.short, sub: e.book });
        for (const h of e.headings) if (h.text.toLowerCase().includes(q)) out.push({ href: siteDir(e) + '#' + h.id, title: h.text, sub: e.book + ' › ' + e.short });
      }
      render(out);
    });
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
})();
