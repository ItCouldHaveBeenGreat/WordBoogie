import { resolve } from 'node:path';
import { createApp } from '../services/local/server.mjs';
import { createWebServer, listen } from './web-server.mjs';

if (process.env.APP_MODE && process.env.APP_MODE !== 'local') throw new Error('npm run dev only supports APP_MODE=local.');
const port = (name, fallback) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port from 1–65535.`);
  return value;
};
const webPort = port('FRONTEND_PORT', 5173);
const apiPort = port('API_PORT', 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN || `http://localhost:${webPort}`;
const databasePath = resolve(process.env.DATABASE_PATH || '.local/wordboogie.sqlite');
const app = createApp({ databasePath, frontendOrigin, seed: process.env.DEV_SEED, onBotError: ({ gameId, code }) => console.error(`Bot retry pending (${code}) for game ${gameId}`) });
const web = createWebServer({ apiUrl: `http://localhost:${apiPort}`, frontendOrigin });
let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  await Promise.all([new Promise(r => web.listening ? web.close(r) : r()), app.close()]);
  process.exitCode = code;
}
try {
  await listen(app.server, apiPort);
  await listen(web, webPort);
  console.log(`\nWordBoogie is ready\n  Play: ${frontendOrigin}\n  API:  http://localhost:${apiPort}\n  Data: ${databasePath}\n\nUse a separate browser/profile for another human. Ctrl+C stops the local server.\n`);
} catch (error) {
  console.error(`Cannot start WordBoogie: ${error.code === 'EADDRINUSE' ? 'a port is already in use; change FRONTEND_PORT/API_PORT.' : error.message}`);
  await shutdown(1);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
