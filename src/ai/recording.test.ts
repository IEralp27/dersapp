// Çalıştırma: node src/ai/recording.test.ts
import assert from "node:assert/strict";
import {
  GAP, PAGE_GAP, RecordingStore, buildTiming, clock, entryOf, estimateRecording, minuteLimit, newId, parseManifest,
  parseScriptReply, planChunks, range1, remainingAt, seekBy, segmentAt, toMarkdown, validId,
} from "./recording.ts";
import type { RecManifest } from "./recording.ts";
import { TARGET_RATE, joinWav, parseWav, resample, seconds, toInt16 } from "./wav.ts";

const same = (a: unknown, b: unknown, m?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
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

// ------------------------------------------------------------ Dilim ve tahmin

t("dilimler sırayı korur, en çok 3 sayfa", () => {
  same(planChunks(range1(4, 11)), [[4, 5, 6], [7, 8, 9], [10, 11]]);
  same(planChunks([7]), [[7]]);
  same(planChunks([]), []);
  same(planChunks(range1(1, 4), 0), [[1], [2], [3], [4]]);
});

t("süre sınırı talimattan okunur", () => {
  assert.equal(minuteLimit("sınava yönelik anlat, 10 dakikayı geçmesin"), 10);
  assert.equal(minuteLimit("en fazla 7,5 dk"), 7.5);
  assert.equal(minuteLimit("yalnızca 3. bölüm"), null);
  assert.equal(minuteLimit(""), null);
});

t("tahmin: sayfa, istek ve süre", () => {
  const e = estimateRecording(10, "normal");
  assert.equal(e.chunks, 4);
  assert.equal(e.minutes, Math.round((10 * 220) / 130));
  assert.ok(/10 sayfa, 4 yapay zeka isteği/.test(e.text), e.text);
  const lim = estimateRecording(10, "detailed", "5 dakikayı geçmesin");
  assert.ok(lim.minutes <= 5, String(lim.minutes));
  assert.ok(lim.wordsPerPage < 400);
  assert.ok(/5 dakika sınırına/.test(lim.text), lim.text);
  assert.equal(estimateRecording(0, "short").minutes, 0);
});

// ------------------------------------------------------------ Yanıt ayrıştırma

t("parçalar, sayfalar, işaretler ve özet", () => {
  const r = parseScriptReply([
    "[s. 3]",
    "Bu sayfada transfer fonksiyonunu öğreneceğiz.",
    "[işaret] {\"type\": \"box\", \"box\": [120, 80, 560, 190], \"note\": \"payda\"}",
    "",
    "[s. 3] Paydaki $\\frac{5}{s+2}$ ifadesine bakalım.",
    "[s. 4]",
    "Grafik.",
    "[İşaret] [{\"type\": \"arrow\", \"from\": [800, 500], \"to\": [620, 420]}, {\"type\": \"label\", \"at\": [1, 1], \"n\": 2}]",
    "[özet] Transfer fonksiyonu ve grafik.",
  ].join("\n"), [3, 4, 5]);
  assert.equal(r.segments.length, 3);
  same(r.segments.map((s) => s.page), [3, 3, 4]);
  assert.equal(r.segments[1].text, "Paydaki $\\frac{5}{s+2}$ ifadesine bakalım.");
  assert.equal(r.segments[0].marks.length, 1);
  assert.equal(r.segments[0].marks[0].kind, "box");
  assert.equal(r.segments[2].marks.length, 2);
  assert.equal(r.summary, "Transfer fonksiyonu ve grafik.");
});

t("bozuk işaret parçanın metnini düşürmez", () => {
  const r = parseScriptReply("[s. 2]\nMetin kalır.\n[işaret] {bozuk json\n[işaret] {\"type\": \"daire\", \"box\": [1,2,3,4]}", [2]);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].text, "Metin kalır.");
  assert.equal(r.segments[0].marks.length, 0);
  assert.ok(r.problems.length >= 2);
});

