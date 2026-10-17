// Pace 2.0-planen (fra ~/pace-okonomi/pace20/chart.json) ligger kryptert i repoet, siden d-pace er offentlig.
// Nøkkel = scrypt(sidepassordet), AES-256-GCM. Samme passord som dashboardet (STATICRYPT_PASSWORD).
//   node scripts/plan-crypt.mjs encrypt <chart.json>   → data/pace20-plan.enc (lokalt, fra render.mjs)
//   import { readPlan } from "./plan-crypt.mjs"          → plan-objekt eller null (bygget)
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLAN_FILE = path.join(DIR, "data", "pace20-plan.enc");
const key = (pw, salt) => scryptSync(pw, salt, 32);

export function readPlan(pw) {
  if (!existsSync(PLAN_FILE)) return null;
  const b = Buffer.from(readFileSync(PLAN_FILE, "utf8").trim(), "base64");
  const salt = b.subarray(0, 16), iv = b.subarray(16, 28), tag = b.subarray(28, 44), data = b.subarray(44);
  const d = createDecipheriv("aes-256-gcm", key(pw, salt), iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
}

if (process.argv[2] === "encrypt") {
  const src = process.argv[3];
  const pw = process.env.STATICRYPT_PASSWORD || readFileSync("C:/Users/morte/konfig/pace_quest_password.txt", "utf8").trim();
  const j = JSON.parse(readFileSync(src, "utf8"));
  // bare feltene dashboardet bruker
  const plan = { built: statSync(src).mtime.toISOString().slice(0, 10), rows: j.rows.map(r => ({ m: r.m, o: r.o, ny: r.ny, sub: r.sub, inn: r.inn, ann: r.ann, kap: r.kap, kasse: r.kasse })), batches: j.batches,
    key: { kasseMin: j.key.kasseMin, kasseMinMnd: j.key.kasseMinMnd, kasseMinEtterKap: j.key.kasseMinEtterKap, kasseMinEtterKapMnd: j.key.kasseMinEtterKapMnd } };
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(pw, salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify(plan), "utf8"), c.final()]);
  mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
  writeFileSync(PLAN_FILE, Buffer.concat([salt, iv, c.getAuthTag(), data]).toString("base64") + "\n");
  console.log("plan kryptert ->", PLAN_FILE, "(" + plan.rows.length + " måneder)");
}
