/**
 * What the data is, and how the grid should read it.
 *
 * A country-partitioned Parquet copy of the Overture Maps Places release: one
 * folder per country (`country=GB/part-0.parquet`), the columns this page uses,
 * rows sorted by a Z-order key so each row group is a small map tile. Nothing
 * is downloaded in advance; this module names the columns, picks the files a
 * map window can touch, and lists the places the visitor can jump to.
 */

import { MANIFEST } from './manifest.js';
import { fileUrl } from './config.js';

export const GRID_FIELDS = ['id', 'name', 'category', 'brand', 'locality', 'country', 'confidence', 'lon', 'lat'];

const NO_ROWS = `(SELECT ${GRID_FIELDS.map((f) => (f === 'confidence' || f === 'lon' || f === 'lat' ? `NULL::DOUBLE AS ${f}` : `NULL::VARCHAR AS ${f}`)).join(', ')} WHERE false)`;

/**
 * `from` for the adapter, over the partition files that can hold the window.
 * DuckDB-Wasm cannot glob https, so the files are listed; `country` comes from
 * the folder names (hive partitioning), the rest are plain columns, so every
 * grid filter, sort, group and quick search addresses a column directly and
 * DuckDB pushes the predicates to the Parquet scan, where the row-group
 * statistics decide what is read at all.
 */
export function fromFor(files) {
  if (!files.length) return NO_ROWS;
  const list = files.map((f) => `'${fileUrl(f).replaceAll("'", "''")}'`).join(', ');
  return `(SELECT ${GRID_FIELDS.join(', ')} FROM read_parquet([${list}], hive_partitioning = true, hive_types = {'country': VARCHAR}))`;
}

const meets = (box, bbox) => box[0] <= bbox.xmax && box[2] >= bbox.xmin && box[1] <= bbox.ymax && box[3] >= bbox.ymin;

/**
 * The files with a row group that meets the window. Country extents overlap
 * (a country's outlying islands stretch its box across the map), so the test
 * is per row group, from the footers (tools/build-partitioned.mjs): a file left
 * out cannot hold a place inside the window.
 */
export function filesFor(bbox) {
  return MANIFEST.files.filter((f) => f.groups.some((g) => meets(g, bbox)));
}

/** Row groups in the given files, and how many of them the window can touch (the rest DuckDB skips from the footer statistics). */
export function groupsFor(files, bbox) {
  const total = files.reduce((n, f) => n + f.groups.length, 0);
  const touched = files.reduce((n, f) => n + f.groups.filter((g) => meets(g, bbox)).length, 0);
  return { total, touched, skipped: total - touched };
}

/** How the "What DuckDB ran" panel shows the source: the files, not the whole URLs. */
export function shortenSource(sql) {
  return sql
    .replace(/FROM \(SELECT [^)]*? FROM (read_parquet\(\[.*?\], hive_partitioning = true), hive_types = \{[^}]*\}\)\)/, 'FROM $1) AS places')
    .replace(/'https?:\/\/[^']*?\/(country=[^']*)'/g, "'$1'");
}

/** City-centre windows, about two kilometres across. */
export const CITIES = [
  { id: 'sf', label: 'San Francisco', note: 'Financial District and SoMa', bbox: { xmin: -122.415, xmax: -122.390, ymin: 37.775, ymax: 37.795 } },
  { id: 'nyc', label: 'New York', note: 'Midtown', bbox: { xmin: -73.995, xmax: -73.975, ymin: 40.750, ymax: 40.765 } },
  { id: 'london', label: 'London', note: 'Soho and Covent Garden', bbox: { xmin: -0.140, xmax: -0.115, ymin: 51.508, ymax: 51.518 } },
  { id: 'paris', label: 'Paris', note: 'Louvre to Opéra', bbox: { xmin: 2.325, xmax: 2.350, ymin: 48.860, ymax: 48.872 } },
  { id: 'tokyo', label: 'Tokyo', note: 'Shibuya', bbox: { xmin: 139.695, xmax: 139.710, ymin: 35.655, ymax: 35.668 } },
  { id: 'sydney', label: 'Sydney', note: 'The CBD', bbox: { xmin: 151.200, xmax: 151.215, ymin: -33.875, ymax: -33.862 } },
  { id: 'reykjavik', label: 'Reykjavík', note: 'Old town', bbox: { xmin: -21.950, xmax: -21.920, ymin: 64.140, ymax: 64.150 } },
];

