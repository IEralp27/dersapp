// Yapay zeka yanıtlarını sesli okuma: seslendirici arayüzü, tarayıcı seslendiricisi (Web Speech),
// cümle kuyruğu, okunan cümleyi vurgulama, yanıt başına denetimler ve panel altındaki oynatıcı çubuğu.
//
// Metin -> konuşma dönüşümü tts-text.ts'te. Bulut seslendirme ileride "Speaker" arayüzünün başka bir
// uygulaması olarak eklenebilir; oynatıcı yalnızca bu arayüzü kullanır.
import "./tts.css";
import { OBJ, guessLang, toSpeech } from "./tts-text";
import type { Lang, Segment } from "./tts-text";

// ================================================================ Seslendirici arayüzü

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
}

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
  /** "" = otomatik (Türkçe ses varsa o) */
  voice: string;
  rate: number;
  auto: boolean;
}

const KEY = "dersapp.ai.tts";
const RATES = [0.75, 1, 1.25, 1.5];
const clampRate = (r: number) => Math.min(1.5, Math.max(0.75, Math.round((Number(r) || 1) * 20) / 20));

function loadSettings(): TtsSettings {
  const d: TtsSettings = { voice: "", rate: 1, auto: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return { voice: typeof o.voice === "string" ? o.voice : "", rate: clampRate(o.rate), auto: o.auto === true };
    }
  } catch {
    // varsayılanlar
  }
  return d;
}

// ================================================================ Durum

/** panel.ts'teki yanıt turu (yalnızca gereken alanlar) */
export interface TtsTurn {
  text: string;
  el: HTMLElement;
  body?: HTMLElement;
}

interface Host {
  panel: HTMLElement;
  main: HTMLElement;
  compose: HTMLElement;
  toast(text: string, kind?: "error" | "info"): void;
}

type State = "idle" | "playing" | "paused";

let host: Host | null = null;
let speaker: Speaker;
let settings: TtsSettings = loadSettings();
let state: State = "idle";
let turn: TtsTurn | null = null;
let segs: Segment[] = [];
let ranges: (Range | null)[] = [];
let idx = 0;
let lang: Lang = "tr";
let errors = 0;
let warnedNoTr = false;
const controls = new WeakMap<HTMLElement, { play: HTMLButtonElement; stop: HTMLButtonElement }>();
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

function bestVoice(l: Lang): VoiceInfo | null {
  const vs = speaker.voices().filter((v) => v.lang.toLowerCase().startsWith(l));
  vs.sort((a, b) => voiceRank(b) - voiceRank(a));
  return vs[0] ?? null;
}

const hasTurkish = () => speaker.voices().some((v) => v.lang.toLowerCase().startsWith("tr"));

function pickVoice(l: Lang): { id: string | null; lang: string } {
  const chosen = settings.voice ? speaker.voices().find((v) => v.id === settings.voice) : undefined;
  if (chosen) return { id: chosen.id, lang: chosen.lang };
  const best = bestVoice(l);
  if (best) return { id: best.id, lang: best.lang };
  return { id: null, lang: l === "tr" ? "tr-TR" : "en-US" };
}

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

