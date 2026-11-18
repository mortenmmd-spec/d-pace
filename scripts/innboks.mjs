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
    // the value of a name field, up to the next "Label:" or else the next three words
    .replace(/((?:^|\s)(?:(?:For|Etter)?navn|Name)\s*:\s*)(?:[^:]{1,60}?(?=\s+\p{L}[\p{L}-]*\s*:)|[^:\s]+(?:\s+[^:\s]+){0,2})/giu, "$1[navn]")
    .replace(/[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, "[e-post]")
    // "00" needs a country code (not 0), so "1 000 000 000" stays; "91 234 567" and "912.34.567" start with 2-9 and "9123 4567" with 4 or 9 (mobile), so amounts, years and order pairs stay
    .replace(/(?<![\d#])(?:(?:\+|00(?=[1-9]))\d{1,3}(?:[ -]?\d){6,12}|\d{8}|\d{3}[ -]\d{2}[ -]\d{3}|\d{2}[ -]\d{2}[ -]\d{2}[ -]\d{2}|[2-9]\d \d{3} \d{3}|[49]\d{3} \d{4}|[2-9]\d{2}\.\d{2}\.\d{3})(?!\.?\d)/g, "[telefon]");
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
      if (!old) for (const [id, e] of Object.entries(next.meldinger)) if (e.kanal === kanal && e.besvart === null && !open.has(id) && threadOf(id) === threadOf(raw.id)) delete next.meldinger[id];
      const stored = { ...raw, tekst: cutText(raw.tekst, MAX_STORED_TEXT) };
      next.meldinger[raw.id] = old
        ? { ...old, ...stored, navn: raw.tekst ? raw.navn : old.navn, tekst: needsLongText(old) ? stored.tekst || old.tekst : old.tekst, gjelder: raw.gjelder ?? old.gjelder, sett: old.sett, besvart: null, type: old.type, forslag: old.forslag, selv: old.selv, forsok: old.forsok }
        : { ...stored, sett: nowIso, besvart: null, type: null, forslag: null, selv: false, svar: null, forsok: 0 };
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
    .filter(e => e.besvart === null && e.tekst !== "" && e.type === null && e.forsok < MAX_TRIES)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, max);
}

export async function suggestAll(entries, suggest) {
  const stats = { kall: 0, tegn: 0, feil: 0, status: {} };
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
    } catch (err) {
      stats.feil++;
      const code = err?.status ?? "annen";
      stats.status[code] = (stats.status[code] ?? 0) + 1;
      // 400 rejects this message: count a try and go on; a second 400 in the same round means the request itself is wrong
      if (err?.status === 400) { e.forsok++; if (stats.status[400] > 1) break; continue; }
      if (err?.transient) break;
      e.forsok++;
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
