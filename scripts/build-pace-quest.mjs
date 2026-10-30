// Bygger pace-quest.html (kryptert) fra pace-quest.template.html.
// Kilder: GitHub Projects-board Tempelbois/2, Shopify (salg/nye kunder/lager per dag), Meta-kvitteringer i Gmail (CAC),
// kasse fra env PACE_KASSE. Kjøres av GitHub Actions (.github/workflows/pace-quest.yml) og lokalt via ~/sync-pace-quest.mjs.
//
// Env:
//   PACE_BOARD_TOKEN         GitHub-token med KUN project-scope (lokalt: ~/konfig/pace_dashboard_token.txt)
//   PACE_PAGE_TOKEN          samme token; bakes inn i siden så alle med sidepassordet kan redigere (tom = krever egen token)
//   SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN   hei@getpace.no (readonly) for Meta-kvitteringer. Valgfri: feiler → CAC vises som «–»
//   PACE_KASSE               "kasse|kasse_dato|gjeld|gjeld_note|sitron_bestfor" (pipe-separert, bestfor som DD.MM.YYYY)
//   STATICRYPT_PASSWORD      sidepassord (påkrevd med mindre SKIP_ENCRYPT)
//   STATICRYPT_SALT          fast salt (default 843e94067e2339f1a3b9073a407ddde1)
//   SKIP_ENCRYPT=1           skriv bare pace-quest-plain.html (lokal test)
//   FORCE=1                  bygg også utenfor 06–23 Oslo
// Board og Shopify er harde krav: feiler de, publiseres ingenting (aldri nuller).

import { execFileSync } from "node:child_process";
import { readPlan } from "./plan-crypt.mjs";
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(DIR, "pace-quest.template.html");
const KART = JSON.parse(readFileSync(path.join(DIR, "scripts", "norge-fylker.json"), "utf8")); // fylkesgrenser + postnummer->fylke, lages av gen-norge-kart.mjs
const OUT = path.join(DIR, "pace-quest.html");
const PLAIN = path.join(DIR, "pace-quest-plain.html");
const env = (k, fallback) => { const v = process.env[k]; if (v === undefined || v === "") { if (fallback !== undefined) return fallback; throw new Error("mangler env " + k); } return v; };

