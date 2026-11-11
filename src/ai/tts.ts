// Yapay zeka yanıtlarını sesli okuma: seçilebilir seslendirme motorları, cümle kuyruğu, okunan cümleyi
// vurgulama, yanıt başına denetimler ve panel altındaki oynatıcı çubuğu.
//
// Metin -> konuşma dönüşümü tts-text.ts'te. Oynatıcı yalnızca "Speaker" arayüzünü (tts-engine.ts) kullanır.
//
// YENİ MOTOR EKLEMEK
//  1. Yeni bir dosya aç: src/ai/tts-<ad>.ts ve içinde registerEngine({ id, name, description, fields,
//     available, create }) çağır (tts-engine.ts'teki TtsEngine arayüzü; örnek: tts-cloud.ts).
//  2. "Metni ver, ses baytı al" türü bir motorsa (bulut ya da Rust/Tauri komutu) Speaker'ı kendin yazma:
//     tts-audio.ts'teki ClipProvider'ı (key + fetch -> {bytes, mime}) yaz ve `new BytesSpeaker(id, () => provider)`
//     döndür; önbellek, önceden isteme, iptal, duraklat/devam ve hız hazır gelir.
//  3. Aşağıdaki import satırlarının yanına `import "./tts-<ad>";` ekle. Ayarlar ekranı, seçim ve hata durumunda
//     sistem sesine düşme otomatik çalışır.
import "./tts.css";
import { OBJ, guessLang, toSpeech } from "./tts-text";
import type { Lang, Segment } from "./tts-text";
import { getEngine, listEngines, registerEngine } from "./tts-engine";
import type { Avail, EngineConfig, SpeakEvents, SpeakOpts, Speaker, TtsEngine, VoiceInfo } from "./tts-engine";
import "./tts-cloud";

export type { Avail, EngineConfig, SpeakEvents, SpeakOpts, Speaker, TtsEngine, VoiceInfo };

// ================================================================ Sistem sesi motoru

/** Tarayıcının yerleşik seslendiricisi (Windows'ta WebView2 sistemdeki sesleri kullanır). */
class WebSpeechSpeaker implements Speaker {
  readonly kind = "web";
  private gen = 0;
  /** Chrome, referansı tutulmayan konuşmayı çöpe atıp "end" olayını hiç göndermeyebiliyor */
  current: SpeechSynthesisUtterance | null = null;
  private timer = 0;
  private ready = false;
  private list: VoiceInfo[] = [];
  private listeners: (() => void)[] = [];

  constructor() {
    if (!this.available()) return;
    const synth = window.speechSynthesis;
    const refresh = () => {
      let vs: SpeechSynthesisVoice[] = [];
      try {
        vs = synth.getVoices();
      } catch {
        vs = [];
      }
      if (!vs.length && !this.ready) return;
      this.ready = true;
      this.list = vs.map((v) => ({ id: v.voiceURI || v.name, name: v.name, lang: v.lang || "", local: v.localService, isDefault: v.default }));
      for (const l of this.listeners) l();
    };
    try {
      synth.addEventListener?.("voiceschanged", refresh);
    } catch {
      // eski motorlar
    }
    refresh();
    // Bazı motorlar voiceschanged göndermez: kısa süre yokla, sonra boş listeyi kabul et
    let tries = 0;
    const poll = window.setInterval(() => {
      tries++;
      refresh();
      if (this.list.length || tries > 12) {
        window.clearInterval(poll);
        if (!this.ready) {
          this.ready = true;
          for (const l of this.listeners) l();
        }
      }
    }, 250);
  }

  available(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window && !!window.speechSynthesis
      && typeof window.SpeechSynthesisUtterance === "function";
  }
  voices(): VoiceInfo[] {
    return this.list;
  }
  voicesReady(): boolean {
    return this.ready;
  }
  onVoicesChanged(cb: () => void): void {
    this.listeners.push(cb);
  }

