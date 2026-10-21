/**
 * What the data is, and how the grid should read it.
 *
 * Overture Maps Places: one row per place of interest, worldwide, published as
 * Parquet that is spatially partitioned across a handful of files. Nothing
 * here is downloaded in advance; this module only names the columns and the
 * places the visitor can jump to.
 */

import { MANIFEST } from './manifest.js';
import { fileUrl } from './config.js';

/**
 * The flat view the grid reads. Overture nests its attributes in structs
 * (`names.primary`, `taxonomy.primary`, `bbox.xmin`); a view with plain column
 * names lets every grid filter, sort, group and quick search address a column
 * directly, and DuckDB pushes those predicates through the projection to the
 * Parquet scan, where the row-group statistics decide what is read at all.
 */
export const VIEW_SELECT = `
  id,
  names."primary" AS name,
  taxonomy."primary" AS category,
  brand.names."primary" AS brand,
  addresses[1].locality AS locality,
  addresses[1].country AS country,
  confidence,
  bbox.xmin AS lon,
  bbox.ymin AS lat`;

export const GRID_FIELDS = ['id', 'name', 'category', 'brand', 'locality', 'country', 'confidence', 'lon', 'lat'];

/** `from` for the adapter, over the files that can hold the given window. */
export function fromFor(files) {
  const list = files.map((f) => `'${fileUrl(f).replaceAll("'", "''")}'`).join(', ');
  return `(SELECT ${VIEW_SELECT} FROM read_parquet([${list}]))`;
}

/**
 * The files whose longitude/latitude extent meets the window. The extents come
 * from the footers (tools/build-manifest.mjs), so a file left out cannot hold a
 * place inside the window.
 */
export function filesFor(bbox) {
  return MANIFEST.files.filter((f) => f.xmin <= bbox.xmax && f.xmax >= bbox.xmin && f.ymin <= bbox.ymax && f.ymax >= bbox.ymin);
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

/** The window and category chips as one filter tree for the grid. */
export function filterTree(city, categoryIds) {
  const { bbox } = city;
  const conditions = [
    { col: 'lon', op: 'gte', value: bbox.xmin },
    { col: 'lon', op: 'lte', value: bbox.xmax },
    { col: 'lat', op: 'gte', value: bbox.ymin },
    { col: 'lat', op: 'lte', value: bbox.ymax },
  ];
  const values = CATEGORIES.filter((c) => categoryIds.has(c.id)).flatMap((c) => c.values);
  if (values.length) conditions.push({ col: 'category', op: 'in', value: values });
  return { op: 'and', conditions };
}

export const COLUMNS = [
  { field: 'name', title: 'Name', filter: { type: 'text' }, layout: { width: 230, pin: 'start' }, allowGroup: false },
  { field: 'category', title: 'Category', filter: { type: 'text' }, layout: { width: 190 }, allowGroup: true },
  { field: 'brand', title: 'Brand', filter: { type: 'text' }, layout: { width: 170 }, allowGroup: true },
  { field: 'locality', title: 'City', filter: { type: 'text' }, layout: { width: 140 }, allowGroup: false },
  { field: 'country', title: 'Country', filter: { type: 'text' }, layout: { width: 90 }, allowGroup: false },
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
