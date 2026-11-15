// Altyazı görünümünün saf mantığı (DOM'suz; Node testi: subtitle.test.ts).
//
// Okunan metin (Markdown + LaTeX) sesli okumanın cümle kuyruğuyla (tts-text.ts toSpeech -> Segment) aynı
// parçalara ayrılır; uzun cümle ekranda 2-3 satırı geçmesin diye ardışık "altyazı parçalarına" bölünür.
// Formül ($...$, \(...\)) hiçbir zaman ortadan bölünmez; kalın yazı (**...**) bölünürse iki parçada da kapatılıp
// yeniden açılır. Sesle eşleme: cümle değişince o cümlenin ilk parçası; cümle içinde parçalar geçen süreyle
// (tahmini okuma hızı) ya da kayıtlı derste ses zamanıyla, uzunluk oranında ilerler.

export interface SubChunk {
  /** Gösterilecek Markdown (KaTeX ile çizilir) */
  md: string;
  /** Ait olduğu cümle (Segment) sırası */
  seg: number;
  /** Bu parçanın işaret numarası (①), yoksa null */
  step: number | null;
  /** Ekrandaki yaklaşık uzunluk (karakter) */
  len: number;
}

/** Varsayılan parça uzunluğu: telefonda ~17 px yazıyla 2-3 satır */
export const SUB_MAX = 100;

/** Formülün ekrandaki yaklaşık genişliği (karakter cinsinden): TeX komutları görünenden uzundur. */
function mathLen(tex: string): number {
  const shown = tex.replace(/\\[A-Za-z]+/g, "x").replace(/[{}^_\s]/g, "");
  return Math.max(1, Math.ceil(shown.length * 0.9));
}

interface Atom {
  text: string;
  len: number;
}

/** Boşluklardan böler; formül içindeki boşluklar bölmez. */
function atoms(text: string): Atom[] {
  const out: Atom[] = [];
  let cur = "";
  let len = 0;
  const push = () => {
    if (cur) out.push({ text: cur, len });
    cur = "";
    len = 0;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      push();
      i++;
      continue;
    }
    // \( ... \)
    if (ch === "\\" && text[i + 1] === "(") {
      const end = text.indexOf("\\)", i + 2);
      if (end >= 0) {
        cur += text.slice(i, end + 2);
        len += mathLen(text.slice(i + 2, end));
        i = end + 2;
        continue;
      }
    }
    // $...$ ve $$...$$ (kaçışlı \$ formül değildir)
    if (ch === "$" && text[i - 1] !== "\\") {
      const dbl = text[i + 1] === "$";
      const open = dbl ? 2 : 1;
      let j = i + open;
      let end = -1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "$" && (!dbl || text[j + 1] === "$")) {
          end = j;
          break;
        }
        j++;
      }
      if (end > i + open - 1) {
        cur += text.slice(i, end + open);
        len += mathLen(text.slice(i + open, end));
        i = end + open;
        continue;
      }
    }
    cur += ch;
    len++;
    i++;
  }
  push();
  return out;
}

/** Parçada açık kalan kalın (**) var mı (formül dışındaki ** sayısı tek mi) */
function openBold(md: string): boolean {
  const plain = md.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)/g, "");
  return ((plain.match(/\*\*/g)?.length ?? 0) % 2) === 1;
}

/**
 * Cümlenin Markdown kaynağını altyazıya uygun tek satıra çevirir: satır başı başlık/liste/alıntı işaretleri
 * ve satır sonları kalkar, blok formül satır içi olur, eşi olmayan ** silinir.
 */
export function cleanSlice(md: string): string {
  let s = String(md ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+)/gm, "");
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, t: string) => `$${t.trim()}$`);
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, t: string) => `$${t.trim()}$`);
  s = s.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
  if (openBold(s)) {
    // Cümle sınırı kalın yazının ortasından geçmiş: tek kalan ** işaretini at
    const k = s.lastIndexOf("**");
    s = (s.slice(0, k) + s.slice(k + 2)).replace(/\s{2,}/g, " ").trim();
  }
  return s;
}

/** Görünen uzunluk (formüller kısaltılarak sayılır) */
export function visualLen(md: string): number {
  return atoms(md).reduce((n, a, i) => n + a.len + (i ? 1 : 0), 0);
}