const ORG = "Tempelbois", PROJECT_NUMBER = 2, LOCATION_ID = 76905513134; // 360 Logistics - 3PL
const API = "2025-10";
const OSLO = "Europe/Oslo";
const NOW = new Date();
const osloDay = d => new Intl.DateTimeFormat("sv-SE", { timeZone: OSLO, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); // YYYY-MM-DD
const osloHour = d => +new Intl.DateTimeFormat("en-GB", { timeZone: OSLO, hour: "2-digit", hour12: false }).format(d);
const osloOffsetMin = d => { // minutter øst for UTC på gitt tidspunkt
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: OSLO, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((asUtc - d.getTime()) / 6e4);
};
const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
const TODAY = osloDay(NOW);
const DAYS = Array.from({ length: 31 }, (_, i) => addDays(TODAY, i - 30)); // 30 hele Oslo-dager + i dag
const stamp = NOW.toLocaleString("no-NO", { timeZone: OSLO, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", " kl.");
const nf = n => Math.round(n).toLocaleString("no-NO");
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// dekningsbidrag per ordre. Kostnader eks mva fra fakturaer:
// Kostnader per fornyelse fra fakturaer (eks mva): varekost 51,29/sjaktel = Pharmatech 34,96 (fakt. 202611329/202611631)
// + folieark 8,51 + frakt 0,25 (Digital Etikett 341824, 10 ark à 0,851) + sjaktel 5,76 (Packly 26.05.2026 17 281,77 kr / 3 000 stk)
// + pall 0,37 og transport til 360 1,44 (Pharmatech 202611329, Østfold Transport 118598); 360 Logistics plukk 25,25 + emballasje 4,04
// + 3,03 per varelinje (fakt. 112646/112752); frakt 52 per ordre (112851: 7 908,71 for 152 ordre i sept.); Shopify Payments 2,81 % (faktiske gebyrer).
const KOST = { sjaktel: 51.29, plukk: 25.25 + 4.04, linje: 3.03, frakt: 52, gebyr: 0.0281 };
const dbOrdre = (eks, inkl, sjaktler, linjer) => eks - sjaktler * KOST.sjaktel - KOST.plukk - linjer * KOST.linje - KOST.frakt - inkl * KOST.gebyr;

if (!process.env.FORCE && !process.env.SKIP_ENCRYPT) { const h = osloHour(NOW); if (h < 6 || h > 23) { console.log("utenfor 06–23 Oslo, hopper over"); process.exit(0); } }

// ---------- 1. Board ----------
async function fetchBoard() {
  const token = env("PACE_BOARD_TOKEN");
  const items = []; let after = null;
  for (let page = 0; page < 20; page++) {
    const q = `query($after: String) { organization(login: "${ORG}") { projectV2(number: ${PROJECT_NUMBER}) {
      items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isArchived
        content { __typename ... on DraftIssue { id title body } ... on Issue { title } ... on PullRequest { title } }
        fieldValues(first: 20) { nodes {
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
        } } } } } } }`;
    const r = await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": "pace-quest" }, body: JSON.stringify({ query: q, variables: { after } }) });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error("GitHub: " + (j.errors?.[0]?.message || r.status));
    const p = j.data?.organization?.projectV2;
    if (!p) throw new Error("GitHub: fant ikke prosjektet (token mangler project-scope?)");
    items.push(...p.items.nodes.filter(n => !n.isArchived)); // arkiverte kort vises ikke
    if (!p.items.pageInfo.hasNextPage) break;
    after = p.items.pageInfo.endCursor;
  }
  if (!items.length) throw new Error("GitHub: tomt board, avbryter");
  return items.map(n => {
    const fv = Object.fromEntries(n.fieldValues.nodes.filter(v => v.field).map(v => [v.field.name, v.name ?? v.date]));
    const c = n.content || {};
    return { id: n.id, draft: c.__typename === "DraftIssue" ? c.id : "", body: c.body || "", sec: fv["Status"] || "Idéer", owner: fv["Ansvarlig"] || "Ikke fordelt", strom: fv["Arbeidsstrøm"] || "", kat: fv["Kategori"] || "Oppgave", due: fv["Måldato"] || "", txt: c.title || "(uten tittel)" };
  });
}

// ---------- 2. Shopify ----------
async function fetchShopify() {
  const SHOP = env("SHOPIFY_SHOP");
  const r0 = await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: env("SHOPIFY_CLIENT_ID"), client_secret: env("SHOPIFY_CLIENT_SECRET"), grant_type: "client_credentials" }) });
  const tok = (await r0.json()).access_token;
  if (!tok) throw new Error("Shopify: fikk ikke token");
  const H = { "X-Shopify-Access-Token": tok };
  const getAll = async (url, key) => { let out = []; while (url) { const r = await fetch(url, { headers: H }); if (!r.ok) throw new Error(`Shopify ${key} ${r.status}`); const j = await r.json(); out = out.concat(j[key] || []); const l = r.headers.get("link"); const m = l && l.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null; } return out; };
  const since = new Date(new Date(DAYS[0] + "T00:00:00Z").getTime() - 36e5 * 26 - 30 * 864e5).toISOString(); // 30 dager før første Oslo-dag (for aktive abonnenter)
  const all = await getAll(`https://${SHOP}/admin/api/${API}/orders.json?status=any&limit=250&created_at_min=${since}&fields=id,created_at,current_total_price,current_total_tax,current_subtotal_price,total_price,cancelled_at,financial_status,test,tags,line_items,customer,landing_site,referring_site,note_attributes,discount_codes`, "orders");
  const tags = o => (o.tags || "").split(",").map(s => s.trim().toLowerCase());
  const ok = o => !o.test && !o.cancelled_at && ["paid", "partially_refunded", "partially_paid"].includes(o.financial_status) && !tags(o).includes("seeding");
  const amt = o => +(o.current_total_price ?? o.total_price);
  const dbRest = o => { const li = (o.line_items || []).filter(x => (x.current_quantity ?? x.quantity) > 0); return dbOrdre(amt(o) - (+o.current_total_tax || 0), amt(o), li.filter(x => /^PACE0[12]$/.test(x.sku || "")).reduce((y, x) => y + (x.current_quantity ?? x.quantity), 0), li.length); };
  const allOk = all.filter(ok).filter(o => amt(o) > 0).map(o => ({ ...o, day: osloDay(new Date(o.created_at)) }));
  const orders = allOk.filter(o => o.day >= DAYS[0]);
  const isSubNew = o => tags(o).includes("subscription first order"), isSubRen = o => tags(o).includes("subscription recurring order"), isSub = o => isSubNew(o) || isSubRen(o);
  // per Oslo-dag
  // kanal per ordre (attribusjon fra Shopify): BML20-kode = bml; fbclid/utm meta eller Adtractions __adtr_channel fb/ig = meta;
  // annen __adtr_channel = adtr (øvrige Adtraction-partnere); gclid/utm google = google; ellers org (organisk/ukjent)
  const KANALER = ["meta", "bml", "adtr", "google", "org"];
  const kanal = o => { const s = (o.landing_site || "") + " " + (o.referring_site || ""); const codes = (o.discount_codes || []).map(d => String(d.code || "").toUpperCase()); const adtr = String((o.note_attributes || []).find(a => a.name === "__adtr_channel")?.value || "");
    if (codes.includes("BML20")) return "bml"; if (/facebook|fb|ig|instagram/i.test(adtr) || /fbclid|facebook|instagram|igshid|utm_source=(fb|ig|facebook|instagram|meta)/i.test(s)) return "meta"; if (adtr) return "adtr"; if (/gclid|gbraid|wbraid|utm_source=google/i.test(s)) return "google"; return "org"; };
  // BML-kost = 30 % provisjon av varesalg eks mva (ordresum etter rabatt, før frakt, 15 % mva) på BML20-ordre
  const bmlKost = o => (o.discount_codes || []).some(d => String(d.code || "").toUpperCase() === "BML20") ? 0.30 * ((+o.current_subtotal_price || 0) / 1.15) : 0;
  const daily = Object.fromEntries(DAYS.map(d => [d, { d, ordre: 0, oms: 0, eks: 0, nye: 0, u1: 0, u2: 0, subNew: 0, subRen: 0, subAct: 0, bmlKost: 0, nyeK: Object.fromEntries(KANALER.map(k => [k, 0])), dbK: Object.fromEntries(KANALER.map(k => [k, 0])), ordreK: Object.fromEntries(KANALER.map(k => [k, 0])), dbOK: Object.fromEntries(KANALER.map(k => [k, 0])) }]));
  for (const o of orders) {
    const x = daily[o.day]; if (!x) continue;
    x.ordre++; x.oms += amt(o); x.eks += amt(o) - (+o.current_total_tax || 0); x.bmlKost += bmlKost(o); { const k = kanal(o); x.ordreK[k]++; x.dbOK[k] += dbRest(o); }
    if (isSubNew(o)) x.subNew++; if (isSubRen(o)) x.subRen++;
    for (const li of o.line_items || []) { const q = li.current_quantity ?? li.quantity; if (li.sku === "PACE01") x.u1 += q; if (li.sku === "PACE02") x.u2 += q; }
  }
  // aktive abonnenter per dag = unike kunder med abonnementsordre (ny eller fornyelse) siste 30 dager t.o.m. dagen
  const subOrders = allOk.filter(o => isSub(o) && o.customer?.id);
  for (const d of DAYS) { const from = addDays(d, -29); daily[d].subAct = new Set(subOrders.filter(o => o.day >= from && o.day <= d).map(o => o.customer.id)).size; }
  // ny kunde = kundeprofil opprettet i vinduet (Shopify lager profilen ved første ordre); telles én gang, på dagen for kundens TIDLIGSTE betalte ordre
  const firstOrder = {}, firstOrd = {};
  for (const o of orders) { const c = o.customer; if (!c?.id || !c.created_at || osloDay(new Date(c.created_at)) < DAYS[0]) continue; if (!firstOrder[c.id] || o.day < firstOrder[c.id]) { firstOrder[c.id] = o.day; firstOrd[c.id] = o; } }
  for (const d of Object.values(firstOrder)) if (daily[d]) daily[d].nye++;
  // nye kunder per kanal (kanalen til første ordre) og dekningsbidrag på første ordre
  for (const o of Object.values(firstOrd)) { const x = daily[o.day]; if (!x) continue; const k = kanal(o); x.nyeK[k]++; x.dbK[k] += dbRest(o); }
  // nye kunder siste 30 hele dager (samme vindu som CAC 30 d) og hva de har kjøpt for i vinduet, eks mva
  const nyFra = DAYS[0], nyTil = addDays(TODAY, -1), nyIds = new Set(Object.entries(firstOrder).filter(([, d]) => d >= nyFra && d <= nyTil).map(([id]) => id));
  const nyEks = orders.filter(o => nyIds.has(String(o.customer?.id)) && o.day <= nyTil).reduce((x, o) => x + amt(o) - (+o.current_total_tax || 0), 0);
  const nyKunde30 = { n: nyIds.size, eks: nyIds.size ? nyEks / nyIds.size : 0 };
  // snittbeløp per abonnementsfornyelse, eks mva, over hele henteperioden (~60 d); fornyelser = det en løpende abonnent faktisk betaler
  const renOrders = allOk.filter(isSubRen);
  const subOrdreEks = renOrders.length ? renOrders.reduce((x, o) => x + amt(o) - (+o.current_total_tax || 0), 0) / renOrders.length : 0;
  // innhold per fornyelse (til dekningsbidraget): sjaktler, varelinjer og beløp inkl. mva
  const liveLines = o => (o.line_items || []).filter(li => (li.current_quantity ?? li.quantity) > 0);
  const subOrdre = renOrders.length ? { sjaktler: renOrders.reduce((x, o) => x + liveLines(o).filter(li => /^PACE0[12]$/.test(li.sku || "")).reduce((y, li) => y + (li.current_quantity ?? li.quantity), 0), 0) / renOrders.length, linjer: renOrders.reduce((x, o) => x + liveLines(o).length, 0) / renOrders.length, inkl: renOrders.reduce((x, o) => x + amt(o), 0) / renOrders.length } : null;
  // faktisk fornyelsesomsetning siste 42 hele dager (én leveringssyklus): fasit for hvor mye abonnementene faktisk gir per dag
  const ren42 = renOrders.filter(o => o.day >= addDays(TODAY, -42) && o.day < TODAY);
  // betalende abonnenter = unike kunder med abonnementsordre (første eller fornyelse) i samme syklus
  const sub42 = allOk.filter(o => isSub(o) && o.day >= addDays(TODAY, -42) && o.day < TODAY);
  const subRen42 = { n: ren42.length, kunder: new Set(ren42.map(o => o.customer?.id).filter(Boolean)).size, betalende: new Set(sub42.map(o => o.customer?.id).filter(Boolean)).size, eks: ren42.reduce((x, o) => x + amt(o) - (+o.current_total_tax || 0), 0) };
  // lager per lokasjon (360 Logistics), ikke aggregatet
  const products = await getAll(`https://${SHOP}/admin/api/${API}/products.json?limit=250&fields=id,title,variants`, "products");
  const items = {};
  for (const pr of products) for (const v of pr.variants) if (v.sku === "PACE01" || v.sku === "PACE02") items[v.sku] = v.inventory_item_id;
  if (!items.PACE01 || !items.PACE02) throw new Error("Shopify: fant ikke PACE01/PACE02");
  const lv = await getAll(`https://${SHOP}/admin/api/${API}/inventory_levels.json?inventory_item_ids=${items.PACE01},${items.PACE02}&location_ids=${LOCATION_ID}`, "inventory_levels");
  const lager = {};
  for (const [sku, iid] of Object.entries(items)) { const l = lv.find(x => x.inventory_item_id === iid); if (!l || typeof l.available !== "number") throw new Error("Shopify: ingen gyldig inventory_level for " + sku); lager[sku] = l.available; }
  // hele ordrehistorikken (read_all_orders) for salg per fylke
  const hist = await getAll(`https://${SHOP}/admin/api/${API}/orders.json?status=any&limit=250&created_at_min=2024-01-01T00:00:00Z&fields=id,created_at,current_total_price,current_total_tax,total_price,cancelled_at,financial_status,test,tags,customer,shipping_address,line_items`, "orders");
  // kohort: realisert dekningsbidrag per ny kunde de første 180 dagene (alle senere ordre med), delt på om første ordre var abonnement.
  // Kunder fra juni 2025 med full observasjonstid; dagens kostnader brukes også på eldre ordre.
  const kohort = { sub: { n: 0, db: 0 }, non: { n: 0, db: 0 } };
  { const per = {}; for (const o of hist.filter(ok).filter(o => amt(o) > 0 && o.customer?.id).sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at))) (per[o.customer.id] ||= []).push(o);
    for (const arr of Object.values(per)) { const f = Date.parse(arr[0].created_at); if (f < Date.parse("2025-06-01") || NOW - f < 180 * 864e5) continue;
      const g = kohort[tags(arr[0]).includes("subscription first order") ? "sub" : "non"]; g.n++; g.db += arr.filter(o => Date.parse(o.created_at) <= f + 180 * 864e5).reduce((x, o) => x + dbRest(o), 0); } }
  // salg per fylke fra leveringsadressens postnummer; bare aggregater forlater bygget (ingen adresser i HTML)
  const fylkeOf = zip => { const z = +zip; const r = KART.pn.find(([a, b]) => z >= a && z <= b); return r ? r[2] : null; };
  const geoWin = { alt: "2000-01-01", d90: addDays(TODAY, -89), d30: addDays(TODAY, -29) };
  const geo = Object.fromEntries(Object.keys(geoWin).map(k => [k, { fy: {}, utland: 0, ukjent: 0 }]));
  for (const o of hist.filter(ok).filter(o => amt(o) > 0)) {
    const a = o.shipping_address, day = osloDay(new Date(o.created_at));
    const zip = (a?.zip || "").replace(/\s/g, "");
    const fy = a && (a.country_code || "NO") === "NO" && /^\d{4}$/.test(zip) ? fylkeOf(zip) : null;
    for (const [k, from] of Object.entries(geoWin)) {
      if (day < from) continue;
      const g = geo[k];
      if (fy) { const x = (g.fy[fy] ||= { o: 0, kr: 0 }); x.o++; x.kr += amt(o); }
      else if (a && a.country_code && a.country_code !== "NO") g.utland++;
      else g.ukjent++;
    }
  }
  for (const g of Object.values(geo)) for (const x of Object.values(g.fy)) x.kr = Math.round(x.kr);
  // unike kunder = kundeprofiler med minst én betalt ordre i hele historikken
  const kunder = new Set(hist.filter(ok).filter(o => amt(o) > 0).map(o => o.customer?.id).filter(Boolean)).size;
  // snitt per kunde = all ordreverdi fra kunder med profil delt på unike kunder (inkl. og eks mva)
  const medKunde = hist.filter(ok).filter(o => amt(o) > 0 && o.customer?.id);
  const perKunde = kunder ? medKunde.reduce((x, o) => x + amt(o), 0) / kunder : 0;
  const perKundeEks = kunder ? medKunde.reduce((x, o) => x + amt(o) - (+o.current_total_tax || 0), 0) / kunder : 0;
  // salg per ukedag: snitt per dag siste 90 hele Oslo-dager (t.o.m. i går)
  const wdFrom = addDays(TODAY, -90), WD = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
  const wdOf = ymd => new Date(ymd + "T12:00:00Z").getUTCDay();
  const ukedag = WD.map(n => ({ n, dager: 0, kr: 0, o: 0 }));
  for (let d = wdFrom; d < TODAY; d = addDays(d, 1)) ukedag[wdOf(d)].dager++;
  for (const o of hist.filter(ok).filter(o => amt(o) > 0)) { const d = osloDay(new Date(o.created_at)); if (d < wdFrom || d >= TODAY) continue; const x = ukedag[wdOf(d)]; x.kr += amt(o); x.o++; }
  const ukedagSnitt = [1, 2, 3, 4, 5, 6, 0].map(i => ({ n: ukedag[i].n, kr: Math.round(ukedag[i].kr / (ukedag[i].dager || 1)), o: Math.round(ukedag[i].o / (ukedag[i].dager || 1) * 10) / 10, dager: ukedag[i].dager }));
  // totalt solgt (inkl. mva, hele historikken) til milepælene, og årets beste dag før i dag (rekorddag)
  const okHist = hist.filter(ok).filter(o => amt(o) > 0);
  const totalt = Math.round(okHist.reduce((x, o) => x + amt(o), 0));
  const perDag = {};
  for (const o of okHist) { const d = osloDay(new Date(o.created_at)); if (d.slice(0, 4) === TODAY.slice(0, 4) && d < TODAY) perDag[d] = (perDag[d] || 0) + amt(o); }
  const rekord = Object.entries(perDag).reduce((b, [d, kr]) => kr > b.kr ? { d, kr: Math.round(kr) } : b, { d: "", kr: 0 });
  // abonnement fra Subscriptions-appen (ShopifyQL): aktive = startet − avsluttet i hele historikken.
  // Dagsmålingen av active_subscriptions (175 per 17.10) stemmer ikke med Shopifys egne startet/avsluttet-tall og brukes ikke. Valgfri.
  let subActive = null, subStart = 0, subStop = 0, subAdd30 = 0, subCan30 = 0, subRekke = 0;
  try {
    const ql = async s => { const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ query: "query($s: String!) { shopifyqlQuery(query: $s) { tableData { rows } parseErrors } }", variables: { s } }) }); const d = (await r.json()).data?.shopifyqlQuery; if (!d || d.parseErrors?.length) throw new Error(d?.parseErrors?.[0] || "ShopifyQL-feil"); return d.tableData.rows[0] || {}; };
    const all = await ql("FROM subscriptions SHOW subscriptions_added, subscriptions_canceled SINCE 2024-01-01 UNTIL today");
    const d30 = await ql("FROM subscriptions SHOW subscriptions_added, subscriptions_canceled SINCE -30d UNTIL today");
    subStart = +all.subscriptions_added || 0; subStop = +all.subscriptions_canceled || 0; subAdd30 = +d30.subscriptions_added || 0; subCan30 = +d30.subscriptions_canceled || 0;
    if (subStart) subActive = subStart - subStop;
    // per dag siste 30 d: nye og avsluttede; aktive per dag regnes bakover fra dagens tall
    const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ query: "query($s: String!) { shopifyqlQuery(query: $s) { tableData { rows } parseErrors } }", variables: { s: `FROM subscriptions SHOW subscriptions_added, subscriptions_canceled TIMESERIES day SINCE ${DAYS[0]} UNTIL today` } }) });
    const rows = (await r.json()).data?.shopifyqlQuery?.tableData?.rows || [];
    for (const row of rows) { const x = daily[String(row.day).slice(0, 10)]; if (x) { x.subAdd = +row.subscriptions_added || 0; x.subCan = +row.subscriptions_canceled || 0; } }
    // rekke: antall hele uker på rad (bakover fra forrige uke) med flere nye enn avsluttede abonnement
    const wr = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ query: "query($s: String!) { shopifyqlQuery(query: $s) { tableData { rows } parseErrors } }", variables: { s: "FROM subscriptions SHOW subscriptions_added, subscriptions_canceled TIMESERIES week SINCE 2025-01-01 UNTIL today" } }) });
    const weeks = ((await wr.json()).data?.shopifyqlQuery?.tableData?.rows || []).slice(0, -1); // siste rad = uka som pågår
    for (const w of weeks.reverse()) { if ((+w.subscriptions_added || 0) > (+w.subscriptions_canceled || 0)) subRekke++; else break; }
    if (subActive !== null) { let live = subActive; for (const d of [...DAYS].reverse()) { daily[d].subLive = live; live -= (daily[d].subAdd || 0) - (daily[d].subCan || 0); } }
  } catch (e) { console.error("ShopifyQL utilgjengelig:", e.message); }
  return { daily, lager, geo, kunder, perKunde, perKundeEks, ukedag: ukedagSnitt, subActive, subStart, subStop, subAdd30, subCan30, subRekke, totalt, rekord, nyKunde30, subOrdreEks, subOrdreN: renOrders.length, subRen42, subOrdre, nyeKunder: await fetchNyeKunder(SHOP, H), kohort, at: NOW.toISOString() };
}

