/**
 * The entry point: start DuckDB, hand the connection to the page, get out of the way.
 * Nothing is awaited at the top level, so the document finishes loading.
 */

import * as LG from './node_modules/@toclocoinc/lattice-grid/lattice-grid.esm.min.js';
import { createMapView } from './node_modules/@toclocoinc/lattice-grid/modules/mapview.esm.min.js';
import { DEMO_LICENCE } from './src/licence.js';
import { startDuckDB, createByteMeter } from './src/duckdb.js';
import { buildApp } from './src/app.js';

LG.setLicence(DEMO_LICENCE);

const root = document.querySelector('#app');

function showMessage(title, message, hint) {
  root.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'loading';
  const h1 = document.createElement('h1');
  h1.textContent = title;
  const line = document.createElement('p');
  line.className = 'loading-message';
  line.textContent = message;
  panel.append(h1, line);
  if (hint) {
    const more = document.createElement('p');
    more.className = 'loading-message';
    more.textContent = hint;
    panel.append(more);
  }
  root.append(panel);
  return (next) => { line.textContent = next; };
}

async function start() {
  const started = performance.now();
  const update = showMessage('The lake is the database', 'Starting DuckDB in your browser...');
  try {
    const meter = createByteMeter();
    const { connection, version, close } = await startDuckDB(update);
    update('Opening the lake...');
    const built = buildApp({ root, LG, createMapView, connection, meter, duckdbVersion: version });
    window.addEventListener('pagehide', () => { built.destroy(); close(); }, { once: true });

    /* Ready means the first rows and the match count are on screen. */
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !(built.grid?.rows.count() > 0 && built.matchCount != null)) {
      await new Promise((r) => setTimeout(r, 150));
    }
    built.ready = true;
    built.bootMs = Math.round(performance.now() - started);
    window.__lakeDemo = built;
    console.log('[lake demo] ready', { ms: built.bootMs, rows: built.grid?.rows.totalCount(), duckdb: version });
  } catch (error) {
    window.__lakeDemo = { ready: false, error: String(error?.message ?? error) };
    showMessage(
      'The lake could not be opened',
      String(error?.message ?? error),
      'This page runs DuckDB compiled to WebAssembly, loaded from jsDelivr, and reads public Parquet files over HTTPS with range requests. It needs a browser with WebAssembly and a network connection.',
    );
    console.error('[lake demo]', error);
  }
}

start();
