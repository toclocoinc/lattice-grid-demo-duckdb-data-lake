# The lake is the database

Query the Overture Maps Places data lake (81 million places, 11 GB of public Parquet)
in place. DuckDB-Wasm reads the files over HTTPS in byte ranges; Lattice Grid turns every
filter, sort, group and search into SQL, with a map bound to the grid and a live counter of
bytes fetched against the size of the dataset.

No framework, no bundler, no build step: `index.html`, `main.js`, `src/*.js`, `styles.css`.

```
npm install
npm start          # http://localhost:<port>/  (add ?data=local to go through the /lake/ route)
npm run verify     # headless Chrome; live bucket if reachable, else test/recorded/
```

URL options: `?city=reykjavik|sf|nyc|london|paris|tokyo|sydney`, `?theme=light|dark`.

See `data/README.md` for the data, licences and sizes. MIT licence for the code.
