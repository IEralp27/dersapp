// Çalıştırma: node src/ai/subtitle.test.ts
import assert from "node:assert/strict";
import {
  SUB_MAX, buildChunks, chunkAtElapsed, chunkAtFraction, chunkAtTime, chunksOfSeg, cleanSlice, clampPos, firstChunkOf,
  posFromTop, splitChunks, visualLen,
} from "./subtitle.ts";
import { toSpeech } from "./tts-text.ts";
import { stepOfSegment } from "./lesson.ts";

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

// ------------------------------------------------------------ Temizleme
t("satır başı işaretleri ve satır sonları kalkar", () => {
  assert.equal(cleanSlice("## Başlık"), "Başlık");
  assert.equal(cleanSlice("- madde bir\n  devam"), "madde bir devam");
  assert.equal(cleanSlice("2. İkinci adım"), "İkinci adım");
  assert.equal(cleanSlice("> alıntı"), "alıntı");
});

t("blok formül satır içi olur", () => {
  assert.equal(cleanSlice("Şöyle:\n$$\nx^2 + 1\n$$"), "Şöyle: $x^2 + 1$");
  assert.equal(cleanSlice("\\[a=b\\]"), "$a=b$");
});

t("eşi olmayan ** silinir, formüldeki * sayılmaz", () => {
  assert.equal(cleanSlice("**Noktasal Kusurlar tek"), "Noktasal Kusurlar tek");
  assert.equal(cleanSlice("**kalın** ve $a**b$"), "**kalın** ve $a**b$");
});

// ------------------------------------------------------------ Bölme
t("kısa cümle tek parça", () => {
  assert.deepEqual(splitChunks("Kısa bir cümle."), ["Kısa bir cümle."]);
  assert.deepEqual(splitChunks(""), []);
});

t("uzun cümle sınırı aşmayan parçalara bölünür, sözcük kaybolmaz", () => {
  const s = "Sayfanın ortasındaki noktasal kusurlar, tek bir atom büyüklüğündeki küçük hatalardır; yani tüm sırayı değil, "
    + "sadece tek bir koltuğu ya da hemen yanını etkiler ve bu yüzden malzemenin genel düzenini bozmaz ama özelliklerini değiştirir.";
  const parts = splitChunks(s, 80);
  assert.ok(parts.length >= 3, String(parts.length));
  for (const p of parts) assert.ok(visualLen(p) <= 80 * 1.25, p);
  assert.equal(parts.join(" "), s);
});

t("noktalamadan kesmeyi tercih eder", () => {
  const s = "Birinci kısım burada biter, ikinci kısım ise biraz daha uzun sürer ve satırı doldurur gerçekten de öyle.";
  const parts = splitChunks(s, 60);
  assert.ok(parts[0].endsWith(","), parts[0]);
});

t("formül ortadan bölünmez", () => {
  const s = "Transfer fonksiyonu $G(s) = \\frac{K}{s^2 + 2\\zeta\\omega_n s + \\omega_n^2}$ biçimindedir ve kutupları paydanın kökleridir, bunu unutma.";
  for (const max of [20, 40, 60]) {
    const parts = splitChunks(s, max);
    for (const p of parts) assert.equal((p.match(/\$/g)?.length ?? 0) % 2, 0, p);
    assert.equal(parts.join(" "), s);
  }
});

t("formül uzunluğu görünen genişlikle sayılır", () => {
  assert.ok(visualLen("$\\frac{a}{b}$") < "$\\frac{a}{b}$".length);
});

t("kalın yazı bölünürse iki parçada da kapatılır", () => {
  const s = "Burada **çok uzun bir kalın yazı var ve bu yazı sınırı geçecek kadar uzun tutuldu** ki bölünsün.";
  const parts = splitChunks(s, 40);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.equal((p.match(/\*\*/g)?.length ?? 0) % 2, 0, p);
});

t("çok kısa son parça öncekiyle birleşir", () => {
  const s = "a".repeat(10) + " " + "b".repeat(80) + " son.";
  const parts = splitChunks(s, 95);
  assert.equal(parts.length, 1, JSON.stringify(parts));
});