  speak(text: string, opts: SpeakOpts, ev: SpeakEvents): void {
    const synth = window.speechSynthesis;
    const g = ++this.gen;
    window.clearInterval(this.timer);
    let busy = false;
    try {
      busy = synth.speaking || synth.pending;
      if (busy) synth.cancel();
    } catch {
      // yoksay
    }
    // cancel() hemen ardından gelen speak() bazı motorlarda yutuluyor: kısa bekle
    window.setTimeout(() => {
      if (g !== this.gen) return;
      let done = false, started = false, quietSince = 0, keep = 0;
      const t0 = performance.now();
      const finish = (fn: () => void) => {
        if (done || g !== this.gen) return;
        done = true;
        window.clearInterval(this.timer);
        this.current = null;
        fn();
      };
      const u = new SpeechSynthesisUtterance(text);
      const voice = opts.voiceId ? synth.getVoices().find((v) => (v.voiceURI || v.name) === opts.voiceId) : undefined;
      if (voice) u.voice = voice;
      u.lang = voice?.lang || opts.lang;
      u.rate = opts.rate;
      u.onstart = () => {
        if (g !== this.gen || started) return;
        started = true;
        ev.start();
      };
      u.onend = () => finish(() => ev.end());
      u.onerror = (e) => {
        const code = (e as SpeechSynthesisErrorEvent).error;
        // cancel() sonrası gelen "interrupted"/"canceled" bizim isteğimiz; gen zaten değişmiştir
        if (code === "interrupted" || code === "canceled") return finish(() => ev.end());
        finish(() => ev.error(code || "bilinmeyen hata"));
      };
      this.current = u;
      try {
        synth.speak(u);
      } catch (e) {
        finish(() => ev.error(e instanceof Error ? e.message : String(e)));
        return;
      }
      // Bekçi: olay gelmeden susan motorlar ve uzun metinde kendiliğinden duran seslendirme
      this.timer = window.setInterval(() => {
        if (done || g !== this.gen) return;
        const now = performance.now();
        let speaking = true;
        try {
          speaking = synth.speaking || synth.pending;
        } catch {
          speaking = false;
        }
        if (!speaking) {
          if (!quietSince) quietSince = now;
          // başladıysa ve sustuysa bitti say; hiç başlamadıysa daha uzun bekle
          if ((started && now - quietSince > 1200) || (!started && now - t0 > 5000)) {
            finish(() => (started ? ev.end() : ev.error("seslendirme başlamadı")));
          }
        } else {
          quietSince = 0;
          // Ağ sesleri (Chrome) ~15 sn sonra kendiliğinden durabiliyor: ara ara dürt
          if (voice && !voice.localService && started && ++keep % 25 === 0) {
            try {
              synth.pause();
              synth.resume();
            } catch {
              // yoksay
            }
          }
        }
      }, 400);
    }, busy ? 80 : 0);
  }

  stop(): void {
    this.gen++;
    window.clearInterval(this.timer);
    this.current = null;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // yoksay
    }
  }
}

// ================================================================ Ayarlar

interface TtsSettings {
  /** Seçili seslendirme motorunun kimliği */
  engine: string;
  /** Motor başına ayarlar (sistem sesinde voice: "" = otomatik, Türkçe ses varsa o) */
  cfg: Record<string, EngineConfig>;
  rate: number;
  auto: boolean;
}

const SYSTEM = "system";

const KEY = "dersapp.ai.tts";
const RATES = [0.75, 1, 1.25, 1.5];
const clampRate = (r: number) => Math.min(1.5, Math.max(0.75, Math.round((Number(r) || 1) * 20) / 20));

function loadSettings(): TtsSettings {
  const d: TtsSettings = { engine: SYSTEM, cfg: {}, rate: 1, auto: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      const cfg: Record<string, EngineConfig> = {};
      if (o.cfg && typeof o.cfg === "object") {
        for (const [id, c] of Object.entries(o.cfg as Record<string, unknown>)) {
          if (!c || typeof c !== "object") continue;
          cfg[id] = {};
          for (const [k, v] of Object.entries(c as Record<string, unknown>)) if (typeof v === "string") cfg[id][k] = v;
        }
      }
      // eski sürüm: ses seçimi en üst düzeyde saklanıyordu
      if (typeof o.voice === "string" && cfg[SYSTEM]?.voice === undefined) cfg[SYSTEM] = { ...cfg[SYSTEM], voice: o.voice };
      return { engine: typeof o.engine === "string" && o.engine ? o.engine : SYSTEM, cfg, rate: clampRate(o.rate), auto: o.auto === true };
    }
  } catch {
    // varsayılanlar
  }
  return d;
}

const cfgOf = (id: string): EngineConfig => (settings.cfg[id] ??= {});
const sysVoice = () => cfgOf(SYSTEM).voice ?? "";

// ================================================================ Durum

/** panel.ts'teki yanıt turu (yalnızca gereken alanlar) */
export interface TtsTurn {
  text: string;
  el: HTMLElement;
  body?: HTMLElement;
  /** "Sesi dene" örneği: panelde görünmez, bağlı olmasa da durdurulmaz */
  sample?: boolean;
}

interface Host {
  panel: HTMLElement;
  main: HTMLElement;
  compose: HTMLElement;
  toast(text: string, kind?: "error" | "info"): void;
}

type State = "idle" | "playing" | "paused";

