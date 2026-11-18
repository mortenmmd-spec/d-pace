import test from "node:test";
import assert from "node:assert/strict";
import { makeSuggester } from "../scripts/innboks-ki.mjs";

const regler = "Du svarer for Pace.";
const redactFn = (t) => t.replace(/\d{8}/g, "[telefon]");

function fakeFetch(answer, { status = 200, raw, stopReason = "end_turn", pre = [], badBody = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body });
    const text = raw !== undefined ? raw : JSON.stringify(answer);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (badBody) throw new SyntaxError("Unexpected token SECRETBODY");
        return { stop_reason: stopReason, content: [...pre, { type: "text", text }] };
      },
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

test("never sends navn, lenke, id or gjelder", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg({ navn: "Kari Nordmann", lenke: "https://example.test/t/1", id: "abc-123-xyz", gjelder: "Ordre #1001" }));
  const b = f.calls[0].body;
  assert.ok(!b.includes("Kari Nordmann"));
  assert.ok(!b.includes("example.test"));
  assert.ok(!b.includes("abc-123-xyz"));
  assert.ok(!b.includes("#1001") && !b.includes("Gjelder"));
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

const userContent = (f) => JSON.parse(f.calls[0].body).messages[0].content;

test("truncation keeps exactly 4000 characters of tekst", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg({ tekst: "a".repeat(5000) }));
  assert.ok(userContent(f).includes("a".repeat(4000)));
  assert.ok(!userContent(f).includes("a".repeat(4001)));
});

test("emne is cut to 300 characters", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg({ emne: "b".repeat(1000) }));
  assert.ok(userContent(f).includes("b".repeat(300)));
  assert.ok(!userContent(f).includes("b".repeat(301)));
});

test("non-JSON answer error does not contain the answer text", async () => {
  await assert.rejects(make(fakeFetch(null, { raw: "hemmelig svartekst" }))(msg()), (e) => {
    assert.ok(!e.message.includes("hemmelig"));
    return true;
  });
});

test("malformed 200 body throws a generic message", async () => {
  await assert.rejects(make(fakeFetch(ok, { badBody: true }))(msg()), (e) => {
    assert.ok(!e.message.includes("SECRETBODY"));
    return true;
  });
});

test("parses when a thinking block comes before the text block", async () => {
  const pre = [{ type: "thinking", thinking: "", signature: "x" }];
  assert.deepEqual(await make(fakeFetch(ok, { pre }))(msg()), ok);
});

test("stop_reason refusal throws", async () => {
  await assert.rejects(make(fakeFetch(ok, { stopReason: "refusal" }))(msg()));
});

test("stop_reason max_tokens throws its own error", async () => {
  await assert.rejects(make(fakeFetch(ok, { stopReason: "max_tokens" }))(msg()), /max_tokens/);
});

test("non-boolean selv throws", async () => {
  await assert.rejects(make(fakeFetch({ ...ok, selv: "nei" }))(msg()));
});

test("empty or whitespace forslag becomes null", async () => {
  const r = await make(fakeFetch({ ...ok, forslag: "  " }))(msg());
  assert.equal(r.forslag, null);
});

test("forslag schema is a plain string and no effort is sent", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg());
  const body = JSON.parse(f.calls[0].body);
  assert.deepEqual(body.output_config.format.schema.properties.forslag, { type: "string" });
  assert.equal(body.output_config.effort, undefined);
});

test("passes an abort signal to fetchFn", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg());
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
});

test("network error is transient", async () => {
  const f = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(make(f)(msg({ tekst: "hemmelig" })), (e) => {
    assert.equal(e.transient, true);
    assert.ok(!e.message.includes("hemmelig"));
    return true;
  });
});

test("non-2xx status is transient", async () => {
  await assert.rejects(make(fakeFetch(ok, { status: 401 }))(msg()), (e) => e.transient === true);
});

for (const [name, f] of [
  ["not JSON", fakeFetch(null, { raw: "ikke json" })],
  ["wrong shape", fakeFetch({ ...ok, type: "annen" })],
  ["refusal", fakeFetch(ok, { stopReason: "refusal" })],
  ["max_tokens", fakeFetch(ok, { stopReason: "max_tokens" })],
  ["bad body", fakeFetch(ok, { badBody: true })],
]) {
  test(`unusable 200 answer (${name}) is not transient`, async () => {
    await assert.rejects(make(f)(msg()), (e) => e.transient !== true);
  });
}

test("non-2xx status is exposed as e.status", async () => {
  await assert.rejects(make(fakeFetch(ok, { status: 429 }))(msg()), (e) => e.status === 429);
});

test("cuts at 4000 and 300 do not split a surrogate pair", async () => {
  const f = fakeFetch(ok);
  await make(f)(msg({ emne: "b".repeat(299) + "😀", tekst: "a".repeat(3999) + "😀 takk" }));
  assert.ok(userContent(f).isWellFormed());
  assert.ok(userContent(f).includes("a".repeat(3999) + "\n"));
});

test("timeout while reading the answer is transient", async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); } });
  await assert.rejects(make(f)(msg()), (e) => e.transient === true);
});
