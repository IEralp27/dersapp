// Çalıştırma: node src/ai/tts-android.test.ts
import assert from "node:assert/strict";
import { availability, parseInfo, sniffMime, sortVoices, voiceLabel } from "./tts-android-rules.ts";

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

t("yanıt doğrulama: bozuk alanlar atılır", () => {
  const i = parseInfo({ engine: "com.google.android.tts", lang: 1, voices: [{ id: "tr-tr-x-cfs-local", quality: 400 }, { id: 3 }, null] });
  assert.equal(i.voices.length, 1);
  assert.equal(i.voices[0].installed, true);
  assert.equal(i.voices[0].network, false);
  assert.equal(parseInfo(null).lang, -2);
});

t("kullanılabilirlik", () => {
  assert.equal(availability(null, "x").ok, false);
  assert.equal(availability(parseInfo({ engine: "", lang: 0 })).ok, false);
  assert.equal(availability(parseInfo({ engine: "g", lang: 0 })).ok, true);
  const missing = availability(parseInfo({ engine: "g", lang: -1 }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /Türkçe ses verisi/);
  const unsupported = availability(parseInfo({ engine: "g", lang: -2 }));
  if (!unsupported.ok) assert.match(unsupported.reason, /desteklemiyor/);
  // dil "yok" dese de kurulu çevrimdışı Türkçe ses varsa okunur
  assert.equal(availability(parseInfo({ engine: "g", lang: -2, voices: [{ id: "tr-x", installed: true }] })).ok, true);
});

t("ses sırası ve etiketi", () => {
  const vs = sortVoices([
    { id: "tr-tr-x-ama-network", quality: 400, network: true, installed: true },
    { id: "tr-tr-x-efu-local", quality: 300, network: false, installed: false },
    { id: "tr-tr-x-cfs-local", quality: 400, network: false, installed: true },
  ]);
  assert.deepEqual(vs.map((v) => v.id), ["tr-tr-x-cfs-local", "tr-tr-x-ama-network", "tr-tr-x-efu-local"]);
  assert.equal(voiceLabel(vs[0]), "Ses cfs (çevrimdışı, yüksek kalite)");
  assert.equal(voiceLabel(vs[1]), "Ses ama (internet gerekir, yüksek kalite)");
  assert.equal(voiceLabel({ id: "tur", quality: 100, network: false, installed: false }), "tur (indirilmedi)");
});

t("ses biçimi", () => {
  const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  assert.equal(sniffMime(enc("RIFF\0\0\0\0WAVEfmt ")), "audio/wav");
  assert.equal(sniffMime(enc("OggS\0\0")), "audio/ogg");
  assert.equal(sniffMime(enc("ID3\x03")), "audio/mpeg");
  assert.equal(sniffMime(new Uint8Array([0xff, 0xfb, 0x90])), "audio/mpeg");
  assert.equal(sniffMime(new Uint8Array([1, 2])), "audio/wav");
});

console.log(`tts-android: ${count} test geçti`);