// nye kunder per Oslo-dag (førstegangsordre, Shopify kundereise): antall, abonnementsstartere og dekningsbidrag på første ordre,
// totalt og for dem med Meta i første eller siste besøk (facebook/instagram/fb/ig/meta). Valgfri → null.
async function fetchNyeKunder(SHOP, H) {
  try {
    const per = {}; let after = null;
    const meta = v => v && /facebook|instagram|\bfb\b|\big\b|meta/i.test((v.source || "") + " " + (v.utmParameters?.source || ""));
    for (;;) {
      const q = `query($a: String) { orders(first: 100, after: $a, query: "created_at:>=${DAYS[0]}", sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { createdAt test cancelledAt displayFinancialStatus tags currentTotalPriceSet { shopMoney { amount } } currentTotalTaxSet { shopMoney { amount } } lineItems(first: 20) { nodes { sku currentQuantity } } customerJourneySummary { customerOrderIndex firstVisit { source utmParameters { source } } lastVisit { source utmParameters { source } } } } } }`;
      const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ query: q, variables: { a: after } }) });
      const j = await r.json(); if (j.errors) throw new Error(j.errors[0]?.message);
      const o = j.data.orders;
      for (const n of o.nodes) {
        const k = n.customerJourneySummary, inkl = +n.currentTotalPriceSet.shopMoney.amount;
        if (n.test || n.cancelledAt || k?.customerOrderIndex !== 1 || !(inkl > 0) || !["PAID", "PARTIALLY_REFUNDED", "PARTIALLY_PAID"].includes(n.displayFinancialStatus) || n.tags.some(t => /seeding/i.test(t))) continue;
        const li = n.lineItems.nodes.filter(x => x.currentQuantity > 0), db = dbOrdre(inkl - +n.currentTotalTaxSet.shopMoney.amount, inkl, li.filter(x => /^PACE0[12]$/.test(x.sku || "")).reduce((y, x) => y + x.currentQuantity, 0), li.length);
        const sub = n.tags.some(t => /subscription first order/i.test(t)) ? 1 : 0, m = meta(k.firstVisit) || meta(k.lastVisit);
        const x = (per[osloDay(new Date(n.createdAt))] ||= { n: 0, nM: 0, sub: 0, subM: 0, db: 0, dbM: 0 });
        x.n++; x.sub += sub; x.db += db; if (m) { x.nM++; x.subM += sub; x.dbM += db; }
      }
      if (!o.pageInfo.hasNextPage) break; after = o.pageInfo.endCursor;
    }
    return per;
  } catch (e) { console.error("Kundereise utilgjengelig:", e.message); return null; }
}

