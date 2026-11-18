import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCache } from "../scripts/innboks-cache.mjs";
import { shortName, contactName, redact, excerpt, gmailLink, updateCache, pickNew, suggestAll, toPage, buildInbox } from "../scripts/innboks.mjs";
import { makeSuggester } from "../scripts/innboks-ki.mjs";

const now = new Date("2026-11-18T12:00:00Z");
const later = new Date("2026-11-18T13:00:00Z");
const raw = (id, extra = {}) => ({ id, kanal: "mail", navn: "Per H.", ts: 1, emne: "e", tekst: "t", lenke: "l", gjelder: null, ...extra });
const empty = () => ({ v: 1, sistOk: { mail: null }, meldinger: {} });
const src = (aapne, ok = true) => ({ mail: { ok, aapne } });
const entry = (id, extra = {}) => ({ ...raw(id), sett: now.toISOString(), besvart: null, type: null, forslag: null, selv: false, forsok: 0, ...extra });

test("shortName quoted name", () => assert.equal(shortName('"Per Hansen" <per@x.no>'), "Per H."));
test("shortName three words", () => assert.equal(shortName("Kari Nordmann Olsen <k@x.no>"), "Kari O."));
test("shortName address only", () => assert.equal(shortName("per.hansen@x.no"), "per.hansen"));
test("shortName single word", () => assert.equal(shortName("Madonna <m@x.no>"), "Madonna"));

test("redact phone and email", () => assert.equal(redact("Ring 934 12 345 eller per@x.no, +47 93412345"), "Ring [telefon] eller [e-post], [telefon]"));
test("redact keeps order numbers and dates", () => assert.equal(redact("Ordre 5359712 kom 13.11.2026"), "Ordre 5359712 kom 13.11.2026"));

test("excerpt", () => {
  assert.equal(excerpt("a".repeat(700)).length, 601);
  assert.ok(excerpt("a".repeat(700)).endsWith("…"));
  assert.equal(excerpt("kort"), "kort");
});

test("gmailLink", () => assert.equal(gmailLink("abc"), "https://mail.google.com/mail/?authuser=hei@getpace.no#all/abc"));

test("updateCache adds new entry and sets sistOk", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1")]), now });
  assert.equal(c.meldinger["mail:a:1"].sett, now.toISOString());
  assert.equal(c.meldinger["mail:a:1"].besvart, null);
  assert.equal(c.meldinger["mail:a:1"].forsok, 0);
  assert.equal(c.sistOk.mail, now.toISOString());
});

test("updateCache does not mutate input", () => {
  const input = empty();
  updateCache({ cache: input, kilder: src([raw("mail:a:1")]), now });
  assert.deepEqual(input, empty());
});

test("gone from source means answered", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1")]), now });
  const c2 = updateCache({ cache: c, kilder: src([]), now: later });
  assert.equal(c2.meldinger["mail:a:1"].besvart, later.toISOString());
});

test("failed source changes nothing", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1")]), now });
  const c3 = updateCache({ cache: c, kilder: src([], false), now: later });
  assert.equal(c3.meldinger["mail:a:1"].besvart, null);
  assert.equal(c3.sistOk.mail, now.toISOString());
});

test("answered dropped after 30 days, unanswered never", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1")]), now });
  const c2 = updateCache({ cache: c, kilder: src([]), now: later });
  const c4 = updateCache({ cache: c2, kilder: src([]), now: new Date("2026-12-18T13:00:01Z") });
  assert.equal(c4.meldinger["mail:a:1"], undefined);
  const c4b = updateCache({ cache: c2, kilder: src([]), now: new Date("2026-12-18T12:59:59Z") });
  assert.ok(c4b.meldinger["mail:a:1"]);
  const c5 = updateCache({ cache: c, kilder: src([raw("mail:a:1")]), now: new Date("2027-03-01T00:00:00Z") });
  assert.ok(c5.meldinger["mail:a:1"]);
});

test("failed source keeps old answered entries", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1")]), now });
  const c2 = updateCache({ cache: c, kilder: src([]), now: later });
  const c3 = updateCache({ cache: c2, kilder: src([], false), now: new Date("2027-03-01T00:00:00Z") });
  assert.ok(c3.meldinger["mail:a:1"]);
});

