// Pure logic for the Innboks view: merge open messages into the cache, pick which get a suggestion, shape the page data.
import { readCache, writeCache } from "./innboks-cache.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRIES = 3;
const TYPES = ["sporsmal", "ordre", "ros", "annet"];

export function shortName(from) {
  const name = from.split("<")[0].replace(/["']/g, "").trim();
  if (!name || (!from.includes("<") && name.includes("@"))) {
    const addr = (from.match(/<([^>]*)>/)?.[1] ?? from).trim();
    return addr.split("@")[0];
  }
  const [surnameFirst, rest] = name.split(",").map(p => p.trim());
  if (rest) return `${rest.split(/\s+/)[0]} ${surnameFirst[0].toUpperCase()}.`;
  const words = name.split(/\s+/);
  if (words.length === 1) return words[0];
  return `${words[0]} ${words[words.length - 1][0].toUpperCase()}.`;
}

export function redact(text) {
  return text
    .replace(/[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, "[e-post]")
    .replace(/(?<!\d)(?:(?:\+|00)47\s?)?(?:\d{8}|\d{3}[ -]\d{2}[ -]\d{3}|\d{2}[ -]\d{2}[ -]\d{2}[ -]\d{2})(?!\d)/g, "[telefon]");
}

export function excerpt(text, n = 600) {
  return text.length > n ? text.slice(0, n) + "…" : text;
}

export function gmailLink(threadId) {
  return `https://mail.google.com/mail/?authuser=hei@getpace.no#all/${threadId}`;
}

export function updateCache({ cache, kilder, now }) {
  const next = structuredClone(cache);
  const nowIso = now.toISOString();
  for (const [kanal, kilde] of Object.entries(kilder)) {
    if (!kilde.ok) continue;
    const open = new Set();
    for (const raw of kilde.aapne) {
      open.add(raw.id);
      const old = next.meldinger[raw.id];
      next.meldinger[raw.id] = old
        ? { ...old, ...raw, sett: old.sett, besvart: null, type: old.type, forslag: old.forslag, selv: old.selv, forsok: old.forsok }
        : { ...raw, sett: nowIso, besvart: null, type: null, forslag: null, selv: false, forsok: 0 };
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
  const stats = { kall: 0, tegn: 0, feil: 0 };
  for (const e of entries) {
    stats.kall++;
    stats.tegn += e.tekst.length;
    try {
      const r = await suggest({ kanal: e.kanal, emne: e.emne, tekst: e.tekst, gjelder: e.gjelder });
      if (!TYPES.includes(r.type)) throw new Error("bad type");
      e.type = r.type;
      e.selv = r.selv === true;
      e.forslag = r.svar && !r.selv && r.forslag ? r.forslag : null;
    } catch {
      e.forsok++;
      stats.feil++;
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
      besvart: e.besvart !== null,
    }));
  const mail = { ok: kilder.mail.ok, hentet: cache.sistOk.mail };
  return { bygget: now.toISOString(), kilder: { mail }, meldinger };
}

export async function buildInbox({ pw, kilder, suggest, now, file }) {
  const cache = updateCache({ cache: readCache(pw, file), kilder, now });
  const picked = suggest ? pickNew(cache) : [];
  const run = suggest ? await suggestAll(picked, suggest) : { kall: 0, tegn: 0, feil: 0 };
  writeCache(pw, cache, file);
  const aapne = Object.values(cache.meldinger).filter(e => e.besvart === null).length;
  return { page: toPage(cache, kilder, now), stats: { aapne, nye: picked.length, ...run } };
}
