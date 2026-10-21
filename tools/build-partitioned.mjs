/**
 * Builds the partitioned copy of Overture Maps Places that the page reads.
 *
 * Reads the public release (Node 22 + @duckdb/node-api, nothing else) and writes
 *
 *   <out>/country=XX/part-0.parquet        (part-1, part-2... only above --max-mb)
 *   <out>/manifest.js                      and the same file to src/manifest.js
 *
 * Each file holds only the columns the page uses, flattened (`name`, `category`,
 * `brand`, `locality`, `confidence`, `lon`, `lat`, plus `id`); the country is the
 * folder name, which DuckDB reads back with hive_partitioning. Rows are sorted by
 * a Z-order (Morton) key of lon/lat, in row groups of ~100,000 rows, so each row
 * group covers a small tile and a bbox filter skips the rest from the footer
 * statistics alone. zstd. A country over ~200 MB is cut into several files at row
 * group boundaries, still in key order, so each file is a contiguous run of tiles.
 *
 * Places with no address country go to country=ZZ (sorted the same way, so a
 * window still opens only the ZZ files near it).
 *
 * The manifest lists every file with rows, bytes, lon/lat extent and the extent
 * of each row group; the page uses it because DuckDB-Wasm cannot glob https.
 *
 *   node tools/build-partitioned.mjs --out data/lake                 the whole release
 *   node tools/build-partitioned.mjs --out data/lake --countries IS,LU,MC,LI,AD   a small copy for tests
 *
 * Options: --release 2026-09-23.1  --out DIR  --countries CSV  --max-mb 200
 *          --row-group 100000  --manifest PATH (default src/manifest.js)  --temp DIR
 *          --reuse-staging  skip the read of the release and redo the sort and write from the staged copy
 *          --bbox "xmin,ymin,xmax,ymax;..."  keep only places inside these boxes (a test knob:
 *          the release is spatially tiled, so boxes around the chosen countries skip most of
 *          the download; the copy then holds those countries only in part)
 *
 * Upload <out>/country=* to https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-data-lake/
 * (CORS open to the page's origin, Range requests supported). Never commit the Parquet.
 */

import { mkdir, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};

const RELEASE = option('release', '2026-09-23.1');
const OUT = resolve(option('out', join(root, 'data', 'lake')));
const MANIFEST_PATH = resolve(option('manifest', join(root, 'src', 'manifest.js')));
const MAX_BYTES = Number(option('max-mb', '200')) * 1e6;
const ROW_GROUP = Number(option('row-group', '100000'));
const COUNTRIES = option('countries', '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const BOXES = option('bbox', '').split(';').filter(Boolean).map((b) => b.split(',').map(Number));
for (const b of BOXES) if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) throw new Error(`not a box: ${b}`);
const STAGING = resolve(option('temp', join(OUT, '.staging')));

const HOST = 'https://data.latticegrid.dev';
const PREFIX = 'duckdb/lattice-grid-demo-duckdb-data-lake/';
const SOURCE = `s3://overturemaps-us-west-2/release/${RELEASE}/theme=places/type=place/*.parquet`;

for (const c of COUNTRIES) if (!/^[A-Z]{2}$/.test(c)) throw new Error(`not a country code: ${c}`);

const db = await DuckDBInstance.create(':memory:');
const conn = await db.connect();
const rows = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

await conn.run("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';");
await mkdir(STAGING, { recursive: true });
await conn.run(`SET temp_directory = '${join(STAGING, 'spill').replaceAll("'", "''")}'`);

/* The country of a place is the country of its first address; anything that is not two letters is ZZ. */
const COUNTRY = `CASE WHEN regexp_matches(addresses[1].country, '^[A-Z]{2}$') THEN addresses[1].country ELSE 'ZZ' END`;

/* ------------------------------------------------------------------ */
/* Stage 1: one pass over the release, flattened and split by country  */
/* ------------------------------------------------------------------ */