test("existing entry keeps its suggestion when seen again", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1")]), now });
  c.meldinger["mail:a:1"].forslag = "Hei!";
  assert.equal(updateCache({ cache: c, kilder: src([raw("mail:a:1")]), now: later }).meldinger["mail:a:1"].forslag, "Hei!");
});

test("pickNew: newest first, max 30, skips excluded", () => {
  const cache = empty();
  for (let i = 1; i <= 35; i++) cache.meldinger["m" + i] = entry("m" + i, { ts: i });
  cache.meldinger.e1 = entry("e1", { ts: 100, tekst: "" });
  cache.meldinger.e2 = entry("e2", { ts: 101, besvart: now.toISOString() });
  cache.meldinger.e3 = entry("e3", { ts: 102, type: "annet" });
  cache.meldinger.e4 = entry("e4", { ts: 103, forsok: 3 });
  const p = pickNew(cache);
  assert.equal(p.length, 30);
  assert.equal(p[0].ts, 35);
  assert.ok(!p.some(e => ["e1", "e2", "e3", "e4"].includes(e.id)));
  assert.equal(pickNew(cache, 5).length, 5);
});

test("suggestAll: answer suggestion", async () => {
  const e = entry("a", { tekst: "Hei" });
  let arg;
  const s = await suggestAll([e], async m => { arg = m; return { type: "sporsmal", svar: true, selv: false, forslag: "Hei Per!" }; });
  assert.equal(e.type, "sporsmal");
  assert.equal(e.forslag, "Hei Per!");
  assert.deepEqual(s, { kall: 1, tegn: 3, feil: 0, status: {} });
  assert.deepEqual(Object.keys(arg).sort(), ["emne", "gjelder", "kanal", "tekst"]);
});

test("suggestAll: selv drops suggestion", async () => {
  const e = entry("a");
  await suggestAll([e], async () => ({ type: "annet", svar: true, selv: true, forslag: "x" }));
  assert.equal(e.selv, true);
  assert.equal(e.forslag, null);
});

test("suggestAll: svar false drops suggestion", async () => {
  const e = entry("a");
  await suggestAll([e], async () => ({ type: "annet", svar: false, selv: false, forslag: "x" }));
  assert.equal(e.type, "annet");
  assert.equal(e.forslag, null);
});

test("suggestAll: rejection counts a try and continues", async () => {
  const a = entry("a"), b = entry("b");
  let n = 0;
  const s = await suggestAll([a, b], async () => {
    if (n++ === 0) throw new Error("boom");
    return { type: "ros", svar: true, selv: false, forslag: "Takk" };
  });
  assert.equal(a.forsok, 1);
  assert.equal(a.type, null);
  assert.equal(s.feil, 1);
  assert.equal(s.kall, 2);
  assert.equal(b.type, "ros");
  assert.equal(b.forslag, "Takk");
});

test("toPage shape", () => {
  const cache = empty();
  cache.sistOk.mail = now.toISOString();
  cache.meldinger.a = entry("a", { ts: 1, tekst: "x".repeat(700) });
  cache.meldinger.b = entry("b", { ts: 2, besvart: later.toISOString(), tekst: "" });
  const p = toPage(cache, src([], false), now);
  assert.equal(p.bygget, now.toISOString());
  assert.deepEqual(p.kilder.mail, { ok: false, hentet: now.toISOString() });
  assert.deepEqual(p.meldinger.map(m => m.id), ["b", "a"]);
  assert.equal(p.meldinger[1].tekst.length, 601);
  assert.equal(p.meldinger[0].tekst, "");
  assert.equal(p.meldinger[0].besvart, true);
  assert.equal(p.meldinger[1].besvart, false);
  for (const m of p.meldinger) {
    assert.ok(!("forsok" in m));
    assert.ok(!("sett" in m));
  }
  assert.deepEqual(Object.keys(p.meldinger[0]).sort(), ["besvart", "emne", "forslag", "gjelder", "id", "kanal", "lenke", "navn", "selv", "svar", "tekst", "ts", "type"]);
  assert.equal(toPage(cache, src([]), now).kilder.mail.ok, true);
});

