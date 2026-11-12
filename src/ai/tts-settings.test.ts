// Çalıştırma: node src/ai/tts-settings.test.ts
import assert from "node:assert/strict";
import { chooseEngine, defaultSettings, needsChooser, parseSettings } from "./tts-settings.ts";

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

t("ilk açılış: seçim kutusu gösterilir", () => {
  assert.equal(needsChooser(parseSettings(null)), true);
  assert.equal(needsChooser(parseSettings("bozuk{")), true);
  assert.equal(needsChooser(parseSettings("null")), true);
  assert.equal(parseSettings(null).engine, "system");
});

t("eski kayıt: yalnızca varsayılan sistem sesi = seçilmemiş sayılır", () => {
  const s = parseSettings(JSON.stringify({ engine: "system", rate: 1.25, auto: true }));
  assert.equal(s.chosen, false);
  assert.equal(s.rate, 1.25);
  assert.equal(s.auto, true);
});

t("eski kayıt: bilerek seçilmiş başka motor korunur", () => {
  const s = parseSettings(JSON.stringify({ engine: "cloud" }));
  assert.equal(s.engine, "cloud");
  assert.equal(needsChooser(s), false);
});

t("seçim kaydedilip geri okunur (sistem sesi de olsa)", () => {
  const s = defaultSettings();
  chooseEngine(s, "system");
  const back = parseSettings(JSON.stringify(s));
  assert.equal(back.engine, "system");
  assert.equal(needsChooser(back), false);
  chooseEngine(back, "piper");
  assert.equal(parseSettings(JSON.stringify(back)).engine, "piper");
});

t("motor ayarları ve eski ses alanı", () => {
  const s = parseSettings(JSON.stringify({ voice: "Tolga", cfg: { cloud: { model: "m", n: 5 }, x: "y" } }));
  assert.equal(s.cfg.system.voice, "Tolga");
  assert.equal(s.cfg.cloud.model, "m");
  assert.equal(s.cfg.cloud.n, undefined);
  assert.equal(s.cfg.x, undefined);
  assert.equal(parseSettings(JSON.stringify({ rate: 9 })).rate, 1.5);
});

console.log(`tts-settings: ${count} test geçti`);
