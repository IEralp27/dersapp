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
/** En çok bu kadar konuşma saklanır (en eski güncellenen atılır) */
const MAX_CONVS = 60;

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
    if (this.convs.size > MAX_CONVS) {
      const oldest = [...this.convs.values()].sort((a, b) => a.updated - b.updated).slice(0, this.convs.size - MAX_CONVS);
      for (const c of oldest) if (c.id !== id) this.convs.delete(c.id);
    }
    return this.save();
  }

  remove(id: string): boolean {
    if (!this.convs.delete(id)) return true;
    return this.save();
  }

  /** Açık sekmesi olmayan konuşmaları siler (açılışta). */
  prune(keep: Iterable<string>): void {
    const k = new Set(keep);
    let changed = false;
    for (const id of [...this.convs.keys()]) if (!k.has(id)) changed = this.convs.delete(id) || changed;
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
}

/** Ekli PDF'lerin modele giden notu. agent: Claude Code CLI dosyaları kendisi okuyabilir (yalnızca yol yeter). */
export function docsContext(docs: DocContext[], agent: boolean, maxText = 6000): string {
  if (!docs.length) return "";
  const lines = ["", "", "# Ekli belgeler", agent
    ? "Öğrenci şu belgeleri bu soruya ekledi. Gerekirse kendin oku (Read, \"pages\" ile sayfa aralığı ver):"
    : "Öğrenci şu belgeleri bu soruya ekledi (her birinin açık olduğu sayfanın metni aşağıda):"];
  for (const d of docs) {
    const where = d.page ? `, açık sayfa ${d.page}${d.pages ? "/" + d.pages : ""}` : "";
    lines.push(`- ${d.name}${where}${agent ? ` (yol: ${d.path})` : ""}`);
  }
  if (!agent) {
    for (const d of docs) {
      const t = (d.text ?? "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      lines.push("", `## ${d.name} s.${d.page ?? "?"}`, t.length > maxText ? t.slice(0, maxText) + " …(kısaltıldı)" : t);
    }
  }
  lines.push("", "Kaynak gösterirken [dosya.pdf s.12] biçimini kullan.");
  return lines.join("\n");
}
