import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWebServer, listen } from '../scripts/web-server.mjs';
import { validateResetPath } from '../scripts/reset.mjs';

test('reset rejects outside paths and the directory itself', () => {
  const root = resolve('.local');
  assert.equal(validateResetPath(join(root, 'test.sqlite'), root), join(root, 'test.sqlite'));
  assert.throws(() => validateResetPath(resolve('production.sqlite'), root), /inside/);
  assert.throws(() => validateResetPath(root, root), /inside/);
});

test('local web server serves config/assets, rejects unknown paths and write methods', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wordboogie-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<h1>WordBoogie</h1>');
  await writeFile(join(root, 'assets', 'app.js'), 'export const ready = true;');
  const server = createWebServer({ root, apiUrl: 'http://localhost:3010' });
  const address = await listen(server, 0);
  t.after(async () => { await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /WordBoogie/);
  assert.match(home.headers.get('content-security-policy'), /http:\/\/localhost:3010/);
  const config = await fetch(base + '/config.js');
  assert.match(await config.text(), /WORDBOOGIE_CONFIG.*3010/);
  assert.equal((await fetch(base + '/assets/app.js')).status, 200);
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/%5C..%5Csecret')).status, 403);
  assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
});