t("başlıksız metin ilk sayfaya, dilim dışı sayfa en yakına, kod çiti yok sayılır", () => {
  const r = parseScriptReply("```\nGiriş cümlesi.\n**[Sayfa 9]**\nUzak sayfa.\n```", [5, 6]);
  same(r.segments.map((s) => [s.page, s.text]), [[5, "Giriş cümlesi."], [6, "Uzak sayfa."]]);
  assert.ok(r.problems.some((p) => p.includes("s. 9")));
});

t("boş ya da garip girdi istisna fırlatmaz", () => {
  for (const x of ["", "   ", "[s. ]", "[işaret] {}", null as unknown as string, "[özet]"]) {
    const r = parseScriptReply(x, [1]);
    assert.ok(Array.isArray(r.segments));
  }
  assert.equal(parseScriptReply("[s. 1]\n[işaret] {\"type\":\"box\",\"box\":[1,1,50,50]}", [1]).segments.length, 0);
});

// ------------------------------------------------------------ Zaman tablosu

t("zaman tablosu: aralar ve sayfa değişimi", () => {
  const { spans, total, gaps } = buildTiming([2, 3, 1], [1, 1, 2]);
  same(gaps, [0, GAP, PAGE_GAP]);
  same(spans[0], { start: 0, end: 2 });
  assert.equal(spans[1].start, 2 + GAP);
  assert.equal(spans[2].start, Math.round((2 + GAP + 3 + PAGE_GAP) * 1000) / 1000);
  assert.equal(total, Math.round((6 + GAP + PAGE_GAP) * 1000) / 1000);
});

t("seek -> o anki parça", () => {
  const { spans, total } = buildTiming([2, 3, 1], [1, 1, 2]);
  assert.equal(segmentAt(spans, -1), 0);
  assert.equal(segmentAt(spans, 0), 0);
  assert.equal(segmentAt(spans, 2.1), 0); // aradaki sessizlik: öncekisi
  assert.equal(segmentAt(spans, spans[1].start), 1);
  assert.equal(segmentAt(spans, total + 5), 2);
  assert.equal(segmentAt([], 3), -1);
  assert.equal(seekBy(total, 1, -10), 0);
  assert.equal(seekBy(total, 1, 1e6), total);
});

t("hız: kalan süre ve saat biçimi", () => {
  assert.equal(remainingAt(100, 40, 2), 30);
  assert.equal(remainingAt(100, 40, 99), 30); // hız 2'ye kırpılır
  assert.equal(remainingAt(100, 120, 1), 0);
  assert.equal(clock(65), "1:05");
  assert.equal(clock(3723), "1:02:03");
  assert.equal(clock(-3), "0:00");
});

// ------------------------------------------------------------ Manifest ve depo

function manifest(): RecManifest {
  const segs = parseScriptReply("[s. 1]\nBir.\n[işaret] {\"type\":\"box\",\"box\":[1,1,90,90]}\n[s. 2]\nİki $x^2$.", [1, 2]).segments;
  const { spans, total } = buildTiming([1.5, 2], [1, 2]);
  return {
    v: 1, id: newId(1700000000000, 0.5), pdf: "C:\\a.pdf", name: "a.pdf", title: "Kayıtlı ders: a", created: 1, updated: 2,
    from: 1, to: 2, pace: "normal", instructions: "sınava yönelik", engine: "piper", engineName: "Piper",
    status: "done", chunks: [[1, 2]], doneChunks: 1, carried: [{ page: 2, text: "özet" }], segments: segs, spans, duration: total,
    audio: "ses.wav",
  };
}

t("kimlik Rust'ın kabul ettiği biçimde", () => {
  const id = newId();
  assert.ok(validId(id), id);
  assert.ok(!validId("../x"));
  assert.ok(!validId("A"));
});

