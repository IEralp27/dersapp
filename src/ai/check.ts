// "Çözümümü kontrol et": öğrencinin tahtada/sayfada kalemle yazdığı çözümü yapay zekaya denetletir. DOM yok;
// `node src/ai/check.test.ts`.
//
// Model ilk yanlış satırı bulur, açıklar ve mevcut işaret mekanizmasıyla (dersapp-marks bloğu, marks.ts) işaretler.
// Sonuç ikinci bir dersapp-marks bloğunda gelir (öğrenci blokları görmez; bozuk LaTeX kaçışı işaretleri bozmasın diye ayrı):
//   {"kontrol": {"durum": "hata", "satir": 3, "soru": "...", "hatali": "...", "dogrusu": "...", "neden": "..."}}
// Hata varsa panel "Hata defterine ekle" düğmesi gösterir (kart: soru + hatalı satır -> o satırın doğrusu + neden).
import { splitMarks } from "./marks.ts";
import { repairJson } from "./quiz.ts";

export type CheckStatus = "hata" | "dogru" | "okunamadi";

export interface CheckVerdict {
  status: CheckStatus;
  /** İlk hatalı satır (1..; bilinmiyorsa 0) */
  line: number;
  /** Problemin kısa hali */
  question: string;
  /** Öğrencinin hatalı satırı */
  wrong: string;
  /** Yalnızca o satırın doğrusu */
  fix: string;
  /** Kısa neden */
  why: string;
}

export const CHECK_LABEL = "Çözümümü kontrol et";

/** Panel isteği. `marks`: işaretleme açık mı (kapalıysa koordinat istenmez). */
export function checkRequest(name: string, page: number, board: boolean, marks: boolean): string {
  const where = board ? "beyaz tahta" : `"${name.replace(/\.(pdf|pptx|ppt|odp)$/i, "")}", sayfa ${page}`;
  return `Bu görüntüde benim (öğrencinin) kalemle yazdığım bir çözüm var (${where}). Çözümümü kontrol et.

- Satır satır ilerle: her satır bir öncekinden doğru çıkıyor mu (formül seçimi, yerine koyma, işlem, işaret, birim, ondalık)?
- İLK yanlış satırı bul ve orada dur; sonraki satırları ayrıca değerlendirme (ilk hatadan sonra hepsi kayar).
- Yanıtın şu sırada ve kısa olsun:
  1. Tek cümle genel durum.
  2. "① Hata:" hatalı satırı LaTeX ile alıntıla, neyin yanlış olduğunu 1-3 cümleyle açıkla.
  3. Yalnızca o satırın nasıl olması gerektiğini söyle. Tam çözümü, sonraki adımları ve sonucu YAZMA; ben istersem ayrıca sorarım.
  4. Kendim düzeltmem için tek kısa ipucu ya da soru.
- Hata yoksa "Çözümün doğru görünüyor." de; varsa tek cümlelik gösterim/birim önerisi ekle.
- Bir satırı okuyamıyorsan tahmin etme: hangi satırı okuyamadığını söyle.
- Problemin metni görüntüde yoksa çözümden ne sorulduğunu çıkar; emin değilsen bunu söyle.

Yanıtının EN SONUNA, dili dersapp-marks olan İKİ kod çiti yaz (ben bunları görmem). Önce işaretler, sonra sonuç:
\`\`\`dersapp-marks
{"marks": [${marks ? `{"n": 1, "type": "box", "box": [x0, y0, x1, y1], "note": "ilk hata"}` : ""}]}
\`\`\`
\`\`\`dersapp-marks
{"kontrol": {"durum": "hata", "satir": 3, "soru": "problemin kısa hali (LaTeX)", "hatali": "hatalı satır (LaTeX)", "dogrusu": "yalnızca o satırın doğrusu (LaTeX)", "neden": "tek cümle"}}
\`\`\`
${marks
    ? `- "marks": hata varsa yalnızca hatalı satırı saran tek bir "box" (n: 1, metinde ①); koordinatlar görüntüye göre 0-1000 (sol üst 0,0; sağ alt 1000,1000). Hata yoksa boş dizi.`
    : `- "marks" boş dizi kalsın.`}
- "durum": "hata", "dogru" ya da "okunamadi". Hata yoksa "satir" 0, "hatali"/"dogrusu"/"neden" boş metin.
- Yalnızca gerçek JSON: LaTeX ters bölülerini JSON içinde iki kez yaz (\\\\frac), sondaki virgül yok.`;
}

function str(v: unknown, max = 1500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "";
}

/** Tek bir blok içinden "kontrol" nesnesini okur; LaTeX ters bölüleri tek yazılmışsa onarmayı dener. */
function readBlock(raw: string): Record<string, unknown> | null {
  const src = raw.trim();
  const a = src.indexOf("{");
  const b = src.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  const body = src.slice(a, b + 1);
  for (const candidate of [repairJson(body), body]) {
    try {
      const data = JSON.parse(candidate);
      const k = data && typeof data === "object" ? (data as Record<string, unknown>).kontrol : null;
      if (k && typeof k === "object" && !Array.isArray(k)) return k as Record<string, unknown>;
    } catch {
      // sonraki aday
    }
  }
  return null;
}

/** Yanıttan kontrol sonucunu çıkarır; yoksa ya da bozuksa null. */
export function parseCheck(text: string): CheckVerdict | null {
  const { blocks } = splitMarks(text, false);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const k = readBlock(blocks[i]);
    if (!k) continue;
    const d = str(k.durum ?? k.status).toLocaleLowerCase("tr").replace("ğ", "g").replace("ı", "i").replace("ş", "s");
    const status: CheckStatus = d.startsWith("hata") || d === "yanlis" || d === "wrong" ? "hata"
      : d.startsWith("dogru") || d === "correct" ? "dogru" : "okunamadi";
    const line = Number(k.satir ?? k.line);
    return {
      status,
      line: Number.isInteger(line) && line > 0 ? line : 0,
      question: str(k.soru ?? k.question),
      wrong: str(k.hatali ?? k.wrong),
      fix: str(k.dogrusu ?? k.fix),
      why: str(k.neden ?? k.why, 600),
    };
  }
  return null;
}

/** Hata defteri kartının metinleri */
export function checkCardText(v: CheckVerdict): { question: string; answer: string; why: string } {
  const q = v.question || "Kendi çözümüm";
  const question = v.wrong
    ? `${q}\n\nBu satırda hata yaptım${v.line ? ` (${v.line}. satır)` : ""}:\n\n${asMath(v.wrong)}\n\nDoğrusu ne olmalı?`
    : `${q}\n\nÇözümümde hata yaptım. Doğru adım ne?`;
  return { question, answer: v.fix ? asMath(v.fix) : "(yanıtta açıklandı)", why: v.why };
}

/** Satır zaten $ içeriyorsa olduğu gibi; formüle benziyorsa $$ ... $$ içine alınır; düz metin kalır. */
export function asMath(s: string): string {
  const t = s.trim();
  if (t.includes("$")) return t;
  return /[\\=^_]/.test(t) ? `$$${t}$$` : t;
}
