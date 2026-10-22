/**
 * DuckDB-Wasm, started in the page.
 *
 * The grid ships no engine: `duckdbAdapter` takes a connection the host made.
 * Everything about DuckDB — which version, where it comes from, what is
 * loaded — is decided here.
 *
 * `LOAD httpfs` is what makes a remote Parquet file a set of byte ranges
 * instead of one whole-file GET: the footer first, then only the row groups
 * and column chunks a query needs.
 *
 * The byte counter. DuckDB reads inside a worker, where nothing in the page can
 * observe its requests. The worker is therefore started from a few lines that
 * wrap XMLHttpRequest — the transport DuckDB-Wasm reads files with — and report
 * each finished request over a BroadcastChannel. This counts what DuckDB asked
 * the CDN for and what came back; it changes nothing about the reads.
 */

import { DUCKDB_MODULE, DUCKDB_VERSION } from './config.js';

/** The engine's WebAssembly once decoded, which is what the progress callback counts. Used only when the server gives no usable total. */
export const ENGINE_BYTES = 34242586;

const CHANNEL = 'lake-bytes';

/** The worker preamble: count every request, then load DuckDB's own worker script. */
const workerSource = (script) => `
const channel = new BroadcastChannel(${JSON.stringify(CHANNEL)});
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url) {
  this.__lake = { method, url: String(url) };
  return open.apply(this, arguments);
};
const send = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function () {
  this.addEventListener('loadend', () => {
    let bytes = 0;
    try {
      const body = this.response;
      bytes = body && typeof body.byteLength === 'number' ? body.byteLength : (typeof body === 'string' ? body.length : 0);
    } catch (e) { /* a body that cannot be read counts as zero */ }
    channel.postMessage({ method: this.__lake && this.__lake.method, url: this.__lake && this.__lake.url, status: this.status, bytes });
  });
  return send.apply(this, arguments);
};
importScripts(${JSON.stringify(script)});
`;

/**
 * Tallies what the worker fetched. `since()` marks a point; `bytes` is the
 * total and `requests` the count since the last reset.
 */
export function createByteMeter() {
  const meter = {
    bytes: 0, requests: 0, failed: 0, log: [],
    listeners: new Set(),
    reset() { meter.bytes = 0; meter.requests = 0; meter.failed = 0; meter.log = []; meter.emit(); },
    emit() { for (const fn of meter.listeners) fn(meter); },
    onChange(fn) { meter.listeners.add(fn); return () => meter.listeners.delete(fn); },
  };
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    const entry = event.data;
    if (!entry || entry.method === 'HEAD') {
      if (entry) { meter.requests += 1; meter.emit(); }
      return;
    }
    meter.requests += 1;
    if (entry.status >= 200 && entry.status < 300) meter.bytes += entry.bytes;
    else meter.failed += 1;
    meter.log.push(entry);
    if (meter.log.length > 500) meter.log.shift();
    meter.emit();
  };
  meter.close = () => channel.close();
  return meter;
}

/**
 * Start the engine and open a connection with httpfs loaded.
 *
 * @param {(message: string) => void} [onStatus] progress, for the loading panel
 * @param {(progress: {loaded: number, total: number}) => void} [onDownload] bytes of the engine downloaded so far
 */
export async function startDuckDB(onStatus = () => {}, onDownload = () => {}) {
  onStatus('Loading the DuckDB library');
  const duckdb = await import(/* @vite-ignore */ DUCKDB_MODULE);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  onStatus('Downloading the query engine');
  const blob = new Blob([workerSource(bundle.mainWorker)], { type: 'text/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
  /* DuckDB fetches its own WebAssembly inside `instantiate` and reports the bytes, so the bar is the real download. */
  let starting = false;
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (progress) => {
    const total = progress.bytesTotal >= progress.bytesLoaded && progress.bytesTotal > 0 ? progress.bytesTotal : ENGINE_BYTES;
    const loaded = Math.min(progress.bytesLoaded, total);
    onDownload({ loaded, total });
    if (loaded >= total && !starting) { starting = true; onStatus('Starting the engine'); }
  });
  URL.revokeObjectURL(workerUrl);

  const connection = await db.connect();
  await connection.query('LOAD httpfs;');
  const version = (await readOne(connection, 'SELECT version() AS v'))?.v ?? 'unknown';

  return {
    connection,
    version: String(version),
    close() {
      try { connection.close?.(); } catch { /* already gone */ }
      try { worker.terminate?.(); } catch { /* already gone */ }
    },
  };
}

/** One row of a one-row query, as a plain object. */
export async function readOne(connection, sql) {
  const result = await connection.query(sql);
  return result.toArray().map((r) => r.toJSON())[0] ?? null;
}

/**
 * Wrap a connection so every statement that passes through it is recorded
 * with its text, bound values and how long it took. The adapter is handed
 * the wrapper, so nothing reaches DuckDB unseen.
 */
export function recordingConnection(connection, record) {
  const note = (sql, params, started, result) => {
    const rows = typeof result?.numRows === 'number' ? result.numRows : 0;
    record({ sql, params, ms: Math.round(performance.now() - started), rows });
  };
  return {
    query: async (sql) => {
      const started = performance.now();
      const result = await connection.query(sql);
      note(sql, [], started, result);
      return result;
    },
    prepare: async (sql) => {
      const statement = await connection.prepare(sql);
      return {
        query: async (...params) => {
          const started = performance.now();
          const result = await statement.query(...params);
          note(sql, params, started, result);
          return result;
        },
        close: () => statement.close?.(),
      };
    },
  };
}
