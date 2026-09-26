import { spawnSync } from 'node:child_process';

const shared = ['--test', '--experimental-test-coverage'];
const runs = [
  [...shared, '--test-coverage-include=services/hosted/*.mjs', '--test-coverage-lines=80', '--test-coverage-branches=80', 'tests/hosted.test.mjs', 'tests/auth.test.mjs'],
  [...shared, '--test-coverage-include=packages/engine/*.mjs', '--test-coverage-lines=90', '--test-coverage-branches=90', 'tests/engine.test.mjs'],
  [...shared, '--test-skip-pattern=complete human', '--test-coverage-include=services/local/server.mjs', '--test-coverage-include=apps/web/model.js', '--test-coverage-lines=80', '--test-coverage-branches=80', 'tests/backend.test.mjs', 'tests/frontend.test.mjs']
];
for (const args of runs) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
