// Çalıştırma: node src/ai/tts-engine.test.ts
import assert from "node:assert/strict";
import { clearEngines, getEngine, listEngines, registerEngine } from "./tts-engine.ts";
import type { TtsEngine } from "./tts-engine.ts";
import { isAudioType, speechBody, speechHttpError, speechNetworkError, speechSupport, speechUrl } from "./tts-cloud-rules.ts";

let count = 0;
const same = (a: unknown, b: unknown) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const t = (name: string, fn: () => void) => {
  try {
    fn();
    count++;
  } catch (e) {
    console.error("FAIL", name);
    throw e;
  }
};
const fake = (id: string, order?: number): TtsEngine => ({
  id, order, name: id, description: "d", fields: [],
  available: () => ({ ok: true }),
  create: () => { throw new Error("kullanılmadı"); },
});

t("kayıt: sıra order'a göre, aynı id yerini alır", () => {
  clearEngines();
  registerEngine(fake("cloud", 10));
  registerEngine(fake("system", 0));
  registerEngine(fake("zzz"));
  same(listEngines().map((e) => e.id), ["system", "cloud", "zzz"]);
  registerEngine({ ...fake("cloud", 10), name: "yeni" });
  assert.equal(listEngines().length, 3);
  assert.equal(getEngine("cloud")?.name, "yeni");
  assert.equal(getEngine("yok"), undefined);
});

t("sağlayıcı desteği: doğrulananlar", () => {
  assert.equal(speechSupport("openai", "openai").ok, true);
  assert.equal(speechSupport("openai", "openai").model, "gpt-4o-mini-tts");
  assert.equal(speechSupport("openrouter", "openai").ok, true);
  assert.equal(speechSupport("custom", "openai").ok, true);
});
t("sağlayıcı desteği: desteklemeyenler neden söyler", () => {
  for (const [id, proto] of [["anthropic", "anthropic"], ["custom", "anthropic"], ["gemini", "openai"], ["ollama", "openai"]] as const) {
    const s = speechSupport(id, proto);
    assert.equal(s.ok, false, id);
    assert.ok(s.reason && s.reason.length > 30, id);
  }
  assert.ok(/Anthropic/.test(speechSupport("anthropic", "anthropic").reason!));
});

t("istek: adres ve gövde", () => {
  assert.equal(speechUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/audio/speech");
  const b = JSON.parse(speechBody("m", "v", "Merhaba"));
  same(b, { model: "m", voice: "v", input: "Merhaba", response_format: "mp3" });
  assert.equal(JSON.parse(speechBody("m", "v", "x".repeat(9000))).input.length, 4000);
});

t("hata mesajları Türkçe ve yönlendirici", () => {
  assert.ok(/anahtar.*kontrol/i.test(speechHttpError(401, '{"error":{"message":"bad key"}}')));
  assert.ok(/bad key/.test(speechHttpError(401, '{"error":{"message":"bad key"}}')));
  assert.ok(/bekleyip/.test(speechHttpError(429, "")));
  assert.ok(/model/i.test(speechHttpError(404, "")));
  assert.ok(/model ya da ses/.test(speechHttpError(400, "x")));
  assert.ok(/yeniden dene/.test(speechHttpError(503, "")));
  assert.ok(/CORS/.test(speechNetworkError("https://x.com/v1")));
  assert.ok(/Yerel/.test(speechNetworkError("http://localhost:8000/v1")));
});
t("içerik türü", () => {
  assert.ok(isAudioType("audio/mpeg") && isAudioType("") && isAudioType("application/octet-stream"));
  assert.ok(!isAudioType("application/json") && !isAudioType("text/html"));
});

console.log(`tts-engine: ${count} test geçti`);
