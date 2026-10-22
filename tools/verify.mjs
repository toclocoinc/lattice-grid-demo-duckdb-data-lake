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
 *   - the map drew the rows the grid holds; the theme switch repaints;
 *   - no console errors, no NaN/undefined text, no watermark.
 *
 * Where the data comes from (always the page's `?data=local`, through tools/serve.mjs):
 *
 *   node tools/verify.mjs               the recording in test/recorded/ (no data needed; what CI runs)
 *   node tools/verify.mjs --local [dir] a local build from tools/build-partitioned.mjs (default data/lake)
 *   node tools/verify.mjs --record [dir] the same, and rewrite test/recorded/ and test/expected.json; also
 *                                       checks the copy against the Overture release itself (network)
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
import { CATEGORIES, CITIES } from '../src/places.js';

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
const RELEASE = '2026-09-23.1';
const EXPECTED_FILE = join(root, 'test', 'expected.json');

const TARGET = CITIES.find((c) => c.id === 'reykjavik');
const CHIP = CATEGORIES.find((c) => c.id === 'restaurant');
const SEARCH = 'hotel';

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
  const glob = join(LOCAL_DIR, 'country=*', '*.parquet').replaceAll("'", "''");
  const local = `read_parquet('${glob}', hive_partitioning = true, hive_types = {'country': VARCHAR})`;
  const answers = await answersOver(conn, local);
  const holding = (await conn.runAndReadAll(`
    SELECT DISTINCT country FROM ${local} WHERE lon BETWEEN ${b.xmin} AND ${b.xmax} AND lat BETWEEN ${b.ymin} AND ${b.ymax} ORDER BY 1`)).getRowObjectsJson().map((r) => r.country);
  const other = CITIES.find((c) => c.id === 'paris').bbox;
  const otherPlace = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ${local} WHERE lon BETWEEN ${other.xmin} AND ${other.xmax} AND lat BETWEEN ${other.ymin} AND ${other.ymax}`)).getRowObjectsJson()[0].n);
  const result = { release: RELEASE, countriesWithRows: holding, otherPlace, ...answers };
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
  const mode = record ? 'record' : (flag('--local') ? 'local' : 'replay');
  console.log(`Data: ${mode === 'replay' ? 'the recording in test/recorded/ (no data needed)' : `${LOCAL_DIR}${record ? ', recording to test/recorded/' : ''}`}`);

  /* The page always reads through /lake/ (?data=local); the server answers from the build or the recording. */
  served = await startServer(0, { lake: mode, dir: LOCAL_DIR });
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
  const box = await evaluate('(() => { const e = document.querySelector(".map-host"); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); const c = e.querySelector("canvas"); return { x: r.left, y: r.top, width: r.width, height: r.height, canvas: c ? c.clientWidth * c.clientHeight : 0, covered: !!document.querySelector(".map-pane .panel-loading:not([hidden])") }; })()');
  check(box.width > 200 && box.height > 200 && box.canvas > 0 && !box.covered, 'the map pane has a size, a canvas and no loading cover', JSON.stringify(box));
  let colours = 0;
  for (let attempt = 0; attempt < 15 && colours < 12; attempt += 1) {
    const { data } = await call('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
    colours = distinctColours(Buffer.from(data, 'base64'));
    if (colours < 12) await sleep(1000);
  }
  check(colours >= 12, 'the map canvas shows a drawn basemap and points, not a blank box', `${colours} distinct colours`);

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
  await waitFor(`window.__lakeDemo.city.id === 'paris' && window.__lakeDemo.matchCount != null`, 120000, 'the second place');
  await sleep(1500);
  const second = await evaluate(`({ n: window.__lakeDemo.matchCount, tile: document.querySelector('[data-stat=partitions] [data-value]').textContent })`);
  check(second.n === expected.otherPlace, `${other.label}: the count is the copy's (${int(expected.otherPlace)})`, `${int(second.n)}; countries opened: ${second.tile}`);
  await shoot('09-other-place');

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
