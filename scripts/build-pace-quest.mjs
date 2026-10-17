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

if (!process.env.FORCE && !process.env.SKIP_ENCRYPT) { const h = osloHour(NOW); if (h < 6 || h > 23) { console.log("utenfor 06–23 Oslo, hopper over"); process.exit(0); } }

// ---------- 1. Board ----------
async function fetchBoard() {
  const token = env("PACE_BOARD_TOKEN");
  const items = []; let after = null;
  for (let page = 0; page < 20; page++) {
    const q = `query($after: String) { organization(login: "${ORG}") { projectV2(number: ${PROJECT_NUMBER}) {
      items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id
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
    items.push(...p.items.nodes);
    if (!p.items.pageInfo.hasNextPage) break;
    after = p.items.pageInfo.endCursor;
  }
  if (!items.length) throw new Error("GitHub: tomt board, avbryter");
  return items.map(n => {
    const fv = Object.fromEntries(n.fieldValues.nodes.filter(v => v.field).map(v => [v.field.name, v.name ?? v.date]));
    const c = n.content || {};
    return { id: n.id, draft: c.__typename === "DraftIssue" ? c.id : "", body: c.body || "", sec: fv["Status"] || "Innboks", owner: fv["Ansvarlig"] || "Ikke fordelt", strom: fv["Arbeidsstrøm"] || "", kat: fv["Kategori"] || "Oppgave", due: fv["Måldato"] || "", txt: c.title || "(uten tittel)" };
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
  const all = await getAll(`https://${SHOP}/admin/api/${API}/orders.json?status=any&limit=250&created_at_min=${since}&fields=id,created_at,current_total_price,current_total_tax,total_price,cancelled_at,financial_status,test,tags,line_items,customer`, "orders");
  const tags = o => (o.tags || "").split(",").map(s => s.trim().toLowerCase());
  const ok = o => !o.test && !o.cancelled_at && ["paid", "partially_refunded", "partially_paid"].includes(o.financial_status) && !tags(o).includes("seeding");
  const amt = o => +(o.current_total_price ?? o.total_price);
  const allOk = all.filter(ok).filter(o => amt(o) > 0).map(o => ({ ...o, day: osloDay(new Date(o.created_at)) }));
  const orders = allOk.filter(o => o.day >= DAYS[0]);
  const isSubNew = o => tags(o).includes("subscription first order"), isSubRen = o => tags(o).includes("subscription recurring order"), isSub = o => isSubNew(o) || isSubRen(o);
  // per Oslo-dag
  const daily = Object.fromEntries(DAYS.map(d => [d, { d, ordre: 0, oms: 0, eks: 0, nye: 0, u1: 0, u2: 0, subNew: 0, subRen: 0, subAct: 0 }]));
  for (const o of orders) {
    const x = daily[o.day]; if (!x) continue;
    x.ordre++; x.oms += amt(o); x.eks += amt(o) - (+o.current_total_tax || 0);
    if (isSubNew(o)) x.subNew++; if (isSubRen(o)) x.subRen++;
    for (const li of o.line_items || []) { const q = li.current_quantity ?? li.quantity; if (li.sku === "PACE01") x.u1 += q; if (li.sku === "PACE02") x.u2 += q; }
  }
  // aktive abonnenter per dag = unike kunder med abonnementsordre (ny eller fornyelse) siste 30 dager t.o.m. dagen
  const subOrders = allOk.filter(o => isSub(o) && o.customer?.id);
  for (const d of DAYS) { const from = addDays(d, -29); daily[d].subAct = new Set(subOrders.filter(o => o.day >= from && o.day <= d).map(o => o.customer.id)).size; }
  // ny kunde = kundeprofil opprettet i vinduet (Shopify lager profilen ved første ordre); telles én gang, på dagen for kundens TIDLIGSTE betalte ordre
  const firstOrder = {};
  for (const o of orders) { const c = o.customer; if (!c?.id || !c.created_at || osloDay(new Date(c.created_at)) < DAYS[0]) continue; if (!firstOrder[c.id] || o.day < firstOrder[c.id]) firstOrder[c.id] = o.day; }
  for (const d of Object.values(firstOrder)) if (daily[d]) daily[d].nye++;
  // lager per lokasjon (360 Logistics), ikke aggregatet
  const products = await getAll(`https://${SHOP}/admin/api/${API}/products.json?limit=250&fields=id,title,variants`, "products");
  const items = {};
  for (const pr of products) for (const v of pr.variants) if (v.sku === "PACE01" || v.sku === "PACE02") items[v.sku] = v.inventory_item_id;
  if (!items.PACE01 || !items.PACE02) throw new Error("Shopify: fant ikke PACE01/PACE02");
  const lv = await getAll(`https://${SHOP}/admin/api/${API}/inventory_levels.json?inventory_item_ids=${items.PACE01},${items.PACE02}&location_ids=${LOCATION_ID}`, "inventory_levels");
  const lager = {};
  for (const [sku, iid] of Object.entries(items)) { const l = lv.find(x => x.inventory_item_id === iid); if (!l || typeof l.available !== "number") throw new Error("Shopify: ingen gyldig inventory_level for " + sku); lager[sku] = l.available; }
  // gjenkjøp: hele ordrehistorikken (read_all_orders), per kunde: dato for første og senere betalte ordre
  const hist = await getAll(`https://${SHOP}/admin/api/${API}/orders.json?status=any&limit=250&created_at_min=2024-01-01T00:00:00Z&fields=id,created_at,current_total_price,total_price,cancelled_at,financial_status,test,tags,customer,shipping_address`, "orders");
  const byCust = {};
  for (const o of hist.filter(ok).filter(o => amt(o) > 0)) { const id = o.customer?.id; if (id) (byCust[id] ||= []).push(osloDay(new Date(o.created_at))); }
  const buyers = Object.values(byCust).map(a => a.sort());
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
  // Shopify Payments-utbetalinger (likviditet) og aktive abonnement fra Subscriptions-appen (ShopifyQL); begge valgfrie
  let payouts = null, subActive = null;
  try { payouts = (await getAll(`https://${SHOP}/admin/api/${API}/shopify_payments/payouts.json?limit=100&date_min=${addDays(TODAY, -45)}`, "payouts")).map(p => ({ date: p.date, status: p.status, amount: +p.amount })); }
  catch (e) { console.error("utbetalinger utilgjengelig:", e.message); }
  try {
    const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ query: `{ shopifyqlQuery(query: "FROM subscriptions SHOW active_subscriptions SINCE -1d") { tableData { rows } parseErrors } }` }) });
    const v = (await r.json()).data?.shopifyqlQuery?.tableData?.rows?.[0]?.active_subscriptions;
    if (v !== undefined && Number.isFinite(+v)) subActive = +v;
  } catch (e) { console.error("ShopifyQL utilgjengelig:", e.message); }
  return { daily, lager, buyers, geo, payouts, subActive, at: NOW.toISOString() };
}

