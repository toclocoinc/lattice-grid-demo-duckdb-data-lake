# Data

This demo **does not rehost any data and builds no Parquet**. DuckDB-Wasm in the
visitor's browser reads Overture Maps' own public Parquet over HTTPS, in byte
ranges, from the bucket that publishes it.

- Source: Overture Maps Foundation, Places theme, release `2026-09-23.1`
- Location: `s3://overturemaps-us-west-2/release/2026-09-23.1/theme=places/type=place/`,
  read as `https://overturemaps-us-west-2.s3.amazonaws.com/...` (the bucket answers
  browser CORS with `Access-Control-Allow-Origin: *` and supports Range requests).
- Licences: per source, CDLA-Permissive-2.0, Apache-2.0 or CC0. Attribution per
  <https://docs.overturemaps.org/attribution/> (shown in the page footer).

## Row counts and sizes (recorded by `npm run build-manifest`)

`SELECT count(*)` over the release: **81,455,423 places in 16 files, 11.00 GB (zstd Parquet)**.
Each file has 256 row groups of roughly 20,000 rows.

| File | Rows | Size | Longitude / latitude extent |
|---|---|---|---|
| part-00000 | 5,120,674 | 681 MB | -180.0..-76.5 / -85.0..28.6 |
| part-00001 | 5,065,932 | 737 MB | -120.5..-77.4 / 28.6..34.5 |
| part-00002 | 5,110,584 | 752 MB | -179.8..-88.7 / 34.5..81.8 |
| part-00003 | 5,124,095 | 758 MB | -88.7..-76.5 / 34.5..82.7 |
| part-00004 | 5,135,717 | 679 MB | -75.6..5.6 / -84.9..-20.1 |
| part-00005 | 5,087,871 | 694 MB | -76.5..6.3 / -20.1..40.4 |
| part-00006 | 5,137,402 | 729 MB | -76.5..-1.6 / 40.4..83.6 |
| part-00007 | 5,152,063 | 728 MB | -1.6..6.3 / 40.4..62.7 |
| part-00008 | 5,060,836 | 663 MB | 6.3..42.1 / -84.5..41.1 |
| part-00009 | 5,018,256 | 621 MB | 6.3..42.1 / 41.1..47.4 |
| part-00010 | 5,075,322 | 632 MB | 6.3..42.1 / 47.4..51.2 |
| part-00011 | 5,088,275 | 633 MB | 6.3..42.1 / 51.2..80.5 |
| part-00012 | 5,078,337 | 669 MB | 42.1..106.7 / -85.0..18.1 |
| part-00013 | 5,047,272 | 657 MB | 106.7..180.0 / -84.7..18.1 |
| part-00014 | 5,058,561 | 683 MB | 42.1..105.8 / 18.1..81.8 |
| part-00015 | 5,094,226 | 679 MB | 105.8..179.6 / 18.1..77.1 |

The files are spatial tiles, which is what lets the page open one footer
(about 1.6 MB) instead of sixteen: `src/manifest.js` carries each file's extent.

## Refreshing

`node tools/build-manifest.mjs [release]` lists the bucket, reads each footer and rewrites
`src/manifest.js` (latest release by default). Nothing else is generated. Then
`node tools/verify.mjs --record` rewrites `test/recorded/` and `test/expected.json`.

## test/recorded/

About 5 MB of range responses (one footer and the column chunks one small
window needs), so `npm run verify` can run with no access to the bucket. They are
fragments of the public files above, under the same licences; they are not a
usable Parquet file and are not served by the page.
