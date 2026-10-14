// Bygger pace-quest.html (kryptert) fra pace-quest.template.html.
// Kilder: GitHub Projects-board Tempelbois/2, Shopify (salg 7/30 d + lager), kasse fra env PACE_KASSE.
// Kjøres av GitHub Actions (.github/workflows/pace-quest.yml) og lokalt via ~/sync-pace-quest.mjs.
//
// Env:
//   PACE_BOARD_TOKEN         GitHub-token med project-scope (lokalt: `gh auth token`)
//   SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
//   PACE_KASSE               "kasse|kasse_dato|gjeld|gjeld_note|sitron_bestfor" (pipe-separert, bestfor som DD.MM.YYYY)
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN   hei@getpace.no (readonly), for Meta-kvitteringer → CAC
//   STATICRYPT_PASSWORD      sidepassord
//   STATICRYPT_SALT          fast salt (default 843e94067e2339f1a3b9073a407ddde1)
//   SKIP_ENCRYPT=1           skriv bare pace-quest-plain.html (lokal test)
// Feiler hardt hvis en kilde feiler: publiserer aldri nuller.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(DIR, "pace-quest.template.html");
const OUT = path.join(DIR, "pace-quest.html");
const PLAIN = path.join(DIR, "pace-quest-plain.html");
const env = (k, fallback) => { const v = process.env[k]; if (v === undefined || v === "") { if (fallback !== undefined) return fallback; throw new Error("mangler env " + k); } return v; };

const ORG = "Tempelbois", PROJECT_NUMBER = 2, LOCATION_ID = 76905513134; // 360 Logistics - 3PL
const OSLO = "Europe/Oslo";
const nowOslo = () => new Date().toLocaleString("no-NO", { timeZone: OSLO, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", " kl.");
const nf = n => Math.round(n).toLocaleString("no-NO");

// ---------- 1. Board ----------
async function fetchBoard() {
  const token = env("PACE_BOARD_TOKEN");
  const q = `query { organization(login: "${ORG}") { projectV2(number: ${PROJECT_NUMBER}) {
    items(first: 100) { nodes { id
      content { ... on DraftIssue { title } ... on Issue { title } ... on PullRequest { title } }
      fieldValues(first: 20) { nodes {
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
      } } } } } } }`;
  const r = await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ query: q }) });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error("GitHub: " + (j.errors?.[0]?.message || r.status));
  const items = j.data.organization.projectV2.items.nodes;
  if (!items.length) throw new Error("GitHub: tomt board, avbryter");
  return items.map(n => {
    const fv = Object.fromEntries(n.fieldValues.nodes.filter(v => v.field).map(v => [v.field.name, v.name ?? v.date]));
    return { id: n.id, sec: fv["Status"] || "Innboks", owner: fv["Ansvarlig"] || "Ikke fordelt", strom: fv["Arbeidsstrøm"] || "", kat: fv["Kategori"] || "Oppgave", due: fv["Måldato"] || "", txt: n.content?.title || "(uten tittel)" };
  });
}

