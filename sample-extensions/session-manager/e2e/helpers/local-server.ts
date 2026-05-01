/**
 * Local HTTP server for real-302 E2E tests (Scenario WR-1).
 *
 * Uses Node.js built-in `http` module only (no new packages).
 *
 * Redirect chain produced:
 *   GET /wr1-a  → 302 /wr1-b?cjevent=wr1   (CJ params rule matches this URL)
 *   GET /wr1-b  → 302 /wr1-c
 *   GET /wr1-c  → 200 <html></html>
 *
 * The ?cjevent=wr1 param on the intermediate hop (/wr1-b) satisfies the
 * embedded CJ policy's `params: "cjevent"` rule, so the SDK detects an
 * affiliate pattern on the intermediate URL.
 */

import * as http from 'node:http';

export function startLocalServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const pathname = req.url?.split('?')[0];

      if (pathname === '/wr1-a') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/wr1-b?cjevent=wr1` });
        res.end();
      } else if (pathname === '/wr1-b') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/wr1-c` });
        res.end();
      } else if (pathname === '/wr1-c') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html></html>');
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function stopLocalServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