let host: Host | null = null;
/** Sistem sesi (her zaman var; bulut motoru hata verirse buna düşülür) */
let system: Speaker | null = null;
/** Şu anki okumada kullanılan seslendirici */
let speaker: Speaker;
const speakers = new Map<string, Speaker>();
const avail = new Map<string, Avail>();
let settings: TtsSettings = loadSettings();
let state: State = "idle";
let turn: TtsTurn | null = null;
let segs: Segment[] = [];
let ranges: (Range | null)[] = [];
let idx = 0;
let lang: Lang = "tr";
let errors = 0;
let stale = false;
let warnedNoTr = false;
const controls = new WeakMap<HTMLElement, { play: HTMLButtonElement; stop: HTMLButtonElement }>();
/** Dış denetleyicinin (ders modu) okuma kancaları; yalnızca ttsPlay ile başlatılan okumada dolu */
let hooks: PlayHooks | null = null;
const turns = new WeakMap<HTMLElement, TtsTurn>();

let bar: HTMLElement;
let barPlay: HTMLButtonElement;
let barPos: HTMLElement;
let barRate: HTMLButtonElement;
let barNote: HTMLElement;
let pop: HTMLElement | null = null;

const ICONS = {
  speak: "M4 9h4l5-4v14l-5-4H4zM16.5 9.5a3.5 3.5 0 010 5M19 7a7 7 0 010 10",
  play: "M8 5.5l10 6.5-10 6.5z",
  pause: "M9 6v12M15 6v12",
  stop: "M7 7h10v10H7z",
  prev: "M7 6v12M17 6l-7 6 7 6z",
  next: "M17 6v12M7 6l7 6-7 6z",
  sliders: "M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4",
  close: "M6 6l12 12M18 6L6 18",
};