log(`reading ${SOURCE}${COUNTRIES.length ? ` for ${COUNTRIES.join(', ')}` : ''}`);
const REUSE = args.includes('--reuse-staging');
if (!REUSE) await rm(join(STAGING, 'by-country'), { recursive: true, force: true });
const clauses = [];
if (BOXES.length) clauses.push(`(${BOXES.map(([x0, y0, x1, y1]) => `(bbox.xmin BETWEEN ${x0} AND ${x1} AND bbox.ymin BETWEEN ${y0} AND ${y1})`).join(' OR ')})`);
if (COUNTRIES.length) clauses.push(`${COUNTRY} IN (${COUNTRIES.map((c) => `'${c}'`).join(', ')})`);
const wanted = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
if (!REUSE) await conn.run(`
  COPY (
    SELECT
      id,
      names."primary" AS name,
      taxonomy."primary" AS category,
      brand.names."primary" AS brand,
      addresses[1].locality AS locality,
      confidence,
      bbox.xmin AS lon,
      bbox.ymin AS lat,
      ${COUNTRY} AS country
    FROM read_parquet('${SOURCE}')
    ${wanted}
  ) TO '${join(STAGING, 'by-country').replaceAll("'", "''")}'
  (FORMAT parquet, PARTITION_BY (country), COMPRESSION snappy, FILENAME_PATTERN 'stage-{i}', OVERWRITE_OR_IGNORE)`);

const staged = (await readdir(join(STAGING, 'by-country'))).filter((d) => d.startsWith('country=')).map((d) => d.slice(8)).sort();
if (!staged.length) throw new Error('the release held no places for the chosen countries');
log(`${staged.length} countries staged`);

/* ------------------------------------------------------------------ */
/* Stage 2: per country, Z-order sort, row groups, size-capped files   */
/* ------------------------------------------------------------------ */

/* Interleave two 16-bit tile numbers into one 32-bit Morton code. */
await conn.run(`CREATE OR REPLACE MACRO spread_a(v) AS (v | (v << 8)) & 16711935::UBIGINT`);
await conn.run(`CREATE OR REPLACE MACRO spread_b(v) AS (spread_a(v) | (spread_a(v) << 4)) & 252645135::UBIGINT`);
await conn.run(`CREATE OR REPLACE MACRO spread_c(v) AS (spread_b(v) | (spread_b(v) << 2)) & 858993459::UBIGINT`);
await conn.run(`CREATE OR REPLACE MACRO spread(v) AS (spread_c(v) | (spread_c(v) << 1)) & 1431655765::UBIGINT`);
await conn.run(`CREATE OR REPLACE MACRO zkey(lon, lat) AS
  spread(CAST(least(greatest((lon + 180.0) / 360.0, 0.0), 1.0) * 65535 AS UBIGINT))
  | (spread(CAST(least(greatest((lat + 90.0) / 180.0, 0.0), 1.0) * 65535 AS UBIGINT)) << 1)`);

const q = (path) => path.replaceAll("'", "''");
const writeSorted = (from, to, tail = '') => conn.run(`
  COPY (SELECT * FROM ${from} ORDER BY zkey(lon, lat), id ${tail})
  TO '${q(to)}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP})`);

