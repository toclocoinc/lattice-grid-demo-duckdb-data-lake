/**
 * A static file server for looking at the demo locally, plus the `/lake/` route.
 *
 * `/lake/<path>` stands in for the Overture bucket when the page is opened with
 * `?data=local`. It has three modes:
 *
 *   live     forwards each request, Range header included, to the public bucket.
 *            Used for development against the real data.
 *   record   live, and every response is also written to test/recorded/, keyed by
 *            path and Range. This is how the CI fixture is made.
 *   replay   answers only from test/recorded/, with no network at all. A request
 *            that was not recorded is a 404 and is listed in `/__lake`, so a
 *            change that reads different bytes shows up as a failed check.
 *
 * `/__lake` serves the tally of what the page asked of `/lake/`, as JSON.
 *
 *   node tools/serve.mjs [port] [--lake=live|record|replay]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const RECORDED = join(root, 'test', 'recorded');
const HOST = 'https://overturemaps-us-west-2.s3.amazonaws.com';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = join(root, relative);
  return full.startsWith(root) ? full : null;
}

const keyOf = (method, path, range) => `${method} ${path} ${range || '-'}`;
const fileOf = (key) => `${createHash('sha1').update(key).digest('hex').slice(0, 16)}.bin`;

export async function startServer(port = 0, { lake = 'replay' } = {}) {
  /** What the page asked of /lake/: one entry per request. */
  let log = [];
  let index = {};
  if (lake === 'replay' || lake === 'record') {
    try { index = JSON.parse(await readFile(join(RECORDED, 'index.json'), 'utf8')); } catch { index = {}; }
  }
  if (lake === 'record') index = {};

  async function serveLake(request, response, path) {
    const range = request.headers.range || null;
    const key = keyOf(request.method, path, range);
    const note = (status, bytes, hit) => log.push({ method: request.method, path, range, status, bytes, hit });

    if (lake === 'replay') {
      const hit = index[key];
      if (!hit) {
        note(404, 0, false);
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not recorded');
        return;
      }
      const body = hit.file ? await readFile(join(RECORDED, hit.file)) : Buffer.alloc(0);
      response.writeHead(hit.status, hit.headers).end(request.method === 'HEAD' ? undefined : body);
      note(hit.status, body.length, true);
      return;
    }

    const headers = {};
    if (range) headers.range = range;
    const upstream = await fetch(`${HOST}${path}`, { method: request.method, headers });
    const body = Buffer.from(await upstream.arrayBuffer());
    const keep = {};
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) keep[name] = value;
    }
    if (request.method !== 'HEAD') keep['content-length'] = String(body.length);
    response.writeHead(upstream.status, keep).end(request.method === 'HEAD' ? undefined : body);
    note(upstream.status, body.length, false);
    if (lake === 'record' && upstream.status < 400) {
      await mkdir(RECORDED, { recursive: true });
      const file = body.length && request.method !== 'HEAD' ? fileOf(key) : null;
      if (file) await writeFile(join(RECORDED, file), body);
      index[key] = { status: upstream.status, headers: keep, file };
      await writeFile(join(RECORDED, 'index.json'), JSON.stringify(index, null, 1));
    }
  }

  const server = createServer(async (request, response) => {
    const url = request.url || '/';
    try {
      if (url.startsWith('/__lake')) {
        if (request.method === 'POST') log = [];
        response.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
          .end(JSON.stringify(request.method === 'POST' ? { reset: true } : { mode: lake, requests: log }));
        return;
      }
      if (url.startsWith('/lake/')) {
        await serveLake(request, response, url.slice('/lake'.length).split('?')[0]);
        return;
      }
      if (url === '/favicon.ico') { response.writeHead(204).end(); return; }

      let file = resolvePath(url);
      if (!file) { response.writeHead(403).end('Forbidden'); return; }
      let info = await stat(file);
      if (info.isDirectory()) { file = join(file, 'index.html'); info = await stat(file); }
      response.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
      });
      if (request.method === 'HEAD') response.end(); else createReadStream(file).pipe(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error?.code === 'ENOENT' ? 404 : 502, { 'content-type': 'text/plain' });
      response.end(error?.code === 'ENOENT' ? 'Not found' : String(error?.message ?? error));
    }
  });

  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => done({
      server,
      port: server.address().port,
      lakeLog: () => log,
      reset: () => { log = []; },
      hasRecording: () => Object.keys(index).length > 0,
    }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const mode = (args.find((a) => a.startsWith('--lake=')) || '--lake=live').split('=')[1];
  const wanted = Number(args.find((a) => /^\d+$/.test(a)) || 0);
  const { port } = await startServer(wanted, { lake: mode });
  process.stdout.write(`Serving the demo at http://localhost:${port}/\n`);
  process.stdout.write(`The real bucket:  http://localhost:${port}/\n`);
  process.stdout.write(`Through /lake/ (${mode}): http://localhost:${port}/?data=local\n`);
  process.stdout.write('Press Control-C to stop.\n');
}