test("buildInbox with suggest null, then second run", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "innboks-")), "c.enc");
  const r1 = await buildInbox({ pw: "pw", kilder: src([raw("mail:a:1"), raw("mail:a:2", { ts: 2 })]), suggest: null, now, file });
  assert.ok(existsSync(file));
  assert.equal(r1.page.meldinger.length, 2);
  assert.ok(r1.page.meldinger.every(m => m.forslag === null));
  assert.deepEqual(r1.stats, { aapne: 2, nye: 0, kall: 0, tegn: 0, feil: 0, status: {} });
  const r2 = await buildInbox({ pw: "pw", kilder: src([raw("mail:a:2", { ts: 2 })]), suggest: null, now: later, file });
  assert.equal(r2.page.meldinger.find(m => m.id === "mail:a:1").besvart, true);
  assert.equal(r2.page.meldinger.find(m => m.id === "mail:a:2").besvart, false);
  assert.equal(r2.stats.aapne, 1);
});

test("buildInbox with suggest fills suggestions", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "innboks-")), "c.enc");
  const r = await buildInbox({ pw: "pw", kilder: src([raw("mail:a:1")]), suggest: async () => ({ type: "sporsmal", svar: true, selv: false, forslag: "Hei" }), now, file });
  assert.equal(r.page.meldinger[0].forslag, "Hei");
  assert.deepEqual(r.stats, { aapne: 1, nye: 1, kall: 1, tegn: 1, feil: 0, status: {} });
});

test("redact: unicode letters in e-mail", () => assert.equal(redact("Skriv til bjørn.ås@x.no."), "Skriv til [e-post]."));
test("redact: phone variants", () => {
  assert.equal(redact("Tlf.93412345"), "Tlf.[telefon]");
  assert.equal(redact("0047 93412345"), "[telefon]");
  assert.equal(redact("934-12-345"), "[telefon]");
  assert.equal(redact("13.11.2026"), "13.11.2026");
});
test("shortName: surname first with comma", () => assert.equal(shortName('"Hansen, Per" <p@x.no>'), "Per H."));
test("shortName: bare address in brackets", () => assert.equal(shortName("<k@x.no>"), "k"));
test("suggestAll: unknown type counts as failed attempt", async () => {
  const e = entry("a");
  const s = await suggestAll([e], async () => ({ type: "spam", svar: true, selv: false, forslag: "x" }));
  assert.equal(e.type, null);
  assert.equal(e.forsok, 1);
  assert.equal(e.forslag, null);
  assert.equal(s.feil, 1);
});

const ok1 = async () => ({ type: "sporsmal", svar: true, selv: false, forslag: "Hei" });

test("updateCache stores at most 4200 characters of tekst", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1", { tekst: "x".repeat(50000) })]), now });
  assert.equal(c.meldinger["mail:a:1"].tekst.length, 4200);
  const c2 = updateCache({ cache: c, kilder: src([raw("mail:a:1", { tekst: "y".repeat(50000) })]), now: later });
  assert.equal(c2.meldinger["mail:a:1"].tekst.length, 4200);
});

test("buildInbox cuts stored tekst to the page excerpt once classified, and keeps it cut", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "innboks-")), "c.enc");
  const long = raw("mail:a:1", { tekst: "x".repeat(50000) });
  const r1 = await buildInbox({ pw: "pw", kilder: src([long]), suggest: ok1, now, file });
  assert.equal(readCache("pw", file).meldinger["mail:a:1"].tekst.length, 601);
  const r2 = await buildInbox({ pw: "pw", kilder: src([long]), suggest: ok1, now: later, file });
  assert.equal(readCache("pw", file).meldinger["mail:a:1"].tekst.length, 601);
  assert.deepEqual(r2.page.meldinger, r1.page.meldinger);
  assert.equal(r1.page.meldinger[0].tekst, excerpt("x".repeat(50000)));
});

test("buildInbox cuts tekst for answered and for exhausted entries", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "innboks-")), "c.enc");
  const long = raw("mail:a:1", { tekst: "x".repeat(5000) });
  await buildInbox({ pw: "pw", kilder: src([long]), suggest: async () => { throw new Error("bad"); }, now, file });
  assert.equal(readCache("pw", file).meldinger["mail:a:1"].tekst.length, 4200);
  await buildInbox({ pw: "pw", kilder: src([long]), suggest: async () => { throw new Error("bad"); }, now, file });
  await buildInbox({ pw: "pw", kilder: src([long]), suggest: async () => { throw new Error("bad"); }, now, file });
  assert.equal(readCache("pw", file).meldinger["mail:a:1"].tekst.length, 601);
  const file2 = path.join(mkdtempSync(path.join(tmpdir(), "innboks-")), "c.enc");
  await buildInbox({ pw: "pw", kilder: src([long]), suggest: null, now, file: file2 });
  await buildInbox({ pw: "pw", kilder: src([]), suggest: null, now: later, file: file2 });
  assert.equal(readCache("pw", file2).meldinger["mail:a:1"].tekst.length, 601);
});