t("manifest gidiş-dönüş ve doğrulama", () => {
  const m = manifest();
  same(parseManifest(JSON.stringify(m)), m);
  assert.equal(parseManifest("bozuk"), null);
  assert.equal(parseManifest(JSON.stringify({ ...m, id: "../../x" })), null);
  // Ses tablosu uyuşmuyorsa ses yeniden üretilecek
  const bad = parseManifest(JSON.stringify({ ...m, spans: [] }))!;
  assert.equal(bad.status, "audio");
  assert.equal(bad.audio, null);
  // Yarım kayıt
  const half = parseManifest(JSON.stringify({ ...m, status: "script", doneChunks: 7, chunks: [[1], [2]] }))!;
  assert.equal(half.doneChunks, 2);
  assert.equal(half.status, "script");
});

t("Markdown okunabilir: başlık, sayfa başlıkları, zaman damgası", () => {
  const md = toMarkdown(manifest());
  assert.ok(/^# Kayıtlı ders: a/.test(md), md);
  assert.ok(/## Sayfa 1\n\n`0:00` Bir\./.test(md), md);
  assert.ok(/## Sayfa 2/.test(md), md);
  assert.ok(/Talimat: sınava yönelik/.test(md), md);
});

t("PDF bağı: ekle, güncelle, sil", () => {
  const mem = new Map<string, string>();
  const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const s = new RecordingStore(kv);
  const m = manifest();
  s.put(m.pdf, entryOf(m));
  s.put(m.pdf, { ...entryOf(m), title: "yeni" });
  assert.equal(s.list(m.pdf).length, 1);
  assert.equal(s.list(m.pdf)[0].title, "yeni");
  s.put(m.pdf, { ...entryOf(m), id: "k2", created: 99 });
  assert.equal(s.list(m.pdf)[0].id, "k2");
  s.remove(m.pdf, "k2");
  s.remove(m.pdf, m.id);
  same(s.list(m.pdf), []);
  mem.set("dersapp:kayitli-ders", "{bozuk");
  same(s.list("x"), []);
});

// ------------------------------------------------------------ WAV

t("WAV: birleştir, oku, süre", () => {
  const a = toInt16(new Float32Array(TARGET_RATE).fill(0.5));
  const b = toInt16(new Float32Array(TARGET_RATE / 2).fill(-0.25));
  const wav = joinWav([a, b], [0, 0.5]);
  const p = parseWav(wav)!;
  assert.equal(p.rate, TARGET_RATE);
  assert.equal(p.samples.length, TARGET_RATE * 2);
  assert.ok(Math.abs(p.samples[10] - 0.5) < 1e-3);
  assert.equal(p.samples[TARGET_RATE + 10], 0); // sessizlik
  assert.ok(Math.abs(p.samples[TARGET_RATE * 2 - 1] + 0.25) < 1e-3);
  assert.equal(seconds(a), 1);
});

t("WAV: stereo 22050 Hz Piper benzeri dosya + yeniden örnekleme", () => {
  const n = 2205;
  const buf = new Uint8Array(44 + n * 4);
  const dv = new DataView(buf.buffer);
  const w = (at: number, s: string) => [...s].forEach((c, i) => (buf[at + i] = c.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 4, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 22050, true); dv.setUint32(28, 22050 * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, 0xffffffff, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, 16384, true);
    dv.setInt16(46 + i * 4, 0, true);
  }
  const p = parseWav(buf)!;
  assert.equal(p.rate, 22050);
  assert.equal(p.samples.length, n);
  assert.ok(Math.abs(p.samples[5] - 0.25) < 1e-3);
  const r = resample(p.samples, 22050, TARGET_RATE);
  assert.equal(r.length, Math.round((n * TARGET_RATE) / 22050));
  assert.equal(parseWav(new Uint8Array([1, 2, 3])), null);
  assert.equal(parseWav(new TextEncoder().encode("ID3" + "x".repeat(60))), null); // MP3 değil WAV
});

console.log(`recording: ${count} test geçti`);