// ---------- 2. Shopify ----------
async function fetchShopify() {
  const SHOP = env("SHOPIFY_SHOP");
  const r0 = await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: env("SHOPIFY_CLIENT_ID"), client_secret: env("SHOPIFY_CLIENT_SECRET"), grant_type: "client_credentials" }) });
  const tok = (await r0.json()).access_token;
  if (!tok) throw new Error("Shopify: fikk ikke token");
  const H = { "X-Shopify-Access-Token": tok };
  const since = new Date(Date.now() - 31 * 864e5).toISOString();
  let url = `https://${SHOP}/admin/api/2024-10/orders.json?status=any&limit=250&created_at_min=${since}&fields=id,created_at,current_total_price,total_price,cancelled_at,financial_status,test,tags,line_items,customer`;
  let out = [];
  while (url) {
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error("Shopify orders " + r.status);
    const j = await r.json(); out = out.concat(j.orders || []);
    const l = r.headers.get("link"); const m = l && l.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null;
  }
  const tags = o => (o.tags || "").split(",").map(s => s.trim().toLowerCase());
  const ok = o => !o.test && !o.cancelled_at && ["paid", "partially_refunded", "partially_paid"].includes(o.financial_status) && !tags(o).includes("seeding");
  const orders = out.filter(ok).filter(o => +(o.current_total_price ?? o.total_price) > 0);
  const win = d => orders.filter(o => Date.now() - new Date(o.created_at) < d * 864e5);
  const sum = a => a.reduce((x, o) => x + +(o.current_total_price ?? o.total_price), 0);
  const units = (a, sku) => a.reduce((x, o) => x + o.line_items.filter(li => li.sku === sku).reduce((y, li) => y + li.quantity, 0), 0);
  // lager per lokasjon (360 Logistics), ikke aggregatet
  const p = await (await fetch(`https://${SHOP}/admin/api/2024-10/products.json?limit=50&fields=title,variants`, { headers: H })).json();
  const items = {};
  for (const pr of p.products) for (const v of pr.variants) if (v.sku === "PACE01" || v.sku === "PACE02") items[v.sku] = v.inventory_item_id;
  if (!items.PACE01 || !items.PACE02) throw new Error("Shopify: fant ikke PACE01/PACE02");
  const lv = await (await fetch(`https://${SHOP}/admin/api/2024-10/inventory_levels.json?inventory_item_ids=${items.PACE01},${items.PACE02}&location_ids=${LOCATION_ID}`, { headers: H })).json();
  const lager = {};
  for (const [sku, iid] of Object.entries(items)) { const l = (lv.inventory_levels || []).find(x => x.inventory_item_id === iid); if (!l) throw new Error("Shopify: ingen inventory_level for " + sku); lager[sku] = l.available; }
  const d7 = win(7), d30 = win(30);
  // ny kunde = kundeprofil opprettet i vinduet (Shopify lager kunden ved første ordre); telles én gang per kunde
  const nye = (a, d) => new Set(a.filter(o => o.customer?.created_at && Date.now() - new Date(o.customer.created_at) < d * 864e5).map(o => o.customer.id)).size;
  return { d7: { n: d7.length, sum: sum(d7), nye: nye(d7, 7) }, d30: { n: d30.length, sum: sum(d30), nye: nye(d30, 30) }, units30: { PACE01: units(d30, "PACE01"), PACE02: units(d30, "PACE02") }, lager, at: new Date().toISOString() };
}

