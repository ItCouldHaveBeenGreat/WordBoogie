import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

export function createWebServer({ root = defaultRoot, apiUrl = 'http://localhost:3001', frontendOrigin = 'http://localhost:5173' } = {}) {
  root = resolve(root);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${new URL(apiUrl).origin}; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('Method not allowed'); return;
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/config.js') {
        res.setHeader('Content-Type', mime['.js']);
        res.end(req.method === 'HEAD' ? '' : `window.WORDBOOGIE_CONFIG=${JSON.stringify({ apiUrl, frontendOrigin })};`);
        return;
      }
      const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!target.startsWith(root + sep) || pathname.includes('\\') || pathname.includes('\0')) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const body = await readFile(target);
      res.setHeader('Content-Type', mime[extname(target)] || 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 400);
      res.end('File not found');
    }
  });
}

export function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolveListen(server.address()); });
  });
}
