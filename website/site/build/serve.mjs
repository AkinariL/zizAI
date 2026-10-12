import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
const args = process.argv.slice(2),
  options = { root: 'site/dist-debug', port: 8791, host: '127.0.0.1' };
for (let index = 0; index < args.length; index += 2) {
  const key = args[index].slice(2);
  if (!(key in options)) throw Error('Unknown server option');
  options[key] = args[index + 1];
}
const root = resolve(options.root),
  mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
  };
const server = createServer(async (request, response) => {
  try {
    let path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(join(root, '.' + path));
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    const headers = {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (path === '/index.html' || path.startsWith('/shared/') || path === '/probe.worker.js')
      Object.assign(headers, {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.listen(Number(options.port), options.host, () =>
  console.log(JSON.stringify({ url: 'http://' + options.host + ':' + options.port + '/', root })),
);
