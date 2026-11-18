// Encrypted cache for the Innboks view. Same scrypt + AES-256-GCM format as the plan file.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encryptJson, decryptJson } from "./plan-crypt.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_FILE = path.join(DIR, "data", "innboks.enc");

const emptyCache = () => ({ v: 1, sistOk: { mail: null }, meldinger: {} });

// Only a missing file gives an empty cache. A file that cannot be read or decrypted throws, so the build does not write over it.
export function readCache(pw, file = CACHE_FILE) {
  if (!existsSync(file)) return emptyCache();
  try {
    return decryptJson(pw, readFileSync(file, "utf8"));
  } catch {
    console.log("innboks: cache kunne ikke leses");
    throw Object.assign(new Error("innboks cache unreadable"), { code: "INNBOKS_CACHE" });
  }
}

export function writeCache(pw, cache, file = CACHE_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encryptJson(pw, cache) + "\n");
}
