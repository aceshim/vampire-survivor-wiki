#!/usr/bin/env node
// Rebuild data/raw/<site>/ from a previously built docs/ (no re-scrape needed).
//   node scraper/rehydrate.mjs [siteId]
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];
for (const siteId of await fs.readdir(path.join(ROOT, 'docs'))) {
  const dir = path.join(ROOT, 'docs', siteId);
  if (!(await fs.stat(dir)).isDirectory() || (only && only !== siteId)) continue;
  const out = path.join(ROOT, 'data', 'raw', siteId);
  await fs.mkdir(path.join(out, 'img'), { recursive: true });
  let n = 0;
  for (const f of await fs.readdir(dir)) {
    if (!f.endsWith('.html')) continue;
    const page = await fs.readFile(path.join(dir, f), 'utf8');
    const m = page.match(/<div class="wiki-content">\n([\s\S]*?)\n  <\/div>\n  <footer class="source">출처: <a href="([^"]+)"[^>]*>[^<]*<\/a> · 저장일 ([0-9-]+)/);
    const title = unesc((page.match(/<h1 class="title">([^<]*)<\/h1>/) || [])[1] || f.replace(/\.html$/, ''));
    if (!m) { console.warn('skip (no content block):', f); continue; }
    const slug = f.replace(/\.html$/, '');
    const wikiPath = '/w/' + title;
    const links = [...m[1].matchAll(/href="\.\/([^"#]+)\.html/g)].map((x) => '/w/' + decodeURIComponent(x[1]).replace(/__/g, '/').replace(/_/g, ' '));
    await fs.writeFile(path.join(out, `${slug}.html`), m[1]);
    await fs.writeFile(path.join(out, `${slug}.json`), JSON.stringify({
      site: siteId, path: wikiPath, requestedPath: wikiPath, title, url: unesc(m[2]), fetchedAt: m[3] + 'T00:00:00.000Z',
      headings: [], links: [...new Set(links)], rehydrated: true,
    }, null, 2));
    n++;
  }
  if (fssync.existsSync(path.join(dir, 'img'))) {
    for (const f of await fs.readdir(path.join(dir, 'img'))) await fs.copyFile(path.join(dir, 'img', f), path.join(out, 'img', f));
  }
  if (!fssync.existsSync(path.join(out, '_aliases.json'))) await fs.writeFile(path.join(out, '_aliases.json'), '{}');
  console.log(`${siteId}: ${n} pages -> data/raw/${siteId}/`);
}
function unesc(s) { return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
