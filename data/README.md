# Data

The page reads a **country-partitioned Parquet copy** of Overture Maps Places, release
`2026-09-23.1`, from `https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-data-lake/`.
The Parquet is never committed (`.gitignore`): it is built from the public release and uploaded.

- Source: Overture Maps Foundation, Places theme,
  `s3://overturemaps-us-west-2/release/2026-09-23.1/theme=places/type=place/`
- Licences: per source, CDLA-Permissive-2.0, Apache-2.0 or CC0. Attribution per
  <https://docs.overturemaps.org/attribution/> (shown in the page footer).

## Layout

```
country=GB/part-0.parquet        one folder per country (ISO 3166-1 alpha-2; ZZ = no address country)
country=US/part-0.parquet ...    a country over ~200 MB is cut into part-1, part-2... in key order
```

Columns: `id, name, category, brand, locality, confidence, lon, lat` (flattened from Overture's
`names.primary`, `taxonomy.primary`, `brand.names.primary`, `addresses[1].locality`,
`bbox.xmin`, `bbox.ymin`); `country` is the folder name (`hive_partitioning = true`).
zstd, row groups of 100,000 rows, sorted by a Z-order (Morton) key of lon/lat, so each row
group is a small map tile and a bbox filter skips the others from the footer statistics.

## Building and publishing (the PM, on the release box)

```
node tools/build-partitioned.mjs --out data/lake       # whole release; writes data/lake/ and src/manifest.js
```

Then upload `data/lake/country=*` to the CDN path above (anonymous GET with Range, CORS open to
the page's origin) and commit the regenerated `src/manifest.js`. The manifest lists every file
with its country, rows, bytes and lon/lat extent, plus the extent of each row group, because
DuckDB-Wasm cannot glob https: the page picks the files a city window can touch and passes them
to `read_parquet([...], hive_partitioning = true)`. The `src/manifest.js` in the repository is the
5-country test build until that is done. The builder prints the partition count, total size and
largest file when it finishes.

## Testing

`node tools/verify.mjs --local [dir]` runs the page against a local build (via `tools/serve.mjs`,
`?data=local`) and checks every figure against a second DuckDB in Node. `--record` does the same,
also checks the copy against the Overture release itself, and rewrites `test/recorded/` (the range
responses for the windows it visits, with the manifest they match)
and `test/expected.json`. Plain `node tools/verify.mjs` replays the recording, with no data.

`node tools/verify.mjs --record --from https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-data-lake/` records from the copy on the CDN instead of a local build (the expected answers are asked of the same files with Node's DuckDB over HTTPS); `--local --from <url>` checks against it without writing the recording. The drag case is recorded at 1440 px; other widths are checked for what they can be and replay the same reads.