// ---------- 3. Meta-annonsekostnad fra kvitteringsmailer (hei@getpace.no), valgfri ----------
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
  return { daily, coveredThrough, nRec, last, receipts };
}

// ---------- 4. Kasse (manuell) og kjente forfall ----------
function parseKasse() {
  const [kasse, kasse_dato, gjeld, gjeld_note, sitron_bestfor] = env("PACE_KASSE").split("|").map(s => s.trim());
  if (!Number.isFinite(+kasse) || !kasse_dato) throw new Error("PACE_KASSE: ugyldig format");
  return { kasse: +kasse, kasse_dato, gjeld: +gjeld || 0, gjeld_note: gjeld_note || "", sitron_bestfor: sitron_bestfor || "" };
}
// PACE_FORFALL = "navn|beløp|DD.MM.YYYY;…" (valgfri). Mangler den, brukes gjelden i PACE_KASSE som én post.
function parseForfall(T) {
  const list = (process.env.PACE_FORFALL || "").split(";").map(s => s.trim()).filter(Boolean)
    .map(s => { const [navn, belop, dato] = s.split("|").map(x => x.trim()); return { navn: navn || "Ukjent", belop: +belop || 0, dato: dato || "" }; }).filter(f => f.belop > 0);
  if (!list.length && T.gjeld) list.push({ navn: T.gjeld_note || "Kjent gjeld", belop: T.gjeld, dato: "" });
  return list;
}
const dmy = s => { const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s || ""); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };

