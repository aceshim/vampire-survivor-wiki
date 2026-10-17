// End-to-end: serve docs/, install the service worker, go offline, verify pages still open.
//   node test/pwa-check.mjs [port]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8090);
const server = spawn(process.execPath, [path.join(ROOT, 'scraper', 'serve.mjs'), path.join(ROOT, 'docs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base)) errors.push(`${r.status()} ${r.url()}`); });
let ok = true;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) ok = false; };

try {
  await page.goto(base + 'index.html');
  await page.waitForFunction(() => document.getElementById('offlinePill')?.textContent === '오프라인 OK', null, { timeout: 30_000 });
  check(true, 'service worker precached everything (pill = 오프라인 OK)');
  const manifest = await page.evaluate(async () => (await fetch('./manifest.webmanifest')).ok);
  check(manifest, 'manifest reachable');
  await page.screenshot({ path: path.join(ROOT, 'test', 'shot-home.png') });

  await context.setOffline(true);
  const links = await page.$$eval('.pagelist a', (as) => as.map((a) => a.href));
  check(links.length > 0, `home lists ${links.length} pages`);
  for (const href of links) {
    const res = await page.goto(href);
    const hasContent = await page.$('.wiki-content .wiki-heading');
    check(res && res.ok() && !!hasContent, `offline open: ${decodeURIComponent(href.split('/').pop())}`);
  }
  // Deep link + image + folding.
  const target = links.find((l) => l.includes('%EC%95%84%EB%A5%B4%EC%B9%B4%EB%82%98'));
  if (target) {
    await page.goto(target + '#s-3.7');
    const imgs = await page.$$eval('.wiki-content img', (els) => els.map((i) => i.naturalWidth));
    check(imgs.length > 0 && imgs.every((w) => w > 0), `images render offline (${imgs.length})`);
    const folds = await page.$$eval('.wiki-content details', (ds) => ({ n: ds.length, open: ds.filter((d) => d.open).length }));
    check(folds.n === folds.open, `folded blocks open (${folds.open}/${folds.n})`);
    const near = await page.evaluate(() => { const r = document.getElementById('s-3.7').getBoundingClientRect(); return location.hash === '#s-3.7' && r.top >= 0 && r.top < innerHeight; });
    check(near, 'deep link #s-3.7 scrolled into view');
    await page.screenshot({ path: path.join(ROOT, 'test', 'shot-page.png'), fullPage: true });
  }
  // Search works offline.
  const idx = await page.evaluate(async () => (await (await fetch('../search.json')).json()));
  const entry = idx.find((e) => e.headings.length) || idx[0];
  const term = entry.headings.length ? entry.headings[Math.floor(entry.headings.length / 2)].text.replace(/^[\d.]+\s*/, '') : entry.short;
  check(idx.every((e) => e.headings.length > 0), `every page has a section index (${idx.reduce((n, e) => n + e.headings.length, 0)} sections)`);
  await page.click('#menuBtn');
  await page.fill('#searchBox', term.slice(0, 6));
  await page.waitForSelector('#results li');
  const hits = await page.$$eval('#results li a', (as) => as.map((a) => a.textContent));
  check(hits.some((h) => h.includes(term.slice(0, 6))), `search hit offline for "${term.slice(0, 6)}": ${hits[0]}`);
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
process.exit(ok ? 0 : 1);