// ---------- 3a. Meta-annonsekostnad fra Marketing API (Insights), brukes når META_ACCESS_TOKEN finnes ----------
// Forbruk per dag i annonsekontoens tidssone (skal være Europe/Oslo; sjekkes mot timezone_name). Dagen i dag er ufullstendig
// og regnes ikke som dekket. Feiler kallet, faller bygget tilbake til kvitteringene (3b).
async function fetchMetaSpendApi() {
  const token = env("META_ACCESS_TOKEN"), act = env("META_AD_ACCOUNT", "act_410230529686773"), V = "v23.0";
  const get = async (path, params) => {
    const r = await fetch(`https://graph.facebook.com/${V}/${path}?${new URLSearchParams({ ...params, access_token: token })}`);
    const j = await r.json();
    if (!r.ok || j.error) throw new Error("Meta API: " + (j.error?.message || r.status));
    return j;
  };
  const acc = await get(act, { fields: "timezone_name,currency,account_id" });
  if (acc.timezone_name !== OSLO) throw new Error(`Meta API: kontoens tidssone er ${acc.timezone_name}, forventet ${OSLO}`);
  if (acc.currency !== "NOK") throw new Error(`Meta API: valuta ${acc.currency}, forventet NOK`);
  const daily = {}; let next = null;
  const first = await get(`${act}/insights`, { fields: "spend", level: "account", time_increment: "1", limit: "100", time_range: JSON.stringify({ since: DAYS[0], until: TODAY }) });
  for (let page = first; page; page = next ? await (await fetch(next)).json() : null) {
    for (const row of page.data || []) daily[row.date_start] = +row.spend || 0;
    next = page.paging?.next || null;
  }
  const coveredThrough = addDays(TODAY, -1);
  return { daily, coveredThrough, source: "api", account: acc.account_id };
}

// ---------- 3b. Meta-annonsekostnad fra kvitteringsmailer (hei@getpace.no), reserve ----------
// "Amount billed: NOKx Date range: <fra> - <til>" fordeles på Oslo-kalenderdager i perioden (sum = kvitteringen).
// Dager etter siste kvittering er ikke fakturert ennå → null (ukjent), ikke 0.
async function fetchMetaSpend() {
  const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GMAIL_CLIENT_ID"), client_secret: env("GMAIL_CLIENT_SECRET"), refresh_token: env("GMAIL_REFRESH_TOKEN"), grant_type: "refresh_token" }) });
  const tj = await tr.json();
  if (!tj.access_token) throw new Error("Gmail: token-feil " + (tj.error || tr.status));
  const G = { Authorization: "Bearer " + tj.access_token };
  const q = encodeURIComponent('from:noreply@business-updates.facebook.com subject:"Meta ads receipt" newer_than:45d');
  const ids = []; let pageToken = "";
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100${pageToken ? "&pageToken=" + pageToken : ""}`, { headers: G });
    if (!r.ok) throw new Error("Gmail list " + r.status);
    const j = await r.json(); ids.push(...(j.messages || []).map(m => m.id)); pageToken = j.nextPageToken || ""; if (!pageToken) break;
  }
  const b64 = s => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const textOf = p => { if (!p) return ""; let t = ""; if (p.body?.data && /text\/(plain|html)/.test(p.mimeType || "")) t += b64(p.body.data) + "\n"; for (const c of p.parts || []) t += textOf(c); return t; };
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const parseD = s => { // kvitteringstid i Oslo-tid → Date (UTC), DST-riktig
    const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)/.exec(s); if (!m) return null;
    let h = +m[4] % 12; if (m[6] === "PM") h += 12;
    const guess = new Date(Date.UTC(+m[3], MON[m[1]], +m[2], h, +m[5]));
    return new Date(guess.getTime() - osloOffsetMin(guess) * 6e4);
  };
  const daily = {}; const seen = new Set(); const receipts = []; let last = null, nRec = 0;
  for (const id of ids) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: G });
    if (!r.ok) throw new Error("Gmail get " + r.status);
    const msg = await r.json();
    const t = textOf(msg.payload).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const m = /Amount billed:\s*NOK\s?([\d,. ]+?\.\d{2})\s*Date range:\s*(.+?)\s*-\s*(.+?)\s*Product type/.exec(t);
    if (!m) continue;
    const ref = (/Reference number:\s*([A-Z0-9]+)/.exec(t) || [])[1] || id;
    if (seen.has(ref)) continue; seen.add(ref);
    const amount = +m[1].replace(/[ ,]/g, ""), a = parseD(m[2]), b = parseD(m[3]);
    if (!a || !b || b <= a || !(amount > 0)) continue;
    nRec++; if (!last || b > last) last = b; receipts.push({ amount, at: b });
    // fordel på Oslo-kalenderdager etter antall timer av perioden som faller på hver dag
    const dayStartUtc = ymd => { const g = new Date(ymd + "T00:00:00Z"); return new Date(g.getTime() - osloOffsetMin(g) * 6e4); };
    const parts = []; let d = osloDay(a); let total = 0;
    while (true) { const s0 = Math.max(dayStartUtc(d).getTime(), a.getTime()), s1 = Math.min(dayStartUtc(addDays(d, 1)).getTime(), b.getTime()); const w = Math.max(0, s1 - s0); parts.push([d, w]); total += w; if (dayStartUtc(addDays(d, 1)).getTime() >= b.getTime()) break; d = addDays(d, 1); }
    for (const [k, w] of parts) daily[k] = (daily[k] || 0) + amount * (w / total);
  }
  if (!nRec) throw new Error("Gmail: ingen Meta-kvitteringer funnet");
  // siste kvittering slutter ofte midt på dagen: den dagen er bare delvis dekket og regnes ikke som dekket
  const coveredThrough = osloHour(last) >= 23 ? osloDay(last) : addDays(osloDay(last), -1);
  return { daily, coveredThrough, nRec, last, receipts, source: "kvitteringer" };
}

// ---------- 3c. Ubesvarte kundehenvendelser i hei@getpace.no ----------
// Tråder i innboksen mottatt f.o.m. HENV_FRA der siste melding ikke er fra oss. Automatiske avsendere (kvitteringer, varsler,
// nyhetsbrev) telles ikke; Shopify-kontaktskjema («Ny kundemelding») telles, for det er kunder.
const HENV_FRA = "2026-10-20"; // Mortens start for tellingen (20.10.2026)
async function gmailAuth() {
  const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GMAIL_CLIENT_ID"), client_secret: env("GMAIL_CLIENT_SECRET"), refresh_token: env("GMAIL_REFRESH_TOKEN"), grant_type: "refresh_token" }) });
  const tj = await tr.json();
  if (!tj.access_token) throw new Error("Gmail: token-feil " + (tj.error || tr.status));
  return { Authorization: "Bearer " + tj.access_token };
}
const AUTO_FROM = /no-?reply|notification|mailer-daemon|facebookmail|business-updates\.facebook|@google\.com|@accounts\.google|@shopify\.com|@stripe\.com|@klarna|@vipps|@dnb\.no|@360logistics|@bring\.com|@posten\.no|@postnord|newsletter|nyhetsbrev|info@|support@|kundeservice@|hello@|team@|@linkedin|@meta\.com|@fiken|@tripletex|@github\.com/i;
const OSS = /@getpace\.no/i; // hei@ og aliasene (morten@ osv.)
async function fetchHenvendelser() {
  const G = await gmailAuth();
  const q = encodeURIComponent(`in:inbox -in:chats after:${addDays(HENV_FRA, -1).replace(/-/g, "/")}`);
  const ids = []; let pageToken = "";
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${q}&maxResults=100${pageToken ? "&pageToken=" + pageToken : ""}`, { headers: G });
    if (!r.ok) throw new Error("Gmail threads " + r.status);
    const j = await r.json(); ids.push(...(j.threads || []).map(t => t.id)); pageToken = j.nextPageToken || ""; if (!pageToken) break;
  }
  const hdr = (m, n) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
  const open = [];
  for (const id of ids) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: G });
    if (!r.ok) throw new Error("Gmail thread " + r.status);
    const t = await r.json(); const msgs = (t.messages || []).slice().sort((a, b) => +a.internalDate - +b.internalDate);
    if (!msgs.length) continue;
    const first = msgs[0], last = msgs[msgs.length - 1];
    const from = hdr(first, "From"), subject = hdr(first, "Subject");
    const lastFrom = hdr(last, "From"), vaarTraad = OSS.test(from); // tråd vi startet: avsender = den som svarte
    const kunde = /ny kundemelding/i.test(subject) || !AUTO_FROM.test(vaarTraad ? lastFrom : from);
    if (!kunde) continue;
    if (OSS.test(lastFrom)) continue; // vi har svart sist
    if (osloDay(new Date(+first.internalDate)) < HENV_FRA) continue; // eldre tråd som fikk nytt svar
    const avsender = vaarTraad ? lastFrom : from;
    const navn = avsender.replace(/<.*>/, "").replace(/"/g, "").trim() || avsender;
    open.push({ d: osloDay(new Date(+last.internalDate)), navn, subject });
  }
  open.sort((a, b) => a.d < b.d ? -1 : 1);
  return { n: open.length, open, threads: ids.length };
}

