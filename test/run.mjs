// npm test: fixture server -> scrape -> build -> offline PWA check. Leaves data/ and docs/ as the fixture build.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = spawn(process.execPath, [path.join(ROOT, 'test/fixture/server.mjs'), '8099'], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status === 0;
let ok = run(['scraper/scrape.mjs', '--site', 'vs', '--base', 'http://127.0.0.1:8099', '--fresh', '--max', '20'])
  && run(['scraper/build.mjs']) && run(['test/pwa-check.mjs', '8090']);
fixture.kill();
process.exit(ok ? 0 : 1);
