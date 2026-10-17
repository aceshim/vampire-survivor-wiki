#!/usr/bin/env node
// Crawl a namu.wiki subtree with a real Chromium (Playwright) and save cleaned
// article fragments + images under data/raw/<site>/.
//
//   node scraper/scrape.mjs --site vs            # one site (id from scraper/sites/*.json)
//   node scraper/scrape.mjs --site all           # every enabled site
//   node scraper/scrape.mjs --site vs --headed   # show the browser (solve a Cloudflare check once)
//   node scraper/scrape.mjs --site vs --fresh    # re-fetch pages already on disk
//   node scraper/scrape.mjs --site vs --base http://127.0.0.1:8099   # test fixture
//
// Output per page:  data/raw/<site>/<slug>.html  (cleaned fragment, links as wiki://<path>)
//                   data/raw/<site>/<slug>.json  (title, path, headings, outgoing links)
//                   data/raw/<site>/img/<hash>.<ext>

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));

if (!args.site) {
  console.error('usage: node scraper/scrape.mjs --site <id|all> [--headed] [--fresh] [--max N] [--base URL]');
  process.exit(1);
}

const sites = await loadSites(args.site);
if (sites.length === 0) { console.error('no matching site config'); process.exit(1); }

const context = await chromium.launchPersistentContext(path.join(ROOT, '.pw-profile'), {
  headless: !args.headed,
  viewport: { width: 1280, height: 900 },
  locale: 'ko-KR',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
});

try {
  for (const site of sites) await crawlSite(site);
} finally {
  await context.close();
}

// ---------------------------------------------------------------------------

async function crawlSite(site) {
  const base = (args.base || site.base).replace(/\/$/, '');
  const outDir = path.join(ROOT, 'data', 'raw', site.id);
  const imgDir = path.join(outDir, 'img');
  await fs.mkdir(imgDir, { recursive: true });

  const include = (site.include || []).map((r) => new RegExp(r));
  const exclude = (site.exclude || []).map((r) => new RegExp(r));
  const inScope = (p) => include.some((r) => r.test(p)) && !exclude.some((r) => r.test(p));
  const maxPages = Number(args.max || site.maxPages || 200);
  const delayMs = Number(site.delayMs ?? 1500);

  const queue = [...site.seeds.map(normalizePath)];
  const seen = new Set(queue);
  const aliases = {}; // redirected path -> canonical path
  const page = await context.newPage();
  let fetched = 0;

  console.log(`\n== ${site.title} (${site.id}) base=${base} max=${maxPages}`);

  while (queue.length && fetched < maxPages) {
    const wikiPath = queue.shift();
    const slug = slugify(wikiPath);
    const htmlFile = path.join(outDir, `${slug}.html`);
    const metaFile = path.join(outDir, `${slug}.json`);

    if (!args.fresh && fssync.existsSync(metaFile)) {
      // Reuse cached page but still follow its links so the crawl completes.
      const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
      enqueue(meta.links);
      console.log(`  cached  ${wikiPath}`);
      continue;
    }

    const url = base + encodeWikiPath(wikiPath);
    process.stdout.write(`  fetch   ${wikiPath} ... `);
    let result;
    try {
      result = await fetchArticle(page, url, site);
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      await fs.writeFile(path.join(outDir, `${slug}.error.txt`), String(e.stack || e));
      continue;
    }

    const finalPath = result.finalPath && inScope(result.finalPath) ? result.finalPath : wikiPath;
    if (finalPath !== wikiPath) {
      // Redirect: record the alias and crawl the canonical page instead of storing a duplicate.
      aliases[wikiPath] = finalPath;
      console.log(`redirect -> ${finalPath}`);
      enqueue([finalPath]);
      await fs.rm(metaFile, { force: true });
      await fs.rm(htmlFile, { force: true });
      continue;
    }

    // Download images, rewrite to local relative paths.
    const imgMap = {};
    for (const src of result.images) {
      try {
        const local = await downloadImage(src, imgDir, base);
        if (local) imgMap[src] = `img/${local}`;
      } catch (e) {
        console.log(`\n    img failed ${src}: ${e.message}`);
      }
    }
    let html = result.html;
    for (const [src, local] of Object.entries(imgMap)) {
      html = html.split(`src="${escapeAttr(src)}"`).join(`src="${local}"`);
    }

    const meta = {
      site: site.id,
      path: finalPath,
      requestedPath: wikiPath,
      title: result.title,
      url,
      fetchedAt: new Date().toISOString(),
      headings: result.headings,
      links: result.links.filter(inScope),
    };
    await fs.writeFile(htmlFile, html);
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));
    await fs.rm(path.join(outDir, `${slug}.error.txt`), { force: true });
    fetched++;
    console.log(`ok (${result.headings.length} sections, ${Object.keys(imgMap).length} images)`);
    enqueue(meta.links);
    await page.waitForTimeout(delayMs);
  }

  await fs.writeFile(path.join(outDir, '_aliases.json'), JSON.stringify(aliases, null, 2));
  console.log(`== done: ${fetched} fetched, ${seen.size} known, ${queue.length} left in queue`);

  function enqueue(links) {
    for (const l of links || []) {
      const p = normalizePath(l);
      if (!inScope(p) || seen.has(p)) continue;
      seen.add(p);
      queue.push(p);
    }
  }
}