const SOFT_END = /[,;:)\]]$|[.!?…]["'”’)]?$|[—–-]$/;

/**
 * Tek bir (temizlenmiş) cümleyi en çok `max` görünen karakterlik parçalara böler. Önce noktalama sonrası
 * yerden (parçanın en az %40ı dolmuşsa), değilse son sözcük arasından keser; çok kısa son parça bir
 * öncekiyle birleşir. Formül hiçbir zaman bölünmez (tek başına uzunsa kendi parçası olur).
 */
export function splitChunks(text: string, max = SUB_MAX): string[] {
  const list = atoms(text);
  if (!list.length) return [];
  const groups: Atom[][] = [];
  let cur: Atom[] = [];
  let len = 0;
  for (const a of list) {
    const add = a.len + (cur.length ? 1 : 0);
    if (cur.length && len + add > max) {
      // Noktalamadan kes (parçanın yarısından sonra), yoksa burada
      let cut = cur.length;
      let acc = 0;
      let best = -1;
      for (let k = 0; k < cur.length; k++) {
        acc += cur[k].len + (k ? 1 : 0);
        if (k < cur.length - 1 && acc >= max * 0.4 && SOFT_END.test(cur[k].text)) best = k + 1;
      }
      if (best > 0) cut = best;
      groups.push(cur.slice(0, cut));
      cur = cur.slice(cut);
      len = cur.reduce((n, x, k) => n + x.len + (k ? 1 : 0), 0);
    }
    cur.push(a);
    len += a.len + (cur.length > 1 ? 1 : 0);
  }
  if (cur.length) groups.push(cur);
  // Çok kısa son parça (tek-iki sözcük) öncekiyle birleşsin, biraz uzasa da
  if (groups.length > 1) {
    const lastLen = groups[groups.length - 1].reduce((n, x, k) => n + x.len + (k ? 1 : 0), 0);
    const prevLen = groups[groups.length - 2].reduce((n, x, k) => n + x.len + (k ? 1 : 0), 0);
    if (lastLen < max * 0.2 && prevLen + lastLen + 1 <= max * 1.25) {
      groups[groups.length - 2].push(...groups.pop()!);
    }
  }
  // Kalın yazı bölündüyse kapat / yeniden aç
  const out: string[] = [];
  let carry = false;
  for (const g of groups) {
    let s = g.map((x) => x.text).join(" ");
    if (carry) s = "**" + s;
    carry = openBold(s);
    if (carry) s += "**";
    out.push(s);
  }
  return out;
}

/**
 * Okunan metni altyazı parçalarına çevirir. segs: toSpeech'in cümleleri (kaynak metinde start/end).
 * stepOf: cümlenin işaret numarası (lesson.ts stepOfSegment), yoksa hep null.
 */
export function buildChunks(
  src: string,
  segs: readonly { start: number; end: number }[],
  max = SUB_MAX,
  stepOf?: (start: number, end: number) => number | null,
): SubChunk[] {
  const out: SubChunk[] = [];
  segs.forEach((s, i) => {
    const md = cleanSlice(src.slice(Math.max(0, s.start), Math.max(s.start, s.end)));
    const step = stepOf ? stepOf(s.start, s.end) : null;
    const parts = md ? splitChunks(md, max) : [];
    // Okunan ama gösterilecek metni olmayan cümle (ör. yalnızca tablo hücresi): boş parça yine de sırayı korur
    if (!parts.length) parts.push("");
    for (const p of parts) out.push({ md: p, seg: i, step, len: Math.max(1, visualLen(p)) });
  });
  return out;
}

/** Cümlenin ilk parçası (yoksa en yakın önceki); liste boşsa 0. */
export function firstChunkOf(chunks: readonly SubChunk[], seg: number): number {
  let best = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].seg === seg) return i;
    if (chunks[i].seg < seg) best = i;
  }
  return best;
}

/** Bir cümlenin parçaları [ilk, son] (yoksa null) */
export function chunksOfSeg(chunks: readonly SubChunk[], seg: number): [number, number] | null {
  let a = -1;
  let b = -1;
  chunks.forEach((c, i) => {
    if (c.seg !== seg) return;
    if (a < 0) a = i;
    b = i;
  });
  return a < 0 ? null : [a, b];
}

/** Uzunluk oranına göre: kesir (0..1) -> parça sırası */
export function chunkAtFraction(lens: readonly number[], f: number): number {
  if (!lens.length) return 0;
  const total = lens.reduce((n, x) => n + Math.max(1, x), 0);
  const at = Math.max(0, Math.min(0.9999, Number.isFinite(f) ? f : 0)) * total;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    acc += Math.max(1, lens[i]);
    if (at < acc) return i;
  }
  return lens.length - 1;
}

/** Türkçe sesli okumanın yaklaşık hızı (karakter/sn, 1× hızda) */
export const READ_CPS = 14;

/**
 * Sesli okuma: cümle başlayalı elapsedMs geçti; cümlenin parçalarından hangisi okunuyor (tahmin).
 * Motorlar cümle içi ilerleme bildirmediği için okuma hızından kestirilir; son parçada kalır.
 */
export function chunkAtElapsed(lens: readonly number[], elapsedMs: number, rate = 1, cps = READ_CPS): number {
  if (lens.length <= 1) return 0;
  const total = lens.reduce((n, x) => n + Math.max(1, x), 0);
  const dur = (total / (cps * Math.max(0.25, rate))) * 1000;
  return chunkAtFraction(lens, Math.max(0, elapsedMs) / dur);
}

/** Kayıtlı ders: parçanın ses aralığı [start, end] (sn) içinde t anında hangi altyazı parçası */
export function chunkAtTime(lens: readonly number[], start: number, end: number, t: number): number {
  if (lens.length <= 1 || !(end > start)) return 0;
  return chunkAtFraction(lens, (t - start) / (end - start));
}

/** Altyazı konumu: 0 = üst, 1 = alt; sürükleme ve kaydedilen değer sınırlanır */
export function clampPos(y: number): number {
  return Number.isFinite(y) ? Math.max(0, Math.min(1, y)) : 1;
}

/** Sürüklenen kutunun yeni konumu: kutu üst kenarı (px) ve kullanılabilir yükseklik -> 0..1 */
export function posFromTop(top: number, room: number): number {
  return room > 0 ? clampPos(top / room) : 1;
}
