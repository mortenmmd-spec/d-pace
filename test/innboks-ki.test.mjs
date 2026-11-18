import test from "node:test";
import assert from "node:assert/strict";
import { makeSuggester } from "../scripts/innboks-ki.mjs";

const regler = "Du svarer for Pace.";
const redactFn = (t) => t.replace(/\d{8}/g, "[telefon]");

function fakeFetch(answer, { status = 200, raw } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body });
    const text = raw !== undefined ? raw : JSON.stringify(answer);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text }] }),
    };
  };
  fn.calls = calls;
  return fn;
}

const ok = { type: "sporsmal", svar: true, selv: false, forslag: "Hei Kari!\nVi sjekker." };
const make = (fetchFn, extra = {}) =>
  makeSuggester({ apiKey: "test-key", regler, redactFn, fetchFn, ...extra });
const msg = (extra = {}) => ({ kanal: "epost", emne: "Spørsmål", tekst: "Hei", ...extra });

test("sends the redacted text", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg({ tekst: "Ring 93412345" }));
  assert.ok(f.calls[0].body.includes("[telefon]"));
  assert.ok(!f.calls[0].body.includes("93412345"));
});

test("cuts tekst to 4000 characters", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg({ tekst: "a".repeat(50000) }));
  assert.ok(f.calls[0].body.length < 6000 + regler.length);
});

test("never sends navn, lenke or id", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg({ navn: "Kari Nordmann", lenke: "https://example.test/t/1", id: "abc-123-xyz" }));
  const b = f.calls[0].body;
  assert.ok(!b.includes("Kari Nordmann"));
  assert.ok(!b.includes("example.test"));
  assert.ok(!b.includes("abc-123-xyz"));
});

test("uses model, api key and url", async () => {
  const f = fakeFetch(ok);
  await make(f, { model: "claude-test-model" })(msg());
  const c = f.calls[0];
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.init.headers["x-api-key"], "test-key");
  assert.equal(c.init.headers["anthropic-version"], "2026-10-21");
  assert.equal(JSON.parse(c.body).model, "claude-test-model");
  assert.equal(JSON.parse(c.body).system, regler);
});

test("defaults to claude-haiku-5-5", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg());
  assert.equal(JSON.parse(f.calls[0].body).model, "claude-haiku-5-5");
});

test("parses a valid answer", async () => {
  assert.deepEqual(await make(fakeFetch(ok))(msg()), ok);
});

test("selv true gives forslag null", async () => {
  const r = await make(fakeFetch({ ...ok, selv: true }))(msg());
  assert.equal(r.forslag, null);
  assert.equal(r.selv, true);
});

test("svar false gives forslag null", async () => {
  const r = await make(fakeFetch({ ...ok, type: "annet", svar: false }))(msg());
  assert.equal(r.forslag, null);
});

for (const status of [429, 500]) {
  test(`throws on HTTP ${status} without message text`, async () => {
    const f = fakeFetch(ok, { status });
    await assert.rejects(make(f)(msg({ tekst: "hemmelig kundetekst" })), (e) => {
      assert.ok(e.message.includes(String(status)));
      assert.ok(!e.message.includes("hemmelig"));
      return true;
    });
  });
}

test("throws when the answer is not valid JSON", async () => {
  await assert.rejects(make(fakeFetch(null, { raw: "ikke json" }))(msg()));
});

test("throws when type is not one of the four values", async () => {
  await assert.rejects(make(fakeFetch({ ...ok, type: "annen" }))(msg()));
});

test("throws when svar or selv are not booleans", async () => {
  await assert.rejects(make(fakeFetch({ ...ok, svar: "ja" }))(msg()));
});

test("includes gjelder as plain text when present", async () => {
  const f = fakeFetch(ok);
  const g = "Ordre #5359, 2026-11-13, sendt, Helthjem 123";
  await make(f)(msg({ gjelder: g }));
  assert.ok(f.calls[0].body.includes(g));
});
