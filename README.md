# The lake is the database

Query a country-partitioned Parquet copy of the Overture Maps Places data (81 million places)
in place. DuckDB-Wasm reads the files over HTTPS in byte ranges, opening only the countries the
map window touches; Lattice Grid turns every filter, sort, group and search into SQL, with a map
bound to the grid and a cost panel (countries opened of total, bytes fetched of the whole copy,
row groups skipped, milliseconds).

The data is a partitioned copy of the Overture Maps Places release 2026-09-23.1, served from
`https://data.latticegrid.dev/duckdb/lattice-grid-demo-duckdb-data-lake/`. Each place carries its
own source licence (CDLA-Permissive-2.0, Apache-2.0 or CC0); attribution per
<https://docs.overturemaps.org/attribution/>, also shown on the page.

No framework, no bundler, no build step: `index.html`, `main.js`, `src/*.js`, `styles.css`.

```
npm install
node tools/build-partitioned.mjs --out data/lake --countries IS,LU,MC,LI,AD \
  --bbox "-25,63,-13,67;5.7,49.4,6.6,50.2;7.3,43.7,7.5,43.8;9.4,47,9.7,47.3;1.4,42.4,1.8,42.7"   # a small test copy
npm start          # http://localhost:<port>/?data=local  serves data/lake through /lake/
npm run verify     # headless Chrome against the recording in test/recorded/
npm run verify -- --local        # ... against data/lake
```

URL options: `?city=reykjavik|sf|nyc|london|paris|tokyo|sydney`, `?theme=light|dark`, `?data=local`.

See `data/README.md` for building and publishing the copy. MIT licence for the code.

## Loading

The first visit has slow steps, so the page says what it is doing instead of showing a blank page (`src/loading.js`, copied from the SaaS analytics demo):

1. A status line in the static HTML (spinner, one plain-English sentence, progress bar), on screen from first paint: "Downloading the query engine (33 MB, first visit only): n of m MB" (real bytes, reported by DuckDB-Wasm's `instantiate`), "Starting the engine", then "Reading the manifest and the country partitions <place> opens (n of up to m MB)". The `m` is the size of the partition files the window opens; DuckDB reads only byte ranges of them, so the bar may stop short. The one-off Parquet reader download is named separately.
2. Every panel (cost tiles, grid, map) is covered by a loading state until the first rows arrive, and again when the place changes.
3. The map libraries load with `async` and the map stylesheet does not block rendering, so they do not delay first paint.
