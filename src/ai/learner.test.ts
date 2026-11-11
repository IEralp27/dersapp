// Çalıştırma: node src/ai/learner.test.ts
import assert from "node:assert/strict";
import {
  EVENTS_KEY, EventLog, MAX_EVENTS, MAX_EVENT_BYTES, PERSONAL_MAX, advanceStudy, buildStats, composeProfile, emptyProfile, isActive,
  parseProfile, personalSection, recentWrong, sanitizeTeacher, topicRows, weakHint, weakTopics, withPersonal,
} from "./learner.ts";
import type { LearnerEvent, Profile } from "./learner.ts";
import type { SavedQuiz } from "./quiz-store.ts";

class Mem {
  data = new Map<string, string>();
  limit = Infinity;
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (v.length > this.limit) throw new Error("QuotaExceededError");
    this.data.set(k, v);
  }
}
const same = (a: unknown, b: unknown) => assert.equal(JSON.stringify(a), JSON.stringify(b));
let n = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    n++;
  } catch (e) {
    console.error("BAŞARISIZ: " + name);
    throw e;
  }
};
const NOW = new Date(2026, 10, 12, 12, 0).getTime();
const DAYMS = 86_400_000;

t("halka tampon: olay sayısı sınırı, en yeniler kalır", () => {
  const kv = new Mem();
  const log = new EventLog(kv);
  for (let i = 0; i < MAX_EVENTS + 40; i++) log.add({ type: "action", at: i, action: "explain", doc: "a.pdf", page: i });
  const all = log.all();
  assert.equal(all.length, MAX_EVENTS);
  assert.equal(all[0].at, 40);
  assert.equal(all[all.length - 1].at, MAX_EVENTS + 39);
});

t("halka tampon: bayt sınırı", () => {
  const kv = new Mem();
  const log = new EventLog(kv);
  for (let i = 0; i < 400; i++) {
    log.add({ type: "quiz", at: i, doc: "d".repeat(80), correct: 1, total: 2, ms: 5, topics: Array.from({ length: 30 }, (_, k) => ({ n: "konu" + k + "x".repeat(30), c: 1, t: 2 })) });
  }
  assert.ok((kv.getItem(EVENTS_KEY) ?? "").length <= MAX_EVENT_BYTES);
  const all = log.all();
  assert.ok(all.length < 400 && all.length > 10);
  assert.equal(all[all.length - 1].at, 399);
});

t("halka tampon: kota hatası ve bozuk veri çökertmez", () => {
  const kv = new Mem();
  kv.limit = 50;
  const log = new EventLog(kv);
  log.add({ type: "tts", at: 1 });
  log.add({ type: "action", at: 2, action: "free", doc: "x", page: 1 });
  kv.limit = Infinity;
  kv.setItem(EVENTS_KEY, "{bozuk");
  same(log.all(), []);
  log.add({ type: "tts", at: 3 });
  assert.equal(log.all().length, 1);
});

t("olaylar yalnızca bilinen alanları saklar (serbest metin sızmaz)", () => {
  const kv = new Mem();
  const log = new EventLog(kv);
  log.add({ type: "action", at: 1, action: "free", doc: "a.pdf", page: 2, text: "GİZLİ SORU" } as never);
  assert.ok(!(kv.getItem(EVENTS_KEY) ?? "").includes("GİZLİ"));
});

t("çalışma dakikaları aynı belge ve gün için birleşir", () => {
  const log = new EventLog(new Mem());
  log.add({ type: "study", at: NOW, doc: "a.pdf", min: 1 });
  log.add({ type: "study", at: NOW + 60_000, doc: "a.pdf", min: 2 });
  log.add({ type: "study", at: NOW + 60_000, doc: "b.pdf", min: 1 });
  log.add({ type: "study", at: NOW + DAYMS, doc: "a.pdf", min: 1 });
  const s = log.all().filter((e) => e.type === "study");
  assert.equal(s.length, 3);
  assert.equal((s[0] as { min: number }).min, 3);
});

