// Çalıştırma: node src/ai/gemini-stream.test.ts
// Satırlar gemini 0.68.0'ın sahte bir Gemini API sunucusuna karşı ürettiği gerçek çıktıdan alındı (2026-11).
import assert from "node:assert/strict";
import { GeminiStream, escapeAt, geminiError, geminiPrompt } from "./gemini-stream.ts";

let count = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    count++;
  } catch (e) {
    console.error("FAIL", name);
    throw e;
  }
};

const REC = [
  `{"type":"init","timestamp":"2026-11-14T15:50:40.799Z","session_id":"be1f5875","model":"gemini-2.5-flash"}`,
  `{"type":"message","timestamp":"2026-11-14T15:50:40.837Z","role":"user","content":"Bu sayfayi anlat."}`,
  `{"type":"tool_use","timestamp":"2026-11-14T15:50:40.867Z","tool_name":"read_file","tool_id":"read_file_1","parameters":{"file_path":"notlar.txt"}}`,
  `{"type":"tool_result","timestamp":"2026-11-14T15:50:40.894Z","tool_id":"read_file_1","status":"success","output":""}`,
  `{"type":"tool_use","timestamp":"2026-11-14T15:50:40.900Z","tool_name":"write_file","tool_id":"write_file_1","parameters":{"file_path":"x.txt","content":"hack"}}`,
  `{"type":"tool_result","timestamp":"2026-11-14T15:50:40.901Z","tool_id":"write_file_1","status":"error","output":"Tool \\"write_file\\" not found.","error":{"type":"tool_not_registered","message":"Tool \\"write_file\\" not found."}}`,
  `{"type":"message","timestamp":"2026-11-14T15:50:40.922Z","role":"assistant","content":"Merhaba, ","delta":true}`,
  `{"type":"message","timestamp":"2026-11-14T15:50:40.922Z","role":"assistant","content":"türev $\\\\frac{1}{4}$ olur.","delta":true}`,
  `{"type":"result","timestamp":"2026-11-14T15:50:40.924Z","status":"success","stats":{"total_tokens":35,"input_tokens":25,"output_tokens":10,"cached":0,"input":25,"duration_ms":124,"tool_calls":4,"models":{}}}`,
];

t("kaydedilmiş akış: metin, araçlar, sonuç", () => {
  const out: string[] = [];
  const tools: string[] = [];
  const s = new GeminiStream((d) => out.push(d));
  s.onTool = (n, i) => tools.push(n + ":" + String(i.file_path));
  for (const l of REC) s.line(l);
  s.line("Warning: 256-color support not detected.");
  s.line("bozuk {");
  assert.equal(out.join(""), "Merhaba, türev $\\frac{1}{4}$ olur.");
  assert.deepEqual(tools, ["read_file:notlar.txt", "write_file:x.txt"]);
  assert.equal(s.model, "gemini-2.5-flash");
  assert.deepEqual(s.result, { ok: true, errorType: "", message: "" });
});

t("araçtan sonra gelen metin ayrı paragraf olur", () => {
  const out: string[] = [];
  const s = new GeminiStream((d) => out.push(d));
  s.line(`{"type":"message","role":"assistant","content":"Bakalım.","delta":true}`);
  s.line(`{"type":"tool_use","tool_name":"glob","tool_id":"g","parameters":{"pattern":"*.pdf"}}`);
  s.line(`{"type":"message","role":"assistant","content":"\\nBuldum.","delta":true}`);
  assert.equal(out.join(""), "Bakalım.\n\nBuldum.");
});

t("hata sonucu ve tur sınırı", () => {
  const s = new GeminiStream(() => {});
  s.line(`{"type":"result","status":"error","error":{"type":"FatalTurnLimitedError","message":"Reached max session turns for this session."},"stats":{}}`);
  assert.equal(s.result?.ok, false);
  assert.equal(s.maxTurns, true);
  const s2 = new GeminiStream(() => {});
  s2.line(`{"type":"error","severity":"error","message":"Maximum session turns exceeded"}`);
  assert.equal(s2.maxTurns, true);
  assert.equal(s2.lastError, "Maximum session turns exceeded");
});

t("stderr yeniden deneme satırı", () => {
  const s = new GeminiStream(() => {});
  const seen: number[] = [];
  s.onRetry = (st, n) => seen.push(st, n);
  s.stderrLine("Attempt 2 failed with status 429. Retrying with backoff... _ApiError: {\"error\":{\"code\":429}}");
  s.stderrLine("    at throwErrorIfNotOK (file:///x.js:1:1)");
  assert.deepEqual(seen, [429, 2]);
  assert.equal(s.retryStatus, 429);
});

t("istem: @ kaçışı ve görüntü yolları", () => {
  assert.equal(escapeAt("a@b.com @dosya"), "a＠b.com ＠dosya");
  const p = geminiPrompt([{ role: "user", text: "mail a@b.com" }], [["/tmp/dersapp-cli-x/gorsel-1.png"]]);
  assert.ok(p.startsWith("mail a＠b.com"));
  assert.ok(p.endsWith(`@"/tmp/dersapp-cli-x/gorsel-1.png"`));
  const multi = geminiPrompt([
    { role: "user", text: "ilk" }, { role: "assistant", text: "yanıt" }, { role: "user", text: "son" },
  ], [[], [], []]);
  assert.ok(multi.includes("<son_mesaj>\nson\n</son_mesaj>"));
});

t("hatalar: kayıtlı gerçek mesajlar", () => {
  // Giriş yok: stdout boş, stderr bu satır, çıkış kodu 41
  assert.equal(geminiError({ stderr: "Please set an Auth method in your /home/u/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA", code: 41 }).kind, "auth");
  const bad = geminiError({ message: `[API Error: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]`, errorType: "unknown", code: 1 });
  assert.equal(bad.kind, "auth");
  assert.match(bad.message, /AI Studio/);
  assert.equal(geminiError({ message: `[API Error: {"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}]`, code: 147 }).kind, "plan");
  assert.equal(geminiError({ message: "IneligibleTierError: INELIGIBLE_ACCOUNT" }).kind, "plan");
  assert.match(geminiError({ message: "IneligibleTierError" }).message, /Google AI Plus/);
  assert.equal(geminiError({ stderr: "Attempt 1 failed with status 429. Retrying with backoff... RESOURCE_EXHAUSTED", message: "You have exhausted your daily quota on this model." }).kind, "limit");
  assert.equal(geminiError({ message: "[API Error: 503 UNAVAILABLE]" }).kind, "overloaded");
  assert.match(geminiError({ code: 55, message: "" }).message, /güven/);
  assert.match(geminiError({ code: 9, stderr: "    at x (y)\nWarning: 256-color support not detected." }).message, /çıkış kodu 9\)\.$/);
});

console.log(`gemini-stream: ${count} test geçti`);
