/**
 * The page.
 *
 * The visitor picks a place and some categories. The grid is a source over
 * country-partitioned copy of Overture's Places; every filter, sort, group and
 * search it applies is SQL that DuckDB-Wasm runs against those files, and the
 * cost panel shows what that touched: countries opened, bytes, row groups.
 */

import { MANIFEST } from './manifest.js';
import { DATA_BASE } from './config.js';
import { recordingConnection } from './duckdb.js';
import { megabytes, slot } from './loading.js';
import { CATEGORIES, CITIES, COLUMNS, GRID_FIELDS, MIN_ZOOM, boxOf, filesFor, filterTree, fmt, fromFor, groupsFor, sameBox, shortenSource } from './places.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const PAGE_SIZE = 500;

export function buildApp({ root, LG, createMapView, connection, meter, duckdbVersion, status }) {
  const params = new URLSearchParams(location.search);
  const built = {
    ready: false,
    grid: null,
    map: null,
    source: null,
    adapter: null,
    city: CITIES.find((c) => c.id === params.get('city')) ?? CITIES[0],
    window: null,
    fileKey: '',
    swaps: 0,
    categories: new Set(),
    groupBy: null,
    matchCount: null,
    files: [],
    groups: { total: 0, touched: 0, skipped: 0 },
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
    `Overture Maps publishes ${fmt.int(MANIFEST.totalRows)} places of interest. Here they sit as ${fmt.bytes(MANIFEST.totalBytes)} of Parquet, one folder per country. `
    + 'DuckDB, running in your browser, opens only the countries your map window touches and reads only the byte ranges '
    + 'your filters need. Pan the map, pick a place or a category, and watch how little of the lake it takes to answer.'));
  root.append(header);
  root.append(status.el);

  const controls = el('section', 'controls');
  controls.setAttribute('aria-label', 'Choose what to query');
  root.append(controls);

  const stats = el('section', 'stats');
  stats.setAttribute('aria-label', 'What the query cost');
  const statsSlot = slot(stats, 'Waiting for the first answer, then the cost of the query');
  root.append(statsSlot.el);

  root.append(el('p', 'window-hint', 'Pan anywhere; the lake answers for the window you see.'));

  const split = el('div', 'split');
  const gridPane = el('section', 'pane grid-pane');
  gridPane.setAttribute('aria-label', 'Matching places');
  const gridHost = el('div', 'grid-host');
  const gridSlot = slot(gridHost, 'Waiting for the first rows from the lake');
  gridPane.append(gridSlot.el);
  const mapPane = el('section', 'pane map-pane');
  mapPane.setAttribute('aria-label', 'Map of the matching places');
  const mapHost = el('div', 'map-host');
  const mapSlot = slot(mapHost, 'Waiting for the first rows, then the map');
  mapPane.append(mapSlot.el);
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
    ` Places, release ${MANIFEST.release}, as a country-partitioned Parquet copy. Each place carries its own source licence (CDLA-Permissive-2.0, Apache-2.0 or CC0); attribution per `,
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
    const noteBox = el('div', 'stat-note', note);
    if (note !== undefined) box.append(noteBox);
    stats.append(box);
    return { box, value, note: noteBox };
  };
  const matchTile = tile('matches', 'Places match', 'inside the map’s window');
  const partitionTile = tile('partitions', 'Countries opened', ' ');
  const fetchedTile = tile('fetched', 'Fetched from the lake');
  const totalTile = tile('total', 'The whole copy', `${fmt.int(MANIFEST.totalRows)} places in ${MANIFEST.files.length} files`);
  const timeTile = tile('time', 'Last query', 'DuckDB, in your browser');
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
    meterFill.style.width = `${Math.min(Math.max(share * 100, 0.4), 100)}%`;
    const pct = share < 0.0001 ? '<0.01' : (share * 100).toFixed(share < 0.01 ? 2 : 1);
    meterNote.textContent = `${pct}% of the copy · ${fmt.int(meter.requests)} range requests`;
    meterBar.setAttribute('aria-label', `${fmt.bytes(built.cityBytes)} fetched of ${fmt.bytes(MANIFEST.totalBytes)}`);
    matchTile.value.textContent = built.matchCount == null ? '—' : fmt.int(built.matchCount);
    timeTile.value.textContent = built.lastQueryMs == null ? '—' : `${fmt.int(built.lastQueryMs)} ms`;
    const countries = new Set(built.files.map((f) => f.country)).size;
    partitionTile.value.textContent = `${countries} of ${MANIFEST.countries}`;
    partitionTile.note.textContent = `${built.files.length} file${built.files.length === 1 ? '' : 's'} · `
      + (built.groups.total ? `${fmt.int(built.groups.skipped)} of ${fmt.int(built.groups.total)} row groups skipped` : 'nothing here to read');
  }
  meter.onChange(() => { built.cityBytes = meter.bytes; renderCost(); });

  function renderQueries() {
    queryList.textContent = '';
    for (const entry of built.sql.slice(-8).reverse()) {
      const item = el('li');
      item.append(el('span', 'q-time', `${fmt.int(entry.ms)} ms · ${fmt.int(entry.rows)} row${entry.rows === 1 ? '' : 's'}`));
      const pre = el('pre', 'q-sql');
      pre.textContent = shortenSource(entry.sql.replace(/\s+/g, ' '))
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

  /* Every panel is covered, and the status line counts the bytes read, until the first rows are back. */
  let loadingStatus = null;
  function showLoading() {
    for (const covered of [statsSlot, gridSlot, mapSlot]) covered.show();
    const total = built.files.reduce((n, f) => n + f.bytes, 0);
    const countries = new Set(built.files.map((f) => f.country)).size;
    const line = () => {
      if (total === 0) return [`Nothing in the lake sits inside this window`, null];
      /* Only the data files count here; the Parquet reader the engine fetches on first use is said separately. */
      const read = meter.log.filter((e) => /\.parquet$/.test(e.url)).reduce((n, e) => n + (e.status >= 200 && e.status < 300 ? e.bytes : 0), 0);
      if (!read && meter.log.length) return ['Fetching the engine’s Parquet reader (about 3 MB, first visit only)', null];
      return [`Reading the manifest and the ${countries} country partition${countries === 1 ? '' : 's'} this window opens (${megabytes(read)} of up to ${megabytes(total)})`, Math.min(1, read / total)];
    };
    loadingStatus?.();
    status.show();
    status.set(...line());
    loadingStatus = meter.onChange(() => status.set(...line()));
  }
  function hideLoading() {
    loadingStatus?.();
    loadingStatus = null;
    status.hide();
    for (const covered of [statsSlot, gridSlot, mapSlot]) covered.hide();
  }

  /** Wrap the adapter so the page learns when a query is answered; a source the page has since replaced is ignored. */
  function instrument(adapter, source) {
    const inner = adapter.execute.bind(adapter);
    adapter.execute = async (query, request) => {
      let result;
      try { result = await inner(query, request); } catch (error) {
        if (source === built.source) { status.set('The lake could not be read. Pan somewhere else.'); gridSlot.show('The lake could not be read'); }
        throw error;
      }
      if (source !== built.source) return result;
      hideLoading();
      if (typeof result.total === 'number' && !query.groupBy?.length) built.matchCount = result.total;
      built.plan = source.lastPlan?.() ?? null;
      renderCost();
      return result;
    };
  }

  const keyOfFiles = (files) => files.map((f) => f.file).join('|');

  /** The window changed: the files it opens and the row groups it can touch are worked out again, and the byte count starts over. */
  function setWindow(box) {
    built.window = box;
    built.files = filesFor(box);
    built.groups = groupsFor(built.files, box);
    meter.reset();
    built.cityBytes = 0;
    built.lastQueryMs = null;
    renderCost();
    renderChips();
  }

  /** Only when the window opens a different set of partition files does the grid get a new source; its sort, grouping, search and filters stay. */
  function followWindow() {
    const grid = built.grid;
    if (!grid) return;
    const box = boxOf(grid.filters.get());
    if (!box || sameBox(box, built.window)) return;
    setWindow(box);
    const key = keyOfFiles(built.files);
    if (key === built.fileKey) return;
    built.fileKey = key;
    const { adapter, source } = makeSource(built.files);
    built.adapter = adapter;
    built.source = source;
    instrument(adapter, source);
    built.swaps += 1;
    grid.set('source', source);
  }

  /** Zoom at which a box fills the map pane, never closer than the lake guard allows out. */
  function zoomFor(box, width, height) {
    const lonSpan = (box.xmax - box.xmin) / 360;
    const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const latSpan = (mercY(box.ymax) - mercY(box.ymin)) / (2 * Math.PI);
    const zoom = Math.log2(Math.min(width / (512 * lonSpan), height / (512 * latSpan)));
    return Math.min(Math.max(zoom, MIN_ZOOM), 16);
  }

  function mountGrid() {
    built.map?.destroy?.();
    built.map = null;
    built.grid?.destroy?.();
    gridHost.textContent = '';
    mapHost.textContent = '';
    const box = built.window ?? built.city.bbox;
    built.files = filesFor(box);
    built.fileKey = keyOfFiles(built.files);
    built.window = box;
    built.groups = groupsFor(built.files, box);
    built.matchCount = null;
    built.lastQueryMs = null;
    meter.reset();
    built.cityBytes = 0;
    renderCost();
    renderChips();
    showLoading();

    const { adapter, source } = makeSource(built.files);
    built.adapter = adapter;
    built.source = source;
    instrument(adapter, source);

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
    grid.filters.set(filterTree(box, built.categories));
    if (built.groupBy) { grid.columns.group([built.groupBy]); void refreshCount(); }
    if (search.value) grid.filters.quick(search.value);
    /* Before the grid queries for a new window, the source is changed if the window opens other files. */
    grid.on('beforeFilter', () => { queueMicrotask(followWindow); });
    grid.on('filter:changed', () => { followWindow(); });

    if (createMapView && window.deck && window.maplibregl) {
      try {
        const rect = mapHost.getBoundingClientRect();
        built.map = createMapView(grid, {
          container: mapHost,
          geometry: { lat: 'lat', lng: 'lon' },
          theme,
          tooltip: ['name', 'category', 'brand'],
          color: { field: 'category' },
          radius: 5,
          radiusUnits: 'pixels',
          view: {
            center: [(box.xmin + box.xmax) / 2, (box.ymin + box.ymax) / 2],
            zoom: zoomFor(box, rect.width || 600, rect.height || 500),
          },
          viewportFilter: true,
        });
        /* A demo decision, not a workaround: a window is never wider than a metro area, so the whole copy cannot be reached by zooming out. */
        built.map.getMap?.()?.setMinZoom(MIN_ZOOM);
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
      const city = CITIES.find((c) => c.id === id);
      const on = sameBox(built.window, city.bbox, 0.01);
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const [id, button] of categoryButtons) {
      const on = built.categories.has(id);
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  /** A place is a shortcut: its box becomes the grid's window, the map flies there and owns the window from then on. */
  async function chooseCity(city) {
    built.city = city;
    built.grid?.filters.set(filterTree(city.bbox, built.categories));
    if (!built.grid) mountGrid();
  }

  /** The window the grid holds right now: the map's, or the box a place chip wrote. */
  const currentBox = () => boxOf(built.grid?.filters.get()) ?? built.window;

  /** A grouped grid reports its group count, not the match count, so the match is asked for directly. */
  async function refreshCount() {
    const source = built.source;
    const filters = built.grid?.filters.get() ?? filterTree(currentBox(), built.categories);
    try {
      const n = await source.countMatching({ filters });
      if (source === built.source) { built.matchCount = n; renderCost(); }
    } catch (error) { console.error('[lake demo] count', error); }
  }

  /** The category chips change the categories only: the window is read back from the grid, never from a place. */
  function applyFilters() {
    renderChips();
    built.grid?.filters.set(filterTree(currentBox(), built.categories));
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
  built.meter = meter;
  built.cities = CITIES;
  built.dataBase = DATA_BASE;
  built.manifest = MANIFEST;
  return built;
}
