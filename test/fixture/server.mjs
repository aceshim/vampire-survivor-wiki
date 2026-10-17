// Fake namu.wiki: GET /w/<path> serves test/fixture/pages/<path with / -> __>.html
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8099);
const redirects = { '/w/Vampire Survivors/캐릭': '/w/Vampire%20Survivors/%EC%BA%90%EB%A6%AD%ED%84%B0' };
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (redirects[p]) { res.writeHead(302, { location: redirects[p] }); return res.end(); }
  if (p.startsWith('/img/')) {
    const f = path.join(dir, p);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': p.endsWith('.webp') ? 'image/webp' : 'image/png' });
    return fs.createReadStream(f).pipe(res);
  }
  if (p.startsWith('/w/')) {
    const f = path.join(dir, 'pages', p.slice(3).replace(/\//g, '__') + '.html');
    if (!fs.existsSync(f)) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html><title>없는 문서 - 나무위키</title><body>없음</body></html>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(f).pipe(res);
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log(`fixture on http://127.0.0.1:${port}`));
