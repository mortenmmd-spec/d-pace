// Functions that live inside the build script (which runs on import) and the page template, loaded from their source text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const build = read("scripts/build-pace-quest.mjs"), template = read("pace-quest.template.html");
const block = (src, start) => { const s = src.slice(src.indexOf(start)); return s.slice(0, s.indexOf("\n}\n") + 2); };
const line = (src, start) => src.split("\n").find(l => l.startsWith(start));

const gmailBody = `${block(build, "async function svartekst")}\n${line(build, "const baretakk")}\nreturn { svartekst, baretakk };`;
const gmail = payload => new Function("fetch", "Buffer", gmailBody)(async () => ({ ok: true, json: async () => ({ payload }) }), Buffer);
const b64 = s => Buffer.from(s, "utf8").toString("base64url");
const plain = t => gmail({ mimeType: "text/plain", body: { data: b64(t) } });
const htmlOnly = h => gmail({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64(h) } }] });

const TAKK = "Tusen takk for hjelpen med byttet, det setter jeg stor pris på. Jeg fikk pakken i dag og alt var i orden, smaken var akkurat som jeg håpet, og jeg kommer helt sikkert til å bestille igjen neste måned når den første boksen er tom. Ha en fin dag videre!";

test("baretakk is as on main: a 251-character thanks with Gmail's attribution line is still counted", async () => {
  const g = plain(TAKK + "\n\nDen tir. 18. nov. 2026 kl. 10:00 skrev Pace <hei@getpace.no>:\n> Hei! Pakken er sendt.\n");
  assert.equal(TAKK.length, 251);
  assert.equal(await g.baretakk({}, "x"), false);
  assert.equal((await g.svartekst({}, "x")).length, 313);
  assert.equal(await g.svartekst({}, "x", true), TAKK);
});

test("baretakk is as on main: a client quoting without > after the attribution line", async () => {
  const g = plain("Takk!\n\nDen 18.11.2026 kl. 10:00 skrev Pace <hei@getpace.no>:\nHei! Pakken er sendt i dag. Er det noe mer vi kan hjelpe med?\n");
  assert.equal(await g.baretakk({}, "x"), false);
  assert.equal(await g.svartekst({}, "x", true), "Takk!");
});

test("inbox text from an HTML-only mail decodes entities and cuts the attribution line", async () => {
  const g = htmlOnly(`<div dir="ltr">Takk &amp; hilsen, jeg &quot;elsker&quot; det &lt;3 og det er Kari&#39;s favoritt</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">tir. 18. nov. 2026 kl. 10:00 skrev Pace &lt;<a href="mailto:hei@getpace.no">hei@getpace.no</a>&gt;:<br></div><blockquote class="gmail_quote">Hei! Pakken er sendt.</blockquote></div>`);
  assert.equal(await g.svartekst({}, "x", true), `Takk & hilsen, jeg "elsker" det <3 og det er Kari's favoritt`);
  assert.ok((await g.svartekst({}, "x")).includes("skrev Pace &lt; hei@getpace.no &gt;:"));
});

test("contact form row shows the message field", () => {
  const inbLine = new Function(`${line(template, "const inbLine")}\nreturn inbLine;`)();
  const tekst = "Du har mottatt en ny melding fra kontaktskjemaet. Landskode: NO Navn: Lise Hansen E-post: l@x.no Kommentar: Når kommer pakken?";
  assert.equal(inbLine({ emne: "Ny kundemelding", tekst }), "Når kommer pakken?");
  assert.equal(inbLine({ emne: "Ny kundemelding", tekst: "Du har mottatt en ny melding." }), "Du har mottatt en ny melding.");
  assert.equal(inbLine({ emne: "Spørsmål", tekst: "Melding: hei" }), "Melding: hei");
  assert.equal(inbLine({ emne: "Spørsmål", tekst: "" }), "Spørsmål");
});

test("inbSafeRender logs the error and shows the fallback text", () => {
  const logged = [], el = {};
  const safe = new Function("inbRender", "document", "console", `${block(template, "function inbSafeRender")}\nreturn inbSafeRender;`)(
    () => { throw new Error("boom"); }, { getElementById: () => el }, { error: (...a) => logged.push(a) });
  safe();
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "innboks");
  assert.equal(el.textContent, "Innboks er ikke tilgjengelig i dette bygget.");
});

// Codex review 18.11.2026

const capture = () => { const logged = []; return { logged, console: { error: (...a) => logged.push(a.join(" ")), log: (...a) => logged.push(a.join(" ")) } }; };

test("the Gmail error log has no bit of the answer, and the card keeps the message as on main", async () => {
  const run = new Function("fetchHenvendelser", "console", `return (async () => { let henv = null, henvErr = ""; ${line(build, "try { henv = await fetchHenvendelser();")} return henvErr; })();`);
  let parseError;
  try { JSON.parse("Kari Nordmann skrev: hvor er pakken"); } catch (e) { parseError = e; }
  const c1 = capture();
  assert.equal(await run(async () => { throw parseError; }, c1.console), parseError.message);
  assert.equal(c1.logged.length, 1);
  assert.ok(!c1.logged[0].includes("Kari"), c1.logged[0]);
  assert.ok(c1.logged[0].includes("SyntaxError"));
  for (const msg of ["Gmail threads 401", "Gmail: token-feil invalid_grant", "mangler env GMAIL_CLIENT_ID"]) {
    const c = capture();
    await run(async () => { throw new Error(msg); }, c.console);
    assert.equal(c.logged[0], "Henvendelser utilgjengelig: " + msg);
  }
  const c2 = capture();
  await run(async () => { throw new Error("Gmail: token-feil Kari Nordmann"); }, c2.console);
  assert.ok(!c2.logged[0].includes("Kari"));
});

