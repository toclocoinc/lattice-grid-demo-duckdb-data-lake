/**
 * Load the demo in headless Chrome and check that it tells the truth.
 *
 * It opens the page on one small window (Reykjavík's old town), then drives it
 * with real mouse, keyboard and DOM events and compares what is on screen with
 * the same questions asked of a second DuckDB, in Node, over the same files:
 *
 *   - the match count and the first rows for the window;
 *   - a category chip, which must narrow the count and every row it shows;
 *   - the quick search, a sort, and a group by category and by brand;
 *   - the byte counter: some bytes were fetched, a small share of the dataset;
 *   - the map drives the window: a real pointer drag on the map changes the match count and, across a
 *     border, the countries opened; the map cannot be zoomed out to a window wider than a metro area;
 *     a place chip is a shortcut for a window and a category chip never moves it;
 *   - the map drew the rows the grid holds; the theme switch repaints;
 *   - no console errors, no NaN/undefined text, no watermark.
 *
 * Where the data comes from (always the page's `?data=local`, through tools/serve.mjs):
 *
 *   node tools/verify.mjs               the recording in test/recorded/ (no data needed; what CI runs)
 *   node tools/verify.mjs --local [dir] a local build from tools/build-partitioned.mjs (default data/lake)
 *   node tools/verify.mjs --record [dir] the same, and rewrite test/recorded/ and test/expected.json; also
 *                                       checks the copy against the Overture release itself (network)
 *   node tools/verify.mjs --record --from <cdn url>
 *                                       the same, with the reads fetched from the copy on the CDN instead of
 *                                       a local build, and the expected answers asked of the same files
 *   node tools/verify.mjs --shots dir   also write screenshots (--width 390 for a phone)
 *
 * The page's own libraries (DuckDB-Wasm, deck.gl, MapLibre) always come from
 * jsDelivr, so the recorded run still needs those, but no data.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { CATEGORIES, CITIES, MIN_ZOOM, filesFor } from '../src/places.js';
import { MANIFEST } from '../src/manifest.js';

/* Count distinct colours in a PNG (8-bit RGB/RGBA, non-interlaced): a blank grey box has one or two. */
function distinctColours(png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20), type = png[25];
  const bpp = type === 6 ? 4 : 3;
  const chunks = [];
  for (let i = 8; i < png.length;) { const len = png.readUInt32BE(i); if (png.toString('latin1', i + 4, i + 8) === 'IDAT') chunks.push(png.subarray(i + 8, i + 8 + len)); i += 12 + len; }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = w * bpp;
  let prev = Buffer.alloc(stride);
  const seen = new Set();
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 255;
    }
    for (let x = 0; x < w; x += 2) seen.add(line.readUIntBE(x * bpp, 3) >> 3);
    prev = line;
  }
  return seen.size;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const dirIndex = Math.max(args.indexOf('--local'), args.indexOf('--record'));
const LOCAL_DIR = resolve(dirIndex >= 0 && args[dirIndex + 1] && !args[dirIndex + 1].startsWith('--') ? args[dirIndex + 1] : join(root, 'data', 'lake'));
const fromIndex = args.indexOf('--from');
const FROM = fromIndex >= 0 ? args[fromIndex + 1] : null;
const RELEASE = '2026-09-23.1';
const EXPECTED_FILE = join(root, 'test', 'expected.json');

const TARGET = CITIES.find((c) => c.id === 'reykjavik');
const CHIP = CATEGORIES.find((c) => c.id === 'restaurant');
const SEARCH = 'hotel';
/** West of the Detroit River, a window about 0.4 degrees wide: dragging it east brings Windsor (Canada) in. */
const DRAG_START = { xmin: -83.60, xmax: -83.22, ymin: 42.20, ymax: 42.45 };
const DRAG_CATEGORY = CATEGORIES.find((c) => c.id === 'restaurant');
const inBox = (b) => `lon BETWEEN ${b.xmin} AND ${b.xmax} AND lat BETWEEN ${b.ymin} AND ${b.ymax}`;
/** Asks the independent DuckDB how many places of the category lie in a box; set by nodeAnswers. */
let askBox = null;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const failures = [];
const notes = [];
function check(ok, description, detail) {
  const line = `${description}${detail ? ` (${detail})` : ''}`;
  if (ok) notes.push(`  ok   ${line}`); else { failures.push(line); notes.push(`  FAIL ${line}`); }
  console.log(notes.at(-1));
}
const dragNote = (before, after) => `Detroit window ${before.tile} -> ${after.tile}; ${int(before.n)} -> ${int(after.n)} restaurants; fetched for the moved window ${(after.fetched / 1e6).toFixed(2)} MB`;
const int = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

