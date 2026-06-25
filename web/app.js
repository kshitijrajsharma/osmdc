import maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@4/+esm";
import * as h3 from "https://cdn.jsdelivr.net/npm/h3-js@4/+esm";
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

// deck.gl's H3HexagonLayer reads h3-js 
window.h3 = h3;
let MapboxOverlay, H3HexagonLayer;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

// Tiles stream directly from the Hugging Face dataset.
const DATA_BASE =
  "https://huggingface.co/datasets/kshitijrajsharma/osm-completeness-tiles/resolve/main/";

const el = (id) => document.getElementById(id);
const status = (msg) => (el("status").textContent = msg);

const COLOR_STOPS = [
  [0.0, [215, 48, 39]],
  [0.5, [254, 224, 139]],
  [1.0, [26, 152, 80]],
];

function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [p1, c1] = COLOR_STOPS[i - 1];
    const [p2, c2] = COLOR_STOPS[i];
    if (t <= p2) {
      const f = (t - p1) / (p2 - p1);
      return c1.map((c, k) => Math.round(c + (c2[k] - c) * f));
    }
  }
  return COLOR_STOPS.at(-1)[1];
}

let map, overlay, db, manifest, currentRows = [];

async function initMap() {
  await loadScript("https://cdn.jsdelivr.net/npm/deck.gl@9/dist.min.js");
  ({ MapboxOverlay, H3HexagonLayer } = window.deck);
  map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [85.32, 27.71],
    zoom: 10,
  });
  overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay);
}

async function initDuckDB() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pkgWorker);
  URL.revokeObjectURL(workerUrl);
}

async function loadManifest() {
  const res = await fetch(new URL("manifest.json", DATA_BASE));
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  manifest = await res.json();
}

function polygonsOf(geojson) {
  const feats = geojson.type === "FeatureCollection" ? geojson.features
    : geojson.type === "Feature" ? [geojson]
      : [{ type: "Feature", geometry: geojson }];
  const polys = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") polys.push(g.coordinates);
    else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  return polys;
}

function coveredCells(polys, resolution) {
  const cells = new Set();
  for (const rings of polys) {
    for (const cell of h3.polygonToCells(rings, resolution, true)) cells.add(cell);
    if (cells.size === 0) {
      for (const [lng, lat] of rings[0]) cells.add(h3.latLngToCell(lat, lng, resolution));
    }
  }
  return cells;
}

async function queryTiles(parents) {
  const urls = [];
  for (const parent of parents) {
    const rel = manifest.tiles[parent];
    if (rel) urls.push(new URL(rel, DATA_BASE).href);
  }
  if (urls.length === 0) return [];

  const conn = await db.connect();
  const names = [];
  for (let i = 0; i < urls.length; i++) {
    const response = await fetch(urls[i]);
    if (!response.ok) throw new Error(`tile fetch failed (${response.status}): ${urls[i]}`);
    const name = `tile_${i}.parquet`;
    await db.registerFileBuffer(name, new Uint8Array(await response.arrayBuffer()));
    names.push(`'${name}'`);
  }
  const result = await conn.query(`SELECT * FROM read_parquet([${names.join(",")}])`);
  await conn.close();
  for (let i = 0; i < names.length; i++) await db.dropFile(`tile_${i}.parquet`);
  return result.toArray().map((r) => {
    const o = r.toJSON();
    return {
      h3: o.h3,
      bld_count: Number(o.bld_count),
      bld_osm: Number(o.bld_osm),
      osm_pct: o.osm_pct == null ? null : Number(o.osm_pct),
      road_count: Number(o.road_count),
      road_len_m: Number(o.road_len_m),
    };
  });
}

function metricValue(d) {
  const layer = el("layer").value;
  const metric = el("metric").value;
  if (layer === "highways") return d.road_len_m / 1000;
  if (metric === "osm_pct") return d.osm_pct;
  return d.bld_count;
}

function normaliser(rows) {
  const metric = el("metric").value;
  const layer = el("layer").value;
  if (layer === "buildings" && metric === "osm_pct") return (v) => (v == null ? null : v / 100);
  let max = 0;
  for (const d of rows) max = Math.max(max, metricValue(d) || 0);
  return (v) => (v == null || max === 0 ? null : v / max);
}