async function fetchArticle(page, url, site) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (response && response.status() === 404) throw new Error('HTTP 404 (문서 없음)');

  // Cloudflare / bot challenge handling.
  for (let i = 0; i < 60; i++) {
    const title = await page.title();
    const challenged = /just a moment|잠시만|attention required|cloudflare/i.test(title);
    if (!challenged) break;
    if (!args.headed) throw new Error('bot challenge page; rerun with --headed and solve it once (profile is persisted)');
    if (i === 0) console.log('\n    >>> challenge shown: solve it in the browser window, waiting up to 2 min...');
    await page.waitForTimeout(2000);
  }

  if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  if (/해당 문서를 찾을 수 없습니다|문서가 존재하지 않습니다/.test(bodyText) && !(await page.$('.wiki-heading'))) {
    throw new Error('문서 없음');
  }
  await page.waitForSelector('.wiki-heading, .wiki-paragraph, article, main', { timeout: 15_000 });
  // Let lazy content settle.
  await page.waitForTimeout(500);
  await autoScroll(page);

  const data = await page.evaluate(extractInBrowser);
  if (!data.html || data.html.length < 200) throw new Error('empty article extracted');

  if (args.debug) {
    const dbg = path.join(ROOT, 'data', 'raw', site.id, 'debug');
    await fs.mkdir(dbg, { recursive: true });
    await fs.writeFile(path.join(dbg, slugify(data.finalPath || 'page') + '.full.html'), await page.content());
  }
  return data;
}