async function findChrome() {
  for (const path of CHROME_CANDIDATES) { try { await access(path); return path; } catch { /* next */ } }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH.`);
}

/* ------------------------------------------------------------------ */
/* The independent answer: a second DuckDB, in Node                    */
/* ------------------------------------------------------------------ */

/**
 * Questions about the window, asked of `from` (a table expression with the page's columns).
 * The files are found by reading them, not from the manifest, so the manifest is checked too.
 */
async function answersOver(conn, from, extra = '') {
  const b = TARGET.bbox;
  const inBox = `lon BETWEEN ${b.xmin} AND ${b.xmax} AND lat BETWEEN ${b.ymin} AND ${b.ymax}`;
  const view = `(SELECT name, category, brand, locality${extra} FROM ${from} WHERE ${inBox})`;
  const rows = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
  const one = async (sql) => Number(Object.values((await rows(sql))[0])[0]);
  const cats = CHIP.values.map((v) => `'${v}'`).join(', ');
  const like = `%${SEARCH}%`;
  return {
    total: await one(`SELECT count(*) FROM ${view}`),
    chip: await one(`SELECT count(*) FROM ${view} WHERE category IN (${cats})`),
    search: await one(`SELECT count(*) FROM ${view} WHERE name ILIKE '${like}' OR category ILIKE '${like}' OR brand ILIKE '${like}' OR locality ILIKE '${like}'`),
    categories: await one(`SELECT count(DISTINCT category) FROM ${view}`),
    brands: await one(`SELECT count(DISTINCT brand) FROM ${view}`),
    firstGroups: {
      category: (await rows(`SELECT category AS k, count(*) AS n FROM ${view} WHERE category IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 3`)).map((r) => ({ key: r.k, n: Number(r.n) })),
      brand: (await rows(`SELECT brand AS k, count(*) AS n FROM ${view} WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 3`)).map((r) => ({ key: r.k, n: Number(r.n) })),
    },
    firstByName: (await rows(`SELECT name FROM ${view} ORDER BY name ASC NULLS LAST LIMIT 3`)).map((r) => r.name),
  };
}

/** The independent answer: a second DuckDB, in Node, over the local build (and, when recording, over the release itself). */
async function nodeAnswers({ againstRelease }) {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const db = await DuckDBInstance.create(':memory:');
  const conn = await db.connect();
  const b = TARGET.bbox;
  let local;
  if (FROM) {
    /* The copy on the CDN, read over HTTPS by Node's DuckDB: every file whose whole-file extent meets one of the windows (the manifest's row groups are not trusted here). */
    await conn.run('INSTALL httpfs; LOAD httpfs;');
    const windows = [TARGET.bbox, CITIES.find((c) => c.id === 'paris').bbox, DRAG_START, { ...DRAG_START, xmin: DRAG_START.xmin + 0.5, xmax: DRAG_START.xmax + 0.5 }];
    const meetsFile = (f, w) => f.xmin <= w.xmax && f.xmax >= w.xmin && f.ymin <= w.ymax && f.ymax >= w.ymin;
    const urls = MANIFEST.files.filter((f) => windows.some((w) => meetsFile(f, w))).map((f) => `'${new URL(f.file, FROM).href}'`);
    local = `read_parquet([${urls.join(', ')}], hive_partitioning = true, hive_types = {'country': VARCHAR})`;
  } else {
    const glob = join(LOCAL_DIR, 'country=*', '*.parquet').replaceAll("'", "''");
    local = `read_parquet('${glob}', hive_partitioning = true, hive_types = {'country': VARCHAR})`;
  }
  askBox = async (box, category) => {
    const cats = category.values.map((v) => `'${v}'`).join(', ');
    const n = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ${local} WHERE ${inBox(box)} AND category IN (${cats})`)).getRowObjectsJson()[0].n);
    const holding = (await conn.runAndReadAll(`SELECT DISTINCT country FROM ${local} WHERE ${inBox(box)} ORDER BY 1`)).getRowObjectsJson().map((r) => r.country);
    return { box, restaurants: n, countriesWithRows: holding };
  };
  const answers = await answersOver(conn, local);
  const holding = (await conn.runAndReadAll(`
    SELECT DISTINCT country FROM ${local} WHERE lon BETWEEN ${b.xmin} AND ${b.xmax} AND lat BETWEEN ${b.ymin} AND ${b.ymax} ORDER BY 1`)).getRowObjectsJson().map((r) => r.country);
  const other = CITIES.find((c) => c.id === 'paris').bbox;
  const otherPlace = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ${local} WHERE lon BETWEEN ${other.xmin} AND ${other.xmax} AND lat BETWEEN ${other.ymin} AND ${other.ymax}`)).getRowObjectsJson()[0].n);
  const result = { release: RELEASE, countriesWithRows: holding, otherPlace, ...answers, dragStart: await askBox(DRAG_START, DRAG_CATEGORY) };
  if (againstRelease) {
    /* The copy must hold exactly what the release holds for this window. */
    await conn.run("INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';");
    const source = `read_parquet('s3://overturemaps-us-west-2/release/${RELEASE}/theme=places/type=place/*.parquet')`;
    const fromRelease = `(SELECT names."primary" AS name, taxonomy."primary" AS category, brand.names."primary" AS brand, addresses[1].locality AS locality, bbox.xmin AS lon, bbox.ymin AS lat FROM ${source} WHERE bbox.xmin BETWEEN ${b.xmin} AND ${b.xmax} AND bbox.ymin BETWEEN ${b.ymin} AND ${b.ymax})`;
    const truth = await answersOver(conn, fromRelease);
    check(JSON.stringify(truth) === JSON.stringify(answers), 'the local copy answers every question as the Overture release itself does', `${int(answers.total)} places in the window`);
  }
  return result;
}

/* ------------------------------------------------------------------ */

let browser; let browserPid; let profile; let served;
async function shutdown() {
  if (browserPid) { try { process.kill(-browserPid, 'SIGKILL'); } catch { /* gone */ } try { browser?.kill('SIGKILL'); } catch { /* gone */ } }
  served?.server?.close();
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
const freePort = () => import('node:net').then(({ createServer }) => new Promise((ok, fail) => {
  const probe = createServer(); probe.on('error', fail);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => ok(port)); });
}));

async function run() {
  if (typeof WebSocket === 'undefined') throw new Error(`This check needs Node 22 or newer. You are on ${process.version}.`);
  const chromePath = await findChrome();

  const record = flag('--record');
  const mode = record ? 'record' : (flag('--local') || FROM ? 'local' : 'replay');
  console.log(`Data: ${mode === 'replay' ? 'the recording in test/recorded/ (no data needed)' : `${LOCAL_DIR}${record ? ', recording to test/recorded/' : ''}`}`);

  /* The page always reads through /lake/ (?data=local); the server answers from the build or the recording. */
  served = await startServer(0, { lake: mode, dir: LOCAL_DIR, from: FROM });
  if (mode === 'replay' && !served.hasRecording()) throw new Error('There is no recording. Run `node tools/verify.mjs --record` once with a local build.');
  const origin = `http://127.0.0.1:${served.port}`;
  const query = new URLSearchParams({ city: TARGET.id, theme: 'light', data: 'local' });
  const pageUrl = `${origin}/?${query}`;

  let expected;
  if (mode === 'replay') expected = JSON.parse(await readFile(EXPECTED_FILE, 'utf8'));
  else {
    expected = await nodeAnswers({ againstRelease: record });
    if (record) { await mkdir(dirname(EXPECTED_FILE), { recursive: true }); await writeFile(EXPECTED_FILE, `${JSON.stringify(expected, null, 1)}\n`); }
  }
  console.log(`Expected for ${TARGET.label}: ${JSON.stringify(expected)}`);
  check(expected.release === RELEASE, 'the expectation is for the release the copy was built from', expected.release);

  profile = await mkdtemp(join(tmpdir(), 'lake-verify-'));
  const port = await freePort();
  const widthIndex = args.indexOf('--width');
  const VIEWPORT = { width: widthIndex >= 0 ? Number(args[widthIndex + 1]) : 1440, height: 1000 };
  browser = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl; } catch { /* not up */ }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');
  const socket = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = () => fail(new Error('could not attach to the browser')); });

  let nextId = 0; const pending = new Map(); const consoleErrors = []; const pageErrors = [];
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id != null && pending.has(m.id)) {
      const { resolve: ok, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else ok(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, reject) => { const id = ++nextId; pending.set(id, { resolve: ok, reject }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression, ms = 30000) => {
    const result = await Promise.race([
      call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => { throw new Error('the page did not answer in time'); }),
    ]);
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    return result.result.value;
  };
  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { try { if (await evaluate(expression, 15000)) return true; } catch { /* busy */ } await sleep(400); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
  };

  /* Real input: a mouse click at the centre of an element, keys, typed text. */
  const centre = (selector, text) => evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = ${text ? `nodes.find((n) => n.textContent.trim() === ${JSON.stringify(text)})` : 'nodes[0]'};
    if (!node) return null;
    node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const click = async (selector, text) => {
    const at = await centre(selector, text);
    if (!at) throw new Error(`nothing to click: ${selector} ${text ?? ''}`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  };
  const typeText = async (text) => { await call('Input.insertText', { text }); };

  const settle = (what) => waitFor(
    'window.__lakeDemo.grid && window.__lakeDemo.matchCount != null && window.__lakeDemo.grid.rows.count() >= 0 && !document.querySelector(".lattice [aria-busy=true]")',
    120000, what,
  );
  const sample = () => evaluate(`(() => {
    const d = window.__lakeDemo;
    const rows = d.grid.rows.getAll ? d.grid.rows.getAll() : [];
    return {
      match: d.matchCount,
      shown: d.grid.rows.count(),
      first: (d.grid.rows.getAll ? d.grid.rows.getAll() : []).slice(0, 5).map((r) => r.data ?? r),
      statMatch: document.querySelector('[data-stat=matches] [data-value]').textContent,
      fetched: d.cityBytes,
      files: d.files.length,
    };
  })()`);

  /* -------------------------------------------------------------- */
  /* Open it                                                         */
  /* -------------------------------------------------------------- */
  await call('Page.navigate', { url: pageUrl });
  await waitFor('!!window.__lakeDemo', 240000, 'the page to report in');
  const boot = await evaluate('({ ready: window.__lakeDemo.ready, error: window.__lakeDemo.error || null })');
  if (!boot.ready) throw new Error(`the page reported a failure: ${boot.error}`);
  await waitFor('window.__lakeDemo.grid.rows.count() > 0 && window.__lakeDemo.matchCount != null', 120000, 'the first rows');
  await sleep(1500);

  /* The row API name is not assumed: ask the grid what it holds. */
  const rowApi = await evaluate('Object.keys(Object.getPrototypeOf(window.__lakeDemo.grid.rows)).concat(Object.keys(window.__lakeDemo.grid.rows)).join(",")');
  console.log(`rows API: ${rowApi}`);

  const readRows = (n = 5) => evaluate(`(() => {
    const g = window.__lakeDemo.grid; const out = [];
    const count = g.rows.count();
    for (let i = 0; i < Math.min(${n}, count); i += 1) { const r = g.rows.at ? g.rows.at(i) : g.rows.get(i); out.push(r && r.data ? r.data : r); }
    return out;
  })()`);

  let s = await evaluate(`({ match: window.__lakeDemo.matchCount, shown: window.__lakeDemo.grid.rows.count(), stat: document.querySelector('[data-stat=matches] [data-value]').textContent })`);
  check(s.match === expected.total, `${TARGET.label}: the grid's match count is the lake's`, `${int(s.match)} vs ${int(expected.total)}`);
  check(s.stat === int(expected.total), 'the match tile shows it', s.stat);
  let rows = await readRows();
  check(rows.length > 0 && rows.every((r) => r.lon >= TARGET.bbox.xmin && r.lon <= TARGET.bbox.xmax && r.lat >= TARGET.bbox.ymin && r.lat <= TARGET.bbox.ymax),
    'the first rows all lie inside the window', rows.slice(0, 2).map((r) => r.name).join(' | '));

  const cost = await evaluate(`(() => { const d = window.__lakeDemo; return {
    bytes: d.cityBytes, opened: d.files.map((f) => f.country), files: d.files.length, total: d.manifest.totalBytes, countries: d.manifest.countries,
    groups: d.groups, tile: document.querySelector('[data-stat=partitions] [data-value]').textContent,
    tileNote: document.querySelector('[data-stat=partitions] .stat-note').textContent,
    whole: document.querySelector('[data-stat=total] [data-value]').textContent,
  }; })()`);
  check(expected.countriesWithRows.every((c) => cost.opened.includes(c)), 'the manifest led the page to every country that holds places in the window', `${expected.countriesWithRows.join(',')} in ${cost.opened.join(',')}`);
  check(cost.files >= 1 && cost.opened.length < cost.countries * 2 && new Set(cost.opened).size < cost.countries, 'only the partitions that can hold the window were opened', `${new Set(cost.opened).size} of ${cost.countries} countries`);
  check(cost.tile === `${new Set(cost.opened).size} of ${cost.countries}` && /row groups skipped/.test(cost.tileNote), 'the cost panel says so', `${cost.tile}; ${cost.tileNote}`);
  check(cost.groups.total > 0 && cost.groups.touched > 0 && cost.groups.skipped >= 0, 'row groups are counted from the footers\' extents', JSON.stringify(cost.groups));
  check(cost.bytes > 0 && Number.isFinite(cost.total) && cost.total > 0, 'bytes were fetched, against the size of the whole copy', `${(cost.bytes / 1e6).toFixed(2)} MB of ${(cost.total / 1e6).toFixed(2)} MB`);
  const requestsSeen = await evaluate('document.querySelector("[data-meter-note]").textContent');
  check(/range requests/.test(requestsSeen) && !/NaN|undefined/.test(requestsSeen), 'the counter reads', requestsSeen);
  const queryText = await evaluate('document.querySelector(".stat[data-stat=time] [data-value]").textContent');
  check(/^[\d,]+ ms$/.test(queryText), 'a live query time is shown', queryText);
  const timing = await evaluate('({ boot: window.__lakeDemo.bootMs, query: window.__lakeDemo.lastQueryMs })');
  console.log(`TIMING cold start (page to first rows): ${timing.boot} ms; last query: ${timing.query} ms`);
  await shoot('01-open');

  const map = await evaluate('(() => { const p = window.__lakeDemo.map && window.__lakeDemo.map.provenance(); return p ? { drawn: p.drawn, rows: window.__lakeDemo.grid.rows.count() } : null; })()');
  check(map && map.drawn > 0 && map.drawn <= map.rows, 'the map draws the rows the grid holds', map ? `${map.drawn} of ${map.rows}` : 'no map');
  /* Pixels, not provenance: the basemap and points must really be on the canvas. */
  const box = await evaluate('(() => { const e = document.querySelector(".map-host"); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const c = e.querySelector("canvas"); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, canvas: c ? c.clientWidth * c.clientHeight : 0, covered: !!document.querySelector(".map-pane .panel-loading:not([hidden])") }; })()');
  check(box.width > 200 && box.height > 200 && box.canvas > 0 && !box.covered, 'the map pane has a size, a canvas and no loading cover', JSON.stringify(box));
  let colours = 0;
  for (let attempt = 0; attempt < 15 && colours < 12; attempt += 1) {
    const { data } = await call('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
    colours = distinctColours(Buffer.from(data, 'base64'));
    if (colours < 12) await sleep(1000);
  }
  check(colours >= 12, 'the map canvas shows a drawn basemap and points, not a blank box', `${colours} distinct colours`);

  /* -------------------------------------------------------------- */
  /* The lake guard: the map cannot be zoomed out to the whole copy  */
  /* -------------------------------------------------------------- */
  const windowNow = () => evaluate('JSON.stringify(window.__lakeDemo.window)').then(JSON.parse);
  await evaluate('(window.__lakeDemo.map.getMap().setZoom(1), 1)');
  await waitFor(`window.__lakeDemo.window.xmax - window.__lakeDemo.window.xmin > 0.25 && window.__lakeDemo.matchCount != null`, 120000, 'the widest window the map allows');
  await sleep(1500);
  const widest = await evaluate(`({ zoom: window.__lakeDemo.map.getMap().getZoom(), minZoom: window.__lakeDemo.map.getMap().getMinZoom(), w: window.__lakeDemo.window, files: window.__lakeDemo.files.length, bytes: window.__lakeDemo.cityBytes, total: window.__lakeDemo.manifest.totalBytes, hint: document.querySelector('.window-hint')?.textContent })`);
  check(widest.minZoom === MIN_ZOOM && widest.zoom >= MIN_ZOOM, `Zooming all the way out stops at zoom ${MIN_ZOOM}`, `zoom ${widest.zoom.toFixed(2)}`);
  check(widest.w.xmax - widest.w.xmin < 2 && widest.bytes < widest.total / 50, 'the widest window is a metro area and the lake is not read wholesale', `${(widest.w.xmax - widest.w.xmin).toFixed(2)}° wide, ${(widest.bytes / 1e6).toFixed(1)} MB of ${(widest.total / 1e9).toFixed(2)} GB`);
  check(widest.hint === 'Pan anywhere; the lake answers for the window you see.', 'the page says so in one sentence', widest.hint);
  /* What a place chip does, from the page's own code path: the box becomes the window, the categories stay. */
  const goTo = (box, categories = []) => evaluate(`(() => { const b = ${JSON.stringify(box)}; const values = ${JSON.stringify(categories)};
    window.__lakeDemo.grid.filters.set({ op: 'and', conditions: [{ col: 'lon', op: 'between', value: [b.xmin, b.xmax] }, { col: 'lat', op: 'between', value: [b.ymin, b.ymax] },
      ...(values.length ? [{ col: 'category', op: 'in', value: values }] : [])] }); return 1; })()`);
  await goTo(TARGET.bbox);
  await waitFor(`window.__lakeDemo.window.xmax === ${TARGET.bbox.xmax} && window.__lakeDemo.matchCount === ${expected.total}`, 120000, 'the first window again');
  await sleep(1500);

  /* -------------------------------------------------------------- */
  /* Category chip                                                   */
  /* -------------------------------------------------------------- */
  const beforeBytes = cost.bytes;
  await click('[data-category]', CHIP.label);
  await waitFor(`window.__lakeDemo.matchCount === ${expected.chip}`, 120000, 'the category count');
  await sleep(1500);
  s = await evaluate('({ match: window.__lakeDemo.matchCount, pressed: document.querySelector("[data-category=restaurant]").getAttribute("aria-pressed") })');
  check(s.match === expected.chip && expected.chip < expected.total, `${CHIP.label}: the count is the lake's and narrower`, `${int(s.match)} of ${int(expected.total)}`);
  check(s.pressed === 'true', 'the chip reports pressed');
  rows = await readRows();
  check(rows.length > 0 && rows.every((r) => CHIP.values.includes(r.category)), 'every row shown is in the category', rows.slice(0, 2).map((r) => `${r.name} (${r.category})`).join(' | '));
  await shoot('02-restaurants');
  await click('[data-clear]');
  await waitFor(`window.__lakeDemo.matchCount === ${expected.total}`, 120000, 'the cleared count');

  /* -------------------------------------------------------------- */
  /* Quick search                                                    */
  /* -------------------------------------------------------------- */
  await click('[data-search]');
  await typeText(SEARCH);
  await waitFor(`window.__lakeDemo.matchCount === ${expected.search}`, 120000, 'the search count');
  await sleep(1200);
  s = await evaluate('({ match: window.__lakeDemo.matchCount })');
  check(s.match === expected.search && expected.search < expected.total, `Search "${SEARCH}": the count is the lake's`, `${int(s.match)} of ${int(expected.total)}`);
  rows = await readRows();
  check(rows.length > 0 && rows.every((r) => [r.name, r.category, r.brand, r.locality].some((v) => String(v ?? '').toLowerCase().includes(SEARCH))), 'every row shown contains the search text', rows.slice(0, 2).map((r) => r.name).join(' | '));
  await shoot('03-search');
  await evaluate('(() => { const i = document.querySelector("[data-search]"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await waitFor(`window.__lakeDemo.matchCount === ${expected.total}`, 120000, 'the cleared search');

  /* -------------------------------------------------------------- */
  /* Sort                                                            */
  /* -------------------------------------------------------------- */
  await click('.lattice [role=columnheader]', 'Name');
  await waitFor(`(() => { const g = window.__lakeDemo.grid; const r = g.rows.at ? g.rows.at(0) : g.rows.get(0); const d = r && r.data ? r.data : r; return d && d.name === ${JSON.stringify(expected.firstByName[0])}; })()`, 120000, 'the sorted first row').catch(() => {});
  rows = await readRows(3);
  check(JSON.stringify(rows.map((r) => r.name)) === JSON.stringify(expected.firstByName), 'Sort by name: the first rows are the lake\'s', rows.map((r) => r.name).join(' | '));
  await shoot('04-sorted');

  /* -------------------------------------------------------------- */
  /* Grouping                                                        */
  /* -------------------------------------------------------------- */
  const groupBy = async (field, expectedGroups, label) => {
    await evaluate(`(() => { const s = document.querySelector('[data-group]'); s.focus(); s.value = ${JSON.stringify(field)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    /* Settled: no placeholder rows left, and the row count has stopped moving. */
    let last = -1; let steady = 0;
    const until = Date.now() + 120000;
    while (Date.now() < until && steady < 4) {
      const now = await evaluate(`(() => ({ n: window.__lakeDemo.grid.rows.count(), loading: /Loading rows/.test(document.querySelector('.lattice').innerText) }))()`);
      steady = (now.n === last && !now.loading) ? steady + 1 : 0;
      last = now.n;
      await sleep(700);
    }
    const g = await evaluate(`(() => ({ rows: window.__lakeDemo.grid.rows.count(), match: window.__lakeDemo.matchCount, text: [...document.querySelectorAll('.lattice [role=row]')].slice(0, 40).map((r) => r.textContent.trim().replace(/\\s+/g, ' ')) }))()`);
    return g;
  };
  const headings = (g, expectedGroups) => {
    /* The group rows on screen, as text: "<key> (<count>)", in order. */
    const squash = (t) => t.replace(/\s+/g, '');
    const shown = squash(g.text.join('\n'));
    let at = -1;
    return expectedGroups.every(({ key, n }) => {
      const found = shown.indexOf(squash(`${key}(${n})`), at + 1);
      if (found < 0) return false;
      at = found;
      return true;
    });
  };
  let g = await groupBy('category', expected.categories, 'category');
  check(headings(g, expected.firstGroups.category), 'Group by category: the first groups and their counts are the lake\'s',
    expected.firstGroups.category.map((x) => `${x.key} (${x.n})`).join(', '));
  check(g.match === expected.total, 'grouping does not change the match count', int(g.match));
  await shoot('05-grouped-category');
  g = await groupBy('brand', expected.brands, 'brand');
  check(headings(g, expected.firstGroups.brand), 'Group by brand: the first groups and their counts are the lake\'s',
    expected.firstGroups.brand.map((x) => `${x.key} (${x.n})`).join(', '));
  await shoot('06-grouped-brand');
  await groupBy('', 0, 'none');
  await waitFor('window.__lakeDemo.grid.rows.count() > 0', 60000, 'rows back');

  /* -------------------------------------------------------------- */
  /* The theme, then a place the copy may not hold                   */
  /* -------------------------------------------------------------- */
  await click('button[data-theme]');
  await sleep(1500);
  const theme = await evaluate('({ attr: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor })');
  check(theme.attr === 'dark' && theme.bg !== 'rgb(255, 255, 255)', 'the theme switch repaints the page', `${theme.attr} ${theme.bg}`);
  await waitFor('window.__lakeDemo && window.__lakeDemo.grid && window.__lakeDemo.grid.rows.count() > 0', 120000, 'rows after the theme switch').catch(() => {});
  await sleep(2000);
  await shoot('08-dark');

  /* A place with no partition in this copy (the small test build) opens nothing and says so; with a full copy it reads. */
  const other = CITIES.find((c) => c.id === 'paris');
  await click('[data-city]', other.label);
  await waitFor(`window.__lakeDemo.window.xmin === ${other.bbox.xmin} && window.__lakeDemo.matchCount === ${expected.otherPlace}`, 120000, 'the second place').catch(() => {});
  await sleep(1500);
  const second = await evaluate(`({ n: window.__lakeDemo.matchCount, tile: document.querySelector('[data-stat=partitions] [data-value]').textContent })`);
  check(second.n === expected.otherPlace, `${other.label}: the count is the copy's (${int(expected.otherPlace)})`, `${int(second.n)}; countries opened: ${second.tile}`);
  await shoot('09-other-place');
  const parisState = await evaluate(`(() => { const d = window.__lakeDemo; const m = d.map.getMap();
    return { win: d.window, centre: m.getCenter(), pressed: [...document.querySelectorAll('[data-city][aria-pressed=true]')].map((b) => b.dataset.city) }; })()`);
  check(Math.abs(parisState.win.xmin - other.bbox.xmin) < 1e-9 && Math.abs(parisState.win.ymax - other.bbox.ymax) < 1e-9, `${other.label}: the chip wrote its box as the grid's window`, JSON.stringify(parisState.win));
  check(parisState.pressed.join() === 'paris' && parisState.centre.lng > other.bbox.xmin && parisState.centre.lng < other.bbox.xmax && parisState.centre.lat > other.bbox.ymin && parisState.centre.lat < other.bbox.ymax,
    'the chip shows pressed and the map flew there', `${parisState.pressed.join()} at ${parisState.centre.lng.toFixed(3)}, ${parisState.centre.lat.toFixed(3)}`);
  await click('[data-category]', CHIP.label);
  await waitFor(`window.__lakeDemo.matchCount != ${second.n}`, 120000, 'the category count in Paris');
  await sleep(1500);
  const afterChip = await evaluate(`({ win: window.__lakeDemo.window, centre: window.__lakeDemo.map.getMap().getCenter(), pressed: document.querySelector('[data-city=paris]').getAttribute('aria-pressed') })`);
  check(JSON.stringify(afterChip.win) === JSON.stringify(parisState.win) && Math.abs(afterChip.centre.lng - parisState.centre.lng) < 1e-9 && afterChip.pressed === 'true',
    'a category chip never moves the map or changes the window', JSON.stringify(afterChip.win));
  await click('[data-clear]');
  await waitFor(`window.__lakeDemo.matchCount === ${expected.otherPlace}`, 120000, 'the cleared category in Paris');

  /* -------------------------------------------------------------- */
  /* Drag the map across a border                                    */
  /* -------------------------------------------------------------- */
  await click('[data-category]', DRAG_CATEGORY.label);
  await goTo(DRAG_START, DRAG_CATEGORY.values);
  await waitFor(`window.__lakeDemo.window.xmax === ${DRAG_START.xmax} && window.__lakeDemo.matchCount != null`, 120000, 'the window west of the river');
  await waitFor(`!document.querySelector('.map-pane .panel-loading:not([hidden])')`, 120000, 'the map');
  await sleep(4000);
  const before = await evaluate(`({ n: window.__lakeDemo.matchCount, opened: window.__lakeDemo.files.map((f) => f.country), tile: document.querySelector('[data-stat=partitions] [data-value]').textContent, swaps: window.__lakeDemo.swaps, win: window.__lakeDemo.window })`);
  check(before.n === expected.dragStart.restaurants, 'Detroit west of the river: the restaurant count is the lake\'s', `${int(before.n)} vs ${int(expected.dragStart.restaurants)}`);
  check(!before.opened.includes('CA'), 'Canada is not opened yet', before.tile);
  await shoot('10-before-drag');

  /* A real pointer drag, kept inside the map pane. */
  const pane = await evaluate('(() => { const e = document.querySelector(".map-host"); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
  const dx = -Math.min(180, Math.floor((await evaluate('document.querySelector(".map-host").getBoundingClientRect().width')) / 3));
  await evaluate('(() => { window.__lakeDemo.sql.length = 0; return 1; })()');
  const bytesBefore = (await evaluate('window.__lakeDemo.meter.bytes'));
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pane.x, y: pane.y });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pane.x, y: pane.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i += 1) { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pane.x + (dx * i) / 12, y: pane.y, buttons: 1 }); await sleep(30); }
  /* A pause before the release so the map keeps no inertia: the drag is exactly as long as it looks, the same every run. */
  await sleep(400);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pane.x + dx, y: pane.y, button: 'left', clickCount: 1 });
  await waitFor(`window.__lakeDemo.window.xmin > ${before.win.xmin} + 0.01 && window.__lakeDemo.matchCount != null && window.__lakeDemo.swaps > ${before.swaps}`, 120000, 'the dragged window');
  await sleep(4000);
  const after = await evaluate(`({ n: window.__lakeDemo.matchCount, opened: window.__lakeDemo.files.map((f) => f.country), tile: document.querySelector('[data-stat=partitions] [data-value]').textContent, win: window.__lakeDemo.window,
    chip: document.querySelector('[data-category=restaurant]').getAttribute('aria-pressed'), fetched: window.__lakeDemo.cityBytes, queries: window.__lakeDemo.sql.map((q) => q.sql.replace(/\\s+/g, ' ').slice(0, 40)),
    sqlShown: document.querySelector('[data-query-list]').textContent, statMatch: document.querySelector('[data-stat=matches] [data-value]').textContent, pressed: document.querySelectorAll('[data-city][aria-pressed=true]').length,
    rows: (() => { const g = window.__lakeDemo.grid; const out = []; for (let i = 0; i < Math.min(5, g.rows.count()); i += 1) { const r = g.rows.at ? g.rows.at(i) : g.rows.get(i); out.push(r && r.data ? r.data : r); } return out; })() })`);
  if (askBox) {
    expected.dragEnd = await askBox(after.win, DRAG_CATEGORY);
    if (record) await writeFile(EXPECTED_FILE, `${JSON.stringify(expected, null, 1)}\n`);
  }
  /* The window a drag ends on depends on the size of the map pane; the recording is of the desktop width. Another width is checked for what it can be: it moved, and it is inside the lake's rows. */
  const end = expected.dragEnd;
  const sameWindow = Math.abs(end.box.xmin - after.win.xmin) < 1e-6 && Math.abs(end.box.ymax - after.win.ymax) < 1e-6;
  if (VIEWPORT.width === 1440) check(sameWindow, 'the drag ended on the window the recording was made for', JSON.stringify(after.win));
  else console.log(`  note the drag window is for another width, so its count is not compared (${int(after.n)})`);
  check(after.n !== before.n && (!sameWindow || after.n === end.restaurants), 'the drag changed the match count, and it is the lake\'s for the window the map shows', `${int(before.n)} -> ${int(after.n)} vs ${int(end.restaurants)}`);
  check(after.statMatch === int(after.n), 'the match tile shows it', after.statMatch);
  check(after.opened.includes('CA') && end.countriesWithRows.includes('CA') && after.tile !== before.tile, 'crossing the river opened Canada: the countries tile moved', `${before.tile} -> ${after.tile}`);
  check(after.chip === 'true' && after.pressed === 0, 'the category stayed on and no place chip is pressed any more', `pressed=${after.chip}`);
  check(after.rows.length > 0 && after.rows.every((r) => DRAG_CATEGORY.values.includes(r.category) && r.lon >= after.win.xmin && r.lon <= after.win.xmax && r.lat >= after.win.ymin && r.lat <= after.win.ymax),
    'every row shown is a restaurant inside the moved window', after.rows.slice(0, 2).map((r) => r.name).join(' | '));
  if (!after.sqlShown.includes(String(after.win.xmin))) console.log(after.sqlShown.slice(0, 1200));
  check(after.sqlShown.includes(String(after.win.xmin)), '"What DuckDB ran" shows the moved window\'s SQL', after.queries.join(' ; '));
  const dataQueries = after.queries.filter((q) => /^SELECT "id"/.test(q));
  check(dataQueries.length >= 1 && dataQueries.length <= 2, 'one drag cost one page query for the grid, plus at most the map\'s own window query', `${after.queries.length} statements: ${after.queries.join(' ; ')}`);
  /* The map draws the window, not the grid's page (BACKLOG-0005528): every matching place up to the map's cap, or the density form over it. */
  const prov = await evaluate('window.__lakeDemo.map.provenance()');
  check(prov && (prov.binned || prov.drawn >= Math.min(after.n, prov.cap)), 'the map draws every matching place in the moved window up to its cap, or the density form',
    `drawn ${prov && prov.drawn} of ${int(after.n)} matched, cap ${prov && prov.cap}, computed ${prov && prov.computed}, binned ${prov && prov.binned}`);
  console.log(`DRAG ${dragNote(before, after, bytesBefore)}`);
  await shoot('11-after-drag');
  await click('[data-clear]');

  /* -------------------------------------------------------------- */
  /* Hygiene                                                         */
  /* -------------------------------------------------------------- */
  const hygiene = await evaluate(`(() => {
    const text = document.body.innerText;
    return { bad: (text.match(/\\b(NaN|undefined|null|\\[object Object\\])\\b/g) || []), watermark: window.__lakeDemo.grid.licence.watermark(), state: window.__lakeDemo.grid.licence.state() };
  })()`);
  check(hygiene.bad.length === 0, 'no NaN / undefined / null text on the page', hygiene.bad.join(','));
  check(hygiene.watermark === false, 'no watermark', hygiene.state);
  check(consoleErrors.length === 0 && pageErrors.length === 0, '0 console errors', [...consoleErrors, ...pageErrors].slice(0, 3).join(' || '));

  if (mode === 'replay') {
    const missed = served.lakeLog().filter((r) => !r.hit);
    check(missed.length === 0, 'every read was answered from the recording', `${served.lakeLog().length} reads, ${missed.length} missing`);
  }
}

try {
  await run();
} catch (error) {
  failures.push(`the check could not finish: ${error.message}`);
  console.log(`  FAIL the check could not finish: ${error.message}`);
} finally {
  await shutdown();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