function play(t: TtsTurn, from = 0): void {
  if (!host || !speaker.available()) return;
  stop(true);
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
  if (lang === "tr" && speaker.voicesReady() && !hasTurkish() && !settings.voice && !warnedNoTr) {
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
  const v = pickVoice(lang);
  const mine = turn;
  speaker.speak(s.text, { voiceId: v.id, rate: settings.rate, lang: v.lang }, {
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
      if (turn !== mine || state !== "playing") return;
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
}

function finish(): void {
  stop();
}

/** Durdurur; okunan yanıt bırakılır. */
export function stop(quiet = false): void {
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
  // Gerçek pause/resume motorlar arasında tutarsız: cümleyi kesip yeniden başlatmak her yerde çalışır
  speaker.stop();
  state = "paused";
  sync();
}

function resume(): void {
  if (state !== "paused") return;
  state = "playing";
  speakCurrent();
  sync();
}

function jump(d: number): void {
  if (state === "idle") return;
  idx = Math.max(0, Math.min(segs.length - 1, idx + d));
  if (state === "playing") speakCurrent();
  else highlight(idx);
  sync();
}

function setRate(r: number): void {
  settings.rate = clampRate(r);
  saveSettings();
  if (state === "playing") speakCurrent(); // yeni hız bir sonraki konuşmada geçerli: cümleyi yeniden başlat
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
  barNote.hidden = !(lang === "tr" && speaker.voicesReady() && !hasTurkish() && !settings.voice);
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
  fillPop();
}

function fillPop(): void {
  if (!pop || !host) return;
  const focused = document.activeElement;
  const hadFocus = focused && pop.contains(focused) ? (focused as HTMLElement).dataset.k : "";
  pop.replaceChildren();
  const head = document.createElement("div");
  head.className = "tts-pop-head";
  const h = document.createElement("b");
  h.textContent = "Sesli okuma";
  head.append(h, btn("Kapat", ICONS.close, closePop));

  const sel = document.createElement("select");
  sel.dataset.k = "voice";
  const auto = document.createElement("option");
  auto.value = "";
  const best = bestVoice("tr");
  auto.textContent = "Otomatik" + (best ? ` (${best.name})` : "");
  sel.append(auto);
  const vs = [...speaker.voices()].sort((a, b) => {
    const ta = a.lang.toLowerCase().startsWith("tr") ? 0 : 1, tb = b.lang.toLowerCase().startsWith("tr") ? 0 : 1;
    return ta - tb || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
  });
  for (const v of vs) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = `${v.name} · ${v.lang}`;
    sel.append(o);
  }
  sel.value = settings.voice && vs.some((v) => v.id === settings.voice) ? settings.voice : "";
  sel.addEventListener("change", () => {
    settings.voice = sel.value;
    saveSettings();
    if (state === "playing") speakCurrent();
    sync();
  });

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
  const autoLbl = document.createElement("label");
  autoLbl.className = "tts-check";
  autoLbl.append(autoBox, " Yanıt bitince otomatik oku");

  pop.append(head, field("Ses", sel), field("Hız", rate, rv), autoLbl);

  if (speaker.voicesReady() && !hasTurkish()) {
    const n = document.createElement("p");
    n.className = "tts-help";
    n.textContent = "Bu bilgisayarda Türkçe ses yüklü değil, bu yüzden formüller ve Türkçe sözcükler yabancı aksanla okunur. "
      + "Windows Ayarları'nın dil (ya da konuşma) bölümünden Türkçe dil paketini konuşma özelliğiyle birlikte ekleyip uygulamayı "
      + "yeniden başlatırsan Türkçe ses burada görünür. O zamana kadar listedeki bir sesle okunur.";
    pop.append(n);
  }
  const k = document.createElement("p");
  k.className = "tts-help dim";
  k.textContent = "Kısayol: Alt+S son yanıtı okur ya da okumayı durdurur.";
  pop.append(k);
  pop.style.bottom = host.compose.offsetHeight + (bar.hidden ? 0 : bar.offsetHeight) + 6 + "px";
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

/** Panel kurulunca bir kez çağrılır. Seslendirme desteklenmiyorsa hiçbir denetim eklenmez. */
export function initTts(h: Host, custom?: Speaker): void {
  speaker = custom ?? new WebSpeechSpeaker();
  if (!speaker.available()) return;
  host = h;
  h.panel.insertBefore(buildBar(), h.compose);
  speaker.onVoicesChanged(() => sync());
  window.addEventListener("keydown", onKey, true);
  // Okunan yanıt silinince, sekme/konuşma değişince ya da panel kapanınca dur
  new MutationObserver(() => {
    if (state === "idle" || !turn) return;
    if (h.panel.hidden || !turn.el.isConnected || !h.main.contains(turn.el)) stop();
  }).observe(h.panel, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("pagehide", () => stop());
}

/** Tamamlanan her yanıtın araç çubuğuna oku/durdur düğmelerini ekler; açıksa otomatik okumayı başlatır. */
export function ttsAttach(tools: HTMLElement, t: TtsTurn): void {
  if (!host || !speaker.available() || !t.text.trim()) return;
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
  if (settings.auto && !stopped && !host.panel.hidden && t.el.isConnected) play(t);
}
