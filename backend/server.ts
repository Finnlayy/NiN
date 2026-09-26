import { createServer } from 'http';
import { parse } from 'url';
import { join } from 'path';
import { createServer as createViteServer } from 'vite';
import { handleRequest } from './handleRequest';

async function startServer() {
  const dev = process.env.NODE_ENV !== 'production';
  const hostname = '0.0.0.0';
  const port = 3000;
  const root = process.cwd();

  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  if (dev) {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const handled = await handleRequest(req, res);
      if (handled) {
        return;
      }

      const parsedUrl = parse(req.url ?? '/', true);
      const method = req.method ?? 'GET';
      const url = parsedUrl.pathname ?? '/';

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      if (dev && vite) {
        vite.middlewares(req, res, (err: unknown) => {
          if (err) {
            res.statusCode = 500;
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      } else {
        const distPath = join(root, 'dist');
        const fs = await import('fs');
        let filePath = join(distPath, url === '/' ? 'index.html' : url);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          filePath = join(distPath, 'index.html');
        }
        const mime = await import('mime-types');
        res.writeHead(200, { 'Content-Type': mime.lookup(filePath) || 'text/html' });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal server error');
      }
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log('Endpoints: GET /api/health, POST /api/task, Vite Frontend');
  });
}

startServer();
