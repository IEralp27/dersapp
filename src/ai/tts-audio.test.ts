// Çalıştırma: node src/ai/tts-audio.test.ts
import assert from "node:assert/strict";
import { BytesSpeaker, LruCache } from "./tts-audio.ts";
import type { ClipProvider } from "./tts-audio.ts";

let count = 0;
const same = (a: unknown, b: unknown) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const t = (name: string, fn: () => void | Promise<void>) => {
  tests.push(async () => {
    try {
      await fn();
      count++;
    } catch (e) {
      console.error("FAIL", name);
      throw e;
    }
  });
};
const tests: (() => Promise<void>)[] = [];
const blob = (n: number) => ({ size: n });

// ---- LRU
t("sınırı aşınca en eski atılır", () => {
  const c = new LruCache<{ size: number }>(10);
  c.set("a", blob(4));
  c.set("b", blob(4));
  c.set("c", blob(4));
  assert.equal(c.has("a"), false);
  assert.ok(c.has("b") && c.has("c"));
  assert.equal(c.bytes, 8);
});
t("get kaydı tazeler (LRU)", () => {
  const c = new LruCache<{ size: number }>(10);
  c.set("a", blob(4));
  c.set("b", blob(4));
  c.get("a");
  c.set("c", blob(4));
  assert.ok(c.has("a") && c.has("c"));
  assert.equal(c.has("b"), false);
});
t("aynı anahtar yeniden yazılınca boyut doğru", () => {
  const c = new LruCache<{ size: number }>(10);
  c.set("a", blob(4));
  c.set("a", blob(6));
  assert.equal(c.bytes, 6);
  assert.equal(c.count, 1);
});
t("tek başına sınırı aşan saklanmaz, eskiler korunur", () => {
  const c = new LruCache<{ size: number }>(10);
  c.set("a", blob(4));
  c.set("big", blob(11));
  assert.equal(c.has("big"), false);
  assert.ok(c.has("a"));
  assert.equal(c.bytes, 4);
});
t("delete ve clear", () => {
  const c = new LruCache<{ size: number }>(10);
  c.set("a", blob(3));
  c.set("b", blob(3));
  c.delete("a");
  assert.equal(c.bytes, 3);
  c.clear();
  assert.equal(c.bytes + c.count, 0);
});

// ---- BytesSpeaker (sahte Audio ile)
class FakeAudio {
  static made: FakeAudio[] = [];
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playbackRate = 1;
  preservesPitch = false;
  preload = "";
  src = "";
  paused = true;
  plays = 0;
  constructor() {
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    this.plays++;
    queueMicrotask(() => this.onplaying?.());
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  load() {}
}
const g = globalThis as Record<string, unknown>;
g.Audio = FakeAudio;
let urlN = 0;
(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:fake/" + ++urlN;
(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};

const tick = () => new Promise((r) => setTimeout(r, 5));
const mkProvider = () => {
  const calls: string[] = [];
  const aborted: string[] = [];
  const failing = new Set<string>();
  const p: ClipProvider = {
    key: (x) => "k:" + x,
    fetch: (x, signal) =>
      new Promise((res, rej) => {
        calls.push(x);
        signal.addEventListener("abort", () => {
          aborted.push(x);
          rej(new DOMException("abort", "AbortError"));
        });
        setTimeout(() => (failing.has(x) ? rej(new Error("Türkçe hata " + x)) : res({ bytes: new Uint8Array(10), mime: "audio/wav" })), 5);
      }),
  };
  return { p, calls, aborted, failing };
};
const events = () => {
  const log: string[] = [];
  return { log, ev: { start: () => log.push("start"), end: () => log.push("end"), error: (m: string) => log.push("error:" + m) } };
};
const opts = { voiceId: null, rate: 1, lang: "tr-TR" };

t("çalar, bitince end; ikinci kez önbellekten (yeni istek yok)", async () => {
  const { p, calls } = mkProvider();
  const sp = new BytesSpeaker("t", () => p, new LruCache<Blob>(1000));
  const a = events();
  sp.speak("bir", opts, a.ev);
  await tick(); await tick();
  FakeAudio.made.at(-1)!.onended!();
  same(a.log, ["start", "end"]);
  const b = events();
  sp.speak("bir", opts, b.ev);
  await tick();
  assert.equal(calls.length, 1, "önbellek");
  FakeAudio.made.at(-1)!.onended!();
  same(b.log, ["start", "end"]);
});
t("prefetch sıradakini ister; gereksizi iptal eder; stop hepsini iptal eder", async () => {
  const { p, calls, aborted } = mkProvider();
  const sp = new BytesSpeaker("t", () => p, new LruCache<Blob>(1000));
  sp.speak("a", opts, events().ev);
  sp.prefetch(["b", "c"], opts);
  same(calls, ["a", "b", "c"]);
  sp.speak("b", opts, events().ev); // atlama: b zaten yolda
  sp.prefetch(["c", "d"], opts);
  same(calls, ["a", "b", "c", "d"]);
  sp.stop();
  await tick();
  assert.ok(aborted.includes("d") && aborted.includes("c"), "bekleyenler iptal: " + aborted);
});
t("hata Türkçe mesajla error olayına gelir; iptal edilen sessiz", async () => {
  const { p, failing } = mkProvider();
  failing.add("x");
  const sp = new BytesSpeaker("t", () => p, new LruCache<Blob>(1000));
  const a = events();
  sp.speak("x", opts, a.ev);
  await tick(); await tick();
  same(a.log, ["error:Türkçe hata x"]);
  const b = events();
  sp.speak("y", opts, b.ev);
  sp.stop();
  await tick(); await tick();
  same(b.log, []);
});
t("duraklat/devam aynı sesi sürdürür; fetch beklerken duraklatınca başlamaz", async () => {
  const { p } = mkProvider();
  const sp = new BytesSpeaker("t", () => p, new LruCache<Blob>(1000));
  const a = events();
  sp.speak("p", opts, a.ev);
  assert.equal(sp.pause(), true);
  await tick(); await tick();
  const au = FakeAudio.made.at(-1)!;
  assert.equal(au.plays, 0, "duraklatılmışken çalmadı");
  assert.equal(sp.resume(), true);
  await tick();
  assert.equal(au.plays, 1);
  same(a.log, ["start"]);
  sp.pause();
  assert.equal(au.paused, true);
  sp.resume();
  assert.equal(au.plays, 2);
});
t("hız çalarken uygulanır", async () => {
  const { p } = mkProvider();
  const sp = new BytesSpeaker("t", () => p, new LruCache<Blob>(1000));
  sp.speak("r", { ...opts, rate: 1.25 }, events().ev);
  await tick(); await tick();
  const au = FakeAudio.made.at(-1)!;
  assert.equal(au.playbackRate, 1.25);
  sp.setRate(1.5);
  assert.equal(au.playbackRate, 1.5);
});

for (const f of tests) await f();
console.log(`tts-audio: ${count}/${tests.length} test geçti`);