t("çalışma sayacı: yalnızca etkinken birikir", () => {
  let r = advanceStudy(0, 10_000, true);
  same(r, { acc: 10_000, minutes: 0 });
  r = advanceStudy(55_000, 10_000, true);
  same(r, { acc: 5_000, minutes: 1 });
  same(advanceStudy(5_000, 10_000, false), { acc: 5_000, minutes: 0 });
  assert.ok(isActive(1000, 1000 - 119_000, true));
  assert.ok(!isActive(1000, 1000 - 121_000, true));
  assert.ok(!isActive(1000, 1000, false));
});

const q = (at: number, doc: string, topics: [string, number, number][]): LearnerEvent => ({
  type: "quiz", at, doc, correct: topics.reduce((s, x) => s + x[1], 0), total: topics.reduce((s, x) => s + x[2], 0), ms: 1000,
  topics: topics.map(([n, c, tt]) => ({ n, c, t: tt })),
});

t("istatistik: az veri açıkça söylenir", () => {
  const s = buildStats([{ type: "tts", at: NOW }], NOW);
  assert.match(s, /Henüz yeterli veri yok/);
  assert.ok(!s.includes("###"));
});

t("istatistik: süre, belgeler, konular, eylemler, kontrol soruları", () => {
  const ev: LearnerEvent[] = [
    { type: "study", at: NOW - 10 * DAYMS, doc: "Eski.pdf", min: 30 },
    { type: "study", at: NOW - DAYMS, doc: "Mekanik.pdf", min: 50 },
    { type: "study", at: NOW, doc: "Mekanik.pdf", min: 15 },
    q(NOW, "Mekanik.pdf", [["Mil hesabı", 1, 4], ["Dişli", 4, 5], ["Rulman", 2, 3], ["Tek soru", 0, 1]]),
    { type: "action", at: NOW, action: "explain", doc: "Mekanik.pdf", page: 1 },
    { type: "action", at: NOW, action: "explain", doc: "Mekanik.pdf", page: 2 },
    { type: "action", at: NOW, action: "solve", doc: "Mekanik.pdf", page: 2 },
    { type: "check", at: NOW, doc: "Mekanik.pdf", first: true },
    { type: "check", at: NOW, doc: "Mekanik.pdf", first: false },
    { type: "check", at: NOW, doc: "Mekanik.pdf", first: true },
    { type: "tts", at: NOW },
  ];
  const s = buildStats(ev, NOW);
  assert.match(s, /Toplam çalışma süresi: 1 sa 35 dk \(son 7 gün: 1 sa 5 dk\)/);
  assert.match(s, /- Mekanik\.pdf: 1 sa 5 dk/);
  assert.ok(s.indexOf("Mekanik.pdf: 1 sa 5 dk") < s.indexOf("Eski.pdf"));
  assert.match(s, /\| Mil hesabı \| 4 \| %25 \| tekrar et \|/);
  assert.match(s, /\| Dişli \| 5 \| %80 \| güçlü \|/);
  assert.match(s, /\| Rulman \| 3 \| %67 \| orta \|/);
  assert.ok(!s.includes("Tek soru"), "3'ten az soru olan konu yok");
  assert.match(s, /En çok kullanılan: Anlat \(2\)/);
  assert.match(s, /İlk denemede doğru: 2\/3 \(%67\)/);
  assert.match(s, /Sesli anlatım kullanılan yanıt: 1/);
  same(weakTopics(ev), ["Mil hesabı"]);
  assert.match(weakHint(ev), /Mil hesabı/);
  assert.equal(weakHint([]), "");
});