test("suggestAll: transient error stops the round without counting a try", async () => {
  const a = entry("a"), b = entry("b"), c = entry("c");
  let n = 0;
  const s = await suggestAll([a, b, c], async () => {
    n++;
    if (n === 2) throw Object.assign(new Error("net"), { transient: true });
    return { type: "ros", svar: true, selv: false, forslag: "Takk" };
  });
  assert.equal(n, 2);
  assert.equal(a.type, "ros");
  assert.equal(b.forsok, 0);
  assert.equal(c.forsok, 0);
  assert.equal(s.feil, 1);
});

test("suggestAll: non-transient error counts a try and continues", async () => {
  const a = entry("a"), b = entry("b");
  let n = 0;
  const s = await suggestAll([a, b], async () => { n++; throw Object.assign(new Error("shape"), { transient: false }); });
  assert.equal(n, 2);
  assert.equal(a.forsok, 1);
  assert.equal(b.forsok, 1);
  assert.equal(s.feil, 2);
});

test("shortName: leading comma does not throw", () => assert.equal(shortName('", Per" <p@x.no>'), "Per"));
test("shortName: empty from gives empty string", () => assert.equal(shortName(""), ""));

test("suggestAll: tegn counts characters sent, capped at 4000", async () => {
  const e = entry("a", { tekst: "x".repeat(50000) });
  const s = await suggestAll([e], ok1);
  assert.equal(s.tegn, 4000);
});

test("suggestAll: svar is stored, also when false", async () => {
  const e = entry("a");
  await suggestAll([e], async () => ({ type: "annet", svar: false, selv: false, forslag: null }));
  assert.equal(e.svar, false);
  assert.equal(toPage({ ...empty(), meldinger: { a: e } }, src([]), now).meldinger[0].svar, false);
});

test("suggestAll: counts errors per HTTP status", async () => {
  const es = [entry("a"), entry("b"), entry("c"), entry("d")];
  let n = 0;
  const s = await suggestAll(es, async () => {
    n++;
    if (n <= 2) throw Object.assign(new Error("x"), { status: 429 });
    if (n === 3) throw new Error("shape");
    return { type: "ros", svar: true, selv: false, forslag: "Takk" };
  });
  assert.deepEqual(s.status, { 429: 2, annen: 1 });
  assert.equal(s.feil, 3);
});

test("updateCache: new message in same thread removes the old unanswered entry", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1")]), now });
  const c2 = updateCache({ cache: c, kilder: src([raw("mail:a:2")]), now: later });
  assert.deepEqual(Object.keys(c2.meldinger), ["mail:a:2"]);
});

test("updateCache: new message keeps answered entries and other threads", () => {
  let c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1"), raw("mail:b:1")]), now });
  c = updateCache({ cache: c, kilder: src([raw("mail:b:1")]), now: later });
  const c2 = updateCache({ cache: c, kilder: src([raw("mail:b:1"), raw("mail:a:2")]), now: later });
  assert.deepEqual(Object.keys(c2.meldinger).sort(), ["mail:a:1", "mail:a:2", "mail:b:1"]);
  assert.notEqual(c2.meldinger["mail:a:1"].besvart, null);
});

test("updateCache: failed text or order lookup keeps the old values", () => {
  const gj = { type: "ordre", nr: "#1", dato: "2026-11-01", status: "sendt", sporing: "" };
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1", { tekst: "Hei der", gjelder: gj })]), now });
  const c2 = updateCache({ cache: c, kilder: src([raw("mail:a:1", { tekst: "", gjelder: null })]), now: later });
  assert.equal(c2.meldinger["mail:a:1"].tekst, "Hei der");
  assert.deepEqual(c2.meldinger["mail:a:1"].gjelder, gj);
});

test("redact: international phone numbers", () => {
  assert.equal(redact("Ring +46 70 123 45 67"), "Ring [telefon]");
  assert.equal(redact("Ring +45 12 34 56 78 nå"), "Ring [telefon] nå");
  assert.equal(redact("Ring +46701234567."), "Ring [telefon].");
  assert.equal(redact("Ring 0046 70 123 45 67"), "Ring [telefon]");
  assert.equal(redact("Ordre 5359712 kom 13.11.2026"), "Ordre 5359712 kom 13.11.2026");
});