// ---------- 4. Kasse (manuell) og kjente forfall ----------
function parseKasse() {
  const [kasse, kasse_dato, gjeld, gjeld_note, sitron_bestfor] = env("PACE_KASSE").split("|").map(s => s.trim());
  if (!Number.isFinite(+kasse) || !kasse_dato) throw new Error("PACE_KASSE: ugyldig format");
  return { kasse: +kasse, kasse_dato, gjeld: +gjeld || 0, gjeld_note: gjeld_note || "", sitron_bestfor: sitron_bestfor || "" };
}
const dmy = s => { const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s || ""); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };

// ---------- 5. Hent ----------
const [tasks, shop] = await Promise.all([fetchBoard(), fetchShopify()]);
let meta = null, metaErr = "";
// API først (varig kilde), ellers kvitteringene (stoppet 12.10.2026 som fast kilde)
if (process.env.META_ACCESS_TOKEN) { try { meta = await fetchMetaSpendApi(); } catch (e) { metaErr = e.message; console.error("Meta API utilgjengelig:", e.message); } }
if (!meta) { try { meta = await fetchMetaSpend(); metaErr = ""; } catch (e) { metaErr = (metaErr ? metaErr + " · " : "") + e.message; console.error("Meta/CAC utilgjengelig:", e.message); } }
// 3c. Manuelt avleste dagsbeløp fra Ads Manager (data/meta-manuell.json: {"daily":{"YYYY-MM-DD": kr}}), brukes for dager etter siste dekkede dag
// til API-en er på plass. Manuelt avleste dager VINNER over kvitteringsfordelingen (kvitteringer kan være små/skjeve, f.eks. 0,02 kr for hele 22.10 som gjorde 13.–22.10 til «dekket» med 0 kr). Dager uten oppføring forblir ukjente (null), ikke 0.
let manuell = {};
try { manuell = JSON.parse(readFileSync(path.join(DIR, "data", "meta-manuell.json"), "utf8")).daily || {}; } catch {}
if (meta) meta.manual = manuell; else if (Object.keys(manuell).length) meta = { daily: {}, coveredThrough: "0000-00-00", source: "manuell", manual: manuell };
const metaKilde = meta?.source === "api" ? "Meta API" : meta?.source === "manuell" ? "Meta manuelt" : "Meta-kvitteringer";
let henv = null, henvErr = "";
try { henv = await fetchHenvendelser(); } catch (e) { henvErr = e.message; console.error("Henvendelser utilgjengelig:", e.message); }
const T = parseKasse();
let plan = null;
try { plan = readPlan(env("STATICRYPT_PASSWORD", "")); } catch (e) { console.error("Pace 2.0-plan utilgjengelig:", e.message); }

// ---------- 5b. Kanalkost (manuell månedsfil) ----------
// data/kanal-kost.json: {"adtraction":{"fast":995,"provisjon":{"YYYY-MM":kr|null}},"google":{"YYYY-MM":kr|null}} eks mva. null/mangler = ukjent (ikke 0).
let kanalKost = { adtraction: { fast: 995, provisjon: {} }, google: {} };
try { kanalKost = { ...kanalKost, ...JSON.parse(readFileSync(path.join(DIR, "data", "kanal-kost.json"), "utf8")) }; } catch {}
const daysInMonth = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
const perDag = (tab, d) => { const v = tab?.[d.slice(0, 7)]; return v == null ? null : v / daysInMonth(d.slice(0, 7)); };
const adtrDag = d => { const p = perDag(kanalKost.adtraction?.provisjon, d); return p == null ? null : (kanalKost.adtraction?.fast ?? 995) / daysInMonth(d.slice(0, 7)) + p; };

// ---------- 6. Tall ----------
const series = DAYS.map(d => { const x = shop.daily[d]; const covered = meta && d <= meta.coveredThrough; return { d, ordre: x.ordre, oms: Math.round(x.oms * 100) / 100, eks: Math.round(x.eks * 100) / 100, nye: x.nye, u1: x.u1, u2: x.u2, subNew: x.subNew, subRen: x.subRen, subAdd: x.subAdd ?? null, subCan: x.subCan ?? null, subLive: x.subLive ?? null, meta: meta && meta.manual[d] != null ? Math.round(meta.manual[d] * 100) / 100 : covered ? Math.round((meta.daily[d] || 0) * 100) / 100 : null, manuell: !!(meta && meta.manual[d] != null), bml: Math.round(x.bmlKost * 100) / 100, adtr: adtrDag(d), google: perDag(kanalKost.google, d), nyeK: x.nyeK, dbK: x.dbK, ordreK: x.ordreK, dbOK: x.dbOK }; });
const today = series[series.length - 1];
const win = n => series.slice(-n - 1, -1); // n hele dager t.o.m. i går
const sum = (a, k) => a.reduce((x, r) => x + (r[k] || 0), 0);
const fmtD = ymd => ymd.slice(8, 10) + "." + ymd.slice(5, 7);
const MON = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const monLabel = ymd => MON[+ymd.slice(5, 7) - 1] + " " + ymd.slice(2, 4); // "okt 26", samme form som planen
// bare dager med annonsekostnad teller (kost og nye kunder); dager uten annonser gir organiske kunder som ellers trekker CAC kunstig ned
const cac = n => { const w = win(n).filter(r => r.meta !== null && r.meta > 0); const s = sum(w, "meta"), ny = sum(w, "nye"); return { spend: s, nye: ny, days: w.length, cac: ny ? s / ny : null }; };
// CAC per kanal: kostnad i vinduet / nye kunder (første ordre) attribuert til kanalen, bare dager der kostnaden er kjent
const KNAVN = { meta: "Meta", bml: "BML-podcast", adtr: "Adtraction", google: "Google Ads", org: "Organisk/ukjent" };
const KKOST = { meta: "Ads Manager (kvitteringer + daglig avlesning)", bml: "30 % provisjon av varesalg eks mva på BML20-ordre", adtr: "995 kr/mnd + provisjon fra faktura (data/kanal-kost.json)", google: "DNB-kort, månedsbeløp i data/kanal-kost.json", org: "ingen kostnad" };
// alle ordre merket med kanalen teller (ikke bare første ordre); nye kunder vises i tillegg
const kanalTall = (k, n) => { const all = win(n); const w = k === "org" ? all : all.filter(r => r[k] !== null && r[k] !== undefined); const kost = k === "org" ? 0 : sum(w, k); const ordre = w.reduce((x, r) => x + (r.ordreK?.[k] || 0), 0); const nye = w.reduce((x, r) => x + (r.nyeK?.[k] || 0), 0); const db = w.reduce((x, r) => x + (r.dbOK?.[k] || 0), 0); return { kost, ordre, nye, db: ordre ? db / ordre : null, days: w.length, cac: nye && k !== "org" ? kost / nye : null, perOrdre: ordre && k !== "org" ? kost / ordre : null }; };
const kanalCard = (k, n = 30) => { const t = kanalTall(k, n); const ukjent = t.days === 0; const v = k === "org" ? nf(t.ordre) : ukjent ? "–" : t.cac != null ? nf(t.cac) + " kr" : "–";
  const sub = k === "org" ? `ordre ${n} d · ${t.nye} nye · 0 kr` : ukjent ? "kost ukjent" : `${nf(t.kost)} kr / ${t.nye} nye · ${t.ordre} ordre${t.perOrdre != null ? ` (${nf(t.perOrdre)} per ordre)` : ""}${t.days < n ? ` · ${t.days} d` : ""}${t.db != null ? ` · DB ${nf(t.db)}` : ""}`;
  return (k === "meta" ? mcard : card)(k === "org" ? `Ordre ${KNAVN[k]}` : `Kost per ny kunde ${KNAVN[k]}`, v, sub, k === "org" ? "c-salg" : "c-cac", `${KNAVN[k]}, siste ${n} hele dager. Kostnad: ${KKOST[k]}. Hovedtall = kostnad delt på NYE kunder hvis første ordre er merket med kanalen (BML20-kode, fbclid/utm/__adtr_channel, gclid). Ordre = alle betalte ordre merket med kanalen, også gjenkjøp; «per ordre» = kostnad delt på dem. Shopify finner færre Meta-kjøp enn Metas piksel, så Meta-tallet per ny kunde er et tak. DB = dekningsbidrag per ordre.${ukjent ? " Kostnaden mangler for alle dagene i vinduet." : t.days < n ? ` ${t.days} av ${n} dager har kjent kostnad; kunder telles bare på de dagene.` : ""}`); };
