#!/usr/bin/env node
/**
 * Zero-dependency static server for the experience.
 *
 *   node server.mjs
 *   node server.mjs 8080
 *
 * Camera capture and MediaPipe's WASM need a secure origin. localhost is
 * treated as a secure context by every modern browser, so HTTP on loopback
 * is enough — opening index.html through file:// is not.
 */

import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8123);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function safePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const target = resolve(ROOT, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const target = safePath(url.pathname);
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });

    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      // The model and wasm are versioned by filename; source files change
      // while iterating, so keep those fresh.
      'Cache-Control': extname(target) === '.wasm' || extname(target) === '.task'
        ? 'public, max-age=86400'
        : 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(status === 404 ? 'Not found' : 'Internal server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  指尖生花 · Blossom in Hand');
  console.log(`  → http://${HOST}:${PORT}/`);
  console.log('  Ctrl+C to stop');
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try: node server.mjs ${PORT + 1}\n`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