test("contactName: reads Navn from a contact form text", () => {
  assert.equal(contactName("Navn: Lise Marie Hansen E-post: l@x.no Melding: Hei"), "Lise H.");
  assert.equal(contactName("Navn: Lise M. Melding: Kan jeg bytte?"), "Lise M.");
  assert.equal(contactName("Navn:\nPer Hansen\nTelefon: 123"), "Per H.");
  assert.equal(contactName("Hei, jeg lurer på noe"), "");
  assert.equal(contactName("Navn: " + "x".repeat(200)), "");
});

const fakeApi = () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    sent.push(JSON.parse(init.body).messages[0].content);
    return { ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ type: "ros", svar: false, selv: false, forslag: "" }) }] }) };
  };
  return { sent, ask: makeSuggester({ apiKey: "k", regler: "r", redactFn: redact, fetchFn }) };
};
const status400 = () => Object.assign(new Error("Claude API error: HTTP 400"), { transient: true, status: 400 });

test("suggestAll: a 400 counts a try and the round goes on", async () => {
  const a = entry("a"), b = entry("b"), c = entry("c");
  let n = 0;
  const s = await suggestAll([a, b, c], async () => { if (n++ === 0) throw status400(); return ok1(); });
  assert.equal(n, 3);
  assert.equal(a.forsok, 1);
  assert.equal(b.type, "sporsmal");
  assert.equal(c.type, "sporsmal");
  assert.deepEqual(s.status, { 400: 1 });
});

test("suggestAll: a second 400 in the same round stops it", async () => {
  const a = entry("a"), b = entry("b"), c = entry("c");
  let n = 0;
  await suggestAll([a, b, c], async () => { n++; throw status400(); });
  assert.equal(n, 2);
  assert.deepEqual([a.forsok, b.forsok, c.forsok], [1, 1, 0]);
});

test("buildInbox: a message that always gets 400 is given up after three builds and does not hold back older ones", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "innboks-")), "c.enc");
  const kilder = src([raw("mail:p:1", { ts: 3, tekst: "p" }), raw("mail:a:1", { ts: 2, tekst: "a" }), raw("mail:b:1", { ts: 1, tekst: "b" })]);
  let calls = 0;
  const suggest = async m => { calls++; if (m.tekst === "p") throw status400(); return ok1(); };
  for (let h = 0; h < 4; h++) await buildInbox({ pw: "pw", kilder, suggest, now: new Date(now.getTime() + h * 3600000), file });
  const c = readCache("pw", file).meldinger;
  assert.equal(c["mail:p:1"].forsok, 3);
  assert.equal(c["mail:a:1"].forslag, "Hei");
  assert.equal(c["mail:b:1"].forslag, "Hei");
  assert.equal(calls, 5);
});

test("updateCache and excerpt do not split a surrogate pair", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1", { tekst: "a".repeat(4199) + "😀 takk" })]), now });
  assert.equal(c.meldinger["mail:a:1"].tekst, "a".repeat(4199));
  assert.ok(excerpt("a".repeat(599) + "😀 takk").isWellFormed());
  assert.equal(excerpt("a".repeat(598) + "😀 takk"), "a".repeat(598) + "😀…");
});

test("an address at the 4000 cut is redacted before the text is cut", async () => {
  const tekst = "x ".repeat(1993) + "kari.nordmann@gmail.com takk";
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1", { tekst })]), now });
  const { sent, ask } = fakeApi();
  await ask({ kanal: "mail", emne: "Hei", tekst: c.meldinger["mail:a:1"].tekst, gjelder: null });
  assert.ok(!sent[0].includes("kari.nordmann"));
  assert.ok(sent[0].includes("[e-post]"));
});

test("suggestAll: tegn is capped at 4000 although 4200 characters are stored", async () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1", { tekst: "x".repeat(5000) })]), now });
  assert.equal((await suggestAll([c.meldinger["mail:a:1"]], ok1)).tegn, 4000);
});

test("buildInbox without suggest stores only the excerpt", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "innboks-")), "c.enc");
  await buildInbox({ pw: "pw", kilder: src([raw("mail:a:1", { tekst: "x".repeat(5000) })]), suggest: null, now, file });
  assert.equal(readCache("pw", file).meldinger["mail:a:1"].tekst.length, 601);
});

