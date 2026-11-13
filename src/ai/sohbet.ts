// Yapay zeka sekmesi: konuşma kaydı (localStorage) ve saf yardımcılar (başlık, ekli belgelerin bağlamı).
// DOM'suz; arayüz ai-tab.ts'te. Çalıştırma: node src/ai/sohbet.test.ts

export interface SavedTurn {
  role: "user" | "assistant";
  /** Modele giden metin */
  text: string;
  /** Konuşmada görünen kısa etiket (yalnızca kullanıcı turu) */
  label?: string;
}

export interface SavedConv {
  id: string;
  title: string;
  created: number;
  updated: number;
  turns: SavedTurn[];
  /** Sekmesi kapatılmış (yalnızca geçmişte görünür) */
  closed?: boolean;
}

/** Geçmiş listesindeki satır */
export interface HistoryItem {
  id: string;
  title: string;
  updated: number;
  /** Konuşmadaki mesaj sayısı (kullanıcı + yanıt) */
  count: number;
  open: boolean;
}

/** localStorage benzeri (testte sahte nesne) */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STORE_KEY = "dersapp.ai.sohbet.v1";
export const DEFAULT_TITLE = "Yeni sohbet";
/** Bir konuşmada saklanan en çok metin (karakter); aşılırsa en eski turlar atılır */
const MAX_CONV_CHARS = 300_000;
/** En çok bu kadar konuşma saklanır (önce en eski kapalılar atılır) */
export const MAX_CONVS = 50;

const hasUser = (c: SavedConv) => c.turns.some((t) => t.role === "user");

/** Kapat: kullanıcı mesajı olan konuşma kapalı işaretlenir, boş olan silinir (null). */
export function markClosed(c: SavedConv): SavedConv | null {
  return hasUser(c) ? { ...c, closed: true } : null;
}

/** Geçmiş listesi: en yeni güncellenen başta; açık/kapalı hepsi (boşlar hariç). */
export function historyList(convs: SavedConv[]): HistoryItem[] {
  return convs.filter(hasUser).sort((a, b) => b.updated - a.updated)
    .map((c) => ({ id: c.id, title: c.title, updated: c.updated, count: c.turns.length, open: !c.closed }));
}

/** En çok max konuşma kalsın: en eski kapalılar atılır; açık sekmeler ve keep kimliği asla. Atılan kimlikleri döndürür. */
export function pruneIds(convs: SavedConv[], max = MAX_CONVS, keep?: string): string[] {
  const extra = convs.length - max;
  if (extra <= 0) return [];
  return convs.filter((c) => c.closed && c.id !== keep).sort((a, b) => a.updated - b.updated).slice(0, extra).map((c) => c.id);
}

