// Çalıştırma: node src/ai/sohbet.test.ts
import assert from "node:assert/strict";
import { ConvStore, MAX_CONVS, historyList, markClosed, pruneIds, DEFAULT_TITLE, deriveTitle, docsContext, newConvId, titleOf, trimTurns, validId } from "./sohbet.ts";
import type { SavedTurn } from "./sohbet.ts";

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

class Mem {
  data = new Map<string, string>();
  fail = false;
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (this.fail) throw new Error("dolu");
    this.data.set(k, v);
  }
}

t("başlık: kısa metin aynen, boş -> varsayılan", () => {
  assert.equal(deriveTitle("Transfer fonksiyonu nedir?"), "Transfer fonksiyonu nedir?");
  assert.equal(deriveTitle("   \n "), DEFAULT_TITLE);
  assert.equal(deriveTitle("**Kalın**  `kod`\n\nyeni   satır"), "Kalın kod yeni satır");
  assert.equal(deriveTitle("$\\frac{1}{s}$ ne demek"), "\\frac{1}{s} ne demek");
});

t("başlık: uzun metin kelime sınırında kısalır", () => {
  const s = deriveTitle("Kontrol sistemlerinde kararlılık analizi nasıl yapılır ve Routh tablosu ne işe yarar");
  assert.ok(s.endsWith("…"));
  assert.ok(s.length <= 33, s);
  assert.equal(s, "Kontrol sistemlerinde…");
  assert.equal(deriveTitle("a".repeat(50)), "a".repeat(32) + "…");
});

t("titleOf: ilk kullanıcı turunun etiketi", () => {
  assert.equal(titleOf([]), DEFAULT_TITLE);
  assert.equal(titleOf([{ role: "user", text: "uzun istem\n\n# Ekli belgeler…", label: "Kısa soru" }]), "Kısa soru");
  assert.equal(titleOf([{ role: "assistant", text: "x" }, { role: "user", text: "Merhaba" }]), "Merhaba");
  assert.equal(titleOf([{ role: "user", text: "x", label: "Özetle\n📎 ders.pdf" }]), "Özetle");
});

t("kimlik", () => {
  const id = newConvId(1_700_000_000_000, 0.5);
  assert.ok(validId(id), id);
  assert.ok(!validId("../x"));
  assert.ok(!validId(""));
  assert.ok(newConvId(1, 0.1) !== newConvId(1, 0.2));
});

t("trimTurns: sınır aşılınca eski turlar atılır, kullanıcıyla başlar", () => {
  const turns: SavedTurn[] = [];
  for (let i = 0; i < 10; i++) turns.push({ role: "user", text: "s" + i }, { role: "assistant", text: "y".repeat(100) });
  const kept = trimTurns(turns, 350);
  assert.equal(kept[0].role, "user");
  assert.ok(kept.length < turns.length && kept.length >= 2);
  assert.equal(kept[kept.length - 1], turns[turns.length - 1]);
  assert.equal(trimTurns(turns).length, turns.length);
});

t("depo: kaydet, yeniden yükle, sil, buda", () => {
  const kv = new Mem();
  const a = new ConvStore(kv);
  assert.ok(a.put("abc1", [{ role: "user", text: "istem", label: "Entropi nedir?" }, { role: "assistant", text: "Yanıt" }], 10));
  assert.ok(a.put("abc2", [], 11));
  const b = new ConvStore(kv);
  const c = b.get("abc1")!;
  assert.equal(c.title, "Entropi nedir?");
  assert.equal(c.turns.length, 2);
  assert.equal(c.turns[0].label, "Entropi nedir?");
  assert.equal(c.created, 10);
  b.put("abc1", c.turns, 20);
  assert.equal(b.get("abc1")!.created, 10);
  assert.equal(b.get("abc1")!.updated, 20);
  b.remove("abc2");
  assert.deepEqual(new ConvStore(kv).ids(), ["abc1"]);
  b.prune(["yok"]);
  assert.equal(new ConvStore(kv).get("abc1")!.closed, true); // silinmez, kapalı işaretlenir
});