t("konu satırları olaylar arasında birleşir (büyük/küçük harf duyarsız)", () => {
  const rows = topicRows([q(1, "a", [["Dişli", 1, 2]]), q(2, "a", [["dişli", 2, 2]]), q(3, "a", [["DİŞLİ", 0, 1]])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 5);
  assert.equal(rows[0].percent, 60);
  assert.equal(rows[0].status, "orta");
  assert.equal(topicRows([q(1, "a", [["X", 1, 2]])]).length, 0);
});

t("istatistik: test yoksa ve konu verisi azsa yorum uydurmaz", () => {
  const ev: LearnerEvent[] = Array.from({ length: 6 }, (_, i) => ({ type: "action", at: NOW + i, action: "free", doc: "a", page: 1 }) as LearnerEvent);
  const s = buildStats(ev, NOW);
  assert.match(s, /Henüz test çözülmedi/);
  assert.match(s, /Henüz kontrol sorusu cevaplanmadı/);
  assert.ok(!s.includes("tekrar et"));
  const s2 = buildStats([...ev, q(NOW, "a", [["X", 1, 2]])], NOW);
  assert.match(s2, /yeterli veri yok \(bir konuda en az 3 soru gerekir\)/);
});

// ---- ogrenci.md

const P: Profile = {
  notes: "Önce sezgi.\n\nSonra formül.", teacher: "Öğrenci dişli konusunda zorlanıyor.", teacherAt: "2026-11-12 10:00",
  stats: "- Toplam: 1 dk\n\n### Testler\n- 1", statsAt: "2026-11-12 10:01",
};

t("md: birleştir -> ayrıştır gidiş dönüş", () => {
  const md = composeProfile(P);
  same(parseProfile(md), P);
  assert.equal(composeProfile(parseProfile(md)), md);
  same(parseProfile(composeProfile(emptyProfile())), emptyProfile());
  assert.match(md, /^# Öğrenci profili/);
  assert.match(md, /## Benim notlarım[\s\S]*## Öğretmen notu[\s\S]*## İstatistikler/);
});

t("md: boş ya da bozuk dosya", () => {
  same(parseProfile(""), emptyProfile());
  const p = parseProfile("\r\n");
  assert.equal(p.notes, "");
});

t("md: başlığı silinen bölüm içeriği kaybolmaz", () => {
  const md = composeProfile(P).replace("## Benim notlarım\n", "");
  const p = parseProfile(md);
  assert.ok(p.notes.includes("Önce sezgi.") && p.notes.includes("Sonra formül."));
  assert.equal(p.teacher, P.teacher);
});

t("md: tanınmayan metin ve başlıklar Benim notlarım'a taşınır", () => {
  const md = "Rastgele satır\n\n## Başka başlık\nkendi yazdığım\n\n## Benim notlarım\nnot A\n\n## Öğretmen notu\nT\n";
  const p = parseProfile(md);
  assert.ok(p.notes.includes("Rastgele satır"));
  assert.ok(p.notes.includes("not A"));
  // "Başka başlık" tanınmadığı için önceki bölümün (burada başlangıç) parçası olarak notlara gider
  assert.ok(p.notes.includes("## Başka başlık") && p.notes.includes("kendi yazdığım"));
  assert.equal(p.teacher, "T");
});

t("md: yinelenen başlık içeriği kaybolmaz; başlıklar büyük/küçük harf duyarsız", () => {
  const md = "## benim notlarım\nA\n## ÖĞRETMEN NOTU\nT1\n## Öğretmen notu\nT2\n## istatistikler\nS\n";
  const p = parseProfile(md);
  assert.equal(p.teacher, "T1");
  assert.equal(p.stats, "S");
  assert.ok(p.notes.includes("A") && p.notes.includes("T2"));
});

t("md: tarih satırı ayrılır; öğretmen metni başlık yapısını bozamaz", () => {
  const p = parseProfile("## Öğretmen notu\n\n_Güncelleme: 2026-01-02 03:04_\n\nmetin\n");
  assert.equal(p.teacherAt, "2026-01-02 03:04");
  assert.equal(p.teacher, "metin");
  assert.equal(sanitizeTeacher("## Başlık\n# Bir\nsıradan #etiket\n"), "Başlık\nBir\nsıradan #etiket");
  const md = composeProfile({ ...emptyProfile(), notes: "x", teacher: sanitizeTeacher("## Benim notlarım\nele geçirme") });
  assert.equal(parseProfile(md).notes, "x");
});

t("md: istatistik yazımı notlara dokunmaz", () => {
  const raw = "# Öğrenci profili\n\n## Benim notlarım\n\nelle yazdım\n\n## İstatistikler\n\neski\n";
  const p = parseProfile(raw);
  p.stats = "yeni";
  const out = parseProfile(composeProfile(p));
  assert.equal(out.notes, "elle yazdım");
  assert.equal(out.stats, "yeni");
});

// ---- kişiselleştirme

t("kişiselleştirme: kapalı ya da boşsa hiçbir şey eklenmez", () => {
  assert.equal(personalSection(P, false), "");
  assert.equal(personalSection(emptyProfile(), true), "");
  assert.equal(personalSection({ ...emptyProfile(), stats: "çok istatistik" }, true), "");
  assert.equal(withPersonal("BASE", P, false), "BASE");
  assert.equal(withPersonal("BASE", emptyProfile(), true), "BASE");
});

t("kişiselleştirme: etiketli bölüm, kural, istatistik yok", () => {
  const s = withPersonal("BASE", { ...P, stats: "GİZLİ-İSTATİSTİK" }, true);
  assert.ok(s.startsWith("BASE\n\n## Öğrencinin çalışma notu"));
  assert.match(s, /nota açıkça atıf yapma ve öğrenciyi etiketleme/);
  assert.match(s, /\[Öğrencinin kendi notları\]\nÖnce sezgi/);
  assert.match(s, /\[Öğretmen notu\]\nÖğrenci dişli/);
  assert.ok(!s.includes("GİZLİ-İSTATİSTİK"));
});

t("kişiselleştirme: metin ~1200 karakterle kırpılır", () => {
  const big = { ...emptyProfile(), notes: "a".repeat(3000), teacher: "b".repeat(3000) };
  const s = personalSection(big, true);
  const body = s.split("[Öğrencinin kendi notları]\n")[1];
  const [a, b] = body.split("\n\n[Öğretmen notu]\n");
  assert.ok(a.length + b.length <= PERSONAL_MAX, `${a.length + b.length}`);
  assert.ok(a.endsWith("…") && b.endsWith("…"));
  assert.ok(a.length > 0 && b.length > 0);
  const only = personalSection({ ...emptyProfile(), teacher: "c".repeat(5000) }, true);
  assert.ok(only.split("[Öğretmen notu]\n")[1].length <= PERSONAL_MAX);
});

// ---- yanlış sorular

const sq = (id: string, qs: SavedQuiz["quiz"]["questions"], attempts: SavedQuiz["attempts"]): SavedQuiz => ({
  id, path: "/a.pdf", name: "a.pdf", created: 1, difficulty: "medium", kind: "mc", pages: [1], quiz: { title: "T", questions: qs }, attempts,
});
const mc = (prompt: string, topic: string) => ({
  type: "mc" as const, prompt, options: ["bir", "iki", "üç"], answer: 1, tolerance: 0, unit: "", explanation: "", topic, page: 1,
});

t("yanlış sorular: cevap, doğru cevap, konu; since ve sınır", () => {
  const qs = [mc("Soru 0", "Dişli"), mc("Soru 1", "Mil"), mc("Soru 2", "Mil")];
  const saved = sq("x", qs, [
    { at: 100, ids: [0, 1, 2], responses: [0, 1, null], ms: 1, correct: 1, total: 3 },
    { at: 200, ids: [1], responses: [null, 2, null], ms: 1, correct: 0, total: 1 },
  ]);
  const w = recentWrong([saved], 0);
  same(w.map((x) => x.question), ["Soru 1", "Soru 0", "Soru 2"]);
  assert.equal(w[0].given, "C) üç");
  assert.equal(w[0].correct, "B) iki");
  assert.equal(w[0].topic, "Mil");
  assert.equal(w.find((x) => x.question === "Soru 2")!.given, "boş bırakıldı");
  same(recentWrong([saved], 150).map((x) => x.question), ["Soru 1"]);
  const many = sq("m", Array.from({ length: 30 }, (_, i) => mc("S" + i, "T")), [
    { at: 5, ids: Array.from({ length: 30 }, (_, i) => i), responses: Array(30).fill(0), ms: 1, correct: 0, total: 30 },
  ]);
  assert.equal(recentWrong([many], 0).length, 15);
  assert.equal(recentWrong([many], 0, 4).length, 4);
});

console.log(`learner.test.ts: ${n} test geçti`);