// ---------- 2b. Meta-annonsekostnad fra kvitteringsmailer (hei@getpace.no) ----------
// Hver kvittering har "Amount billed: NOKx Date range: <fra> - <til>". Beløpet fordeles likt per dag i perioden,
// så summeres dagene som faller i siste 7/30 d. Forbruk etter siste kvittering er ikke fakturert ennå og mangler.
async function fetchMetaSpend() {
  const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GMAIL_CLIENT_ID"), client_secret: env("GMAIL_CLIENT_SECRET"), refresh_token: env("GMAIL_REFRESH_TOKEN"), grant_type: "refresh_token" }) });
  const tj = await tr.json();
  if (!tj.access_token) throw new Error("Gmail: token-feil " + (tj.error || tr.status));
  const G = { Authorization: "Bearer " + tj.access_token };
  const q = encodeURIComponent('from:noreply@business-updates.facebook.com subject:"Meta ads receipt" newer_than:45d');
  const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=50`, { headers: G })).json();
  const ids = (list.messages || []).map(m => m.id);
  const b64 = s => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const textOf = p => { if (!p) return ""; let t = ""; if (p.body?.data && /text\/(plain|html)/.test(p.mimeType || "")) t += b64(p.body.data) + "\n"; for (const c of p.parts || []) t += textOf(c); return t; };
  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const parseD = s => { const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)/.exec(s); if (!m) return null; let h = +m[4] % 12; if (m[6] === "PM") h += 12; return new Date(Date.UTC(+m[3], MON[m[1]], +m[2], h - 2, +m[5])); }; // kvitteringstid ≈ Oslo
  const daily = {}; let last = null, nRec = 0;
  for (const id of ids) {
    const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: G })).json();
    const t = textOf(msg.payload).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const m = /Amount billed:\s*NOK\s?([\d,]+\.\d{2})\s*Date range:\s*(.+?)\s*-\s*(.+?)\s*Product type/.exec(t);
    if (!m) continue;
    const amt = +m[1].replace(/,/g, ""), a = parseD(m[2]), b = parseD(m[3]);
    if (!a || !b || b <= a) continue;
    nRec++; if (!last || b > last) last = b;
    const days = (b - a) / 864e5, perDay = amt / days;
    for (let d = new Date(a); d < b; d = new Date(d.getTime() + 864e5)) { const k = d.toISOString().slice(0, 10); const frac = Math.min(1, (b - d) / 864e5); daily[k] = (daily[k] || 0) + perDay * frac; }
  }
  if (!nRec) throw new Error("Gmail: ingen Meta-kvitteringer funnet");
  const spend = d => { const lim = Date.now() - d * 864e5; return Object.entries(daily).filter(([k]) => new Date(k + "T12:00:00Z") >= lim).reduce((x, [, v]) => x + v, 0); };
  return { s7: spend(7), s30: spend(30), last, nRec };
}

// ---------- 3. Kasse (manuell) ----------
function parseKasse() {
  const [kasse, kasse_dato, gjeld, gjeld_note, sitron_bestfor] = env("PACE_KASSE").split("|").map(s => s.trim());
  if (!+kasse || !kasse_dato) throw new Error("PACE_KASSE: ugyldig format");
  return { kasse: +kasse, kasse_dato, gjeld: +gjeld || 0, gjeld_note: gjeld_note || "", sitron_bestfor: sitron_bestfor || "" };
}

// ---------- 4. Bygg ----------
const [tasks, shop, meta] = await Promise.all([fetchBoard(), fetchShopify(), fetchMetaSpend()]);
const T = parseKasse();
const stamp = nowOslo();
const card = (k, v, s) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const lagerCard = (navn, sku, bestfor) => {
  const qty = shop.lager[sku], perUke = shop.units30[sku] / 30 * 7;
  let s = perUke > 0 ? `${nf(perUke)} per uke · ${nf(qty / perUke)} uker igjen` : "ingen målbar takt siste 30 d";
  if (bestfor && perUke > 0) {
    const [d, m, y] = bestfor.split(".").map(Number);
    const uker = (new Date(y, m - 1, d) - Date.now()) / (7 * 864e5);
    const rest = Math.max(0, qty - perUke * uker);
    s += ` · best før ${bestfor}${rest > 0 ? `, ~${nf(rest)} går ut ved dagens takt` : ""}`;
  }
  return card(`Lager ${navn}`, nf(qty) + " stk", s);
};
const cacCard = (navn, w, s) => card(`CAC ${navn}`, w.nye ? nf(s / w.nye) + " kr" : "–", `Meta ${nf(s)} kr / ${w.nye} nye kunder`);
const lastRec = meta.last.toLocaleDateString("no-NO", { timeZone: OSLO, day: "2-digit", month: "2-digit" });
const cards = card("Salg 7 dager", nf(shop.d7.sum) + " kr", shop.d7.n + " ordre")
  + card("Salg 30 dager", nf(shop.d30.sum) + " kr", shop.d30.n + " ordre")
  + cacCard("7 dager", shop.d7, meta.s7)
  + cacCard("30 dager", shop.d30, meta.s30)
  + card("Kasse", nf(T.kasse) + " kr", "oppdatert " + T.kasse_dato + (T.gjeld ? " · gjeld ~" + nf(T.gjeld) : ""))
  + lagerCard("sitron", "PACE01", T.sitron_bestfor)
  + lagerCard("bringebær", "PACE02", "");
const note = `Salg = ordreverdi inkl. mva for ordre opprettet i perioden (etter refusjon, uten test- og seeding-ordre), hentet fra Shopify ${stamp}. CAC = Meta-annonsekostnad fra kvitteringene (fordelt per dag, siste kvittering dekker til ${lastRec}, forbruk etter det er ikke med) delt på nye kunder (første ordre) i samme periode. Lager = tilgjengelig hos 360 Logistics. Kasse er bankbalanse lagt inn manuelt${T.gjeld_note ? ", gjeld: " + T.gjeld_note : ""}.`;
const metaInfo = { built_at: new Date().toISOString(), shopify_at: shop.at, shopify_label: stamp };

let html = readFileSync(TEMPLATE, "utf8");
const js = s => JSON.stringify(s, null, 1).replace(/</g, "\\u003c");
html = html.replace(/\/\*__TASKS__\*\/[\s\S]*?\/\*__TASKS_END__\*\//, () => `/*__TASKS__*/ const SNAPSHOT = ${js(tasks)}; /*__TASKS_END__*/`);
html = html.replace(/\/\*__META__\*\/[\s\S]*?\/\*__META_END__\*\//, () => `/*__META__*/ const META = ${js(metaInfo)}; /*__META_END__*/`);
html = html.replace(/\/\*__PAGE_TOKEN__\*\/[\s\S]*?\/\*__PAGE_TOKEN_END__\*\//, () => `/*__PAGE_TOKEN__*/ const PAGE_TOKEN = ${JSON.stringify(process.env.PACE_PAGE_TOKEN || "")}; /*__PAGE_TOKEN_END__*/`);
html = html.replace(/<!--STATS-->[\s\S]*?<!--\/STATS-->/, () => `<!--STATS-->${cards}<!--/STATS-->`);
html = html.replace(/<!--STATSNOTE-->[\s\S]*?<!--\/STATSNOTE-->/, () => `<!--STATSNOTE-->${note}<!--/STATSNOTE-->`);
html = html.replace(/<!--SYNC-->.*?<!--\/SYNC-->/, () => `<!--SYNC-->${stamp}<!--/SYNC-->`);
writeFileSync(PLAIN, html);
console.log(`bygget: ${tasks.length} kort | 7d ${shop.d7.n}/${nf(shop.d7.sum)} | 30d ${shop.d30.n}/${nf(shop.d30.sum)} | lager ${JSON.stringify(shop.lager)} | ${stamp}`);
if (process.env.SKIP_ENCRYPT) process.exit(0);

// ---------- 5. Krypter (custom dark template) ----------
const pw = env("STATICRYPT_PASSWORD");
const salt = env("STATICRYPT_SALT", "843e94067e2339f1a3b9073a407ddde1");
const tplSrc = execSync("node -e \"console.log(require.resolve('staticrypt/lib/password_template.html'))\"", { cwd: DIR, encoding: "utf8" }).trim();
let t = readFileSync(tplSrc, "utf8")
  .replace(/(\.staticrypt-form \{[^}]*?)background: #ffffff;/, "$1background: #161b22; border: 1px solid #2a313c; border-radius: 8px;")
  .replace(/(\.staticrypt-password-container \{[^}]*?)background: #f2f2f2;/, "$1background: #0e1116; color: #e6edf3;")
  .replace(/(\.staticrypt-content \{[^}]*?)font-family:[^;]+;/, "$1font-family:-apple-system,\"Segoe UI\",Roboto,sans-serif;")
  .replace(/(\.staticrypt-title \{)/, "$1color:#e6edf3;font-weight:600;")
  .replace(/(\.staticrypt-instructions \{)/, "$1color:#8b949e;");
writeFileSync(path.join(DIR, "pace-template.html"), t);
copyFileSync(PLAIN, path.join(DIR, "pq.html"));
execSync(`npx --no-install staticrypt pq.html --short --salt ${salt} --template pace-template.html --template-color-primary "#58a6ff" --template-color-secondary "#0e1116" --template-title "Pace — Beskyttet" --template-button "ÅPNE" --template-instructions "Skriv inn passord" --template-placeholder "Passord" --remember 0 -d encrypted`,
  { cwd: DIR, stdio: "inherit", env: { ...process.env, STATICRYPT_PASSWORD: pw } });
copyFileSync(path.join(DIR, "encrypted", "pq.html"), OUT);
for (const f of ["encrypted", ".staticrypt.json", "pace-template.html", "pq.html"]) if (existsSync(path.join(DIR, f))) rmSync(path.join(DIR, f), { recursive: true });
console.log("kryptert ->", OUT);
