// Pure logic for the Innboks view: merge open messages into the cache, pick which get a suggestion, shape the page data.
import { readCache, writeCache } from "./innboks-cache.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRIES = 3;
const TYPES = ["sporsmal", "ordre", "ros", "annet"];
// Stored text keeps a margin past the 4000 characters sent, so redaction sees a whole address or number at the cut.
const MAX_STORED_TEXT = 4200;
const MAX_SENT_TEXT = 4000;

// slice without leaving half of a surrogate pair at the end
export const cutText = (text, n) => text.slice(0, n).replace(/[\uD800-\uDBFF]$/, "");

export function shortName(from) {
  const name = from.split("<")[0].replace(/["']/g, "").trim();
  if (!name || (!from.includes("<") && name.includes("@"))) {
    const addr = (from.match(/<([^>]*)>/)?.[1] ?? from).trim();
    return addr.split("@")[0];
  }
  const [surnameFirst, rest] = name.split(",").map(p => p.trim());
  if (rest && !surnameFirst) return rest.split(/\s+/)[0];
  if (rest) return `${rest.split(/\s+/)[0]} ${surnameFirst[0].toUpperCase()}.`;
  const words = name.split(/\s+/);
  if (words.length === 1) return words[0];
  return `${words[0]} ${words[words.length - 1][0].toUpperCase()}.`;
}

export function redact(text) {
  return text
    // links go first and whole, so an address or number inside one is not left half-replaced; trailing punctuation stays
    .replace(/(?:https?:\/\/|www\.)[^\s<>"]*[^\s<>".,;:!?)\]]/gi, "[lenke]")
    // the value of a name field, up to the next "Label:" or else the next three words
    .replace(/((?:^|\s)(?:(?:For|Etter)?navn|Name)\s*:\s*)(?:[^:]{1,60}?(?=\s+\p{L}[\p{L}-]*\s*:)|[^:\s]+(?:\s+[^:\s]+){0,2})/giu, "$1[navn]")
    .replace(/[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, "[e-post]")
    // "00" needs a country code (not 0), so "1 000 000 000" stays; "91 234 567", "912.34.567" and "2233 4455" start with 2-9, and two years ("2026 2027") are not a number, so amounts, years and order pairs stay
    .replace(/(?<![\d#])(?:(?:\+|00(?=[1-9]))\d{1,3}(?:[ -]?\d){6,12}|\d{8}|\d{3}[ -]\d{2}[ -]\d{3}|\d{2}[ -]\d{2}[ -]\d{2}[ -]\d{2}|\d{2}\.\d{2}\.\d{2}\.\d{2}|[2-9]\d \d{3} \d{3}|(?!(?:19|20)\d\d[ -](?:19|20)\d\d)[2-9]\d{3}[ -]\d{4}|[2-9]\d{2}\.\d{2}\.\d{3})(?!\.?\d)/g, "[telefon]");
}

// Name from a contact form, only when the next field is a known one; otherwise "" and the caller falls back to the sender.
export function contactName(tekst) {
  const name = /(?:^|\s)(?:Navn|Name):\s*([^:@<\d]{1,60}?)(?=\s+(?:E-?post|E-?mail|Telefon\w*|Mobil\w*|Phone(?:\s+number)?|Melding|Message|Kommentar|Comment|Body|Landskode|Country(?:\s+code)?|Emne|Subject)\s*:|$)/iu.exec(tekst)?.[1].trim();
  return name && /\p{L}/u.test(name) ? shortName(name) : "";
}

export function excerpt(text, n = 600) {
  return text.length > n ? cutText(text, n) + "…" : text;
}

export function gmailLink(threadId) {
  return `https://mail.google.com/mail/?authuser=hei@getpace.no#all/${threadId}`;
}

const threadOf = id => id.split(":").slice(0, 2).join(":");
const needsLongText = e => e.besvart === null && e.type === null && e.forsok < MAX_TRIES;

export function updateCache({ cache, kilder, now }) {
  const next = structuredClone(cache);
  const nowIso = now.toISOString();
  for (const [kanal, kilde] of Object.entries(kilder)) {
    if (!kilde.ok) continue;
    const open = new Set(kilde.aapne.map(r => r.id));
    for (const raw of kilde.aapne) {
      const old = next.meldinger[raw.id];
      let prev = null;
      if (!old) for (const [id, e] of Object.entries(next.meldinger)) if (e.kanal === kanal && e.besvart === null && !open.has(id) && threadOf(id) === threadOf(raw.id)) { prev = e; delete next.meldinger[id]; }
      const stored = { ...raw, tekst: cutText(raw.tekst, MAX_STORED_TEXT) };
      // gjelder undefined = the order lookup failed (keep what we had); null = looked up, no order
      const m = old
        ? { ...old, ...stored, navn: raw.tekst ? raw.navn : old.navn, tekst: old.gammelTekst || needsLongText(old) ? stored.tekst || old.tekst : old.tekst, gjelder: raw.gjelder === undefined ? old.gjelder : raw.gjelder, sett: old.sett, besvart: null, type: old.type, forslag: old.forslag, selv: old.selv, forsok: old.forsok }
        : { ...stored, gjelder: raw.gjelder === undefined ? prev?.gjelder ?? null : raw.gjelder, sett: nowIso, besvart: null, type: null, forslag: null, selv: false, svar: null, forsok: 0 };
      // a new message whose text could not be fetched keeps the previous message's text, marked, until its own arrives; never its suggestion
      if (!old && !stored.tekst && prev?.tekst) Object.assign(m, { tekst: prev.tekst, gammelTekst: true });
      if (stored.tekst) delete m.gammelTekst;
      next.meldinger[raw.id] = m;
    }
    for (const [id, e] of Object.entries(next.meldinger)) {
      if (e.kanal !== kanal || open.has(id)) continue;
      if (e.besvart === null) e.besvart = nowIso;
      else if (now.getTime() - new Date(e.besvart).getTime() > 30 * DAY_MS) delete next.meldinger[id];
    }
    next.sistOk[kanal] = nowIso;
  }
  return next;
}

export function pickNew(cache, max = 30) {
  return Object.values(cache.meldinger)
    .filter(e => e.besvart === null && e.tekst !== "" && !e.gammelTekst && e.type === null && e.forsok < MAX_TRIES)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, max);
}

export async function suggestAll(entries, suggest) {
  const stats = { kall: 0, tegn: 0, feil: 0, status: {} };
  let prev = null; // the previous call, when it failed in the API call itself: { e, kind }
  for (const e of entries) {
    stats.kall++;
    stats.tegn += Math.min(e.tekst.length, MAX_SENT_TEXT);
    try {
      const r = await suggest({ kanal: e.kanal, emne: e.emne, tekst: e.tekst, gjelder: e.gjelder });
      if (!TYPES.includes(r.type)) throw new Error("bad type");
      e.type = r.type;
      e.selv = r.selv === true;
      e.svar = r.svar;
      e.forslag = r.svar && !r.selv && r.forslag ? r.forslag : null;
      prev = null;
    } catch (err) {
      stats.feil++;
      const code = err?.status ?? "annen";
      stats.status[code] = (stats.status[code] ?? 0) + 1;
      // a wrong key fails every message: stop without counting a try
      if (err?.status === 401 || err?.status === 403) break;
      // a failed call (timeout, network, HTTP error) counts a try and the round goes on; the same failure twice in a row is shared: give the first try back and stop
      const kind = err?.transient ? err.status ?? "nett" : null;
      if (kind !== null && prev?.kind === kind) { prev.e.forsok--; break; }
      e.forsok++;
      prev = kind === null ? null : { e, kind };
    }
  }
  return stats;
}

export function toPage(cache, kilder, now) {
  const meldinger = Object.values(cache.meldinger)
    .sort((a, b) => b.ts - a.ts)
    .map(e => ({
      id: e.id,
      kanal: e.kanal,
      navn: e.navn,
      ts: e.ts,
      emne: e.emne,
      tekst: excerpt(e.tekst),
      lenke: e.lenke,
      gjelder: e.gjelder,
      type: e.type,
      forslag: e.forslag,
      selv: e.selv,
      svar: e.svar ?? null,
      besvart: e.besvart !== null,
      gammelTekst: e.gammelTekst === true,
    }));
  const mail = { ok: kilder.mail.ok, hentet: cache.sistOk.mail };
  return { bygget: now.toISOString(), kilder: { mail }, meldinger };
}

export async function buildInbox({ pw, kilder, suggest, now, file }) {
  const cache = updateCache({ cache: readCache(pw, file), kilder, now });
  const picked = suggest ? pickNew(cache) : [];
  const run = suggest ? await suggestAll(picked, suggest) : { kall: 0, tegn: 0, feil: 0, status: {} };
  for (const e of Object.values(cache.meldinger)) if (!suggest || !needsLongText(e)) e.tekst = excerpt(e.tekst);
  writeCache(pw, cache, file);
  const aapne = Object.values(cache.meldinger).filter(e => e.besvart === null).length;
  return { page: toPage(cache, kilder, now), stats: { aapne, nye: picked.length, ...run } };
}
