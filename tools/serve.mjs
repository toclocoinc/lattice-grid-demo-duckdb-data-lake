/**
 * A static file server for looking at the demo locally, plus the `/lake/` route.
 *
 * `/lake/<path>` stands in for the CDN (data.latticegrid.dev) when the page is
 * opened with `?data=local`. It has three modes:
 *
 *   local    answers from a directory made by tools/build-partitioned.mjs, with
 *            Range support, like the CDN. Used for development and for verify.
 *   record   local, and every response is also written to test/recorded/, keyed
 *            by path and Range, with the directory's manifest. This is how the
 *            CI fixture is made.
 *            With `--from=<base url>` (the CDN) there is no local directory: the
 *            reads are fetched from there, Range and all, and recorded, with
 *            the page's own src/manifest.js. How the full copy is recorded.
 *   replay   answers only from test/recorded/, with no data at all. A request
 *            that was not recorded is a 404 and is listed in `/__lake`, so a
 *            change that reads different bytes shows up as a failed check.
 *
 * In all three the page's `src/manifest.js` is answered from the manifest that
 * matches the data being served (the directory's, or the recording's), so the
 * page never lists files the server does not have.
 *
 * `/__lake` serves the tally of what the page asked of `/lake/`, as JSON.
 *
 *   node tools/serve.mjs [port] [--lake=local|record|replay] [--dir=data/lake] [--from=https://cdn/.../]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const RECORDED = join(root, 'test', 'recorded');
export const DEFAULT_DIR = join(root, 'data', 'lake');

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

/** One file of the local copy, answered the way the CDN does: whole, or the Range asked for. */
async function readLocal(dir, path, range, headOnly) {
  const full = join(dir, normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(dir)) return null;
  let info;
  try { info = await stat(full); } catch { return null; }
  if (!info.isFile()) return null;
  const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag: `"${info.size}-${Math.round(info.mtimeMs)}"` };
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0; let end = info.size - 1; let status = 200;
  if (match) {
    if (match[1] === '') { start = Math.max(info.size - Number(match[2]), 0); } else { start = Number(match[1]); if (match[2] !== '') end = Math.min(Number(match[2]), info.size - 1); }
    if (start > end) return { status: 416, headers: { 'content-range': `bytes */${info.size}` }, body: Buffer.alloc(0) };
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['content-length'] = String(end - start + 1);
  if (headOnly) return { status, headers, body: Buffer.alloc(0) };
  const handle = await open(full);
  try {
    const body = Buffer.alloc(end - start + 1);
    await handle.read(body, 0, body.length, start);
    return { status, headers, body };
  } finally { await handle.close(); }
}

/** The same answer from the CDN: whole, or the Range asked for. */
async function readUpstream(base, path, range, headOnly) {
  const upstream = await fetch(new URL(`.${path}`, base), { method: headOnly ? 'HEAD' : 'GET', headers: range ? { range } : {} });
  const body = headOnly ? Buffer.alloc(0) : Buffer.from(await upstream.arrayBuffer());
  const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
  for (const name of ['content-range', 'etag']) if (upstream.headers.get(name)) headers[name] = upstream.headers.get(name);
  headers['content-length'] = headOnly ? (upstream.headers.get('content-length') ?? '0') : String(body.length);
  return { status: upstream.status, headers, body };
}

export async function startServer(port = 0, { lake = 'replay', dir = DEFAULT_DIR, from = null } = {}) {
  dir = resolve(dir);
  /** What the page asked of /lake/: one entry per request. */
  let log = [];
  let index = {};
  if (lake === 'replay' || lake === 'record') {
    try { index = JSON.parse(await readFile(join(RECORDED, 'index.json'), 'utf8')); } catch { index = {}; }
  }
  if (lake === 'record') {
    index = {};
    await rm(RECORDED, { recursive: true, force: true });
    await mkdir(RECORDED, { recursive: true });
    await copyFile(from ? join(root, 'src', 'manifest.js') : join(dir, 'manifest.js'), join(RECORDED, 'manifest.js'));
  }

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

    const found = from ? await readUpstream(from, path, range, request.method === 'HEAD') : await readLocal(dir, path, range, request.method === 'HEAD');
    if (!found) {
      note(404, 0, false);
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    response.writeHead(found.status, found.headers).end(request.method === 'HEAD' ? undefined : found.body);
    note(found.status, found.body.length, false);
    if (lake === 'record' && found.status < 400) {
      await mkdir(RECORDED, { recursive: true });
      const file = found.body.length && request.method !== 'HEAD' ? fileOf(key) : null;
      if (file) await writeFile(join(RECORDED, file), found.body);
      index[key] = { status: found.status, headers: found.headers, file };
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
      if (url.split('?')[0] === '/src/manifest.js') {
        const own = lake === 'replay' ? join(RECORDED, 'manifest.js') : (from ? join(root, 'src', 'manifest.js') : join(dir, 'manifest.js'));
        const found = await stat(own).then(() => own, () => null);
        if (found) {
          response.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
          createReadStream(found).pipe(response);
          return;
        }
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
  const flag = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
  const mode = flag('lake') || 'local';
  const wanted = Number(args.find((a) => /^\d+$/.test(a)) || 0);
  const { port } = await startServer(wanted, { lake: mode, dir: flag('dir') || DEFAULT_DIR, from: flag('from') || null });
  process.stdout.write(`Serving the demo at http://localhost:${port}/\n`);
  process.stdout.write(`The copy on the CDN:  http://localhost:${port}/\n`);
  process.stdout.write(`Through /lake/ (${mode}): http://localhost:${port}/?data=local\n`);
  process.stdout.write('Press Control-C to stop.\n');
}
