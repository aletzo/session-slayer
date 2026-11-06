import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { type App, HttpError } from './app';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

async function body(req: http.IncomingMessage): Promise<Record<string, string>> {
  let data = '';
  for await (const chunk of req) data += chunk;
  try {
    return data ? JSON.parse(data) : {};
  } catch {
    throw new HttpError(400, 'bad JSON');
  }
}

function send(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function createServer(app: App, staticDir?: string): http.Server & { broadcast: () => void } {
  const clients = new Set<http.ServerResponse>();
  let lastSent = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    // Block other web pages: DNS rebinding (wrong Host) and cross-site writes (wrong Origin).
    const port = (server.address() as { port?: number } | null)?.port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host ?? '')) return send(res, 403, { error: 'bad host' });
    // The Host check is the real guard. Browsers always send Origin on cross-site writes, so a missing Origin is a same-site or non-browser client.
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !allowed.some((h) => origin === `http://${h}`)) return send(res, 403, { error: 'bad origin' });
    const m = p.match(/^\/api\/sessions\/([^/]+)\/(focus|close|move|name|recap)$/);
    try {
      if (req.method === 'GET' && p === '/api/board') return send(res, 200, app.board());
      if (req.method === 'GET' && p === '/api/repos') return send(res, 200, app.repos());
      if (req.method === 'GET' && p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify(app.board())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && p === '/api/sessions') {
        const b = await body(req);
        await app.newSession(b.repo, b.name, b.tool === 'opencode' || b.tool === 'codex' ? b.tool : 'claude');
        return send(res, 200, {});
      }
      if (m && req.method === 'GET' && m[2] === 'recap') return send(res, 200, app.recap(m[1]));
      if (m && req.method === 'POST' && m[2] === 'focus') return send(res, 200, await app.focus(m[1]));
      if (m && req.method === 'POST' && m[2] === 'close') {
        await app.close(m[1]);
        return send(res, 200, {});
      }
      if (m && req.method === 'POST' && m[2] === 'move') {
        await app.moveToWezterm(m[1]);
        return send(res, 200, {});
      }
      if (m && req.method === 'PUT' && m[2] === 'name') {
        app.rename(m[1], (await body(req)).name ?? '');
        server.broadcast();
        return send(res, 200, {});
      }
      if (req.method === 'GET' && staticDir && !p.startsWith('/api/')) {
        const file = path.join(staticDir, path.normalize(p === '/' ? '/index.html' : p));
        if (file.startsWith(staticDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message });
    }
  }) as http.Server & { broadcast: () => void };

  // Keeps idle streams alive, so pages can tell a dead stream (server restart) from a quiet one.
  setInterval(() => {
    for (const c of clients) c.write('event: ping\ndata: \n\n');
  }, 10_000).unref();

  // Sends the board to all pages, only when it changed.
  server.broadcast = () => {
    const json = JSON.stringify(app.board());
    if (json === lastSent) return;
    lastSent = json;
    for (const c of clients) c.write(`data: ${json}\n\n`);
  };

  return server;
}
