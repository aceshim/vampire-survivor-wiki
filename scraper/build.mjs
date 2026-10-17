#!/usr/bin/env node
// Turn data/raw/<site>/ into the static PWA under docs/.
//   node scraper/build.mjs
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { cleanArticle } from './clean.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'docs');
const ASSETS = path.join(ROOT, 'scraper', 'app');

const siteConfigs = await loadSiteConfigs();
const books = [];

for (const site of siteConfigs) {
  const dir = path.join(RAW, site.id);
  if (!fssync.existsSync(dir)) continue;
  const metas = [];
  for (const f of await fs.readdir(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    metas.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
  }
  if (!metas.length) continue;
  const aliases = fssync.existsSync(path.join(dir, '_aliases.json'))
    ? JSON.parse(await fs.readFile(path.join(dir, '_aliases.json'), 'utf8')) : {};
  const pages = metas
    .map((m) => ({ ...m, slug: slugify(m.requestedPath || m.path), shortTitle: shortTitle(m.path, site) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'ko'));
  books.push({ site, pages, aliases, dir });
}

if (!books.length) {
  console.error('nothing in data/raw/ — run `npm run scrape` first');
  process.exit(1);
}

// Global path -> href resolver (cross-book links work too).
const index = new Map(); // "/w/..." -> { siteId, slug }
for (const b of books) {
  for (const p of b.pages) {
    index.set(p.path, { siteId: b.site.id, slug: p.slug });
    if (p.requestedPath && p.requestedPath !== p.path) index.set(p.requestedPath, { siteId: b.site.id, slug: p.slug });
  }
  for (const [from, to] of Object.entries(b.aliases)) {
    const t = index.get(to);
    if (t) index.set(from, t);
  }
}

const browser = await chromium.launch();
const cleaner = await browser.newPage();
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, '.nojekyll'), '');

const precache = new Set(['./', './index.html']);
const searchIndex = [];
const pageTpl = await fs.readFile(path.join(ASSETS, 'page.html'), 'utf8');
const homeTpl = await fs.readFile(path.join(ASSETS, 'index.html'), 'utf8');

