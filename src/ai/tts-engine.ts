// Seslendirme motorlarının ortak arayüzü ve kayıt defteri. DOM'a bağımlı değildir (node ile sınanır).
// Yeni motor ekleme adımları tts.ts'in başındaki yorumda.

export interface VoiceInfo {
  id: string;
  name: string;
  lang: string;
  local: boolean;
  isDefault: boolean;
}

export interface SpeakOpts {
  voiceId: string | null;
  rate: number;
  lang: string;
}

export interface SpeakEvents {
  start(): void;
  end(): void;
  /** Kullanıcıya gösterilebilecek Türkçe, ne yapılacağını söyleyen bir mesaj */
  error(message: string): void;
}

/** Tek bir metin parçasını seslendiren motor. Olaylardan yalnızca biri (end ya da error) bir kez gelir. */
export interface Speaker {
  readonly kind: string;
  available(): boolean;
  voices(): VoiceInfo[];
  /** Ses listesi yüklendi mi (tarayıcılar listeyi geç verir) */
  voicesReady(): boolean;
  onVoicesChanged(cb: () => void): void;
  speak(text: string, opts: SpeakOpts, ev: SpeakEvents): void;
  stop(): void;
  /** İsteğe bağlı: sıradaki cümleleri önceden hazırla (ağ motorları için) */
  prefetch?(texts: string[], opts: SpeakOpts): void;
  /** İsteğe bağlı: çalan sesi cümleyi baştan başlatmadan duraklat/sürdür. Başarılıysa true döner. */
  pause?(): boolean;
  resume?(): boolean;
  /** İsteğe bağlı: çalan sesin hızını anında değiştir. Başarılıysa true döner. */
  setRate?(rate: number): boolean;
}

export type Avail = { ok: true } | { ok: false; reason: string };

/** Bir motorun ayar alanı (kendi ayarları, localStorage'da motor başına saklanır). */
export interface EngineField {
  key: string;
  label: string;
  kind: "text" | "select";
  /** Boş bırakılınca kullanılacak değer (sağlayıcıya göre değişebilir); alanda soluk gösterilir */
  placeholder?: () => string;
  hint?: string;
  /** kind "select" için seçenekler (boş değer = otomatik) */
  options?: () => { value: string; label: string }[];
}

export type EngineConfig = Record<string, string>;

export interface TtsEngine {
  id: string;
  /** Listedeki sıra (küçük olan önce; varsayılan 100). Sistem sesi 0'dır. */
  order?: number;
  /** Türkçe ad (ayarlarda seçenek başlığı) */
  name: string;
  /** Tek cümle: ücret/çevrimdışı bilgisi */
  description: string;
  fields: EngineField[];
  /** Kullanılabilir mi? Değilse nedenini söyler (Türkçe, ne yapılacağıyla birlikte). */
  available(): Avail | Promise<Avail>;
  /** Ayarlarda motorun altında gösterilecek dinamik notlar (ör. maliyet) */
  notes?(): { text: string; warn?: boolean }[];
  /** Seçili motor için Speaker üretir. getCfg her çağrıda güncel ayarı verir; Speaker bir kez üretilir. */
  create(getCfg: () => EngineConfig): Speaker;
}

const registry: TtsEngine[] = [];

/** Motoru kaydeder; aynı id ile ikinci kayıt öncekinin yerini alır. Listedeki sıra `order` alanına göre belirlenir. */
export function registerEngine(e: TtsEngine): void {
  const i = registry.findIndex((x) => x.id === e.id);
  if (i >= 0) registry[i] = e;
  else registry.push(e);
  registry.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function listEngines(): readonly TtsEngine[] {
  return registry;
}

export function getEngine(id: string): TtsEngine | undefined {
  return registry.find((e) => e.id === id);
}

/** Test için */
export function clearEngines(): void {
  registry.length = 0;
}
