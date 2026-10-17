// Engangsgenerator for fylkeskartet på dashboardet (kjøres manuelt ved ny fylkesinndeling eller nytt postnummerregister).
// Kilder: robhop/fylker-og-kommuner Fylker-S.geojson (Kartverket, CC BY 4.0) og Brings postnummerregister (Postnummerregister-ansi.txt).
// Bruk: node scripts/gen-norge-kart.mjs <Fylker-S.geojson> <Postnummerregister-ansi.txt>
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [geoFile, pnFile] = process.argv.slice(2);
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "norge-fylker.json");

// Mercator-projeksjon, 400 px bredt
const geo = JSON.parse(readFileSync(geoFile, "utf8"));
for (const f of geo.features) if (f.geometry.type === "Polygon") f.geometry = { type: "MultiPolygon", coordinates: [f.geometry.coordinates] };
const merc = ([lon, lat]) => [lon, (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
for (const f of geo.features) for (const poly of f.geometry.coordinates) for (const p of poly[0]) { const [x, y] = merc(p); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const W = 400, k = W / (x1 - x0), H = Math.ceil((y1 - y0) * k);
const pt = p => { const [x, y] = merc(p); return [Math.round((x - x0) * k * 2) / 2, Math.round((y1 - y) * k * 2) / 2]; };
const area = r => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
const fylker = geo.features.map(f => {
  let d = "";
  for (const poly of f.geometry.coordinates) for (const ring of poly) {
    const r = []; for (const p of ring.map(pt)) { const q = r[r.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= 1.2) r.push(p); } // tynn ut punkter nærmere enn 1,2 px
    if (r.length < 4 || area(r) < 1.5) continue; // dropp småøyer under ~1,5 px²
    d += "M" + r.map(p => p.join(",")).join("L") + "Z";
  }
  return { id: f.properties.fylkesnummer, navn: f.properties.name, d };
}).sort((a, b) => a.id.localeCompare(b.id));

// postnummer -> fylke (to første sifre i kommunenummer), lagret som intervaller [fra, til, fylke]
const rows = readFileSync(pnFile, "latin1").split(/\r?\n/).map(l => l.split("\t")).filter(c => /^\d{4}$/.test(c[0]) && /^\d{4}$/.test(c[2]))
  .map(c => [+c[0], c[2].slice(0, 2)]).sort((a, b) => a[0] - b[0]);
const pn = [];
for (const [z, f] of rows) { const last = pn[pn.length - 1]; if (last && last[2] === f) last[1] = z; else pn.push([z, z, f]); }

writeFileSync(OUT, JSON.stringify({ kilde: "Kartverket via robhop/fylker-og-kommuner (CC BY 4.0), Bring postnummerregister", w: W, h: H, fylker, pn }));
console.log(`skrev ${OUT}: ${W}x${H}, ${fylker.length} fylker, ${pn.length} postnummer-intervaller, ${Math.round(JSON.stringify({ fylker, pn }).length / 1024)} KB`);