/** İlk kullanıcı mesajından sekme başlığı: Markdown/LaTeX işaretleri ve boşluklar sadeleşir, kelime sınırında kısalır. */
export function deriveTitle(text: string, max = 32): string {
  const s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\$\$?([^$]*)\$\$?/g, "$1")
    .replace(/[#*_`>\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return DEFAULT_TITLE;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?-]+$/, "") + "…";
}

/** Konuşmanın başlığı: ilk kullanıcı turunun etiketinin (yoksa metninin) ilk satırı (ek satırı "📎 …" girmez). */
export function titleOf(turns: SavedTurn[]): string {
  const first = turns.find((t) => t.role === "user");
  return first ? deriveTitle((first.label || first.text).trim().split("\n")[0]) : DEFAULT_TITLE;
}

export function newConvId(now = Date.now(), rand = Math.random()): string {
  return now.toString(36) + Math.floor(rand * 36 ** 4).toString(36).padStart(4, "0");
}

/** Kimlik yalnızca küçük harf ve rakam (sekme anahtarı "ai:<kimlik>" olarak kaydedilir). */
export const validId = (id: string) => /^[a-z0-9]{1,32}$/.test(id);

/** Saklama sınırı: toplam metin sınırı aşılırsa en eski turlar (kullanıcı+yanıt çiftleri) atılır. */
export function trimTurns(turns: SavedTurn[], maxChars = MAX_CONV_CHARS): SavedTurn[] {
  let total = turns.reduce((n, t) => n + t.text.length + (t.label?.length ?? 0), 0);
  let i = 0;
  while (total > maxChars && i < turns.length - 2) {
    total -= turns[i].text.length + (turns[i].label?.length ?? 0);
    i++;
  }
  // Konuşma bir kullanıcı turuyla başlasın
  while (i < turns.length && turns[i].role !== "user") i++;
  return turns.slice(i);
}

function isConv(v: unknown): v is SavedConv {
  const c = v as SavedConv;
  return !!c && typeof c.id === "string" && validId(c.id) && Array.isArray(c.turns)
    && c.turns.every((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string");
}

/** Yapay zeka sekmelerinin konuşmaları (tek anahtar altında JSON). Bozuk kayıt sessizce yok sayılır. */
export class ConvStore {
  private convs = new Map<string, SavedConv>();
  private kv: KeyValue;
  private key: string;

  constructor(kv: KeyValue, key = STORE_KEY) {
    this.kv = kv;
    this.key = key;
    try {
      const raw = kv.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) for (const c of list) if (isConv(c)) this.convs.set(c.id, c);
    } catch {
      // bozuk kayıt: boş başla
    }
  }

  get(id: string): SavedConv | null {
    return this.convs.get(id) ?? null;
  }

  ids(): string[] {
    return [...this.convs.keys()];
  }

  /** Konuşmayı kaydeder (başlık turlardan çıkarılır). Yazılamazsa false. */
  put(id: string, turns: SavedTurn[], now = Date.now()): boolean {
    const old = this.convs.get(id);
    const kept = trimTurns(turns.map((t) => ({ role: t.role, text: t.text, ...(t.label ? { label: t.label } : {}) })));
    this.convs.set(id, { id, title: titleOf(kept), created: old?.created ?? now, updated: now, turns: kept });
    for (const x of pruneIds([...this.convs.values()], MAX_CONVS, id)) this.convs.delete(x);
    return this.save();
  }

  /** Sekme kapandı: konuşma korunur (kapalı işaretlenir), boşsa silinir. */
  close(id: string): boolean {
    const c = this.convs.get(id);
    if (!c) return true;
    const m = markClosed(c);
    if (m) this.convs.set(id, m);
    else this.convs.delete(id);
    return this.save();
  }

  /** Geçmişten yeniden açıldı: kapalı işareti kalkar. */
  reopen(id: string): boolean {
    const c = this.convs.get(id);
    if (!c) return false;
    if (c.closed) {
      const { closed: _, ...rest } = c;
      this.convs.set(id, rest);
      this.save();
    }
    return true;
  }

  history(): HistoryItem[] {
    return historyList([...this.convs.values()]);
  }

  remove(id: string): boolean {
    if (!this.convs.delete(id)) return true;
    return this.save();
  }

  /** Açık sekmesi olmayan konuşmaları kapalı işaretler (boşlar silinir); açılışta. Sekmesi olanlar açık sayılır. */
  prune(keep: Iterable<string>): void {
    const k = new Set(keep);
    let changed = false;
    for (const c of [...this.convs.values()]) {
      if (k.has(c.id)) {
        if (c.closed) {
          this.convs.set(c.id, { ...c, closed: false });
          changed = true;
        }
      } else if (!c.closed) {
        const m = markClosed(c);
        if (m) this.convs.set(c.id, m);
        else this.convs.delete(c.id);
        changed = true;
      }
    }
    for (const x of pruneIds([...this.convs.values()])) changed = this.convs.delete(x) || changed;
    if (changed) this.save();
  }

  private save(): boolean {
    try {
      this.kv.setItem(this.key, JSON.stringify([...this.convs.values()]));
      return true;
    } catch {
      return false;
    }
  }
}

// ------------------------------------------------------------ Ekli belgeler

export interface DocContext {
  name: string;
  path: string;
  /** Belge yüklüyse şu anki sayfa ve toplam sayfa */
  page?: number;
  pages?: number;
  /** Şu anki sayfanın metni (yüklüyse) */
  text?: string;
  /** Sunumsa okunacak dönüştürülmüş PDF (sayfa = slayt) */
  pdf?: string;
}

/** Ekli PDF'lerin modele giden notu. agent: Claude Code CLI dosyaları kendisi okuyabilir (yalnızca yol yeter). */
export function docsContext(docs: DocContext[], agent: boolean, maxText = 6000): string {
  if (!docs.length) return "";
  const lines = ["", "", "# Ekli belgeler", agent
    ? "Öğrenci şu belgeleri bu soruya ekledi. Gerekirse kendin oku (Read, \"pages\" ile sayfa aralığı ver):"
    : "Öğrenci şu belgeleri bu soruya ekledi (her birinin açık olduğu sayfanın metni aşağıda):"];
  for (const d of docs) {
    const where = d.page ? `, açık sayfa ${d.page}${d.pages ? "/" + d.pages : ""}` : "";
    const loc = d.pdf ? ` (sunum; şu PDF olarak oku: ${d.pdf}; sayfa = slayt)` : ` (yol: ${d.path})`;
    lines.push(`- ${d.name}${where}${agent ? loc : ""}`);
  }
  if (!agent) {
    for (const d of docs) {
      const t = (d.text ?? "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      lines.push("", `## ${d.name} s.${d.page ?? "?"}`, t.length > maxText ? t.slice(0, maxText) + " …(kısaltıldı)" : t);
    }
  }
  lines.push("", "Kaynak gösterirken [dosya.pdf s.12] biçimini kullan (sunumda özgün ad: [sunum.pptx s.3]).");
  return lines.join("\n");
}