function render(rows) {
  const norm = normaliser(rows);
  const layer = new H3HexagonLayer({
    id: "cells",
    data: rows,
    getHexagon: (d) => d.h3,
    extruded: false,
    filled: true,
    stroked: true,
    getLineColor: [255, 255, 255, 30],
    lineWidthMinPixels: 0.5,
    opacity: 0.72,
    pickable: true,
    getFillColor: (d) => {
      const t = norm(metricValue(d));
      return t == null ? [80, 80, 80, 120] : [...ramp(t), 200];
    },
    updateTriggers: { getFillColor: [el("layer").value, el("metric").value] },
  });
  overlay.setProps({
    layers: [layer],
    getTooltip: ({ object }) =>
      object && {
        html: `<b>${object.h3}</b><br/>buildings: ${object.bld_count} (${object.osm_pct ?? "-"}% in OSM)<br/>roads: ${(object.road_len_m / 1000).toFixed(2)} km`,
        style: { background: "#111827", color: "#e5e7eb", fontSize: "12px", padding: "6px" },
      },
  });
}

function showStats(rows) {
  let bld = 0, osm = 0, km = 0;
  for (const d of rows) {
    bld += d.bld_count;
    osm += d.bld_osm;
    km += d.road_len_m / 1000;
  }
  el("s-cells").textContent = rows.length.toLocaleString();
  el("s-bld").textContent = bld.toLocaleString();
  el("s-osm").textContent = osm.toLocaleString();
  el("s-pct").textContent = bld ? `${((osm / bld) * 100).toFixed(1)}%` : "-";
  el("s-km").textContent = `${km.toFixed(1)} km`;
  el("stats").hidden = false;
}

function fitTo(rows) {
  if (rows.length === 0) return;
  const b = new maplibregl.LngLatBounds();
  for (const d of rows) for (const [lat, lng] of h3.cellToBoundary(d.h3)) b.extend([lng, lat]);
  map.fitBounds(b, { padding: 40, duration: 600 });
}

async function process(geojson) {
  status("Reading area...");
  const polys = polygonsOf(geojson);
  if (polys.length === 0) return status("No polygon found in that file.");

  const cells = coveredCells(polys, manifest.resolution);
  const parents = new Set([...cells].map((c) => h3.cellToParent(c, manifest.partition_resolution)));

  status(`Querying ${parents.size} tile(s)...`);
  const all = await queryTiles(parents);
  currentRows = all.filter((d) => cells.has(d.h3));

  if (currentRows.length === 0) return status("No data tiles cover this area yet.");
  render(currentRows);
  showStats(currentRows);
  fitTo(currentRows);
  el("download").disabled = false;
  status(`${currentRows.length} cells in view.`);
}

function downloadGeoJSON() {
  const features = currentRows.map((d) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [h3.cellToBoundary(d.h3, true)] },
    properties: d,
  }));
  const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "osm-completeness.geojson";
  a.click();
  URL.revokeObjectURL(a.href);
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => process(JSON.parse(reader.result));
  reader.readAsText(file);
}

function wireUI() {
  const drop = el("drop");
  drop.addEventListener("click", () => el("file").click());
  el("file").addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hover"); })
  );
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]));

  const rerender = () => currentRows.length && (render(currentRows), updateLegend());
  el("layer").addEventListener("change", () => { syncMetricOptions(); rerender(); });
  el("metric").addEventListener("change", rerender);
  el("download").addEventListener("click", downloadGeoJSON);
  el("sample").addEventListener("click", () => process(SAMPLE));
}

function syncMetricOptions() {
  const highways = el("layer").value === "highways";
  el("metric").disabled = highways;
  updateLegend();
}

function updateLegend() {
  const highways = el("layer").value === "highways";
  el("legend-label").textContent = highways
    ? "Road length per cell"
    : el("metric").value === "osm_pct"
      ? "Completeness (% in OSM)"
      : "Building density";
}

const SAMPLE = {
  type: "Polygon",
  coordinates: [[
    [85.29, 27.67], [85.37, 27.67], [85.37, 27.74], [85.29, 27.74], [85.29, 27.67],
  ]],
};

async function boot() {
  wireUI();
  syncMetricOptions();
  status("Loading engine...");
  await Promise.all([initDuckDB(), loadManifest(), initMap()]);
  status("Ready. Drop a GeoJSON or try the sample.");
}

boot().catch((e) => status(`Error: ${e.message}`));