for (const b of books) {
  const siteOut = path.join(OUT, b.site.id);
  await fs.mkdir(path.join(siteOut, 'img'), { recursive: true });
  const imgSrc = path.join(b.dir, 'img');
  if (fssync.existsSync(imgSrc)) {
    for (const f of await fs.readdir(imgSrc)) {
      await fs.copyFile(path.join(imgSrc, f), path.join(siteOut, 'img', f));
      precache.add(`./${b.site.id}/img/${encodeURIComponent(f)}`);
    }
  }

  // 1. Clean every page in a headless browser, resolve links.
  for (const p of b.pages) {
    let html = await fs.readFile(path.join(b.dir, `${p.slug}.html`), 'utf8');
    await cleaner.setContent(`<!doctype html><html><body><div id="__root">${html}</div></body></html>`);
    const cleaned = await cleaner.evaluate(cleanArticle, { rootSelector: '#__root' });
    html = cleaned.html;
    p.headings = cleaned.headings;
    html = html.replace(/href="wiki:\/\/([^"#]+)(#[^"]*)?"/g, (_, rawPath, hash = '') => {
      const wikiPath = unescapeHtml(rawPath);
      const t = index.get(wikiPath);
      if (t) {
        const rel = t.siteId === b.site.id ? `./${enc(t.slug)}.html` : `../${t.siteId}/${enc(t.slug)}.html`;
        return `href="${rel}${hash}"`;
      }
      const online = b.site.base.replace(/\/$/, '') + wikiPath.split('/').map(encodeURIComponent).join('/') + hash;
      return `href="${online}" data-online="1" title="오프라인 사본 없음 (온라인 전용)" target="_blank" rel="noopener"`;
    });
    p.html = html;
  }

  // 2. Extra generated pages (cheat sheets etc.), parsed from a cleaned source page.
  const extras = [];
  for (const name of b.site.extras || []) {
    const mod = await import(`./extras/${name}.mjs`);
    const src = b.pages.find((p) => p.slug === mod.sourceSlug);
    if (!src) { console.warn(`extra ${name}: source page ${mod.sourceSlug} not found`); continue; }
    await cleaner.setContent(`<!doctype html><html><body>${src.html}</body></html>`);
    const data = await cleaner.evaluate(mod.extract);
    const rendered = mod.render(data, { esc });
    extras.push({
      slug: mod.slug, shortTitle: mod.title, title: `${b.site.title} · ${mod.title}`, path: `/extra/${mod.slug}`,
      html: rendered.html, headings: rendered.headings, url: src.url, fetchedAt: src.fetchedAt, extra: true,
    });
    const n = data.sections?.reduce((k, s) => k + s.recipes.length + s.subs.reduce((j, x) => j + x.recipes.length, 0), 0);
    console.log(`  extra ${name}: ${n ?? '?'} entries`);
  }

  // 3. Navigation (extras pinned on top) and page output.
  const navHtml = [
    ...extras.map((e) => `<li class="extra"><a href="./${enc(e.slug)}.html">⚡ ${esc(e.shortTitle)}</a></li>`),
    ...b.pages.map((p) => `<li data-depth="${depth(p.path, b.site)}"><a href="./${enc(p.slug)}.html">${esc(p.shortTitle)}</a></li>`),
  ].join('\n');
  b.extras = extras;

  for (const p of [...extras, ...b.pages]) {
    const toc = p.headings.filter((h) => h.id).map((h) =>
      `<li data-level="${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('\n');
    const out = fill(pageTpl, {
      ROOT: '../',
      SITE_ID: b.site.id,
      BOOK_TITLE: esc(b.site.title),
      BOOK_EMOJI: b.site.emoji || '📖',
      TITLE: esc(p.title),
      SHORT_TITLE: esc(p.shortTitle),
      NAV: navHtml,
      TOC: toc,
      CONTENT: p.html,
      SOURCE_URL: esc(p.url),
      FETCHED_AT: esc(p.fetchedAt.slice(0, 10)),
    });
    await fs.writeFile(path.join(siteOut, `${p.slug}.html`), out);
    precache.add(`./${b.site.id}/${enc(p.slug)}.html`);
    searchIndex.push({
      site: b.site.id, book: b.site.title, slug: p.slug, title: p.title, short: p.shortTitle,
      headings: p.headings.filter((h) => h.id).map((h) => ({ id: h.id, text: h.text })),
    });
  }
  console.log(`${b.site.title}: ${b.pages.length} pages`);
}

// Home page.
const booksHtml = books.map((b) => `
  <section class="book">
    <h2>${b.site.emoji || '📖'} ${esc(b.site.title)} <small>${b.pages.length}개 문서</small></h2>
    <ul class="pagelist">
      ${(b.extras || []).map((e) => `<li class="extra"><a href="./${b.site.id}/${enc(e.slug)}.html">⚡ ${esc(e.shortTitle)}</a></li>`).join('\n')}
      ${b.pages.map((p) => `<li data-depth="${depth(p.path, b.site)}"><a href="./${b.site.id}/${enc(p.slug)}.html">${esc(p.shortTitle)}</a></li>`).join('\n')}
    </ul>
  </section>`).join('\n');
await fs.writeFile(path.join(OUT, 'index.html'), fill(homeTpl, { ROOT: './', BOOKS: booksHtml, BUILT_AT: new Date().toISOString().slice(0, 10) }));

// Static assets.
for (const f of ['app.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
  await fs.copyFile(path.join(ASSETS, f), path.join(OUT, f));
  precache.add(`./${f}`);
}
await fs.writeFile(path.join(OUT, 'search.json'), JSON.stringify(searchIndex));
precache.add('./search.json');

// Service worker with the precache list + a content-hash version baked in.
const list = [...precache].sort();
const version = crypto.createHash('sha1').update(list.join('\n') + (await hashDir(OUT))).digest('hex').slice(0, 10);
const sw = (await fs.readFile(path.join(ASSETS, 'sw.js'), 'utf8'))
  .replace('__VERSION__', version)
  .replace('__PRECACHE__', JSON.stringify(list));
await fs.writeFile(path.join(OUT, 'sw.js'), sw);
console.log(`built docs/ — ${list.length} files precached, version ${version}`);
await browser.close();

// ---------------------------------------------------------------------------

async function loadSiteConfigs() {
  const dir = path.join(ROOT, 'scraper', 'sites');
  const out = [];
  for (const f of await fs.readdir(dir)) if (f.endsWith('.json')) out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
  return out;
}
async function hashDir(dir) {
  const h = crypto.createHash('sha1');
  for (const f of (await fs.readdir(dir, { recursive: true })).sort()) {
    const p = path.join(dir, f);
    if ((await fs.stat(p)).isFile() && !f.endsWith('sw.js')) h.update(await fs.readFile(p));
  }
  return h.digest('hex');
}
function shortTitle(wikiPath, site) {
  const rootName = site.seeds[0].replace(/^\/w\//, '');
  const rest = wikiPath.replace(/^\/w\//, '');
  if (rest === rootName) return rootName;
  return rest.startsWith(rootName + '/') ? rest.slice(rootName.length + 1) : rest;
}
function depth(wikiPath, site) {
  return Math.max(0, shortTitle(wikiPath, site).split('/').length - 1);
}
function slugify(wikiPath) {
  return wikiPath.replace(/^\/w\//, '').replace(/\//g, '__').replace(/\s+/g, '_')
    .replace(/[^0-9A-Za-z가-힣_.\-·]/g, '-').slice(0, 180);
}
function enc(s) { return encodeURIComponent(s); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function unescapeHtml(s) { return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function fill(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : '')); }
