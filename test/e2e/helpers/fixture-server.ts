// Tiny static HTTP server used by E2E tests as a stand-in for "the internet".
//
// Serves:
//   GET /                    → fixtures/index.html
//   GET /download/<name>     → small text file with Content-Disposition: attachment
//
// Bind to 127.0.0.1 on port 0 so the kernel picks a free port; callers read the
// real port from baseUrl() after start() resolves.

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const indexHtml = await readFile(join(FIXTURES_DIR, 'index.html'));

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': indexHtml.length,
      });
      res.end(indexHtml);
      return;
    }
    if (url.startsWith('/download/')) {
      const name = url.slice('/download/'.length).replace(/[^A-Za-z0-9._-]/g, '_') || 'file.bin';
      const body = Buffer.from(`brix-e2e fixture download body for ${name}\n`, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // Don't let an open listening socket keep the test process alive past
  // the after() hooks. Without unref(), Node waits for the server to be
  // closed (which can hang if a client never properly FINs its connection,
  // e.g. an orphan Chrome we couldn't reach to kill).
  server.unref();

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    close(): Promise<void> {
      // Forcibly drop any keep-alive connections (Chrome from the test may
      // still be holding one open), otherwise server.close() waits forever
      // for them to drain.
      try { server.closeAllConnections(); } catch { /* node < 18.2 */ }
      return new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), 3000).unref();
        server.close(() => { clearTimeout(t); resolve(); });
      });
    },
  };
}