// Runs inside the browser. Must be self-contained.
function extractInBrowser() {
  const decodePath = (href) => {
    try {
      const u = new URL(href, location.href);
      if (u.origin !== location.origin) return null;
      return decodeURIComponent(u.pathname).replace(/\/+$/, '');
    } catch { return null; }
  };

  const headings = Array.from(document.querySelectorAll('.wiki-heading'));
  let root = document.querySelector('.wiki-content');
  if (!root && headings.length) {
    root = headings[0];
    while (root && !headings.every((h) => root.contains(h))) root = root.parentElement;
  }
  if (!root) root = document.querySelector('article') || document.querySelector('main') || document.body;
  root = root.cloneNode(true);

  // Strip chrome, scripts, ads, edit links.
  root.querySelectorAll('script, style, iframe, noscript, link, button, ins, svg, [aria-hidden="true"] > svg')
    .forEach((n) => n.remove());
  root.querySelectorAll('a[href^="/edit/"], a[href^="/history/"], a[href^="/discuss/"], a[href^="/raw/"], a[href^="/backlink/"], .wiki-edit-section')
    .forEach((n) => n.remove());
  // Headings: unwrap the "[편집]" tokens that sometimes remain as text.
  root.querySelectorAll('.wiki-heading').forEach((h) => {
    h.querySelectorAll('span, a').forEach((s) => {
      if (/^\s*\[편집\]\s*$/.test(s.textContent)) s.remove();
    });
  });

  // Folded blocks -> <details>, visible by default via CSS.
  root.querySelectorAll('dl.wiki-folding').forEach((dl) => {
    const dt = dl.querySelector('dt');
    const dd = dl.querySelector('dd');
    const d = document.createElement('details');
    d.className = 'wiki-folding';
    const s = document.createElement('summary');
    s.innerHTML = dt ? dt.innerHTML : '펼치기';
    d.appendChild(s);
    const body = document.createElement('div');
    body.className = 'wiki-folding-text';
    body.innerHTML = dd ? dd.innerHTML : '';
    d.appendChild(body);
    dl.replaceWith(d);
  });

  // Remove display:none that JS would normally toggle (folded sections).
  root.querySelectorAll('[style]').forEach((el) => {
    const st = el.getAttribute('style') || '';
    if (/display\s*:\s*none/i.test(st)) {
      const cleaned = st.replace(/display\s*:\s*none\s*;?/gi, '').trim();
      if (cleaned) el.setAttribute('style', cleaned); else el.removeAttribute('style');
    }
  });

  // Images: resolve lazy sources to absolute URLs, drop srcset.
  const images = new Set();
  root.querySelectorAll('img, source, video').forEach((img) => {
    const raw = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src');
    img.removeAttribute('srcset');
    img.removeAttribute('data-srcset');
    img.removeAttribute('loading');
    if (!raw || raw.startsWith('data:')) return;
    let abs;
    try { abs = new URL(raw, location.href).href; } catch { return; }
    img.setAttribute('src', abs);
    img.removeAttribute('data-src');
    img.removeAttribute('data-lazy-src');
    images.add(abs);
  });

  // Links: internal wiki links -> wiki://<path>#hash placeholders; others kept.
  const links = new Set();
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) return;
    const p = decodePath(href);
    if (p && p.startsWith('/w/')) {
      let hash = '';
      try { hash = new URL(href, location.href).hash; } catch {}
      a.setAttribute('href', 'wiki://' + p + hash);
      links.add(p);
      return;
    }
    try {
      const abs = new URL(href, location.href).href;
      a.setAttribute('href', abs);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    } catch {}
  });

  // Section index for search / TOC.
  const sections = Array.from(root.querySelectorAll('.wiki-heading')).map((h) => {
    const idEl = h.querySelector('[id]') || h;
    const level = Number((h.tagName.match(/\d/) || [2])[0]);
    const text = h.textContent.replace(/\s+/g, ' ').trim();
    return { id: idEl.id || '', level, text };
  });

  const title = (document.querySelector('h1')?.textContent || document.title)
    .replace(/\s*-\s*나무위키\s*$/, '').replace(/\s+/g, ' ').trim();

  return {
    title,
    finalPath: decodePath(location.href),
    html: root.innerHTML,
    images: Array.from(images),
    links: Array.from(links),
    headings: sections,
  };
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = 1200;
    for (let y = 0; y < document.body.scrollHeight && y < 60000; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
}

async function downloadImage(src, imgDir, base) {
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 16);
  const existing = fssync.readdirSync(imgDir).find((f) => f.startsWith(hash + '.'));
  if (existing) return existing;
  const res = await context.request.get(src, { headers: { referer: base + '/' }, timeout: 30_000 });
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  const ct = res.headers()['content-type'] || '';
  const ext = ct.includes('webp') ? 'webp' : ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif'
    : ct.includes('svg') ? 'svg' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg'
    : ct.includes('mp4') ? 'mp4' : (path.extname(new URL(src).pathname).slice(1) || 'bin');
  const name = `${hash}.${ext}`;
  await fs.writeFile(path.join(imgDir, name), await res.body());
  return name;
}

// --- helpers ---------------------------------------------------------------

async function loadSites(which) {
  const dir = path.join(ROOT, 'scraper', 'sites');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  const all = [];
  for (const f of files) all.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
  if (which === 'all') return all.filter((s) => s.enabled !== false);
  return all.filter((s) => s.id === which || path.basename(which, '.json') === s.id);
}

function normalizePath(p) {
  let s = p.trim();
  if (/^https?:/.test(s)) { try { s = decodeURIComponent(new URL(s).pathname); } catch {} }
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!s.startsWith('/w/')) s = '/w/' + s.replace(/^\/+/, '');
  return s;
}

export function slugify(wikiPath) {
  return wikiPath.replace(/^\/w\//, '')
    .replace(/\//g, '__')
    .replace(/\s+/g, '_')
    .replace(/[^0-9A-Za-z가-힣_.\-·]/g, '-')
    .slice(0, 180);
}

function encodeWikiPath(p) {
  return p.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
