/**
 * The page.
 *
 * The visitor picks a place and some categories. The grid is a source over
 * Overture's public Parquet; every filter, sort, group and search it applies is
 * SQL that DuckDB-Wasm runs against the bucket, and the counter beside it
 * shows what that cost in bytes, against the size of the whole dataset.
 */

import { MANIFEST } from './manifest.js';
import { LAKE_BASE } from './config.js';
import { recordingConnection } from './duckdb.js';
import { CATEGORIES, CITIES, COLUMNS, GRID_FIELDS, filesFor, filterTree, fmt, fromFor } from './places.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const PAGE_SIZE = 500;

export function buildApp({ root, LG, createMapView, connection, meter, duckdbVersion }) {
  const params = new URLSearchParams(location.search);
  const built = {
    ready: false,
    grid: null,
    map: null,
    source: null,
    adapter: null,
    city: CITIES.find((c) => c.id === params.get('city')) ?? CITIES[0],
    categories: new Set(),
    groupBy: null,
    matchCount: null,
    files: [],
    sql: [],
    lastQueryMs: null,
    cityBytes: 0,
    duckdbVersion,
  };
  let theme = params.get('theme') === 'dark' ? 'dark' : params.get('theme') === 'light' ? 'light'
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  root.textContent = '';
  root.className = 'app';

  const header = el('header', 'masthead');
  const titleRow = el('div', 'title-row');
  titleRow.append(el('h1', null, 'The lake is the database'));
  const themeButton = el('button', 'theme-toggle');
  themeButton.type = 'button';
  themeButton.dataset.theme = '';
  titleRow.append(themeButton);
  header.append(titleRow);
  header.append(el('p', 'lede',
    `Overture Maps publishes ${fmt.int(MANIFEST.totalRows)} places of interest as ${fmt.bytes(MANIFEST.totalBytes)} of public Parquet. `
    + 'Nothing here is copied or rehosted: DuckDB, running in your browser, queries those files where they sit and reads only the byte ranges '
    + 'your filters need. Pick a place and a category and watch how little of the lake it takes to answer.'));
  root.append(header);

  const controls = el('section', 'controls');
  controls.setAttribute('aria-label', 'Choose what to query');
  root.append(controls);

  const stats = el('section', 'stats');
  stats.setAttribute('aria-label', 'What the query cost');
  root.append(stats);

  const split = el('div', 'split');
  const gridPane = el('section', 'pane grid-pane');
  gridPane.setAttribute('aria-label', 'Matching places');
  const gridHost = el('div', 'grid-host');
  gridPane.append(gridHost);
  const mapPane = el('section', 'pane map-pane');
  mapPane.setAttribute('aria-label', 'Map of the matching places');
  const mapHost = el('div', 'map-host');
  mapPane.append(mapHost);
  split.append(gridPane, mapPane);
  root.append(split);

  const queries = el('details', 'queries');
  queries.dataset.queries = '';
  const summary = el('summary', null, 'What DuckDB ran');
  const queryList = el('ol', 'query-list');
  queryList.dataset.queryList = '';
  queries.append(summary, queryList);
  root.append(queries);

  const footer = el('footer', 'colophon');
  footer.innerHTML = '';
  const credit = el('p', null);
  credit.append(
    'Data: ',
    Object.assign(el('a', null, 'Overture Maps Foundation'), { href: 'https://overturemaps.org/', rel: 'noopener' }),
    ` Places, release ${MANIFEST.release}, read in place from the public bucket. Each place carries its own source licence (CDLA-Permissive-2.0, Apache-2.0 or CC0); attribution per `,
    Object.assign(el('a', null, 'docs.overturemaps.org/attribution'), { href: 'https://docs.overturemaps.org/attribution/', rel: 'noopener' }),
    '. Basemap: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors.',
  );
  footer.append(credit);
  root.append(footer);

  /* ------------------------------------------------------------------ */
  /* Controls                                                            */
  /* ------------------------------------------------------------------ */

  const cityRow = el('div', 'row');
  cityRow.append(el('span', 'row-label', 'Place'));
  const cityGroup = el('div', 'chips');
  cityGroup.setAttribute('role', 'group');
  cityGroup.setAttribute('aria-label', 'Place');
  const cityButtons = new Map();
  for (const city of CITIES) {
    const button = el('button', 'chip', city.label);
    button.type = 'button';
    button.dataset.city = city.id;
    button.title = city.note;
    button.addEventListener('click', () => { void chooseCity(city); });
    cityButtons.set(city.id, button);
    cityGroup.append(button);
  }
  cityRow.append(cityGroup);
  controls.append(cityRow);

  const categoryRow = el('div', 'row');
  categoryRow.append(el('span', 'row-label', 'Category'));
  const categoryGroup = el('div', 'chips');
  categoryGroup.setAttribute('role', 'group');
  categoryGroup.setAttribute('aria-label', 'Category');
  const categoryButtons = new Map();
  for (const category of CATEGORIES) {
    const button = el('button', 'chip', category.label);
    button.type = 'button';
    button.dataset.category = category.id;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      if (built.categories.has(category.id)) built.categories.delete(category.id);
      else built.categories.add(category.id);
      applyFilters();
    });
    categoryButtons.set(category.id, button);
    categoryGroup.append(button);
  }
  const clearButton = el('button', 'chip-clear', 'Clear');
  clearButton.type = 'button';
  clearButton.dataset.clear = '';
  clearButton.addEventListener('click', () => { built.categories.clear(); applyFilters(); });
  categoryGroup.append(clearButton);
  categoryRow.append(categoryGroup);
  controls.append(categoryRow);

  const toolRow = el('div', 'row');
  const searchLabel = el('label', 'row-label', 'Search');
  searchLabel.htmlFor = 'quick-search';
  const search = el('input', 'search');
  search.id = 'quick-search';
  search.type = 'search';
  search.placeholder = 'Name, category, brand or city';
  search.dataset.search = '';
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => built.grid?.filters.quick(search.value), 300);
  });
  const groupLabel = el('label', 'row-label group-label', 'Group by');
  groupLabel.htmlFor = 'group-by';
  const groupSelect = el('select', 'select');
  groupSelect.id = 'group-by';
  groupSelect.dataset.group = '';
  for (const [value, label] of [['', 'No grouping'], ['category', 'Category'], ['brand', 'Brand']]) {
    const option = el('option', null, label);
    option.value = value;
    groupSelect.append(option);
  }
  groupSelect.addEventListener('change', () => setGrouping(groupSelect.value || null));
  toolRow.append(searchLabel, search, groupLabel, groupSelect);
  controls.append(toolRow);

  /* ------------------------------------------------------------------ */
  /* The cost panel                                                      */
  /* ------------------------------------------------------------------ */

  const tile = (id, label, note) => {
    const box = el('div', 'stat');
    box.dataset.stat = id;
    const value = el('div', 'stat-value', '—');
    value.dataset.value = '';
    box.append(el('div', 'stat-label', label), value);
    if (note) box.append(el('div', 'stat-note', note));
    stats.append(box);
    return { box, value };
  };
  const matchTile = tile('matches', 'Places match', 'inside the chosen window');
  const fetchedTile = tile('fetched', 'Fetched from the lake');
  const totalTile = tile('total', 'The whole dataset', `${fmt.int(MANIFEST.totalRows)} places in ${MANIFEST.files.length} files`);
  const timeTile = tile('time', 'Last query', 'DuckDB, in your browser');
  const filesTile = tile('files', 'Files opened', 'the rest are never touched');
  totalTile.value.textContent = fmt.bytes(MANIFEST.totalBytes);
  const meterBar = el('div', 'meter');
  meterBar.setAttribute('role', 'img');
  const meterFill = el('div', 'meter-fill');
  meterBar.append(meterFill);
  fetchedTile.box.append(meterBar);
  const meterNote = el('div', 'stat-note');
  meterNote.dataset.meterNote = '';
  fetchedTile.box.append(meterNote);

  function renderCost() {
    const share = built.cityBytes / MANIFEST.totalBytes;
    fetchedTile.value.textContent = fmt.bytes(built.cityBytes);
    meterFill.style.width = `${Math.max(share * 100, 0.4)}%`;
    const pct = share < 0.0001 ? '<0.01' : (share * 100).toFixed(share < 0.01 ? 2 : 1);
    meterNote.textContent = `${pct}% of the dataset · ${fmt.int(meter.requests)} range requests`;
    meterBar.setAttribute('aria-label', `${fmt.bytes(built.cityBytes)} fetched of ${fmt.bytes(MANIFEST.totalBytes)}`);
    matchTile.value.textContent = built.matchCount == null ? '—' : fmt.int(built.matchCount);
    timeTile.value.textContent = built.lastQueryMs == null ? '—' : `${fmt.int(built.lastQueryMs)} ms`;
    filesTile.value.textContent = `${built.files.length} of ${MANIFEST.files.length}`;
  }
  meter.onChange(() => { built.cityBytes = meter.bytes; renderCost(); });

  function renderQueries() {
    queryList.textContent = '';
    for (const entry of built.sql.slice(-8).reverse()) {
      const item = el('li');
      item.append(el('span', 'q-time', `${fmt.int(entry.ms)} ms · ${fmt.int(entry.rows)} row${entry.rows === 1 ? '' : 's'}`));
      const pre = el('pre', 'q-sql');
      pre.textContent = entry.sql.replace(/\s+/g, ' ').replace(/FROM \(SELECT .*?read_parquet\(\[.*?\]\)\)/, 'FROM places')
        + (entry.params.length ? `\n-- bound: ${JSON.stringify(entry.params, (k, v) => (typeof v === 'bigint' ? Number(v) : v))}` : '');
      item.append(pre);
      queryList.append(item);
    }
  }

  const record = (entry) => {
    built.sql.push(entry);
    if (built.sql.length > 100) built.sql.splice(0, built.sql.length - 100);
    built.lastQueryMs = entry.ms;
    renderCost();
    renderQueries();
  };

  /* ------------------------------------------------------------------ */
  /* The grid and the map                                                */
  /* ------------------------------------------------------------------ */

  function makeSource(files) {
    const adapter = LG.duckdbAdapter({
      connection: recordingConnection(connection, record),
      from: fromFor(files),
      fields: GRID_FIELDS,
      keyField: 'id',
      quickColumns: ['name', 'category', 'brand', 'locality'],
    });
    const source = LG.createPushdownSource({ adapter, compute: LG, pageSize: PAGE_SIZE });
    return { adapter, source };
  }

  function mountGrid() {
    built.map?.destroy?.();
    built.map = null;
    built.grid?.destroy?.();
    gridHost.textContent = '';
    mapHost.textContent = '';
    built.files = filesFor(built.city.bbox);
    built.matchCount = null;
    built.lastQueryMs = null;
    meter.reset();
    built.cityBytes = 0;
    renderCost();

    const { adapter, source } = makeSource(built.files);
    built.adapter = adapter;
    built.source = source;

    const inner = adapter.execute.bind(adapter);
    adapter.execute = async (query, request) => {
      const result = await inner(query, request);
      if (source !== built.source) return result;
      if (typeof result.total === 'number' && !query.groupBy?.length) built.matchCount = result.total;
      built.plan = source.lastPlan?.() ?? null;
      renderCost();
      return result;
    };

    const grid = LG.createGrid(gridHost, {
      rowKey: 'id',
      theme,
      columns: COLUMNS,
      source,
      toolPanel: { side: 'right', panels: ['filters', 'columns'] },
      showTotalInHeader: true,
      groupDefaultExpanded: false,
    });
    built.grid = grid;
    grid.filters.set(filterTree(built.city, built.categories));
    if (built.groupBy) { grid.columns.group([built.groupBy]); void refreshCount(); }
    if (search.value) grid.filters.quick(search.value);

    if (createMapView && window.deck && window.maplibregl) {
      try {
        built.map = createMapView(grid, {
          container: mapHost,
          geometry: { lat: 'lat', lng: 'lon' },
          theme,
          tooltip: ['name', 'category', 'brand'],
          color: { field: 'category' },
          radius: 5,
          radiusUnits: 'pixels',
        });
      } catch (error) {
        console.error('[lake demo] map', error);
        mapHost.append(el('p', 'map-note', `The map could not be drawn: ${error.message}`));
      }
    } else {
      mapHost.append(el('p', 'map-note', 'The map libraries could not be loaded, so only the grid is shown.'));
    }
    return grid;
  }

  function renderChips() {
    for (const [id, button] of cityButtons) {
      const on = id === built.city.id;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const [id, button] of categoryButtons) {
      const on = built.categories.has(id);
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  async function chooseCity(city) {
    if (city.id === built.city.id && built.grid) return;
    built.city = city;
    renderChips();
    mountGrid();
  }

  /** A grouped grid reports its group count, not the match count, so the match is asked for directly. */
  async function refreshCount() {
    const source = built.source;
    const filters = filterTree(built.city, built.categories);
    try {
      const n = await source.countMatching({ filters });
      if (source === built.source) { built.matchCount = n; renderCost(); }
    } catch (error) { console.error('[lake demo] count', error); }
  }

  function applyFilters() {
    renderChips();
    built.grid?.filters.set(filterTree(built.city, built.categories));
    if (built.groupBy) void refreshCount();
  }

  function setGrouping(field) {
    built.groupBy = field;
    built.grid?.columns.group(field ? [field] : []);
    if (field) void refreshCount();
  }

  /* ------------------------------------------------------------------ */
  /* Theme                                                               */
  /* ------------------------------------------------------------------ */

  function renderTheme() {
    document.documentElement.dataset.theme = theme;
    themeButton.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
    themeButton.setAttribute('aria-label', `Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`);
  }
  themeButton.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    renderTheme();
    if (built.grid) mountGrid();
  });
  renderTheme();
  renderChips();
  mountGrid();

  built.destroy = () => { built.map?.destroy?.(); built.grid?.destroy?.(); meter.close?.(); };
  built.chooseCity = chooseCity;
  built.cities = CITIES;
  built.lakeBase = LAKE_BASE;
  return built;
}