function svg(d: string): string {
  return `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
}

function btn(title: string, d: string, onClick: () => void, cls = "icon"): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = svg(d);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function setIcon(b: HTMLButtonElement, d: string, title: string): void {
  if (b.dataset.icon !== d) {
    b.innerHTML = svg(d);
    b.dataset.icon = d;
  }
  b.title = title;
  b.setAttribute("aria-label", title);
}

function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    host?.toast("Sesli okuma ayarları kalıcı olarak kaydedilemedi; yalnızca bu oturumda geçerli.");
  }
}

const rateLabel = (r: number) => String(r).replace(".", ",") + "×";

// ================================================================ Ses seçimi

function voiceRank(v: VoiceInfo): number {
  return (/natural|neural|online/i.test(v.name) ? 4 : 0) + (v.local ? 2 : 0) + (v.isDefault ? 1 : 0);
}

const sys = (): Speaker => (system ??= new WebSpeechSpeaker());

function bestVoice(l: Lang): VoiceInfo | null {
  const vs = sys().voices().filter((v) => v.lang.toLowerCase().startsWith(l));
  vs.sort((a, b) => voiceRank(b) - voiceRank(a));
  return vs[0] ?? null;
}

const hasTurkish = () => sys().voices().some((v) => v.lang.toLowerCase().startsWith("tr"));

function pickVoice(l: Lang): { id: string | null; lang: string } {
  const chosen = sysVoice() ? sys().voices().find((v) => v.id === sysVoice()) : undefined;
  if (chosen) return { id: chosen.id, lang: chosen.lang };
  const best = bestVoice(l);
  if (best) return { id: best.id, lang: best.lang };
  return { id: null, lang: l === "tr" ? "tr-TR" : "en-US" };
}

const noTurkish = () => sys().voicesReady() && !hasTurkish();

/** Birinci motor: tarayıcının/sistemin kendi sesi. Ücretsiz, çevrimdışı; davranışı eskisiyle aynı. */
registerEngine({
  id: SYSTEM,
  order: 0,
  name: "Sistem sesi (ücretsiz, çevrimdışı)",
  description: "Bilgisayarında yüklü sesleri kullanır; internet ve ücret gerekmez. Ses kalitesi bilgisayarındaki seslere bağlıdır.",
  fields: [{
    key: "voice", label: "Ses", kind: "select",
    options: () => {
      const best = bestVoice("tr");
      const vs = [...sys().voices()].sort((a, b) => {
        const ta = a.lang.toLowerCase().startsWith("tr") ? 0 : 1, tb = b.lang.toLowerCase().startsWith("tr") ? 0 : 1;
        return ta - tb || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
      });
      return [{ value: "", label: "Otomatik" + (best ? ` (${best.name})` : "") }, ...vs.map((v) => ({ value: v.id, label: `${v.name} · ${v.lang}` }))];
    },
  }],
  available: () => (sys().available() ? { ok: true } : {
    ok: false, reason: "Bu bilgisayarda sistem sesi desteklenmiyor. Başka bir seslendirici seç.",
  }),
  notes: () => (noTurkish() ? [{
    warn: true,
    text: "Bu bilgisayarda Türkçe ses yüklü değil, bu yüzden formüller ve Türkçe sözcükler yabancı aksanla okunur. "
      + "Windows Ayarları'nın dil (ya da konuşma) bölümünden Türkçe dil paketini konuşma özelliğiyle birlikte ekleyip uygulamayı "
      + "yeniden başlatırsan Türkçe ses burada görünür. O zamana kadar listedeki bir sesle okunur.",
  }] : []),
  create: () => sys(),
});

// ================================================================ Vurgulama

/** Yanıt gövdesinin görünen metni (boşluksuz); KaTeX formülleri tek ￼ sayılır. */
function flatten(root: HTMLElement): { chars: string; map: ({ n: Text; o: number } | { e: Element })[] } {
  let chars = "";
  const map: ({ n: Text; o: number } | { e: Element })[] = [];
  const walk = (node: Node) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        const s = (c as Text).data;
        for (let i = 0; i < s.length; i++) {
          if (/\s/.test(s[i])) continue;
          chars += s[i];
          map.push({ n: c as Text, o: i });
        }
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const e = c as Element;
        if (e.classList.contains("katex")) {
          chars += OBJ;
          map.push({ e });
        } else if (!e.classList.contains("ai-typing")) walk(e);
      }
    }
  };
  walk(root);
  return { chars, map };
}

function computeRanges(body: HTMLElement | undefined, list: Segment[]): (Range | null)[] {
  if (!body) return list.map(() => null);
  const { chars, map } = flatten(body);
  let cursor = 0;
  return list.map((s) => {
    const key = s.match;
    if (!key) return null;
    let at = chars.indexOf(key, cursor);
    let len = key.length;
    if (at < 0) {
      // biraz farklıysa (ör. HTML temizliği) ilk ~12 karakterle dene
      const head = key.slice(0, 12);
      at = head.length >= 4 ? chars.indexOf(head, cursor) : -1;
      len = Math.min(key.length, chars.length - at);
    }
    if (at < 0 || len <= 0) return null;
    // Aynı cümle birden çok parçaya bölündüyse imleç ilerlemesin
    cursor = at;
    const a = map[at], b = map[Math.min(at + len, map.length) - 1];
    try {
      const r = document.createRange();
      if ("n" in a) r.setStart(a.n, a.o);
      else r.setStartBefore(a.e);
      if ("n" in b) r.setEnd(b.n, b.o + 1);
      else r.setEndAfter(b.e);
      return r;
    } catch {
      return null;
    }
  });
}

const HL = "dersapp-tts";
interface HighlightRegistry { set(name: string, h: unknown): void; delete(name: string): void }
const highlights = (): HighlightRegistry | null => {
  const c = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return c?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === "function" ? c.highlights : null;
};

function clearHighlight(): void {
  highlights()?.delete(HL);
  host?.main.querySelectorAll(".tts-now").forEach((e) => e.classList.remove("tts-now"));
}

function highlight(i: number): void {
  clearHighlight();
  const r = ranges[i];
  if (!r || !host) return;
  const reg = highlights();
  if (reg) {
    const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    reg.set(HL, new H(r));
  } else {
    const n = r.startContainer;
    const e = (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement)?.closest("p,li,tr,h1,h2,h3,h4,pre,.ai-math-block");
    e?.classList.add("tts-now");
  }
  // görünür alana kaydır
  const m = host.main;
  const rr = r.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  if (rr.height && (rr.top < mr.top + 8 || rr.bottom > mr.bottom - 8)) {
    m.scrollTo({ top: m.scrollTop + rr.top - mr.top - m.clientHeight / 3, behavior: "smooth" });
  }
}

// ================================================================ Oynatıcı

/** Seçili motorun Speaker'ı; kullanılamıyorsa nedenini söyleyip sistem sesine düşer. Hiçbiri yoksa null. */
function resolveSpeaker(): Speaker | null {
  const e = getEngine(settings.engine) ?? getEngine(SYSTEM)!;
  let reason = "";
  if (e.id !== SYSTEM) {
    const a = e.available();
    if (a instanceof Promise || a.ok) {
      let sp = speakers.get(e.id);
      if (!sp) speakers.set(e.id, (sp = e.create(() => cfgOf(e.id))));
      if (sp.available()) return sp;
      reason = "Bu cihazda desteklenmiyor.";
    } else reason = a.reason;
    if (sys().available()) {
      host?.toast(`${e.name} şu anda kullanılamıyor. ${reason} Bu okuma için sistem sesi kullanılıyor.`, "info");
      return sys();
    }
    host?.toast(`${e.name} şu anda kullanılamıyor. ${reason}`);
    return null;
  }
  if (sys().available()) return sys();
  host?.toast("Bu bilgisayarda sistem sesi desteklenmiyor. Sesli okuma ayarlarından başka bir seslendirici seç.");
  return null;
}

function play(t: TtsTurn, from = 0): void {
  if (!host) return;
  stop(true);
  const sp = resolveSpeaker();
  if (!sp) return;
  speaker = sp;
  stale = false;
  lang = guessLang(t.text);
  segs = toSpeech(t.text, lang);
  if (!segs.length) {
    host.toast("Bu yanıtta okunacak metin yok.", "info");
    return;
  }
  turn = t;
  ranges = computeRanges(t.body, segs);
  idx = Math.max(0, Math.min(from, segs.length - 1));
  errors = 0;
  state = "playing";
  if (lang === "tr" && speaker === system && noTurkish() && !sysVoice() && !warnedNoTr) {
    warnedNoTr = true;
    host.toast("Bilgisayarında Türkçe ses bulunamadı; yanıt mevcut bir sesle okunuyor. Ayrıntı için oynatıcıdaki ayarlara bak.", "info");
  }
  speakCurrent();
  sync();
}

function speakCurrent(): void {
  const s = segs[idx];
  if (!s) return finish();
  highlight(idx);
  hooks?.onSegment?.(idx, s);
  const v = speaker === system ? pickVoice(lang) : { id: null, lang: lang === "tr" ? "tr-TR" : "en-US" };
  const mine = turn;
  const sp = speaker;
  const opts = { voiceId: v.id, rate: settings.rate, lang: v.lang };
  sp.speak(s.text, opts, {
    start: () => {},
    end: () => {
      if (turn !== mine || state !== "playing") return;
      errors = 0;
      idx++;
      if (idx >= segs.length) finish();
      else {
        speakCurrent();
        sync();
      }
    },
    error: (msg) => {
      if (turn !== mine || speaker !== sp) return;
      if (state === "paused") {
        stale = true; // duraklatılmışken hata geldi: devam edince cümle yeniden denenir
        return;
      }
      if (state !== "playing") return;
      if (sp !== system) {
        // Seçili motor çalışırken hata verdi: nedenini söyle, bu okuma için sistem sesine düş
        sp.stop();
        const e = getEngine(settings.engine);
        if (sys().available()) {
          host?.toast(`${e?.name ?? "Seslendirici"} hata verdi: ${msg} Bu okuma için sistem sesi kullanılıyor.`);
          speaker = sys();
          speakCurrent();
          sync();
        } else {
          host?.toast(`${e?.name ?? "Seslendirici"} hata verdi: ${msg}`);
          stop();
        }
        return;
      }
      if (++errors >= 3) {
        host?.toast("Sesli okuma durdu: seslendirici yanıt vermiyor (" + msg + "). Başka bir ses seçmeyi dene.");
        stop();
        return;
      }
      idx++;
      if (idx >= segs.length) finish();
      else {
        speakCurrent();
        sync();
      }
    },
  });
  // Sıradaki 1-2 cümleyi önceden hazırla (ağ motorlarında cümle arası boşluk olmasın)
  sp.prefetch?.(segs.slice(idx + 1, idx + 3).map((x) => x.text), opts);
}

function finish(): void {
  const h = hooks;
  hooks = null;
  stop();
  h?.onEnd?.();
}

/** Durdurur; okunan yanıt bırakılır. */
export function stop(quiet = false): void {
  const h = hooks;
  hooks = null;
  if (h && state !== "idle") h.onStop?.();
  if (state !== "idle") speaker?.stop();
  state = "idle";
  const old = turn;
  turn = null;
  segs = [];
  ranges = [];
  clearHighlight();
  if (!quiet || old) sync(old);
}

function pause(): void {
  if (state !== "playing") return;
  // Gerçek pause/resume motorlar arasında tutarsız: yoksa cümleyi kesip yeniden başlatmak her yerde çalışır
  if (!speaker.pause?.()) speaker.stop();
  state = "paused";
  sync();
}

function resume(): void {
  if (state !== "paused") return;
  state = "playing";
  if (stale || !speaker.resume?.()) {
    stale = false;
    speakCurrent();
  }
  sync();
}

function jump(d: number): void {
  if (state === "idle") return;
  idx = Math.max(0, Math.min(segs.length - 1, idx + d));
  if (state === "playing") speakCurrent();
  else {
    speaker.stop(); // duraklatılmış sesi bırak; devam edince yeni cümle baştan okunur
    stale = true;
    highlight(idx);
  }
  sync();
}

function setRate(r: number): void {
  settings.rate = clampRate(r);
  saveSettings();
  const live = state !== "idle" && speaker.setRate?.(settings.rate);
  if (state === "playing" && !live) speakCurrent(); // anında hız değiştiremeyen motor: cümleyi yeniden başlat
  sync();
}

function toggleTurn(t: TtsTurn): void {
  if (turn === t && state === "playing") pause();
  else if (turn === t && state === "paused") resume();
  else play(t);
}

// ================================================================ Arayüz

function sync(old: TtsTurn | null = null): void {
  if (!host) return;
  for (const t of [old, turn]) {
    if (!t) continue;
    const c = controls.get(t.el);
    if (!c) continue;
    const active = turn === t && state !== "idle";
    const playing = active && state === "playing";
    setIcon(c.play, playing ? ICONS.pause : ICONS.speak, playing ? "Sesli okumayı duraklat (Alt+S durdurur)" : active ? "Okumaya devam et" : "Sesli oku (Alt+S)");
    c.play.classList.toggle("tts-on", active);
    c.stop.hidden = !active;
    t.el.classList.toggle("tts-active", active);
  }
  bar.hidden = state === "idle";
  if (state === "idle") {
    closePop();
    return;
  }
  setIcon(barPlay, state === "playing" ? ICONS.pause : ICONS.play, state === "playing" ? "Duraklat" : "Devam et");
  barPos.textContent = `${idx + 1}/${segs.length}`;
  barRate.textContent = rateLabel(settings.rate);
  barNote.hidden = !(lang === "tr" && speaker === system && noTurkish() && !sysVoice());
  if (pop) fillPop();
}

function buildBar(): HTMLElement {
  bar = document.createElement("div");
  bar.className = "tts-bar";
  bar.hidden = true;
  const row = document.createElement("div");
  row.className = "tts-row";
  barPlay = btn("Duraklat", ICONS.pause, () => (state === "playing" ? pause() : resume()));
  barPos = document.createElement("span");
  barPos.className = "tts-pos";
  barPos.title = "Okunan cümle";
  barRate = document.createElement("button");
  barRate.type = "button";
  barRate.className = "tts-rate";
  barRate.title = "Okuma hızı (tıkla: değiştir)";
  barRate.addEventListener("click", () => {
    const i = RATES.findIndex((r) => r >= settings.rate - 0.01);
    setRate(RATES[(i + 1) % RATES.length] ?? 1);
  });
  const label = document.createElement("span");
  label.className = "tts-label";
  label.textContent = "Sesli okuma";
  row.append(
    btn("Önceki cümle", ICONS.prev, () => jump(-1)),
    barPlay,
    btn("Sonraki cümle", ICONS.next, () => jump(1)),
    btn("Durdur", ICONS.stop, () => stop()),
    label,
    barPos,
    barRate,
    btn("Ses ayarları", ICONS.sliders, () => togglePop()),
  );
  barNote = document.createElement("div");
  barNote.className = "tts-note";
  barNote.hidden = true;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "tts-link";
  more.textContent = "Nasıl eklenir?";
  more.addEventListener("click", () => togglePop(true));
  barNote.append("Türkçe ses yok; varsayılan sesle okunuyor. ", more);
  bar.append(row, barNote);
  return bar;
}

function closePop(): void {
  pop?.remove();
  pop = null;
}

function togglePop(force?: boolean): void {
  if (!host) return;
  if (pop && !force) return closePop();
  if (!pop) {
    pop = document.createElement("div");
    pop.className = "tts-pop";
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePop();
      }
    });
    host.panel.append(pop);
  }
  refreshAvail();
  fillPop(true);
}

const SAMPLE = "Merhaba, ben DersApp. Örnek bir kesir: $\\frac{1}{2}$, yani yarım. Sesim sana böyle duyuluyor.";

/** Seçili motorla kısa bir örnek okur (oynatıcı çubuğu da görünür; Durdur ile kesilir). */
function speakSample(): void {
  if (!host) return;
  play({ text: SAMPLE, el: document.createElement("div"), sample: true });
}

function availOf(e: TtsEngine): Avail {
  const a = e.available();
  if (a instanceof Promise) return avail.get(e.id) ?? { ok: true };
  return a;
}

/** Eşzamansız kullanılabilirlik denetimi yapan motorlar için sonucu tazeler */
function refreshAvail(): void {
  for (const e of listEngines()) {
    const a = e.available();
    if (a instanceof Promise) {
      a.then((r) => {
        avail.set(e.id, r);
        if (pop) fillPop();
      }, () => avail.set(e.id, { ok: false, reason: "Kullanılabilirlik denetlenemedi." }));
    }
  }
}

function fillPop(force = false): void {
  if (!pop || !host) return;
  const focused = document.activeElement;
  // Yazarken (okuma ilerleyip arayüz tazelenirken) imleç kaybolmasın
  if (!force && focused && pop.contains(focused) && focused instanceof HTMLInputElement && focused.type === "text") return;
  const hadFocus = focused && pop.contains(focused) ? (focused as HTMLElement).dataset.k : "";
  const top = pop.scrollTop;
  pop.replaceChildren();
  const head = document.createElement("div");
  head.className = "tts-pop-head";
  const h = document.createElement("b");
  h.textContent = "Sesli okuma";
  head.append(h, btn("Kapat", ICONS.close, closePop));
  pop.append(head);

  // ---- Seslendirici seçimi
  const engines = listEngines();
  // Seçili motor kullanılamıyorsa (ör. sağlayıcı Anthropic'e çevrildi) sistem sesi gösterilir; kayıtlı seçim bozulmaz,
  // sağlayıcı düzelince motor yeniden seçili görünür.
  const chosen = getEngine(settings.engine);
  const cur = chosen && availOf(chosen).ok ? chosen : getEngine(SYSTEM)!;
  const group = document.createElement("div");
  group.className = "tts-engines";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Seslendirici");
  for (const e of engines) {
    const a = availOf(e);
    const row = document.createElement("label");
    row.className = "tts-eng" + (a.ok ? "" : " tts-off");
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "tts-engine";
    r.value = e.id;
    r.dataset.k = "engine-" + e.id;
    r.checked = e.id === cur.id;
    r.disabled = !a.ok; // kullanılamayan seçilemez
    r.addEventListener("change", () => {
      if (!r.checked) return;
      settings.engine = e.id;
      saveSettings();
      if (state !== "idle") stop();
      fillPop(true);
    });
    const text = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = e.name;
    const desc = document.createElement("small");
    desc.textContent = e.description;
    text.append(name, desc);
    if (!a.ok) {
      const why = document.createElement("small");
      why.className = "tts-why";
      why.textContent = "Kullanılamıyor: " + a.reason;
      text.append(why);
    }
    row.append(r, text);
    group.append(row);
  }
  const gl = document.createElement("span");
  gl.className = "tts-sec";
  gl.textContent = "Seslendirici";
  pop.append(gl, group);

  // ---- Seçili motorun kendi alanları
  const cfg = cfgOf(cur.id);
  const field = (label: string, ...ctl: HTMLElement[]) => {
    const l = document.createElement("label");
    l.className = "tts-field";
    const s = document.createElement("span");
    s.textContent = label;
    const r = document.createElement("div");
    r.className = "tts-ctl";
    r.append(...ctl);
    l.append(s, r);
    return l;
  };
  for (const f of cur.fields) {
    let ctl: HTMLElement;
    if (f.kind === "select") {
      const sel = document.createElement("select");
      sel.dataset.k = "f-" + f.key;
      const opts = f.options?.() ?? [];
      for (const o of opts) {
        const op = document.createElement("option");
        op.value = o.value;
        op.textContent = o.label;
        sel.append(op);
      }
      sel.value = opts.some((o) => o.value === (cfg[f.key] ?? "")) ? cfg[f.key] ?? "" : "";
      sel.addEventListener("change", () => {
        cfg[f.key] = sel.value;
        saveSettings();
        if (state === "playing" && speaker === (cur.id === SYSTEM ? system : speakers.get(cur.id))) speakCurrent();
        sync();
      });
      ctl = sel;
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.dataset.k = "f-" + f.key;
      inp.value = cfg[f.key] ?? "";
      inp.placeholder = f.placeholder?.() ?? "";
      inp.spellcheck = false;
      inp.autocomplete = "off";
      inp.addEventListener("input", () => {
        cfg[f.key] = inp.value;
        saveSettings();
      });
      ctl = inp;
    }
    const fl = field(f.label, ctl);
    if (f.hint) {
      const hint = document.createElement("small");
      hint.className = "tts-hint";
      hint.textContent = f.hint;
      fl.append(hint);
    }
    pop.append(fl);
  }

  // ---- Ortak: hız, otomatik okuma, deneme
  const rate = document.createElement("input");
  rate.type = "range";
  rate.dataset.k = "rate";
  rate.min = "0.75";
  rate.max = "1.5";
  rate.step = "0.05";
  rate.value = String(settings.rate);
  const rv = document.createElement("span");
  rv.className = "tts-rv";
  rv.textContent = rateLabel(settings.rate);
  rate.addEventListener("input", () => (rv.textContent = rateLabel(clampRate(+rate.value))));
  rate.addEventListener("change", () => setRate(+rate.value));

  const autoBox = document.createElement("input");
  autoBox.type = "checkbox";
  autoBox.dataset.k = "auto";
  autoBox.checked = settings.auto;
  autoBox.addEventListener("change", () => {
    settings.auto = autoBox.checked;
    saveSettings();
  });
  const autoLbl = document.createElement("label");
  autoLbl.className = "tts-check";
  autoLbl.append(autoBox, " Yanıt bitince otomatik oku");

  const test = document.createElement("button");
  test.type = "button";
  test.className = "tts-test";
  test.dataset.k = "test";
  test.textContent = "Sesi dene";
  const ca = availOf(cur);
  test.disabled = !ca.ok;
  test.title = ca.ok ? "Seçili seslendirici kısa bir örnek cümle okur" : "Bu seslendirici şu anda kullanılamıyor";
  test.addEventListener("click", speakSample);

  pop.append(field("Hız", rate, rv), autoLbl, test);

  for (const n of cur.notes?.() ?? []) {
    const p = document.createElement("p");
    p.className = "tts-help" + (n.warn ? "" : " dim");
    p.textContent = n.text;
    pop.append(p);
  }
  const k = document.createElement("p");
  k.className = "tts-help dim";
  k.textContent = "Kısayol: Alt+S son yanıtı okur ya da okumayı durdurur.";
  pop.append(k);
  const bottom = host.compose.offsetHeight + (bar.hidden ? 0 : bar.offsetHeight) + 6;
  pop.style.bottom = bottom + "px";
  // Küçük (cam) pencerede kutu panelin dışına taşmasın; içeriği kayar
  pop.style.maxHeight = Math.max(160, host.panel.clientHeight - bottom - 8) + "px";
  pop.scrollTop = top;
  if (hadFocus) (pop.querySelector(`[data-k="${hadFocus}"]`) as HTMLElement | null)?.focus();
}

function lastTurn(): TtsTurn | null {
  if (!host) return null;
  const els = [...host.main.querySelectorAll<HTMLElement>(".ai-turn.ai-assistant")].reverse();
  for (const e of els) {
    const t = turns.get(e);
    if (t) return t;
  }
  return null;
}

function onKey(e: KeyboardEvent): void {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.code !== "KeyS" && e.key.toLowerCase() !== "s") return;
  if (!host) return;
  e.preventDefault();
  e.stopPropagation();
  if (state !== "idle") return stop();
  if (host.panel.hidden) return host.toast("Sesli okuma için önce yapay zeka panelini aç (Ctrl+J).", "info");
  const t = lastTurn();
  if (!t) return host.toast("Okunacak bir yapay zeka yanıtı yok.", "info");
  play(t);
}

// ================================================================ Bağlama

/** Panel kurulunca bir kez çağrılır. */
export function initTts(h: Host, custom?: Speaker): void {
  if (custom) system = custom;
  speaker = sys();
  host = h;
  h.panel.insertBefore(buildBar(), h.compose);
  sys().onVoicesChanged(() => sync());
  window.addEventListener("keydown", onKey, true);
  // Okunan yanıt silinince, sekme/konuşma değişince ya da panel kapanınca dur
  new MutationObserver(() => {
    if (state === "idle" || !turn) return;
    if (h.panel.hidden || (!turn.sample && (!turn.el.isConnected || !h.main.contains(turn.el)))) stop();
  }).observe(h.panel, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("pagehide", () => stop());
}

/** Hiçbir motor kullanılamıyorsa (ör. sistem sesi yok, bulut ayarı yok) denetimler eklenmez; eskisi gibi. */
function anyUsable(): boolean {
  return listEngines().some((e) => {
    const a = e.available();
    return a instanceof Promise || a.ok;
  });
}

// ================================================================ Dış denetleyiciler (ders modu)

/** ttsPlay kancaları: okunan cümle değişince, okuma kendiliğinden bitince ve dışarıdan durdurulunca */
export interface PlayHooks {
  onSegment?(i: number, seg: Segment): void;
  onEnd?(): void;
  /** Kullanıcı ya da panel (kapanma, yanıt silinmesi) okumayı yarıda kesti */
  onStop?(): void;
}

/** Sesli okuma kullanılabilir mi (en az bir motor) */
export function ttsUsable(): boolean {
  return !!host && anyUsable();
}

/** Bir yanıtı kancalarla okur (from: başlanacak cümle). Okuma başlayamadıysa false. */
export function ttsPlay(t: TtsTurn, h: PlayHooks, from = 0): boolean {
  play(t, from);
  if (turn !== t || state === "idle") return false;
  hooks = h;
  h.onSegment?.(idx, segs[idx]);
  return true;
}

/** Okunan yanıt bu mu ve ne durumda */
export function ttsStateOf(t: TtsTurn): State | "other" {
  return turn === t ? state : state === "idle" ? "idle" : "other";
}

export function ttsPause(): void {
  pause();
}

export function ttsResume(): void {
  resume();
}

/** Tamamlanan her yanıtın araç çubuğuna oku/durdur düğmelerini ekler; açıksa otomatik okumayı başlatır. */
export function ttsAttach(tools: HTMLElement, t: TtsTurn, auto = true): void {
  if (!host || !t.text.trim() || !anyUsable()) return;
  const play_ = btn("Sesli oku (Alt+S)", ICONS.speak, () => toggleTurn(t));
  const stop_ = btn("Okumayı durdur", ICONS.stop, () => stop());
  stop_.hidden = true;
  const set = btn("Sesli okuma ayarları", ICONS.sliders, () => togglePop());
  set.classList.add("tts-set");
  tools.append(play_, stop_, set);
  controls.set(t.el, { play: play_, stop: stop_ });
  turns.set(t.el, t);
  // Durdurulmuş (yarım) yanıtlar otomatik okunmaz
  const stopped = !!t.el.querySelector(":scope > .ai-note");
  if (auto && settings.auto && !stopped && !host.panel.hidden && t.el.isConnected) play(t);
}
