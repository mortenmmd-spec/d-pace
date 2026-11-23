// Writes innboks-preview-plain.html: the template with INNBOKS replaced by invented example data. No secrets, no network.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { updateCache, toPage } from "./innboks.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const js = s => JSON.stringify(s).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const aapne = JSON.parse(readFileSync(path.join(DIR, "test", "fixtures", "innboks-eksempel.json"), "utf8"));
const now = new Date();
let cache = { v: 1, sistOk: { mail: null }, meldinger: {} };
cache = updateCache({ cache, kilder: { mail: { ok: true, aapne } }, now });
const ids = Object.keys(cache.meldinger);
Object.assign(cache.meldinger[ids[0]], { type: "ordre", forslag: "Hei Kari! Beklager ventetiden. Vi sjekker saken og kommer tilbake til deg." });
Object.assign(cache.meldinger[ids[1]], { type: "sporsmal", forslag: "Hei! Pace kan blandes i kaldt eller lunkent vann." });
Object.assign(cache.meldinger[ids[2]], { type: "annet", selv: true });

const page = toPage(cache, { mail: { ok: true } }, now);
const template = readFileSync(path.join(DIR, "pace-quest.template.html"), "utf8");
const marker = /\/\*__INNBOKS__\*\/[\s\S]*?\/\*__INNBOKS_END__\*\//;
if (!marker.test(template)) throw new Error("INNBOKS marker missing in template");
const out = template.replace(marker, () => `/*__INNBOKS__*/ const INNBOKS = ${js(page)}; /*__INNBOKS_END__*/`);
writeFileSync(path.join(DIR, "innboks-preview-plain.html"), out);
console.log("wrote innboks-preview-plain.html with", page.meldinger.length, "messages");