// ------------------------------------------------------------ Cümle kuyruğu ile
const text = "① Sayfanın ortasındaki **Noktasal Kusurlar**, tek bir atom büyüklüğündeki küçük hatalardır. "
  + "Yani tüm sırayı değil, sadece tek bir koltuğu ya da hemen yanını etkiler; bu yüzden malzemenin genel düzeni korunur ama "
  + "elektriksel ve mekanik özellikleri belirgin biçimde değişebilir.\n\n② Boşluk derişimi $n_v = N e^{-Q_v / kT}$ ile verilir.";

t("toSpeech cümleleri parçalara dönüşür, cümle sırası korunur", () => {
  const segs = toSpeech(text, "tr");
  assert.ok(segs.length >= 3);
  const nums = new Set([1, 2]);
  const chunks = buildChunks(text, segs, 70, (a, b) => stepOfSegment(text, a, b, nums));
  assert.ok(chunks.length > segs.length, "uzun cümle bölündü");
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].seg >= chunks[i - 1].seg);
  assert.equal(chunks[0].step, 1);
  const last = chunks[chunks.length - 1];
  assert.equal(last.step, 2);
  assert.ok(last.md.includes("$n_v = N e^{-Q_v / kT}$"), last.md);
  assert.equal(firstChunkOf(chunks, 0), 0);
  const r = chunksOfSeg(chunks, 1)!;
  assert.ok(r[1] > r[0]);
  assert.equal(firstChunkOf(chunks, 1), r[0]);
  assert.equal(chunksOfSeg(chunks, 99), null);
});

t("işaret bloğu altyazıya girmez", () => {
  const md = "Kısa anlatım.\n\n```dersapp-marks\n{\"marks\":[]}\n```";
  const chunks = buildChunks(md, toSpeech(md, "tr"));
  assert.ok(chunks.every((c) => !c.md.includes("dersapp")), JSON.stringify(chunks));
});

// ------------------------------------------------------------ Zamanlama
t("kesir -> parça uzunluk oranında", () => {
  assert.equal(chunkAtFraction([10, 10], 0), 0);
  assert.equal(chunkAtFraction([10, 10], 0.49), 0);
  assert.equal(chunkAtFraction([10, 10], 0.51), 1);
  assert.equal(chunkAtFraction([10, 30], 0.3), 1);
  assert.equal(chunkAtFraction([10, 10], 5), 1);
  assert.equal(chunkAtFraction([], 0.5), 0);
});

t("geçen süre -> parça; hız artınca daha erken ilerler; sonda kalır", () => {
  const lens = [70, 70];
  // 140 karakter / 14 cps = 10 sn
  assert.equal(chunkAtElapsed(lens, 4000, 1), 0);
  assert.equal(chunkAtElapsed(lens, 6000, 1), 1);
  assert.equal(chunkAtElapsed(lens, 4000, 1.5), 1);
  assert.equal(chunkAtElapsed(lens, 60000, 1), 1);
  assert.equal(chunkAtElapsed([50], 9000, 1), 0);
});

t("kayıtlı ders: ses zamanı -> parça", () => {
  assert.equal(chunkAtTime([10, 10, 10], 5, 8, 5), 0);
  assert.equal(chunkAtTime([10, 10, 10], 5, 8, 6.5), 1);
  assert.equal(chunkAtTime([10, 10, 10], 5, 8, 7.9), 2);
  assert.equal(chunkAtTime([10, 10], 5, 5, 9), 0);
});

t("konum sınırlanır", () => {
  assert.equal(clampPos(-1), 0);
  assert.equal(clampPos(2), 1);
  assert.equal(clampPos(NaN), 1);
  assert.equal(posFromTop(150, 300), 0.5);
  assert.equal(posFromTop(10, 0), 1);
});

t("varsayılan parça uzunluğu makul", () => assert.ok(SUB_MAX >= 80 && SUB_MAX <= 130));

console.log(`subtitle: ${count} test geçti`);