// kort: kort undertekst (én linje), detaljer i title-tooltip
// Meta-data som ikke er oppdatert t.o.m. i går: kortene merkes synlig (stiplet ramme + tekst), tallene vises likevel
const metaSist = series.filter(r => r.meta !== null).map(r => r.d).pop() || null;
const metaStale = !metaSist || metaSist < addDays(TODAY, -1);
const staleTxt = metaStale ? ` · ⚠ IKKE OPPDATERT: Meta mangler fra ${metaSist ? fmtD(addDays(metaSist, 1)) : "start"}` : "";
const mcard = (k, v, s, cls, tip) => card(k, v, s + staleTxt, cls + (metaStale ? " stale" : ""), (tip || "") + (metaStale ? ` ADVARSEL: Meta-annonsekost mangler fra ${metaSist ? fmtD(addDays(metaSist, 1)) : "start"}; tallet er ikke oppdatert.` : ""));
const card = (k, v, s, cls, tip) => `<div class="stat ${cls}" title="${esc(tip || "")}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const rek = shop.rekord?.kr ? shop.rekord : null, slaatt = rek && today.oms > rek.kr;
const todayCard = () => card("Salg i dag", nf(today.oms) + " kr" + (slaatt ? " 🏆" : ""), `${today.ordre} ordre · ${today.nye} nye${slaatt ? " · årets beste dag" : ""}`, "c-salg", `Ordreverdi inkl. mva i dag t.o.m. ${stamp}${rek ? `. Årets beste dag før i dag: ${nf(rek.kr)} kr (${fmtD(rek.d)})` : ""}`);
const salgCard = (n) => { const w = win(n); return card(`Salg ${n} d`, nf(sum(w, "oms")) + " kr", `${sum(w, "ordre")} ordre · ${sum(w, "nye")} nye`, "c-salg", `Ordreverdi inkl. mva siste ${n} hele dager t.o.m. i går, ${sum(w, "nye")} nye kunder`); };
// grunnlinje uten annonser: nye kunder per dag 18.08–27.09.2026 (Meta av, 41 dager, 61 nye = 1,49). Oppdateres etter neste av-periode.
const BASELINE_NYE = 1.49, BASELINE_KILDE = "18.08–27.09.2026, 41 dager uten Meta, 61 nye";
const ekstraCard = (n) => { if (!meta) return mcard(`Kost per ekstra kunde ${n} d`, "–", "Meta-data mangler", "c-cac", metaErr); const c = cac(n); const forv = c.days * BASELINE_NYE, ekstra = c.nye - forv;
  return mcard(`Kost per ekstra kunde ${n} d`, ekstra > 0 ? nf(c.spend / ekstra) + " kr" : "–", ekstra > 0 ? `${nf(c.spend)} / (${c.nye} nye − ${nf(forv)} grunnlinje)${c.days < n ? ` · ${c.days} d` : ""}` : `${c.nye} nye ≤ grunnlinje ${nf(forv)}`, "c-cac", `Meta-kostnad på dager med annonser delt på nye kunder UTOVER dem som kommer uansett (${BASELINE_NYE} per dag, ${BASELINE_KILDE}). Dette er tallet stoppregelen måler; CAC ${n} d deler på alle nye og undervurderer kostnaden.`); };
const cacCard = (n) => { if (!meta) return mcard(`CAC ${n} d`, "–", "Meta-data mangler", "c-cac", metaErr); const c = cac(n); return mcard(`CAC ${n} d`, c.cac ? nf(c.cac) + " kr" : "–", `${nf(c.spend)} / ${c.nye} nye${c.days < n ? ` · ${c.days} d` : ""}`, "c-cac", `Meta ${nf(c.spend)} kr delt på ${c.nye} nye kunder${c.days < n ? ` (${c.days} av ${n} dager har Meta-data)` : ""}. Snitt over ALLE nye kunder på annonsedager, også de som ville kommet uansett; se «Kost per ekstra kunde»`); };
// annonsekost: Meta-forbruk på fakturerte dager i vinduet; kr/dag over de samme dagene
const adsCard = (n) => { if (!meta) return mcard(`Annonser ${n} d`, "–", "Meta-data mangler", "c-ads", metaErr); const w = win(n).filter(r => r.meta !== null); const s = sum(w, "meta");
  // ingen dekkede dager i vinduet: kostnaden er ukjent, ikke 0 (annonsene kan gå uten at kilden har fått tallene ennå)
  if (!w.length) return mcard(`Annonser ${n} d`, "–", `ingen Meta-data etter ${fmtD(meta.coveredThrough)}`, "c-ads", `Meta-annonsekostnad mangler for alle ${n} dagene (siste dekkede dag ${fmtD(meta.coveredThrough)}). Annonsene kan ha gått; forbruket er ikke hentet ennå.`);
  const m = w.filter(r => r.manuell).length, sist = w[w.length - 1].d;
  return mcard(`Annonser ${n} d`, nf(s) + " kr", `~${nf(s / w.length)} kr/dag · ${w.length < n ? `${w.length} av ${n} d · ` : ""}t.o.m. ${fmtD(sist)}`, "c-ads", `Meta-annonsekostnad ${w.length} av ${n} dager (kvitteringer t.o.m. ${fmtD(meta.coveredThrough)}${m ? `, ${m} dager lest manuelt fra Ads Manager` : ""}; dager uten tall er ukjente, ikke 0)`); };
// lager: tomdato ved takten siste 30 hele dager; neste batch for smaken fra Pace 2.0-planen
const lagerCard = (navn, sku, key, bestfor, flavor) => {
  const qty = shop.lager[sku], perDag = sum(win(30), key) / 30;
  const batch = plan?.batches?.find(b => b.f === flavor);
  const tom = perDag > 0 ? addDays(TODAY, Math.floor(qty / perDag)) : null;
  let s = tom ? `tom ~${monLabel(tom)}` : "ingen takt";
  let tip = perDag > 0 ? `${nf(perDag * 7)} sjaktler per uke siste 30 d, ${nf(qty / perDag / 7)} uker dekning, tom rundt ${fmtD(tom)}.${tom.slice(0, 4)}` : "ingen målbar takt siste 30 d";
  if (batch) tip += ` · neste batch i planen: bestilles ${batch.bestilt}, levert ${batch.levert}`;
  let rest = 0;
  if (bestfor && perDag > 0) {
    const bf = dmy(bestfor);
    rest = Math.max(0, qty - perDag * (Date.parse(bf) - Date.parse(TODAY)) / 864e5);
    tip += ` · best før ${bestfor}${rest > 0 ? `, ~${nf(rest)} går ut ved dagens takt` : ""}`;
  }
  s += rest > 0 ? ` · ~${nf(rest)} utgår` : batch ? ` · bestill ${batch.bestilt}` : "";
  return card(`Lager ${navn}`, nf(qty) + " stk", s, "c-lager", tip);
};
const subNow = today.subAct, subNew30 = sum(win(30), "subNew"), subRen30 = sum(win(30), "subRen");
const subCard = shop.subActive !== null
  ? card("Aktive abonnement", nf(shop.subActive), `+${sum(series.slice(-30), "subAdd")} nye · −${sum(series.slice(-30), "subCan")} avsluttet (30 d)${shop.subRekke >= 2 ? ` · 🔥 ${shop.subRekke} uker på rad med vekst` : ""}`, "c-sub", `${nf(shop.subStart)} abonnement startet og ${nf(shop.subStop)} avsluttet totalt ifølge Shopify Subscriptions (Shopify-analyse).. Siste 30 d: ${sum(series.slice(-30), "subAdd")} nye, ${sum(series.slice(-30), "subCan")} avsluttet`)
  : card("Kunder m/ abonnementsordre", nf(subNow), `+${subNew30} nye · ${subRen30} forny. (30 d)`, "c-sub", `Unike kunder med abonnementsordre siste 30 dager (ekte abonnementsstatus utilgjengelig)`);
// abonnement per dag: aktive abonnement × snitt per fornyelse eks mva, fordelt på leveringsintervallet (alle planer = hver 6. uke)
const SUB_DAGER = 42;
const subDagCard = () => { if (shop.subActive === null || !shop.subOrdreN) return card("Fornyelser per dag", "–", "abonnementsdata mangler", "c-sub", "Krever aktive abonnement fra Shopify Subscriptions og minst én fornyelsesordre");
  const r = shop.subRen42, kr = r.eks / SUB_DAGER, modell = shop.subActive * shop.subOrdreEks / SUB_DAGER;
  return card("Fornyelser per dag", nf(kr) + " kr", `${r.n} forny. ${SUB_DAGER} d · ${r.betalende} betalende · eks mva`, "c-sub", `Faktisk fornyelsesomsetning eks mva siste ${SUB_DAGER} hele dager (én leveringssyklus): ${r.n} fornyelsesordre fra ${r.kunder} kunder = ${nf(r.eks)} kr (${r.betalende} kunder fikk abonnementsordre i perioden, inkl. nye) ≈ ${nf(kr * 30)} kr per 30 d. Førstegangsordre er ikke med. Til sammenligning: ${nf(shop.subActive)} «aktive» i Shopify-statistikken × ${nf(shop.subOrdreEks)} kr / ${SUB_DAGER} d ville gitt ${nf(modell)} kr/dag; avviket betyr at statistikken teller flere aktive enn som faktisk betaler.`); };
// resultat av betalt reklame: dekningsbidrag per reklamekrone (POAS) på dager med Meta-kvittering. Over 1,00 = reklamen lønner seg.
// Konservativt = bare nye kunder med Meta i kundereisen; alle nye = alle førstegangskjøpere. Riktig tall krever inkrementalitetstest.
// «Etter 180 d» = nye kunder × historisk 180-dagers bidrag for sin gruppe (startet med / uten abonnement).
const poasCard = () => {
  const w = meta ? win(30).filter(r => r.meta !== null && r.meta > 0) : [], nk = shop.nyeKunder, k = shop.kohort;
  if (!w.length || !nk || !k.sub.n || !k.non.n) return mcard("Fortjeneste per reklamekrone", "–", "Meta-data eller kundereise mangler", "c-cac", "Krever Meta-kostnad per dag og Shopify-kundereise");
  const S = sum(w, "meta"), a = w.reduce((t, r) => { const x = nk[r.d]; if (x) for (const key in t) t[key] += x[key]; return t; }, { n: 0, nM: 0, sub: 0, subM: 0, db: 0, dbM: 0 });
  const vs = k.sub.db / k.sub.n, vn = k.non.db / k.non.n, x = v => v.toFixed(2).replace(".", ",");
  const fA = a.db / S, fM = a.dbM / S, hA = (a.sub * vs + (a.n - a.sub) * vn) / S, hM = (a.subM * vs + (a.nM - a.subM) * vn) / S;
  return mcard("Fortjeneste per reklamekrone", x(fM), `siste 30 d · konservativt · alle nye ${x(fA)} · etter 180 d ${x(hM)}`, "c-cac",
    `Dekningsbidrag (salg eks mva − varer, plukk, frakt, gebyr) per krone Meta-reklame, ${fmtD(w[0].d)}–${fmtD(w[w.length - 1].d)} (${w.length} dager med kvittering, ${nf(S)} kr). `
    + `Konservativt: ${a.nM} nye kunder med Meta i kundereisen ga ${nf(a.dbM)} kr på første kjøp (${x(fM)}); med forventet 180-dagers bidrag ${x(hM)}. `
    + `Alle ${a.n} nye kunder: ${nf(a.db)} kr på første kjøp (${x(fA)}); etter 180 d ${x(hA)}. `
    + `180 d bygger på historikk: startet med abonnement ${nf(vs)} kr (${k.sub.n} kunder), uten ${nf(vn)} kr (${k.non.n} kunder), dagens kostnader. Over 1,00 = reklamen lønner seg. `
    + `Sannheten ligger mellom tallene til en pausetest er gjort. Faste kostnader (360-minimum, programvare) er ikke med.`);
};
// snitt per kunde: hva en kunde legger igjen i snitt over hele historikken, sammenlignet med CAC 30 d
// ny kunde 30 d: hva kunder som kom i de siste 30 hele dagene har kjøpt for i samme periode, eks mva (CAC er Meta-kost uten norsk mva)
const kundeCard = () => { const c = meta ? cac(30).cac : null, k = shop.nyKunde30;
  if (!k?.n) return card("Snitt per kunde", nf(shop.perKunde) + " kr", `${nf(shop.perKundeEks)} kr eks mva`, "c-cac", `All ordreverdi inkl. mva delt på ${nf(shop.kunder)} unike kunder (hele historikken)`);
  return card("Omsetning per ny kunde 30 d", nf(k.eks) + " kr", c ? `${(k.eks / c).toFixed(1).replace(".", ",")}× CAC 30 d · eks mva, før varekost` : "eks mva, før varekost", "c-cac", `${k.n} nye kunder siste 30 hele dager har i snitt kjøpt for ${nf(k.eks)} kr eks mva i samme periode. Dette er omsetning, ikke dekningsbidrag (DB per ordre er ca. 213 kr)${c ? `. CAC 30 d er ${nf(c)} kr (bare dager med Meta-data)` : ""}. Snitt per kunde over hele historikken: ${nf(shop.perKunde)} kr inkl. mva (${nf(shop.perKundeEks)} eks mva)`); };
// ubesvarte kundehenvendelser i hei@getpace.no siden HENV_FRA (tråder der siste melding ikke er fra oss)
const henvCard = () => { if (!henv) return card("Ubesvarte henvendelser", "–", "Gmail utilgjengelig", "c-ads", henvErr);
  const eldst = henv.open[0], dager = eldst ? Math.round((Date.parse(TODAY) - Date.parse(eldst.d)) / 864e5) : 0;
  const liste = henv.open.slice(0, 8).map(o => `${fmtD(o.d)} ${o.navn}: ${o.subject}`).join(" · ");
  return card("Ubesvarte henvendelser", nf(henv.n), henv.n ? `eldste ${dager === 0 ? "i dag" : dager + " d"} · siden ${fmtD(HENV_FRA)}` : `alle besvart · siden ${fmtD(HENV_FRA)}`, henv.n ? "c-ads" : "c-kasse",
    `Kundetråder i hei@getpace.no mottatt f.o.m. ${fmtD(HENV_FRA)} der siste melding ikke er fra oss. Automatiske avsendere (kvitteringer, varsler) telles ikke; Shopify-kontaktskjema telles.${liste ? " Åpne: " + liste : ""}`); };
const cards = todayCard() + henvCard() + salgCard(7) + salgCard(30) + subCard
  + poasCard()
  + adsCard(7) + adsCard(30) + cacCard(7) + cacCard(30) + ekstraCard(30)
  + kanalCard("meta") + kanalCard("bml") + kanalCard("adtr") + kanalCard("google") + kanalCard("org")
  + kundeCard()
  + card("Unike kunder", nf(shop.kunder), `+${sum(win(30), "nye")} nye siste 30 d`, "c-salg", "Kundeprofiler med minst én betalt ordre i hele historikken (uten test- og seeding-ordre)")
  + card("Kasse", nf(T.kasse) + " kr", "bankbalanse lagt inn " + T.kasse_dato, "c-kasse", `Bankbalanse lagt inn manuelt ${T.kasse_dato}`)
  + lagerCard("sitron", "PACE01", "u1", T.sitron_bestfor, "Sitron & Lime") + lagerCard("bringebær", "PACE02", "u2", "", "Bringebær");

// datastatus: hvor ferske tallene er per kilde
const datastatus = [`Shopify ${stamp}`, meta ? `${metaKilde} t.o.m. ${metaSist ? fmtD(metaSist) : "–"}${metaStale ? " ⚠ IKKE OPPDATERT" : ""}` : "Meta mangler ⚠", `bankbalanse ${T.kasse_dato}`, plan ? `Pace 2.0-plan ${fmtD(plan.built)}` : "plan mangler"].join(" · ");

const note = `7 og 30 d = hele Oslo-dager t.o.m. i går; «Salg i dag» er dagen så langt. Salg = ordreverdi inkl. mva for ordre opprettet i perioden, etter refusjon, uten test- og seeding-ordre (Shopify ${stamp}). Planraden sammenlignes eks mva. Nye kunder = kundeprofiler opprettet i perioden med betalt ordre. `
  + (meta ? (meta.source === "api" ? `CAC = Meta-annonsekostnad per dag fra Meta Marketing API (t.o.m. ${fmtD(meta.coveredThrough)}; dagen i dag er ufullstendig og holdes utenfor), delt på nye kunder samme dager. ` : `CAC = Meta-annonsekostnad fra kvitteringene i hei@getpace.no, fordelt per dag (dekket t.o.m. ${fmtD(meta.coveredThrough)}; forbruk etter det er ikke fakturert ennå og holdes utenfor), delt på nye kunder samme dager. `) : `CAC mangler: ${esc(metaErr)}. `)
  + (shop.subActive !== null ? `Aktive abonnement = startet minus avsluttet i Shopify Subscriptions (Shopify-analyse). ` : "")
  + `Kost per ny kunde per kanal = kanalens kostnad siste 30 hele dager delt på nye kunder hvis første ordre er merket med kanalen (BML20-kode, Meta-klikk/__adtr_channel fb/ig, annen Adtraction-partner, gclid); per ordre vises i underteksten. Kost per ekstra kunde = Meta-kost delt på nye kunder utover grunnlinjen 1,49 per dag (18.08–27.09 uten Meta); BML-kost = 30 % provisjon av varesalg eks mva, Adtraction = 995/mnd + provisjon fra faktura, Google = kortbelastning per måned (manuelle månedsfiler; mangler = kost ukjent). `
  + `Lager = tilgjengelig hos 360 Logistics; tomdato ved takten siste 30 d. Kasse er bankbalanse lagt inn manuelt (sist ${T.kasse_dato}).`;
const metaInfo = { built_at: NOW.toISOString(), shopify_at: shop.at, label: stamp, today: TODAY, meta_through: meta ? meta.coveredThrough : null, totalt: shop.totalt ?? null, daily: series.slice(-30), ukedag: shop.ukedag, geo: shop.geo, kart: { w: KART.w, h: KART.h, fylker: KART.fylker } };

// ---------- 7. Bygg HTML ----------
let html = readFileSync(TEMPLATE, "utf8");
const js = s => JSON.stringify(s).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const put = (re, val, label) => { if (!re.test(html)) throw new Error("template mangler " + label); html = html.replace(re, () => val); };
put(/\/\*__TASKS__\*\/[\s\S]*?\/\*__TASKS_END__\*\//, `/*__TASKS__*/ const SNAPSHOT = ${js(tasks)}; /*__TASKS_END__*/`, "TASKS");
put(/\/\*__META__\*\/[\s\S]*?\/\*__META_END__\*\//, `/*__META__*/ const META = ${js(metaInfo)}; /*__META_END__*/`, "META");
put(/\/\*__PAGE_TOKEN__\*\/[\s\S]*?\/\*__PAGE_TOKEN_END__\*\//, `/*__PAGE_TOKEN__*/ const PAGE_TOKEN = ${js(process.env.PACE_PAGE_TOKEN || "")}; /*__PAGE_TOKEN_END__*/`, "PAGE_TOKEN");
put(/<!--STATS-->[\s\S]*?<!--\/STATS-->/, `<!--STATS-->${cards}<!--/STATS-->`, "STATS");
put(/<!--DATASTATUS-->[\s\S]*?<!--\/DATASTATUS-->/, `<!--DATASTATUS-->${esc(datastatus)}<!--/DATASTATUS-->`, "DATASTATUS");
put(/<!--STATSNOTE-->[\s\S]*?<!--\/STATSNOTE-->/, `<!--STATSNOTE-->${note}<!--/STATSNOTE-->`, "STATSNOTE");
put(/<!--SYNC-->.*?<!--\/SYNC-->/, `<!--SYNC-->${stamp}<!--/SYNC-->`, "SYNC");
// syntakssjekk av sidens script før publisering
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch (e) { throw new Error("template-JS har syntaksfeil: " + e.message); } }
writeFileSync(PLAIN, html);
const w7 = win(7);
console.log(`bygget: ${tasks.length} kort | 7d ${sum(w7, "ordre")}/${nf(sum(w7, "oms"))} nye ${sum(w7, "nye")} | 30d ${sum(series, "ordre")}/${nf(sum(series, "oms"))} | CAC30 ${meta ? nf(cac(30).cac || 0) : "–"} | lager ${JSON.stringify(shop.lager)} | ${stamp}`);
if (process.env.SKIP_ENCRYPT) process.exit(0);

// ---------- 8. Krypter (custom dark template) ----------
const pw = env("STATICRYPT_PASSWORD");
const salt = env("STATICRYPT_SALT", "843e94067e2339f1a3b9073a407ddde1");
if (!/^[0-9a-f]{32}$/.test(salt)) throw new Error("ugyldig salt");
const tplSrc = path.join(DIR, "node_modules", "staticrypt", "lib", "password_template.html");
let t = readFileSync(tplSrc, "utf8")
  .replace(/(\.staticrypt-form \{[^}]*?)background: #ffffff;/, "$1background: #161b22; border: 1px solid #2a313c; border-radius: 8px;")
  .replace(/(\.staticrypt-password-container \{[^}]*?)background: #f2f2f2;/, "$1background: #0e1116; color: #e6edf3;")
  .replace(/(\.staticrypt-content \{[^}]*?)font-family:[^;]+;/, "$1font-family:-apple-system,\"Segoe UI\",Roboto,sans-serif;")
  .replace(/(\.staticrypt-title \{)/, "$1color:#e6edf3;font-weight:600;")
  .replace(/(\.staticrypt-instructions \{)/, "$1color:#8b949e;");
t = t.replace("</style>", ".staticrypt-form input[type=\"password\"], .staticrypt-form input[type=\"text\"] { color:#ffffff !important; -webkit-text-fill-color:#ffffff; caret-color:#ffffff; font-size:18px !important; letter-spacing:3px; } .staticrypt-form input::placeholder { color:#8b949e; -webkit-text-fill-color:#8b949e; letter-spacing:0; font-size:14px; }</style>");
writeFileSync(path.join(DIR, "pace-template.html"), t);
copyFileSync(PLAIN, path.join(DIR, "pq.html"));
const bin = path.join(DIR, "node_modules", "staticrypt", "cli", "index.js");
execFileSync(process.execPath, [bin, "pq.html", "--short", "--salt", salt, "--template", "pace-template.html", "--template-color-primary", "#58a6ff", "--template-color-secondary", "#0e1116", "--template-title", "Pace-dashboard", "--template-button", "ÅPNE", "--template-instructions", "Skriv inn passord", "--template-placeholder", "Passord", "--remember", "0", "-d", "encrypted"],
  { cwd: DIR, stdio: "inherit", env: { ...process.env, STATICRYPT_PASSWORD: pw } });
copyFileSync(path.join(DIR, "encrypted", "pq.html"), OUT);
for (const f of ["encrypted", ".staticrypt.json", "pace-template.html", "pq.html"]) if (existsSync(path.join(DIR, f))) rmSync(path.join(DIR, f), { recursive: true });
console.log("kryptert ->", OUT);
