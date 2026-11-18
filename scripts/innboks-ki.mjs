const API_URL = "https://api.anthropic.com/v1/messages";
const TYPES = ["sporsmal", "ordre", "ros", "annet"];
const MAX_TEXT = 4000;
const MAX_SUBJECT = 300;

const SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: TYPES },
    svar: { type: "boolean" },
    selv: { type: "boolean" },
    forslag: { type: "string" },
  },
  required: ["type", "svar", "selv", "forslag"],
  additionalProperties: false,
};

function userText(m, redactFn) {
  const parts = [
    `Kanal: ${m.kanal ?? ""}`,
    `Emne: ${redactFn(String(m.emne ?? "")).slice(0, MAX_SUBJECT)}`,
  ];
  if (m.gjelder) parts.push(`Gjelder: ${m.gjelder}`);
  parts.push(`Melding:\n${redactFn(String(m.tekst ?? "")).slice(0, MAX_TEXT)}`);
  parts.push(
    'Svar bare med JSON: {"type": "sporsmal"|"ordre"|"ros"|"annet", "svar": boolean, "selv": boolean, "forslag": string}. Bruk tom streng i "forslag" når du ikke har noe forslag.'
  );
  return parts.join("\n");
}

const transientError = message => Object.assign(new Error(message), { transient: true });

export function makeSuggester({ apiKey, model = "claude-haiku-5-5", regler, redactFn, fetchFn = fetch }) {
  return async (m) => {
    let res;
    try {
      res = await fetchFn(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2026-10-21",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          system: regler,
          output_config: { format: { type: "json_schema", schema: SCHEMA } },
          messages: [{ role: "user", content: userText(m, redactFn) }],
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw transientError("Claude API request failed (network error or timeout)");
    }
    if (!res.ok) throw transientError(`Claude API error: HTTP ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("Claude API response is not valid JSON");
    }
    if (data.stop_reason === "refusal") throw new Error("Claude API refused the request");
    if (data.stop_reason === "max_tokens") throw new Error("Claude API answer cut off at max_tokens");
    const block = (data.content ?? []).find((b) => b.type === "text");
    let out;
    try {
      out = JSON.parse(block?.text);
    } catch {
      throw new Error("Claude API answer is not valid JSON");
    }
    if (
      !out ||
      !TYPES.includes(out.type) ||
      typeof out.svar !== "boolean" ||
      typeof out.selv !== "boolean"
    ) {
      throw new Error("Claude API answer has an unexpected shape");
    }
    const forslag =
      out.selv || !out.svar || typeof out.forslag !== "string" || !out.forslag.trim()
        ? null
        : out.forslag;
    return { type: out.type, svar: out.svar, selv: out.selv, forslag };
  };
}
