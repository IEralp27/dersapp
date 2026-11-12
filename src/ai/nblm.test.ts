// Çalıştırma: node src/ai/nblm.test.ts
import assert from "node:assert/strict";
import {
  NblmStore, assembleSource, cleanMarkdown, estimateNblm, latexToText, parseNblmReply, planChunks, range1, slug,
  sourceFileName, validSourceFile,
} from "./nblm.ts";
import { nblmRequest } from "./prompts.ts";

const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const has = (s: string, re: RegExp) => assert.ok(re.test(s), `${re} bulunamadı:\n${s}`);
const lacks = (s: string, re: RegExp) => assert.ok(!re.test(s), `${re} olmamalı:\n${s}`);
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

t("tahmin ve dilimler", () => {
  const e = estimateNblm(10);
  assert.equal(e.chunks, 3);
  has(e.text, /10 sayfa, 3 yapay zeka isteği/);
  same(planChunks(range1(3, 9), 4), [[3, 4, 5, 6], [7, 8, 9]]);
  assert.equal(estimateNblm(0).chunks, 0);
});

t("LaTeX metne çevrilir", () => {
  assert.equal(latexToText("$G(s) = \\dfrac{5}{s+2}$"), "G(s) = 5/(s+2)");
  assert.equal(latexToText("$$x^2 + \\sqrt{y}$$"), "x² + √y");
  assert.equal(latexToText("$\\omega_{n} = 2{,}5$ rad/s"), "ω_n = 2,5 rad/s");
  assert.equal(latexToText("$e^{-st}$"), "e^(-st)");
  assert.equal(latexToText("$a \\cdot b \\le c$"), "a · b ≤ c");
  assert.equal(latexToText("düz metin"), "düz metin");
});

t("temizlik: dış çit, # başlık, boş satırlar, iç kod çiti korunur", () => {
  const md = cleanMarkdown("```markdown\n# Konu\n\n\n\nMetin $x^2$\n```");
  assert.equal(md, "## Konu\n\nMetin x²");
  const code = cleanMarkdown("## A\n\n```\n$x^2$\n```\n\nson");
  has(code, /```\n\$x\^2\$\n```/);
});

t("yanıt ayrıştırma: özet satırı ayrılır", () => {
  const p = parseNblmReply("## Transfer fonksiyonu\n\nAçıklama.\n\n[özet] Transfer fonksiyonu $G(s)$ tanımlandı.", [3, 4]);
  assert.equal(p.markdown, "## Transfer fonksiyonu\n\nAçıklama.");
  assert.equal(p.summary, "Transfer fonksiyonu G(s) tanımlandı.");
  same(p.pages, [3, 4]);
  const bos = parseNblmReply("", [1]);
  assert.equal(bos.markdown, "");
  assert.equal(bos.summary, "");
  assert.equal(parseNblmReply("**[Özet]:** kısa", [1]).summary, "kısa");
});

t("belge birleştirme", () => {
  const doc = assembleSource({
    name: "Kontrol.pdf", from: 3, to: 9, instructions: "sınava yönelik",
    parts: [{ pages: [3], markdown: "## A\n\nmetin", summary: "A özeti" }, { pages: [7], markdown: "", summary: "" }],
  });
  has(doc, /^# Kontrol: çalışma metni \(s\. 3-9\)\n/);
  has(doc, /Odak: sınava yönelik/);
  has(doc, /## A\n\nmetin\n\n## Kısa tekrar\n\n- A özeti\n$/);
  lacks(doc, /\n{3,}/);
  lacks(assembleSource({ name: "x.pdf", from: 1, to: 1, instructions: "", parts: [] }), /Odak|Kısa tekrar/);
});

t("dosya adı", () => {
  assert.equal(slug("Süreç Kontrolü: İŞLEM ğüçı"), "surec-kontrolu-islem-guci");
  assert.equal(slug("///"), "ders");
  const f = sourceFileName("Makine Elemanları 2.pdf", 3, 9);
  assert.equal(f, "makine-elemanlari-2-s3-9-notebooklm.md");
  assert.ok(validSourceFile(f));
  assert.ok(validSourceFile(sourceFileName("ş".repeat(200) + ".pdf", 100, 999)));
  assert.ok(!validSourceFile("../x.md"));
  assert.ok(!validSourceFile("ders.pdf"));
});

t("istek metni talimatı ve sayfaları içerir", () => {
  const r = nblmRequest({ name: "K.pdf", pages: [3, 4], part: 2, parts: 2, from: 1, to: 4, instructions: "yalnızca formüller", carried: "s. 2: giriş", texts: ["metin3", ""] });
  has(r, /1\. görüntü = sayfa 3/);
  has(r, /Öğrencinin talimatı: yalnızca formüller/);
  has(r, /Sayfa 3 metni[\s\S]*metin3/);
  lacks(r, /Sayfa 4 metni/);
  has(r, /s\. 2: giriş/);
});

t("PDF bağı (localStorage)", () => {
  const mem = new Map<string, string>();
  const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const s = new NblmStore(kv);
  const e = { id: "nabc-0001", file: "k-s1-2-notebooklm.md", path: "/v/dersler/nabc-0001/k-s1-2-notebooklm.md", title: "K", created: 1, from: 1, to: 2 };
  s.put("/a.pdf", e);
  s.put("/a.pdf", { ...e, id: "nabc-0002", created: 2 });
  s.put("/a.pdf", { ...e, id: "../kötü" });
  same(s.list("/a.pdf").map((x) => x.id), ["nabc-0002", "nabc-0001"]);
  s.remove("/a.pdf", "nabc-0002");
  s.remove("/a.pdf", "nabc-0001");
  same(s.list("/a.pdf"), []);
  mem.set("dersapp:nblm-metin", "{bozuk");
  same(s.list("/a.pdf"), []);
});

console.log(`nblm: ${count} test geçti`);