t("depo: bozuk kayıt ve yazma hatası", () => {
  const kv = new Mem();
  kv.setItem("dersapp.ai.sohbet.v1", "{bozuk");
  assert.deepEqual(new ConvStore(kv).ids(), []);
  kv.setItem("dersapp.ai.sohbet.v1", JSON.stringify([{ id: "../x", turns: [] }, { id: "ok1", turns: [{ role: "user", text: "a" }] }, { id: "ok2", turns: [{ role: "x" }] }]));
  assert.deepEqual(new ConvStore(kv).ids(), ["ok1"]);
  const s = new ConvStore(kv);
  kv.fail = true;
  assert.equal(s.put("ok1", [{ role: "user", text: "b" }]), false);
});

t("ekli belgeler: API sağlayıcısında sayfa metni, ajanda yol", () => {
  assert.equal(docsContext([], false), "");
  const docs = [{ name: "ders.pdf", path: "/d/ders.pdf", page: 3, pages: 20, text: "  Laplace   dönüşümü " }, { name: "b.pdf", path: "/d/b.pdf" }];
  const api = docsContext(docs, false);
  assert.ok(api.includes("- ders.pdf, açık sayfa 3/20"));
  assert.ok(api.includes("## ders.pdf s.3\nLaplace dönüşümü"));
  assert.ok(!api.includes("/d/ders.pdf"));
  assert.ok(!api.includes("## b.pdf"));
  const cli = docsContext(docs, true);
  assert.ok(cli.includes("(yol: /d/ders.pdf)"));
  assert.ok(!cli.includes("Laplace"));
  const pres = docsContext([{ name: "s.pptx", path: "/d/s.pptx", page: 2, pdf: "/data/office/ic1-a/sunum.pdf" }], true);
  assert.ok(pres.includes("- s.pptx, açık sayfa 2 (sunum; şu PDF olarak oku: /data/office/ic1-a/sunum.pdf; sayfa = slayt)"));
  assert.ok(!pres.includes("yol: /d/s.pptx"));
  assert.ok(docsContext([{ ...docs[0], text: "x".repeat(50) }], false, 10).includes("x".repeat(10) + " …(kısaltıldı)"));
});

const U: SavedTurn[] = [{ role: "user", text: "s" }, { role: "assistant", text: "y" }];
const mk = (id: string, updated: number, turns = U, closed = false) => ({ id, title: titleOf(turns), created: 1, updated, turns, ...(closed ? { closed } : {}) });

t("kapat: dolu kapalı işaretlenir, boş silinir", () => {
  assert.equal(markClosed(mk("a", 1))!.closed, true);
  assert.equal(markClosed(mk("a", 1, []) ), null);
  const kv = new Mem();
  const s = new ConvStore(kv);
  s.put("aa1", U, 5);
  s.put("bb1", [], 6);
  s.close("aa1");
  s.close("bb1");
  const r = new ConvStore(kv);
  assert.deepEqual(r.ids(), ["aa1"]);
  assert.equal(r.get("aa1")!.closed, true);
  assert.equal(r.history()[0].open, false);
  r.reopen("aa1");
  assert.equal(new ConvStore(kv).get("aa1")!.closed, undefined);
  r.close("aa1");
  r.put("aa1", U, 9); // sekmeden yeniden yazılınca açık
  assert.equal(new ConvStore(kv).get("aa1")!.closed, undefined);
});

t("geçmiş: yeniden eskiye, boşlar yok, sayı ve açık bilgisi", () => {
  const h = historyList([mk("a", 1), mk("b", 3, U, true), mk("c", 2, []), mk("d", 2)]);
  assert.deepEqual(h.map((x) => x.id), ["b", "d", "a"]);
  assert.equal(h[0].count, 2);
  assert.equal(h[0].open, false);
  assert.equal(h[1].open, true);
});

t("50 sınırı: en eski kapalılar atılır, açıklar korunur", () => {
  const list = Array.from({ length: 53 }, (_, i) => mk("c" + i, i, U, i % 2 === 0));
  const drop = pruneIds(list);
  assert.equal(drop.length, 3);
  assert.deepEqual(drop, ["c0", "c2", "c4"]);
  assert.deepEqual(pruneIds(list.map((c) => ({ ...c, closed: undefined }))), []); // hepsi açık: atılmaz
  assert.deepEqual(pruneIds(list.slice(0, 50)), []);
  const kv = new Mem();
  const s = new ConvStore(kv);
  for (let i = 0; i < MAX_CONVS + 5; i++) { s.put("x" + i.toString(36), U, i); s.close("x" + i.toString(36)); }
  assert.equal(new ConvStore(kv).ids().length, MAX_CONVS);
});

console.log(`sohbet: ${count} test geçti`);
