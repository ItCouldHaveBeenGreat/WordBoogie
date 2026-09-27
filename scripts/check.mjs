import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() && entry.name === 'node_modules' ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}
for (const file of ['apps', 'packages', 'services', 'scripts', 'tests'].flatMap(walk).filter(x => /\.(mjs|js)$/.test(x))) run(['--check', file]);
run(['--test', 'tests/engine.test.mjs', 'tests/frontend.test.mjs', 'tests/local.test.mjs']);
run(['scripts/coverage.mjs']);
run(['--test', 'tests/backend.test.mjs']);
run(['--test', 'tests/hosted.test.mjs', 'tests/auth.test.mjs']);
run(['infra/generate.mjs']);
run(['infra/bootstrap.mjs']);
console.log('\nLocal and hosted application checks passed. AWS deployment is a separate manual step.');
