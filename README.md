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