// ---------- 5. Hent ----------
const [tasks, shop] = await Promise.all([fetchBoard(), fetchShopify()]);
let meta = null, metaErr = "";
try { meta = await fetchMetaSpend(); } catch (e) { metaErr = e.message; console.error("Meta/CAC utilgjengelig:", e.message); }
const T = parseKasse();
const F = parseForfall(T);
let plan = null;
try { plan = readPlan(env("STATICRYPT_PASSWORD", "")); } catch (e) { console.error("Pace 2.0-plan utilgjengelig:", e.message); }

// ---------- 6. Tall ----------
const series = DAYS.map(d => { const x = shop.daily[d]; const covered = meta && d <= meta.coveredThrough; return { d, ordre: x.ordre, oms: Math.round(x.oms * 100) / 100, eks: Math.round(x.eks * 100) / 100, nye: x.nye, u1: x.u1, u2: x.u2, subNew: x.subNew, subRen: x.subRen, subAct: x.subAct, meta: covered ? Math.round((meta.daily[d] || 0) * 100) / 100 : null }; });
const today = series[series.length - 1];
const win = n => series.slice(-n - 1, -1); // n hele dager t.o.m. i går
const sum = (a, k) => a.reduce((x, r) => x + (r[k] || 0), 0);
const fmtD = ymd => ymd.slice(8, 10) + "." + ymd.slice(5, 7);
const MON = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const monLabel = ymd => MON[+ymd.slice(5, 7) - 1] + " " + ymd.slice(2, 4); // "okt 26", samme form som planen
// bare dager med annonsekostnad teller (kost og nye kunder); dager uten annonser gir organiske kunder som ellers trekker CAC kunstig ned
const cac = n => { const w = win(n).filter(r => r.meta !== null && r.meta > 0); const s = sum(w, "meta"), ny = sum(w, "nye"); return { spend: s, nye: ny, days: w.length, cac: ny ? s / ny : null }; };
// kort: kort undertekst (én linje), detaljer i title-tooltip
const card = (k, v, s, cls, tip) => `<div class="stat ${cls}" title="${esc(tip || "")}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const todayCard = () => card("Salg i dag", nf(today.oms) + " kr", `${today.ordre} ordre · ${today.nye} nye`, "c-salg", `Ordreverdi inkl. mva i dag t.o.m. ${stamp}`);
const salgCard = (n) => { const w = win(n); return card(`Salg ${n} d`, nf(sum(w, "oms")) + " kr", `${sum(w, "ordre")} ordre · ${sum(w, "nye")} nye`, "c-salg", `Ordreverdi inkl. mva siste ${n} hele dager t.o.m. i går, ${sum(w, "nye")} nye kunder`); };
const cacCard = (n) => { if (!meta) return card(`CAC ${n} d`, "–", "Meta-data mangler", "c-cac", metaErr); const c = cac(n); return card(`CAC ${n} d`, c.cac ? nf(c.cac) + " kr" : "–", `${nf(c.spend)} / ${c.nye} nye${c.days < n ? ` · ${c.days} d` : ""}`, "c-cac", `Meta ${nf(c.spend)} kr delt på ${c.nye} nye kunder${c.days < n ? ` (${c.days} av ${n} dager har Meta-data)` : ""}`); };
// annonsekost: Meta-forbruk på fakturerte dager i vinduet; kr/dag over de samme dagene
const adsCard = (n) => { if (!meta) return card(`Annonser ${n} d`, "–", "Meta-data mangler", "c-ads", metaErr); const w = win(n).filter(r => r.meta !== null); const s = sum(w, "meta"); return card(`Annonser ${n} d`, nf(s) + " kr", `~${nf(w.length ? s / w.length : 0)} kr/dag · t.o.m. ${fmtD(meta.coveredThrough)}`, "c-ads", `Meta-annonsekostnad ${w.length} av ${n} dager (fakturert t.o.m. ${fmtD(meta.coveredThrough)}; forbruk etter siste kvittering er ikke med)`); };
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
  ? card("Aktive abonnement", nf(shop.subActive), `${nf(subNow)} kunder m/ ordre 30 d`, "c-sub", `Aktive abonnement ifølge Shopify Subscriptions (Shopify-analyse). ${subNow} unike kunder har hatt abonnementsordre siste 30 d; ${subNew30} nye og ${subRen30} fornyelser`)
  : card("Kunder m/ abonnementsordre", nf(subNow), `+${subNew30} nye · ${subRen30} forny. (30 d)`, "c-sub", `Unike kunder med abonnementsordre siste 30 dager (ekte abonnementsstatus utilgjengelig)`);
const cards = todayCard() + salgCard(7) + salgCard(30) + subCard
  + adsCard(7) + adsCard(30) + cacCard(7) + cacCard(30)
  + card("Kasse", nf(T.kasse) + " kr", "bankbalanse lagt inn " + T.kasse_dato, "c-kasse", `Bankbalanse lagt inn manuelt ${T.kasse_dato}. Se Likviditet for kjente poster etterpå`)
  + lagerCard("sitron", "PACE01", "u1", T.sitron_bestfor, "Sitron & Lime") + lagerCard("bringebær", "PACE02", "u2", "", "Bringebær");

// datastatus: hvor ferske tallene er per kilde
const datastatus = [`Shopify ${stamp}`, meta ? `Meta-kvitteringer t.o.m. ${fmtD(meta.coveredThrough)}` : "Meta mangler", `bankbalanse ${T.kasse_dato}`, plan ? `Pace 2.0-plan ${fmtD(plan.built)}` : "plan mangler"].join(" · ");

// faktisk vs Pace 2.0-plan for inneværende måned (oktober-raden gjelder 15.–31.)
let planHtml = "";
const curRow = plan?.rows?.find(r => r.m.startsWith(monLabel(TODAY)));
if (curRow) {
  const startDay = +((/\((\d{1,2})\./.exec(curRow.m) || [])[1] || 1);
  const start = TODAY.slice(0, 8) + String(startDay).padStart(2, "0");
  const end = addDays(addDays(TODAY.slice(0, 8) + "01", 32).slice(0, 8) + "01", -1);
  const pd = series.filter(r => r.d >= start);
  if (pd.length) {
    const total = (Date.parse(end) - Date.parse(start)) / 864e5 + 1;
    const gone = Math.min(1, (pd.length - 1 + osloHour(NOW) / 24) / total);
    const metaDays = pd.filter(r => r.meta !== null);
    // planens «sub» = abonnementsordre per måned (estimat.mjs: oms = (o − subX)·aov + subX·subAov), sammenlignes med abonnementsordre i perioden
    const rows = [
      { k: "Omsetning eks mva", a: sum(pd, "eks"), p: curRow.inn, u: " kr", g: gone },
      { k: "Ordre", a: sum(pd, "ordre"), p: curRow.o, u: "", g: gone },
      { k: "Nye kunder", a: sum(pd, "nye"), p: curRow.ny, u: "", g: gone },
      { k: "Abonnementsordre", a: sum(pd, "subNew") + sum(pd, "subRen"), p: curRow.sub, u: "", g: gone },
      { k: "Annonser (Meta)", a: sum(metaDays, "meta"), p: curRow.ann, u: " kr", g: metaDays.length / total, none: !metaDays.length, why: meta ? "fakturert t.o.m. " + fmtD(meta.coveredThrough) : "Meta-data mangler", cost: true },
    ];
    // tempo: forventet nå = plan × andel av perioden; prognose = faktisk ÷ andel (lineært)
    const row = r => {
      if (r.none || !r.p) return `<div class="pl-row none"><div class="pl-k">${esc(r.k)}</div><div class="pl-bar"></div><div class="pl-v"><span>${r.p ? "ingen fakturert kostnad i perioden ennå · " + esc(r.why || "") : "ikke i planen"}</span></div></div>`;
      const exp = r.p * r.g, proj = r.g > 0 ? r.a / r.g : 0, d = exp ? r.a / exp - 1 : 0;
      const max = Math.max(r.p, proj, r.a) * 1.04, X = v => (v / max * 100).toFixed(1) + "%";
      const ahead = r.cost ? d <= 0 : d >= 0; // for kostnad er under tempo bra
      const chip = `<em class="${ahead ? "up" : "dn"}">${d >= 0 ? "▲" : "▼"} ${nf(Math.abs(d) * 100)} % ${d >= 0 ? "over" : "under"} tempo</em>`;
      const tip = `${r.k}: ${nf(r.a)}${r.u} nå, forventet ${nf(exp)}${r.u} ved dette punktet. Prognose ${nf(proj)}${r.u} mot plan ${nf(r.p)}${r.u} ved dagens tempo${r.why ? " (" + r.why + ")" : ""}`;
      return `<div class="pl-row" title="${esc(tip)}"><div class="pl-k">${esc(r.k)}${r.why ? `<small>${esc(r.why)}</small>` : ""}</div>`
        + `<div class="pl-bar"><s style="width:${X(proj)}"></s><i style="width:${X(r.a)}"></i><b class="now" style="left:${X(exp)}"></b><b class="goal" style="left:${X(r.p)}"></b></div>`
        + `<div class="pl-v"><strong>${nf(r.a)}${r.u}</strong> ${chip}<span>prognose ${nf(proj)} av ${nf(r.p)}${r.u}</span></div></div>`;
    };
    const early = gone < 0.25 ? " · tidlig i perioden, prognosen er usikker" : "";
    planHtml = `<div class="sec-h">Pace 2.0-plan · ${esc(curRow.m)} <span class="sec-sub">${nf(gone * 100)} % av perioden gått · plan per ${fmtD(plan.built)}${early}</span></div><section class="plan">${rows.map(row).join("")}<div class="pl-key"><span><i></i>faktisk</span><span><i class="pj"></i>prognose ved dagens tempo</span><span><b class="now"></b>forventet nå</span><span><b class="goal"></b>plan for perioden</span></div></section>`;
  }
}

// likviditet: bankbalanse + kjente bevegelser etter den − kjente forfall; kapital i planen holdes utenfor
let likvidHtml = "";
{
  const kDay = dmy(T.kasse_dato);
  const paid = shop.payouts && kDay ? shop.payouts.filter(p => p.status === "paid" && p.date > kDay) : null;
  const way = shop.payouts ? shop.payouts.filter(p => ["in_transit", "scheduled", "pending"].includes(p.status)) : null;
  const metaAfter = meta && kDay ? meta.receipts.filter(r => osloDay(r.at) > kDay) : null;
  const sP = paid ? paid.reduce((x, p) => x + p.amount, 0) : 0, sW = way ? way.reduce((x, p) => x + p.amount, 0) : 0, sM = metaAfter ? metaAfter.reduce((x, r) => x + r.amount, 0) : 0;
  const naa = T.kasse + sP + sW - sM, fTot = F.reduce((x, f) => x + f.belop, 0);
  const kap = plan?.rows?.filter(r => r.kap > 0) || [];
  // fossefall: saldo-søyler fra 0, bevegelser som flytende søyler
  const steps = [{ k: "Bank " + esc(T.kasse_dato.split(" ")[0]) + " (manuell)", v: T.kasse, t: "base" }];
  if (paid) steps.push({ k: `Shopify-utbetalinger etter ${fmtD(kDay)} (${paid.length})`, v: sP, t: "in" });
  if (way && sW) steps.push({ k: `Utbetalinger på vei (${way.length})`, v: sW, t: "in" });
  if (metaAfter && sM) steps.push({ k: `Meta fakturert etter ${fmtD(kDay)}`, v: -sM, t: "out" });
  steps.push({ k: "Estimert nå", v: naa, t: "sum" });
  for (const f of F) steps.push({ k: esc(f.navn) + (f.dato ? ` <small>${esc(f.dato)}</small>` : ""), v: -f.belop, t: "out" });
  steps.push({ k: "Etter kjente forfall", v: naa - fTot, t: "sum" });
  let run = 0;
  for (const st of steps) { if (st.t === "base" || st.t === "sum") { st.a = 0; st.b = st.v; run = st.v; } else { st.a = run; st.b = run + st.v; run = st.b; } }
  const lo = Math.min(0, ...steps.map(x => Math.min(x.a, x.b))), hi = Math.max(...steps.map(x => Math.max(x.a, x.b)));
  const X = v => (v - lo) / (hi - lo || 1) * 100;
  const kr = v => (v < 0 ? "−" : "") + nf(Math.abs(v)) + " kr";
  const wrow = st => `<div class="wf-row ${st.t}"><div class="wf-k">${st.t === "in" ? "+ " : st.t === "out" ? "− " : ""}${st.k}</div><div class="wf-bar">${lo < 0 ? `<u style="left:${X(0).toFixed(2)}%"></u>` : ""}<i style="left:${X(Math.min(st.a, st.b)).toFixed(2)}%;width:${Math.max(0.4, X(Math.max(st.a, st.b)) - X(Math.min(st.a, st.b))).toFixed(2)}%"></i></div><div class="wf-v">${st.t === "in" ? "+" : ""}${kr(st.v)}</div></div>`;
  const warn = plan && plan.key.kasseMin < 0 ? `<div class="wf-warn">⚠ Planen går til ${nf(plan.key.kasseMin)} kr i ${esc(plan.key.kasseMinMnd)} uten ny kapital${kap.length ? ` (${kap.map(r => `${nf(r.kap)} kr i ${esc(r.m)}`).join(", ")})` : ""}. Med kapitalen er laveste punkt ${nf(plan.key.kasseMinEtterKap)} kr (${esc(plan.key.kasseMinEtterKapMnd)}).</div>` : "";
  likvidHtml = `<div class="box"><div class="box-h">Likviditet, kjente poster <b>${kr(naa - fTot)} etter forfall</b></div>${warn}<div class="wf">${steps.map(wrow).join("")}</div>`
    + `<div class="box-n">Andre utgifter etter ${kDay ? fmtD(kDay) : "?"} (3PL, leverandører, abonnementer) er ikke med. Kapital regnes ikke med før den står i bankbalansen.</div></div>`;
}

// gjenkjøp per kohort (måned for første betalte ordre): andel som kjøper igjen innen 30/60/90 dager; bare kunder som har rukket vinduet teller
let kohortHtml = "";
{
  const W = [30, 60, 90], C = {};
  for (const a of shop.buyers) {
    const f = a[0], c = C[f.slice(0, 7)] ||= { n: 0, w: Object.fromEntries(W.map(N => [N, [0, 0]])) };
    c.n++;
    for (const N of W) { const lim = addDays(f, N); if (lim > TODAY) continue; c.w[N][0]++; if (a.some(d => d > f && d <= lim)) c.w[N][1]++; }
  }
  const months = Object.keys(C).sort().slice(-9);
  // varmekart: blå intensitet etter andel (full farge ved 40 %), stiplet ramme = ikke alle har rukket perioden
  const cell = (c, N) => { const [m, r] = c.w[N]; if (!m) return `<td class="na">–</td>`; const p = r / m; return `<td class="${m < c.n ? "part" : ""}" title="${r} av ${m} kunder${m < c.n ? ` (${c.n - m} har ikke rukket ${N} d)` : ""}"><span style="background:color-mix(in oklab, var(--blue) ${Math.round(Math.min(1, p / 0.4) * 85)}%, var(--surface-2))">${nf(p * 100)} %</span></td>`; };
  const tot = { n: 0, w: Object.fromEntries(W.map(N => [N, [0, 0]])) };
  for (const c of Object.values(C)) { tot.n += c.n; for (const N of W) { tot.w[N][0] += c.w[N][0]; tot.w[N][1] += c.w[N][1]; } }
  const t90 = tot.w[90][0] ? tot.w[90][1] / tot.w[90][0] : null;
  kohortHtml = `<div class="box"><div class="box-h">Gjenkjøp${t90 !== null ? ` <b>${nf(t90 * 100)} % kjøper igjen innen 90 d</b>` : ""}</div><table class="kh"><tr><th>Første kjøp</th><th>Nye</th><th>30 d</th><th>60 d</th><th>90 d</th></tr>`
    + months.map(m => `<tr><td>${monLabel(m + "-01")}</td><td>${C[m].n}</td>${W.map(N => cell(C[m], N)).join("")}</tr>`).join("")
    + `<tr class="sum"><td>Alle</td><td>${tot.n}</td>${W.map(N => cell(tot, N)).join("")}</tr></table>`
    + `<div class="box-n">Andel nye kunder som har kjøpt igjen innen 30/60/90 dager (abonnementsfornyelser teller). Stiplet = ikke alle i måneden har rukket perioden ennå.</div></div>`;
}

const note = `7 og 30 d = hele Oslo-dager t.o.m. i går; «Salg i dag» er dagen så langt. Salg = ordreverdi inkl. mva for ordre opprettet i perioden, etter refusjon, uten test- og seeding-ordre (Shopify ${stamp}). Planraden sammenlignes eks mva. Nye kunder = kundeprofiler opprettet i perioden med betalt ordre. `
  + (meta ? `CAC = Meta-annonsekostnad fra kvitteringene i hei@getpace.no, fordelt per dag (dekket t.o.m. ${fmtD(meta.coveredThrough)}; forbruk etter det er ikke fakturert ennå og holdes utenfor), delt på nye kunder samme dager. ` : `CAC mangler: ${esc(metaErr)}. `)
  + (shop.subActive !== null ? `Aktive abonnement = Shopify Subscriptions via Shopify-analyse. ` : "")
  + `Lager = tilgjengelig hos 360 Logistics; tomdato ved takten siste 30 d. Kasse er bankbalanse lagt inn manuelt (sist ${T.kasse_dato}).`;
const metaInfo = { built_at: NOW.toISOString(), shopify_at: shop.at, label: stamp, today: TODAY, meta_through: meta ? meta.coveredThrough : null, daily: series.slice(-30), geo: shop.geo, kart: { w: KART.w, h: KART.h, fylker: KART.fylker } };

// ---------- 7. Bygg HTML ----------
let html = readFileSync(TEMPLATE, "utf8");
const js = s => JSON.stringify(s).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const put = (re, val, label) => { if (!re.test(html)) throw new Error("template mangler " + label); html = html.replace(re, () => val); };
put(/\/\*__TASKS__\*\/[\s\S]*?\/\*__TASKS_END__\*\//, `/*__TASKS__*/ const SNAPSHOT = ${js(tasks)}; /*__TASKS_END__*/`, "TASKS");
put(/\/\*__META__\*\/[\s\S]*?\/\*__META_END__\*\//, `/*__META__*/ const META = ${js(metaInfo)}; /*__META_END__*/`, "META");
put(/\/\*__PAGE_TOKEN__\*\/[\s\S]*?\/\*__PAGE_TOKEN_END__\*\//, `/*__PAGE_TOKEN__*/ const PAGE_TOKEN = ${js(process.env.PACE_PAGE_TOKEN || "")}; /*__PAGE_TOKEN_END__*/`, "PAGE_TOKEN");
put(/<!--STATS-->[\s\S]*?<!--\/STATS-->/, `<!--STATS-->${cards}<!--/STATS-->`, "STATS");
put(/<!--DATASTATUS-->[\s\S]*?<!--\/DATASTATUS-->/, `<!--DATASTATUS-->${esc(datastatus)}<!--/DATASTATUS-->`, "DATASTATUS");
put(/<!--PLAN-->[\s\S]*?<!--\/PLAN-->/, `<!--PLAN-->${planHtml}<!--/PLAN-->`, "PLAN");
put(/<!--LIKVID-->[\s\S]*?<!--\/LIKVID-->/, `<!--LIKVID-->${likvidHtml}${kohortHtml}<!--/LIKVID-->`, "LIKVID");
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