test("the Innboks error log has only the error code or type", () => {
  const c = capture();
  const inb = new Function("console", "err", `let INNBOKS = 1; try { throw err; ${line(build, "} catch (e) { INNBOKS = null;")}\nreturn INNBOKS;`);
  let parseError;
  try { JSON.parse("Kari Nordmann"); } catch (e) { parseError = e; }
  assert.equal(inb(c.console, parseError), null);
  assert.equal(inb(c.console, Object.assign(new Error("innboks cache unreadable"), { code: "INNBOKS_CACHE" })), null);
  assert.deepEqual(c.logged, ["Innboks utilgjengelig: SyntaxError", "Innboks utilgjengelig: INNBOKS_CACHE"]);
});

test("the number on the Innboks button stays the source count after «Marker besvart»", () => {
  const code = `${line(template, "const inbDone")}\n${template.split("\n").filter(l => l.startsWith("const inbCount")).join("\n")}\n${block(template, "function inbBtnCount")}\nreturn inbBtnCount;`;
  const msgs = [{ id: "m1", besvart: false }, { id: "m2", besvart: true }];
  const btnCount = new Function("INNBOKS", "inbMsgs", "inbHidden", "document", code)({ meldinger: msgs }, msgs, { m1: Date.now() + 3600000 }, { createElement: () => ({}) });
  const shown = [];
  btnCount({ append: s => shown.push(s.textContent) });
  assert.deepEqual(shown, [1]);
});

const T0 = Date.UTC(2026, 10, 17, 9);
const henvendelser = threads => {
  const msgs = {}, threadJson = {};
  for (const [tid, list] of Object.entries(threads)) threadJson[tid] = { messages: list.map(([from, subject, text], i) => {
    const id = `${tid}m${i}`; msgs[id] = { mimeType: "text/plain", body: { data: b64(text) } };
    return { id, internalDate: String(T0 + i * 3600000), payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }] } };
  }) };
  const fetch = async url => { const u = String(url); return { ok: true, status: 200, json: async () => u.includes("/threads?") ? { threads: Object.keys(threads).map(id => ({ id })) } : u.includes("/threads/") ? threadJson[u.split("/threads/")[1].split("?")[0]] : { payload: msgs[u.split("/messages/")[1].split("?")[0]] } }; };
  const body = [line(build, "const HENV_FRA"), line(build, "const AUTO_FROM"), line(build, "const OSS"), block(build, "async function svartekst"), line(build, "const baretakk"), block(build, "async function fetchHenvendelser"), "return fetchHenvendelser;"].join("\n");
  const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const osloDay = d => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return new Function("fetch", "Buffer", "gmailAuth", "addDays", "osloDay", "readFileSync", "path", "DIR", "process", body)(fetch, Buffer, async () => ({}), addDays, osloDay, () => '{"lukket":[]}', { join: () => "" }, "", { env: {} })();
};

test("the inbox identity is the last sender, while the card still shows the thread's first sender as on main", async () => {
  const h = await henvendelser({ t1: [["Kari <kari@x.no>", "Pakke", "Hvor er pakken?"], ["Ola <ola@x.no>", "Re: Pakke", "Jeg venter også på min."]] });
  assert.equal(h.n, 1);
  assert.equal(h.open[0].navn, "Kari");
  assert.equal(h.open[0].fra, "Ola <ola@x.no>");
  assert.equal(h.open[0].tekst, "Jeg venter også på min.");
});

test("a message shown with the previous message's text says so and offers no suggestion", () => {
  const els = {};
  const msg = { id: "m2", kanal: "mail", navn: "Kari N.", ts: T0, emne: "Pakke", tekst: "Hvor er pakken?", gjelder: null, type: null, forslag: null, selv: false, svar: null, besvart: false, gammelTekst: true };
  const detail = new Function("inbMsgs", "inbSel", "document", "INNBOKS", "INB_KANAL", "inbDay", "inbClock", "inbDate", `${line(template, "const esc")}\n${block(template, "function inbDetail")}\nreturn inbDetail;`)(
    [msg], "m2", { getElementById: id => (els[id] ||= {}) }, {}, { mail: "Mail" }, () => "2026-11-17", () => "10:00", () => "17.11");
  detail();
  const h = els["inb-detail"].innerHTML;
  assert.ok(h.includes("Den nye meldingen kunne ikke hentes. Teksten under er fra forrige melding i tråden."));
  assert.ok(h.includes("Ingen forslag"));
  assert.ok(!h.includes("inb-draft"));
  msg.gammelTekst = false;
  detail();
  assert.ok(!els["inb-detail"].innerHTML.includes("forrige melding"));
});
