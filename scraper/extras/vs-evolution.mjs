// Extra page for Vampire Survivors: "무기 + 장신구 = 진화" icon cheat sheet, parsed from the
// 조합법 table of the 아이템 page. Enabled via "extras": ["vs-evolution"] in the site config.

export const slug = '진화_조합표';
export const title = '진화 조합표';
export const sourceSlug = 'Vampire_Survivors__아이템';

// Runs in the browser over the cleaned source page (document.body holds the article).
export function extract() {
  const headings = [...document.querySelectorAll('.wiki-heading')];
  const h = headings.find((x) => /조합법/.test(x.textContent));
  if (!h) return { sections: [] };
  const tables = [...document.querySelectorAll('table')].filter((t) =>
    (h.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) && t.parentElement.closest('table'));
  const table = tables[0];
  if (!table) return { sections: [] };

  const nameFromHref = (a) => {
    if (!a) return '';
    const href = a.getAttribute('href') || '';
    const i = href.indexOf('#');
    if (i < 0) return '';
    try {
      const n = decodeURIComponent(href.slice(i + 1)).replace(/^s-[\d.]+$/, '');
      // Missing image on the wiki links to the file page: 파일:VS_Item_Yatta_Daikarin.webp -> Yatta Daikarin
      return n.startsWith('파일:') ? n.replace(/^파일:/, '').replace(/^VS[_ ](Item|Weapon|Evoled)?[_ ]?/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ') : n;
    } catch { return ''; }
  };
  const parseCell = (td) => {
    const items = [];
    const anchors = [...td.querySelectorAll('a')];
    const imgs = [...td.querySelectorAll('img')];
    for (const img of imgs) {
      const a = img.closest('a');
      let name = nameFromHref(a) || img.getAttribute('alt') || '';
      if (/seal/i.test(img.getAttribute('alt') || '') && !nameFromHref(a)) name = '없음';
      items.push({ src: img.getAttribute('src'), name, href: a?.getAttribute('href') || '' });
    }
    if (!imgs.length && anchors.length) {
      // Missing image on the wiki: keep the name only.
      for (const a of anchors) {
        const t = a.textContent.trim();
        const name = nameFromHref(a) || (t.startsWith('파일:') ? t.replace(/^파일:/, '').replace(/^VS[_ ](Item|Weapon|Evoled)?[_ ]?/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ') : t);
        items.push({ src: '', name, href: a.getAttribute('href') || '' });
      }
    }
    const text = td.textContent.replace(/\s+/g, ' ').trim();
    const tag = (text.match(/\[([^\]]+)\]/) || [])[1] || '';
    return { items, tag };
  };

  const sections = [];
  let section = null, sub = null, block = null;
  const flush = () => {
    if (!block || !block.evolved) return;
    const n = Math.max(block.weapons.length, block.evolved.length);
    for (let i = 0; i < n; i++) {
      const e = block.evolved[i];
      if (!e || !e.items.length) continue;
      (sub || section).recipes.push({ weapons: block.weapons[i] || { items: [], tag: '' }, passives: block.passives[i] || { items: [], tag: '' }, evolved: e });
    }
    block = null;
  };
  for (const tr of table.querySelectorAll(':scope > tbody > tr')) {
    const cells = [...tr.children];
    if (!cells.length) continue;
    const first = cells[0].textContent.replace(/\s+/g, ' ').trim();
    if (cells.length === 1) {
      flush();
      if (first) { section = { title: first, note: '', recipes: [], subs: [] }; sections.push(section); sub = null; }
      continue;
    }
    if (cells.length === 2 && cells[1].colSpan >= 6 && !cells[1].querySelector('img')) {
      flush();
      const td = cells[1];
      const bold = td.querySelector('strong, b');
      const name = (bold ? bold.textContent : (td.firstChild?.textContent || td.textContent)).replace(/\s+/g, ' ').trim();
      const note = td.textContent.replace(/\s+/g, ' ').trim().replace(name, '').trim();
      sub = { title: name, note, recipes: [] };
      (section || (section = { title: '', note: '', recipes: [], subs: [] })).subs.push(sub);
      continue;
    }
    const rest = cells.slice(1).map(parseCell);
    if (/^일반\s*무기/.test(first) || /무기$/.test(first)) { flush(); block = { weapons: rest, passives: [], evolved: null }; }
    else if (/장신구|요구/.test(first)) { if (!block) block = { weapons: [], passives: [], evolved: null }; block.passives = rest; }
    else if (/진화/.test(first)) { if (!block) block = { weapons: [], passives: [], evolved: null }; block.evolved = rest; flush(); }
  }
  flush();
  return { sections: sections.filter((s) => s.recipes.length || s.subs.some((x) => x.recipes.length)) };
}

export function render(data, { esc }) {
  const icon = (it, tag) => {
    const img = it.src ? `<img src="${esc(it.src)}" alt="${esc(it.name)}">` : `<span class="noimg">?</span>`;
    const badge = tag ? `<b class="badge">${esc(tag === '최대' ? 'MAX' : tag)}</b>` : '';
    const inner = `<span class="ic">${img}${badge}</span><small>${esc(it.name)}</small>`;
    return it.href ? `<a class="item" href="${esc(it.href)}">${inner}</a>` : `<span class="item">${inner}</span>`;
  };
  const group = (cell) => cell.items.map((it, i) => (i ? '<span class="op">+</span>' : '') + icon(it, cell.tag)).join('');
  const recipe = (r) => `<div class="recipe${r.weapons.items.length + r.passives.items.length + r.evolved.items.length > 3 ? ' wide' : ''}">${group(r.weapons)}<span class="op">+</span>${group(r.passives)}<span class="op eq">=</span>${group(r.evolved)}</div>`;
  const list = (recipes) => `<div class="recipes">${recipes.map(recipe).join('')}</div>`;
  let html = '<p class="lead">무기 + 장신구(MAX = 최대 레벨 필요) = 진화 무기. 아이콘을 누르면 해당 문단으로 이동.</p>';
  for (const s of data.sections) {
    html += `<h2 class="wiki-heading"><a id="${esc(slugId(s.title))}" href="#toc"></a>${esc(s.title)}</h2>`;
    if (s.recipes.length) html += list(s.recipes);
    for (const sub of s.subs) {
      if (!sub.recipes.length) continue;
      html += `<h3 class="wiki-heading"><a id="${esc(slugId(sub.title))}" href="#toc"></a>${esc(sub.title)}</h3>`;
      if (sub.note) html += `<p class="note">${esc(sub.note)}</p>`;
      html += list(sub.recipes);
    }
  }
  const headings = [];
  for (const s of data.sections) {
    headings.push({ id: slugId(s.title), level: 2, text: s.title });
    for (const sub of s.subs) if (sub.recipes.length) headings.push({ id: slugId(sub.title), level: 3, text: sub.title });
  }
  return { html: `<div class="evo">${html}</div>`, headings };
}

function slugId(s) { return 'evo-' + s.replace(/\s+/g, '-').replace(/[^\w가-힣-]/g, '').slice(0, 40); }
