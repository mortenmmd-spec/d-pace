// Gratisordre i retur (Morten 23.11.2026): alle 0-kronersordre (seeding, erstatning, B2B-prøver), ikke kansellert.
// Status leses fra Helthjems åpne sporingsside i bakgrunnsnettleseren (CDP 9333, ~/claude-browser/start.ps1); Shopify vet ikke om retur.
// Kjøres lokalt: node scripts/gratis-retur.mjs  → skriver data/gratis-retur.json, som build-pace-quest.mjs leser.
// Endelige statuser (levert, retur) sjekkes ikke på nytt.
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(DIR, "data", "gratis-retur.json");
const p = JSON.parse(readFileSync("C:/Users/morte/konfig/passord.json", "utf8")).shopify;
const SHOP = p.shop;
const tok = (await (await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: p.clientId, client_secret: p.clientSecret, grant_type: "client_credentials" }) })).json()).access_token;
let url = `https://${SHOP}/admin/api/2024-10/orders.json?status=any&limit=250&fields=id,name,created_at,total_price,tags,cancelled_at,test,fulfillments,line_items`, all = [];
while (url) { const r = await fetch(url, { headers: { "X-Shopify-Access-Token": tok } }); if (!r.ok) throw new Error("Shopify " + r.status); all = all.concat((await r.json()).orders); const l = r.headers.get("link"); const m = l && l.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null; }
const free = all.filter(o => +o.total_price === 0 && !o.cancelled_at && !o.test);
const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { ordre: {} };
const FINAL = new Set(["delivered", "return_to_store", "returned", "picked_up", "collected"]);
const RETUR = s => /return/i.test(s || "");
const sjaktler = o => (o.line_items || []).filter(li => /^PACE0[12]$/.test(li.sku || "")).reduce((x, li) => x + li.quantity, 0);
const ordre = {}; let sperret = false; // CloudFront gir 403 ved mange raske oppslag: 4 s pause, stopp ved 403, resten neste kjøring
const require = createRequire("C:/Users/morte/lowstrike/x.js");
const { chromium } = require("playwright");
const b = await chromium.connectOverCDP("http://127.0.0.1:9333"); const pg = await b.contexts()[0].newPage();
try {
  for (const o of free) {
    const f = (o.fulfillments || []).find(x => x.tracking_number);
    const base = { nr: o.name, d: o.created_at.slice(0, 10), tags: o.tags || "", sj: sjaktler(o), bud: f?.tracking_company || null, spor: f?.tracking_number || null };
    const prev = old.ordre[o.name];
    if (prev && FINAL.has(prev.status)) { ordre[o.name] = { ...base, status: prev.status, sist: prev.sist }; continue; }
    if (!f) { ordre[o.name] = { ...base, status: (o.fulfillments || []).length ? "uten_sporing" : "ikke_sendt" }; continue; }
    if (!/helthjem/i.test(f.tracking_company || "")) { ordre[o.name] = { ...base, status: prev?.status || "ukjent_transportor" }; continue; }
    if (sperret) { ordre[o.name] = { ...base, status: prev && prev.status !== "ukjent" ? prev.status : "ikke_sjekket", sist: prev?.sist }; continue; }
    const resp = await pg.goto("https://helthjem.no/sporing/" + f.tracking_number, { waitUntil: "networkidle" }); await pg.waitForTimeout(4000);
    const t = (await pg.innerText("body").catch(() => "")).replace(/\s+/g, " ");
    if (resp?.status() === 403 || /Request blocked/.test(t)) { sperret = true; ordre[o.name] = { ...base, status: prev && prev.status !== "ukjent" ? prev.status : "ikke_sjekket", sist: prev?.sist }; continue; }
    const st = new URL(pg.url()).searchParams.get("status") || "ukjent";
    const sist = (/Siste status: ([^A-ZÆØÅ]*?kl\. \d\d:\d\d)/.exec(t) || [])[1] || null;
    ordre[o.name] = { ...base, status: st, sist };
  }
} finally { await pg.close(); }
const liste = Object.values(ordre);
const retur = liste.filter(x => RETUR(x.status));
const res = { at: new Date().toISOString(), fullstendig: !sperret, antall: liste.length, retur: retur.length, returSj: retur.reduce((x, r) => x + r.sj, 0), statuser: liste.reduce((a, x) => (a[x.status] = (a[x.status] || 0) + 1, a), {}), ordre };
writeFileSync(OUT, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ antall: res.antall, retur: res.retur, returSj: res.returSj, statuser: res.statuser }));
console.log(retur.map(r => `${r.nr} ${r.d} ${r.sj} sj ${r.tags} ${r.sist || ""}`).join("\n"));
process.exit(0);
