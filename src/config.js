/**
 * Where the data is read from. **This is the only place the data address is set.**
 *
 * The data is a country-partitioned Parquet copy of the Overture Maps Places
 * release, served from our CDN (tools/build-partitioned.mjs builds it).
 * DuckDB-Wasm reads it in byte ranges. `?data=local` points the same reads at
 * this site's own `/lake/` route instead, which `tools/serve.mjs` answers from
 * a local build or a recording, so the page can be developed and checked with
 * no network and nothing is ever sent from a visitor to anywhere but the CDN.
 */

import { MANIFEST } from './manifest.js';

/* `location` is absent when Node imports this for tools/verify.mjs; the CDN is the default there. */
export const DATA_BASE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('data') === 'local'
  ? new URL('./lake/', location.href).href
  : `${MANIFEST.host}/${MANIFEST.prefix}`;

/** The absolute address of one partition file. DuckDB resolves it inside a worker, so it must be absolute. */
export const fileUrl = (file) => `${DATA_BASE}${file.file}`;

/** Pinned, so the page does not change on someone else's release day. */
export const DUCKDB_VERSION = '1.32.0';
export const DUCKDB_MODULE = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;
export const DECK_URL = 'https://cdn.jsdelivr.net/npm/deck.gl@9.1.12/dist.min.js';
export const MAPLIBRE_URL = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.js';
export const MAPLIBRE_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.css';
