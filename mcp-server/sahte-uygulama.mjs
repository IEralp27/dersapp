#!/usr/bin/env node
// Sahte DersApp: MCP dosya kuyruğunu elle denemek için uygulamayı taklit eder.
//
// Kullanım:
//   node mcp-server/sahte-uygulama.mjs [--veri <klasör>] [--gecikme <ms>] [--hata] [--sessiz]
//
//   --veri     Veri klasörü (varsayılan: DERSAPP_DATA, yoksa sunucunun kullandığı
//              işletim sistemi klasörü, ör. %APPDATA%\com.eralp.dersapp)
//   --gecikme  Her yanıttan önce bekle (zaman aşımını denemek için büyük ver)
//   --hata     Her isteğe { ok:false } dön
//   --sessiz   Hiç yanıt verme (yalnızca context.json yaz)
//
// Ne yapar:
//   - <veri>/mcp/context.json dosyasını 2 sn'de bir { updatedAt, ... } ile yazar
//   - <veri>/mcp/requests/*.json dosyalarını 100 ms'de bir yoklar (.tmp'leri atlar)
//   - her isteği okuyunca siler ve <veri>/mcp/responses/<id>.json yanıtını
//     önce .tmp'ye yazıp sonra rename ederek bırakır
// Ctrl+C ile çıkınca context.json silinir (uygulama "kapalı" görünür).
//
// Arayüz köprüsünü yazarken bu dosya başvuru örneğidir: aynı dosya adları,
// aynı JSON biçimleri.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- argümanlar ----
const argv = process.argv.slice(2);
const opt = { veri: null, gecikme: 0, hata: false, sessiz: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--veri") opt.veri = argv[++i];
  else if (a === "--gecikme") opt.gecikme = Number(argv[++i]) || 0;
  else if (a === "--hata") opt.hata = true;
  else if (a === "--sessiz") opt.sessiz = true;
  else if (a === "--help" || a === "-h") {
    console.log("node sahte-uygulama.mjs [--veri <klasör>] [--gecikme <ms>] [--hata] [--sessiz]");
    process.exit(0);
  } else {
    console.error(`Bilinmeyen argüman: ${a}`);
    process.exit(2);
  }
}

// Sunucudaki src/paths.rs ile aynı kural.
function veriKlasoru() {
  if (opt.veri) return path.resolve(opt.veri);
  if (process.env.DERSAPP_DATA) return process.env.DERSAPP_DATA;
  const id = "com.eralp.dersapp";
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", id);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", id);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), id);
}

const VERI = veriKlasoru();
const MCP = path.join(VERI, "mcp");
const REQ = path.join(MCP, "requests");
const RESP = path.join(MCP, "responses");
fs.mkdirSync(REQ, { recursive: true });
fs.mkdirSync(RESP, { recursive: true });

// ---- sahte uygulama durumu ----
const belgeler = [
  { id: "doc-1", name: "Makine Elemanları - Bölüm 3.pdf", page: 12, pageCount: 48 },
  { id: "doc-2", name: "Süreç Kontrol Ders Notu.pdf", page: 1, pageCount: 120 },
];
let etkin = "doc-1";
const sinavlar = [{ course: "Süreç Kontrol", date: "2026-11-20", time: "10:00", place: "B-204", note: "vize" }];
const testSonuclari = [];

