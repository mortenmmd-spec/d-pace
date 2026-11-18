import { test } from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";
import { encryptJson, decryptJson } from "../scripts/plan-crypt.mjs";
import { readCache, writeCache } from "../scripts/innboks-cache.mjs";
const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "inb-")), "innboks.enc");

test("encryptJson round-trips and uses a fresh salt each time", () => {
  const a = encryptJson("pw", { x: "æøå" }), b = encryptJson("pw", { x: "æøå" });
  assert.deepEqual(decryptJson("pw", a), { x: "æøå" }); assert.notEqual(a, b);
});
test("decryptJson throws on wrong password", () => { assert.throws(() => decryptJson("feil", encryptJson("pw", { x: 1 }))); });
test("readCache returns an empty cache when the file is missing", () => {
  assert.deepEqual(readCache("pw", tmp()), { v: 1, sistOk: { mail: null }, meldinger: {} });
});
test("writeCache then readCache gives the same cache, and the file holds no plaintext", () => {
  const f = tmp(), c = { v: 1, sistOk: { mail: "2026-11-18T12:00:00.000Z" }, meldinger: { "mail:a:b": { navn: "Per H.", tekst: "hemmelig" } } };
  writeCache("pw", c, f); assert.deepEqual(readCache("pw", f), c);
  assert.ok(!readFileSync(f, "utf8").includes("hemmelig"));
});
test("readCache returns an empty cache when the file cannot be decrypted", () => {
  const f = tmp(); writeFileSync(f, "ikke-gyldig"); assert.deepEqual(readCache("pw", f).meldinger, {});
});
