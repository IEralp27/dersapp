// Çalıştırma: node src/ai/cli-stream.test.ts
import assert from "node:assert/strict";
import { CliStream, cliError, flattenPrompt, validModel } from "./cli-stream.ts";

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
const ev = (event: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "stream_event", event, parent_tool_use_id: null, ...extra });
const delta = (text: string) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const textStart = ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

t("metin parçaları sırayla gelir, result tekrar edilmez", () => {
  const out: string[] = [];
  const s = new CliStream((d) => out.push(d));
  s.line(JSON.stringify({ type: "system", subtype: "init", model: "x" }));
  s.line(textStart);
  s.line(delta("Mer"));
  s.line(delta("haba"));
  s.line("bozuk satır {");
  s.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Merhaba" }));
  assert.equal(out.join(""), "Merhaba");
  assert.equal(JSON.stringify(s.result), JSON.stringify({ text: "Merhaba", isError: false }));
});

t("parça gelmezse result metni verilir", () => {
  const out: string[] = [];
  const s = new CliStream((d) => out.push(d));
  s.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Tam yanıt" }));
  assert.equal(out.join(""), "Tam yanıt");
});

t("araçtan sonraki metin bloğu ayrılır, alt ajan metni gizlenir", () => {
  const out: string[] = [];
  const s = new CliStream((d) => out.push(d));
  s.line(textStart);
  s.line(delta("Bakıyorum."));
  s.line(ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read" } }));
  s.line(delta("gizli") .replace('"parent_tool_use_id":null', '"parent_tool_use_id":"tu_1"'));
  s.line(textStart);
  s.line(delta("\nCevap"));
  assert.equal(out.join(""), "Bakıyorum.\n\nCevap");
});

t("hata sonucu metin olarak akmaz; api_retry türü saklanır", () => {
  const out: string[] = [];
  const s = new CliStream((d) => out.push(d));
  s.line(JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error: "rate_limit" }));
  s.line(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }));
  assert.equal(out.length, 0);
  assert.equal(s.retryError, "rate_limit");
  assert.equal(s.result?.isError, true);
});

t("hatalar Türkçe ve doğru türde", () => {
  assert.equal(cliError({ result: "Not logged in · Please run /login", code: 1 }).kind, "auth");
  assert.equal(cliError({ retry: "authentication_failed" }).kind, "auth");
  assert.equal(cliError({ retry: "billing_error" }).kind, "limit");
  assert.equal(cliError({ result: "Claude usage limit reached" }).kind, "limit");
  assert.equal(cliError({ retry: "overloaded" }).kind, "overloaded");
  const e = cliError({ stderr: "garip", code: 3 });
  assert.equal(e.kind, "other");
  assert.ok(/çıkış kodu 3/.test(e.message));
  assert.ok(/garip/.test(e.message));
});

t("tek mesaj olduğu gibi, görüntü yollarıyla", () => {
  const p = flattenPrompt([{ role: "user", text: "Bunu anlat" }], [["/tmp/a/gorsel-1.png"]]);
  assert.ok(/^Bunu anlat/.test(p));
  assert.ok(/1 görüntü/.test(p));
  assert.ok(/- \/tmp\/a\/gorsel-1\.png/.test(p));
});

t("çok turlu konuşma düzleşir, son mesaj ayrı", () => {
  const p = flattenPrompt([
    { role: "user", text: "S1" },
    { role: "assistant", text: "C1" },
    { role: "user", text: "S2" },
  ], [["C:\\t\\g1.png"], [], []]);
  assert.ok(p.indexOf("<ogrenci>\nS1") < p.indexOf("<ogretmen>\nC1"));
  assert.ok(p.indexOf("</konusma>") < p.indexOf("<son_mesaj>\nS2\n</son_mesaj>"));
  assert.ok(/C:\\t\\g1\.png/.test(p));
  assert.equal(p.split("</konusma>").length, 2);
});

t("model adı denetimi", () => {
  assert.ok(validModel("sonnet"));
  assert.ok(validModel("claude-opus-5[1m]"));
  assert.ok(!validModel("sonnet --tools Bash"));
  assert.ok(!validModel("a&b"));
});

console.log(`cli-stream: ${count} test geçti`);