const entries = [];
let done = 0;
for (const country of staged) {
  const dir = join(OUT, `country=${country}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const source = `read_parquet('${q(join(STAGING, 'by-country', `country=${country}`, '*.parquet'))}')`;
  const first = join(dir, 'part-0.parquet');
  await writeSorted(source, first);
  const size = (await stat(first)).size;

  if (size > MAX_BYTES) {
    /* Cut the sorted run into contiguous files at row-group boundaries. */
    const total = Number((await rows(`SELECT count(*) AS n FROM ${source}`))[0].n);
    const parts = Math.ceil((size * 1.03) / MAX_BYTES);
    const each = Math.ceil(total / parts / ROW_GROUP) * ROW_GROUP;
    const whole = join(STAGING, `whole-${country}.parquet`);
    await rename(first, whole);
    for (let i = 0, offset = 0; offset < total; i += 1, offset += each) {
      await writeSorted(`read_parquet('${q(whole)}')`, join(dir, `part-${i}.parquet`), `LIMIT ${each} OFFSET ${offset}`);
    }
    await rm(whole);
  }

  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.parquet')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const path = join(dir, name);
    const meta = await rows(`SELECT num_rows FROM parquet_file_metadata('${q(path)}')`);
    const groups = await rows(`
      SELECT row_group_id AS g, any_value(row_group_num_rows) AS n,
        min(TRY_CAST(stats_min AS DOUBLE)) FILTER (path_in_schema = 'lon') AS xmin,
        min(TRY_CAST(stats_min AS DOUBLE)) FILTER (path_in_schema = 'lat') AS ymin,
        max(TRY_CAST(stats_max AS DOUBLE)) FILTER (path_in_schema = 'lon') AS xmax,
        max(TRY_CAST(stats_max AS DOUBLE)) FILTER (path_in_schema = 'lat') AS ymax
      FROM parquet_metadata('${q(path)}') GROUP BY row_group_id ORDER BY row_group_id`);
    /* Extents rounded outward to 1e-5 degrees, so a rounded box never excludes a place the footer would keep. */
    const lo = (v) => Math.floor(Number(v) * 1e5) / 1e5;
    const hi = (v) => Math.ceil(Number(v) * 1e5) / 1e5;
    const boxes = groups.map((g) => [lo(g.xmin), lo(g.ymin), hi(g.xmax), hi(g.ymax), Number(g.n)]);
    entries.push({
      country, file: `country=${country}/${name}`, rows: Number(meta[0].num_rows), bytes: (await stat(path)).size,
      xmin: Math.min(...boxes.map((b) => b[0])), ymin: Math.min(...boxes.map((b) => b[1])),
      xmax: Math.max(...boxes.map((b) => b[2])), ymax: Math.max(...boxes.map((b) => b[3])),
      groups: boxes,
    });
  }
  done += 1;
  if (done % 10 === 0 || done === staged.length) log(`${done} of ${staged.length} countries written`);
}
await rm(STAGING, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* The manifest                                                        */
/* ------------------------------------------------------------------ */

const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
const totalRows = entries.reduce((s, e) => s + e.rows, 0);
const compact = (value) => JSON.stringify(value, null, 1)
  .replace(/\[\n\s+(-?[\d.e+-]+),\n\s+(-?[\d.e+-]+),\n\s+(-?[\d.e+-]+),\n\s+(-?[\d.e+-]+),\n\s+(\d+)\n\s+\]/g, '[$1, $2, $3, $4, $5]');
const body = `/**
 * The partitioned copy of Overture Maps Places, generated by tools/build-partitioned.mjs.
 * Do not edit by hand. Overture release ${RELEASE}.
 *
 * DuckDB-Wasm cannot glob an https path, so the page needs the list of files. Each
 * file has its longitude/latitude extent and the extent of each row group
 * ([xmin, ymin, xmax, ymax, rows]), so the page opens only the files a map window
 * can touch and can say how many row groups the footer statistics let DuckDB skip.
 */
export const MANIFEST = ${compact({
    release: RELEASE,
    host: HOST,
    prefix: PREFIX,
    countries: new Set(entries.map((e) => e.country)).size,
    totalBytes, totalRows, files: entries,
  })};
`;
await mkdir(dirname(MANIFEST_PATH), { recursive: true });
await writeFile(join(OUT, 'manifest.js'), body);
if (MANIFEST_PATH !== join(OUT, 'manifest.js')) await copyFile(join(OUT, 'manifest.js'), MANIFEST_PATH);

const largest = entries.reduce((a, b) => (b.bytes > a.bytes ? b : a));
log(`release ${RELEASE}: ${new Set(entries.map((e) => e.country)).size} countries, ${entries.length} files, ${totalRows.toLocaleString('en-US')} rows, ${(totalBytes / 1e9).toFixed(3)} GB`);
log(`largest file: ${largest.file}, ${(largest.bytes / 1e6).toFixed(1)} MB, ${largest.rows.toLocaleString('en-US')} rows`);
log(`manifest: ${MANIFEST_PATH}`);
