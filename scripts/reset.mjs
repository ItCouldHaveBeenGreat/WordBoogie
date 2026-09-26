import { existsSync, realpathSync, rmSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateResetPath(databasePath, root = resolve('.local')) {
  const target = resolve(databasePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Reset only accepts a database file inside .local/.');
  // Resolve existing parents so symlinks cannot redirect deletion outside the development directory.
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const parent = existsSync(dirname(target)) ? realpathSync(dirname(target)) : dirname(target);
  const realRel = relative(realRoot, parent);
  if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('Database parent points outside .local/.');
  if (existsSync(target) && realpathSync(target) !== resolve(parent, target.slice(dirname(target).length + 1))) throw new Error('Refusing to reset a linked database file.');
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.APP_MODE && process.env.APP_MODE !== 'local') throw new Error('Reset is only available in local mode.');
  if (!process.argv.includes('--confirm')) throw new Error('Stop the server, then run npm run local:reset -- --confirm to delete local games.');
  const target = validateResetPath(process.env.DATABASE_PATH || '.local/wordboogie.sqlite');
  for (const suffix of ['', '-wal', '-shm']) rmSync(target + suffix, { force: true });
  console.log('Local game database reset. Browser credentials for deleted games can be cleared in the app.');
}