test("buildInbox: once suggest is set, the suggestion gets the fresh full text", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "innboks-")), "c.enc");
  const kilder = src([raw("mail:a:1", { tekst: "x".repeat(5000) })]);
  await buildInbox({ pw: "pw", kilder, suggest: null, now, file });
  let got;
  await buildInbox({ pw: "pw", kilder, suggest: async m => { got = m.tekst; return ok1(); }, now: later, file });
  assert.equal(got.length, 4200);
});

test("contactName: falls back to empty when the form is not as expected", () => {
  assert.equal(contactName("Navn: Lise Hansen Kommentar: Hei, når kommer pakken"), "Lise H.");
  assert.equal(contactName("Navn: Telefon: 91234567 Melding: hei"), "");
  assert.equal(contactName("Navn: , Melding: hei"), "");
  assert.equal(contactName("Landskode: NO Name: Lise Hansen Email: l@x.no Body: Hei"), "Lise H.");
  assert.equal(contactName("Name: Lise Hansen Phone number: 912 34 567 Comment: Hei"), "Lise H.");
  assert.equal(contactName("Navn: Hansen, Lise Melding: Hei"), "Lise H.");
  assert.equal(contactName("Navn: Lise Hansen Telefonnummer: 91234567 Kommentar: Hei"), "Lise H.");
  assert.equal(contactName("Navn: Lise Hansen Adresse: Storgata 1 Melding: Hei"), "");
  assert.equal(contactName("Navn: Lise Hansen"), "Lise H.");
});

test("updateCache keeps the old navn when the text could not be fetched", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1", { navn: "Lise H.", tekst: "Navn: Lise Hansen Melding: Hei" })]), now });
  const c2 = updateCache({ cache: c, kilder: src([raw("mail:a:1", { navn: "Pace", tekst: "" })]), now: later });
  assert.equal(c2.meldinger["mail:a:1"].navn, "Lise H.");
});

test("redact: Norwegian phone forms", () => {
  assert.equal(redact("Ring 91 234 567 eller 9123 4567"), "Ring [telefon] eller [telefon]");
  assert.equal(redact("Ring 912.34.567."), "Ring [telefon].");
  assert.equal(redact("Ring 93412345."), "Ring [telefon].");
  assert.equal(redact("Tlf 22 123 456"), "Tlf [telefon]");
});

test("redact: amounts, order numbers, postal codes and dates stay", () => {
  for (const s of ["Beløp kr 1 299,00", "Pris 12 990 kr", "Omsetning 1 000 000 kr", "Omsetning 1 000 000 000 kr", "Ordre #1001 og #10023", "Ordre #53597120",
    "Ordre 5359712", "Postnr 0150 Oslo", "Postnr 4010 Stavanger", "Dato 13.11.2026 og 2026-11-13", "Sesong 2026 2027", "Ordre 1001 1002",
    "Orgnr 923 456 789", "Kontonr 1234.56.78901", "Beløp 12345678.50"]) assert.equal(redact(s), s);
});

test("redact: the value of a name field", () => {
  assert.equal(redact("Navn: Lise Marie Hansen E-post: l@x.no Melding: Hei"), "Navn: [navn] E-post: [e-post] Melding: Hei");
  assert.equal(redact("Name: Lise Hansen Phone number: 912 34 567"), "Name: [navn] number: [telefon]");
  assert.equal(redact("Fornavn: Lise Etternavn: Hansen Melding: Hei"), "Fornavn: [navn] Etternavn: [navn] Melding: Hei");
  assert.equal(redact("Navn: Lise Hansen"), "Navn: [navn]");
  assert.equal(redact("Navn: Lise Hansen hei jeg lurer på noe"), "Navn: [navn] jeg lurer på noe");
});

test("the full name from a contact form is not sent to the API", async () => {
  const { sent, ask } = fakeApi();
  await ask({ kanal: "mail", emne: "Ny kundemelding", tekst: "Du har mottatt en ny melding. Landskode: NO Navn: Lise Marie Hansen E-post: lise@x.no Telefonnummer: 91 234 567 Kommentar: Når kommer pakken?", gjelder: null });
  for (const s of ["Lise", "Marie", "Hansen", "lise@", "234 567"]) assert.ok(!sent[0].includes(s), s);
  assert.ok(sent[0].includes("Når kommer pakken?"));
});