// 1x1 PNG (görüntü içeriği denemesi için)
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function yazAtomik(hedef, nesne) {
  const tmp = `${hedef}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nesne), "utf8"); // BOM yok
  fs.renameSync(tmp, hedef); // Windows'ta da üzerine yazar
}

function contextYaz() {
  yazAtomik(path.join(MCP, "context.json"), {
    updatedAt: Date.now(),
    app: "sahte-uygulama.mjs",
    activeDocument: etkin,
    documents: belgeler,
  });
}

function belgeBul(ad) {
  if (!ad) return belgeler.find((b) => b.id === etkin);
  return belgeler.find((b) => b.id === ad || b.name === ad || b.name.toLowerCase().includes(String(ad).toLowerCase()));
}

const metin = (t) => ({ type: "text", text: t });
const hata = (m) => ({ ok: false, error: m });
const tamam = (...content) => ({ ok: true, content });

function isle(tool, args = {}) {
  switch (tool) {
    case "list_documents":
      return tamam(
        metin(
          belgeler
            .map((b) => `${b.id === etkin ? "* " : "  "}${b.id} — ${b.name} (sayfa ${b.page}/${b.pageCount})`)
            .join("\n") + "\n(* = etkin)",
        ),
      );
    case "read_page": {
      const b = belgeBul(args.document);
      if (!b) return hata(`Belge bulunamadı: ${args.document}`);
      const s = args.page ?? b.page;
      if (s < 1 || s > b.pageCount) return hata(`${b.name} içinde ${s}. sayfa yok (${b.pageCount} sayfa).`);
      const fmt = args.format ?? "both";
      const c = [];
      if (fmt !== "image") c.push(metin(`[${b.name} — sayfa ${s}]\nBu sahte bir sayfa metnidir. Rulmanlar, yataklar, mil hesabı…`));
      if (fmt !== "text") c.push({ type: "image", data: PNG_1X1, mimeType: "image/png" });
      return tamam(...c);
    }
    case "read_pages_text": {
      const b = belgeBul(args.document);
      if (!b) return hata(`Belge bulunamadı: ${args.document}`);
      const { from, to } = args;
      if (!(from >= 1 && to >= from)) return hata("Geçersiz aralık: from ≥ 1 ve to ≥ from olmalı.");
      if (to - from + 1 > 30) return hata("En çok 30 sayfa okunabilir.");
      if (to > b.pageCount) return hata(`${b.name} ${b.pageCount} sayfa.`);
      const parcalar = [];
      for (let s = from; s <= to; s++) parcalar.push(`--- sayfa ${s} ---\nSahte metin ${s}.`);
      return tamam(metin(parcalar.join("\n")));
    }
    case "go_to_page": {
      const b = belgeBul(args.document);
      if (!b) return hata(`Belge bulunamadı: ${args.document}`);
      if (args.page < 1 || args.page > b.pageCount) return hata(`${b.name} içinde ${args.page}. sayfa yok.`);
      b.page = args.page;
      etkin = b.id;
      contextYaz();
      return tamam(metin(`${b.name}, ${args.page}. sayfaya kaydırıldı.`));
    }
    case "show_test": {
      const n = Array.isArray(args.questions) ? args.questions.length : 0;
      // Öğrenci hemen çözmüş gibi davran.
      testSonuclari.unshift({
        title: args.title,
        solvedAt: new Date().toISOString(),
        total: n,
        correct: Math.floor(n / 2),
        answers: [],
      });
      return tamam(metin(`"${args.title}" testi (${n} soru) öğrenciye gösterildi. Sonuçlar için get_test_results.`));
    }
    case "get_test_results": {
      const limit = args.limit ?? 5;
      const r = testSonuclari.slice(0, limit);
      return tamam(metin(r.length ? JSON.stringify(r, null, 2) : "Henüz çözülmüş test yok."));
    }
    case "list_exams":
      return tamam(metin(JSON.stringify(sinavlar, null, 2)));
    case "add_exam": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date ?? "")) return hata("Tarih YYYY-AA-GG biçiminde olmalı.");
      sinavlar.push({ course: args.course, date: args.date, time: args.time, place: args.place, note: args.note });
      return tamam(metin(`${args.course} sınavı ${args.date}${args.time ? " " + args.time : ""} olarak eklendi.`));
    }
    default:
      return hata(`Bu araç uygulamada tanımlı değil: ${tool}`);
  }
}

// ---- kuyruk döngüsü ----
const islenen = new Set();

function yokla() {
  let adlar;
  try {
    adlar = fs.readdirSync(REQ);
  } catch {
    return;
  }
  for (const ad of adlar) {
    if (!ad.endsWith(".json") || islenen.has(ad)) continue; // .tmp'leri atla
    const tam = path.join(REQ, ad);
    let istek;
    try {
      istek = JSON.parse(fs.readFileSync(tam, "utf8"));
    } catch {
      continue; // yarım yazılmış olabilir; sonra tekrar dene
    }
    islenen.add(ad);
    try {
      fs.unlinkSync(tam); // isteği tükettik
    } catch {}
    console.log(`→ ${istek.tool} ${JSON.stringify(istek.args)}`);
    if (opt.sessiz) continue;
    let yanit;
    try {
      yanit = opt.hata ? hata("Sahte uygulama: --hata kipinde.") : isle(istek.tool, istek.args ?? {});
    } catch (e) {
      yanit = hata(`Uygulama içi hata: ${e.message}`);
    }
    yanit.id = istek.id;
    setTimeout(() => {
      yazAtomik(path.join(RESP, `${istek.id}.json`), yanit);
      console.log(`← ${istek.id} ok=${yanit.ok}`);
    }, opt.gecikme);
  }
}

contextYaz();
const t1 = setInterval(contextYaz, 2000);
const t2 = setInterval(yokla, 100);
console.log(`Sahte DersApp çalışıyor. Veri klasörü: ${VERI}\nÇıkmak için Ctrl+C.`);

function kapat() {
  clearInterval(t1);
  clearInterval(t2);
  try {
    fs.unlinkSync(path.join(MCP, "context.json"));
  } catch {}
  console.log("Kapatıldı (context.json silindi).");
  process.exit(0);
}
process.on("SIGINT", kapat);
process.on("SIGTERM", kapat);