/** Category chips: Overture `taxonomy.primary` values. */
export const CATEGORIES = [
  { id: 'restaurant', label: 'Restaurants', values: ['restaurant'] },
  { id: 'coffee', label: 'Coffee', values: ['coffee_shop', 'cafe'] },
  { id: 'hotel', label: 'Hotels', values: ['hotel'] },
  { id: 'shops', label: 'Clothing', values: ['clothing_store', 'womens_clothing_store', 'mens_clothing_store'] },
  { id: 'beauty', label: 'Beauty', values: ['beauty_salon', 'hair_salon', 'spa'] },
  { id: 'health', label: 'Health', values: ['health_care', 'dental_clinic', 'doctors_office', 'pharmacy'] },
  { id: 'finance', label: 'Finance', values: ['financial_service', 'bank_credit_union', 'atm'] },
];

/** The window and category chips as one filter tree for the grid. `bbox` is the grid's current window, never a remembered one. */
export function filterTree(bbox, categoryIds) {
  const conditions = [
    { col: 'lon', op: 'between', value: [bbox.xmin, bbox.xmax] },
    { col: 'lat', op: 'between', value: [bbox.ymin, bbox.ymax] },
  ];
  const values = CATEGORIES.filter((c) => categoryIds.has(c.id)).flatMap((c) => c.values);
  if (values.length) conditions.push({ col: 'category', op: 'in', value: values });
  return { op: 'and', conditions };
}

/**
 * The window a filter tree holds: the `lon` and `lat` ranges it carries, or
 * null when it has no complete box. The map's viewport condition is a `between`
 * pair on these columns; `gte`/`lte` pairs are read too.
 */
export function boxOf(tree) {
  const range = { lon: [-Infinity, Infinity], lat: [-Infinity, Infinity] };
  const seen = { lon: false, lat: false };
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node.conditions)) { node.conditions.forEach(walk); return; }
    const r = range[node.col];
    if (!r) return;
    if (node.op === 'between') {
      const [lo, hi] = Array.isArray(node.value) ? node.value : [node.value, node.value2];
      r[0] = Math.max(r[0], Number(lo)); r[1] = Math.min(r[1], Number(hi)); seen[node.col] = true;
    }
    else if (node.op === 'gte') { r[0] = Math.max(r[0], Number(node.value)); seen[node.col] = true; }
    else if (node.op === 'lte') { r[1] = Math.min(r[1], Number(node.value)); seen[node.col] = true; }
  };
  walk(tree);
  if (!seen.lon || !seen.lat || !range.lon.every(Number.isFinite) || !range.lat.every(Number.isFinite)) return null;
  return { xmin: range.lon[0], xmax: range.lon[1], ymin: range.lat[0], ymax: range.lat[1] };
}

/** Whether two windows are the same box, within `slack` of the first one's size (the map writes the box it fitted, to a few decimals). */
export const sameBox = (a, b, slack = 1e-9) => !!a && !!b && [['xmin', 'xmax'], ['ymin', 'ymax']].every(([lo, hi]) => {
  const tol = Math.max((b[hi] - b[lo]) * slack, 1e-9);
  return Math.abs(a[lo] - b[lo]) <= tol && Math.abs(a[hi] - b[hi]) <= tol;
});

/** The closest the map may zoom out: a window never wider than a metro area, so the lake is never asked for a continent. */
export const MIN_ZOOM = 9;

export const COLUMNS = [
  { field: 'name', title: 'Name', filter: { type: 'text' }, layout: { width: 220, pin: 'start' }, allowGroup: false },
  { field: 'category', title: 'Category', filter: { type: 'set' }, layout: { width: 180 }, allowGroup: true },
  { field: 'brand', title: 'Brand', filter: { type: 'set' }, layout: { width: 160 }, allowGroup: true },
  { field: 'locality', title: 'City', filter: { type: 'text' }, layout: { width: 140, hidden: true }, allowGroup: false },
  { field: 'country', title: 'Country', filter: { type: 'set' }, layout: { width: 90 }, allowGroup: false },
  { field: 'confidence', title: 'Confidence', type: 'number', filter: { type: 'number' }, format: { decimals: 2 }, layout: { width: 110 }, allowGroup: false },
  { field: 'lon', title: 'Longitude', type: 'number', filter: { type: 'number' }, format: { decimals: 5 }, layout: { width: 110, hidden: true }, allowGroup: false },
  { field: 'lat', title: 'Latitude', type: 'number', filter: { type: 'number' }, format: { decimals: 5 }, layout: { width: 110, hidden: true }, allowGroup: false },
];

export const fmt = {
  int: (n) => (n == null ? '—' : Number(n).toLocaleString('en-US')),
  bytes: (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v < 1e3) return `${v} B`;
    if (v < 1e6) return `${(v / 1e3).toFixed(1)} KB`;
    if (v < 1e9) return `${(v / 1e6).toFixed(1)} MB`;
    return `${(v / 1e9).toFixed(2)} GB`;
  },
};
