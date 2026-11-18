import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCache } from "../scripts/innboks-cache.mjs";
import { shortName, contactName, redact, excerpt, gmailLink, updateCache, pickNew, suggestAll, toPage, buildInbox } from "../scripts/innboks.mjs";

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

test("updateCache stores at most 4000 characters of tekst", () => {
  const c = updateCache({ cache: empty(), kilder: src([raw("mail:a:1", { tekst: "x".repeat(50000) })]), now });
  assert.equal(c.meldinger["mail:a:1"].tekst.length, 4000);
  const c2 = updateCache({ cache: c, kilder: src([raw("mail:a:1", { tekst: "y".repeat(50000) })]), now: later });
  assert.equal(c2.meldinger["mail:a:1"].tekst.length, 4000);
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
  assert.equal(readCache("pw", file).meldinger["mail:a:1"].tekst.length, 4000);
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
