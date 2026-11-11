// Hesap makinesi paneli: #stage üzerinde yüzen, sürüklenebilir küçük pencere.
// Varsayılan görünüm sade; "Gelişmiş" düğmesi karmaşık sayı / fonksiyon / önek / değişken sekmelerini açar.
import "./calc.css";
import {
  CalcError, type Complex, type FormatOptions, type Value, calc, formatBases, formatValue,
} from "./calc-engine";

const KEY = "dersapp.calc";
const VARS_KEY = "dersapp.calc.vars";
const HISTORY_MAX = 20;
const VARS_MAX = 60;

type Tab = "cx" | "fn" | "pre" | "var";

interface CalcState {
  open: boolean;
  degrees: boolean;
  history: boolean;
  x: number | null;
  y: number | null;
  adv: boolean;
  tab: Tab;
  polar: boolean;
  eng: boolean;
  bases: boolean;
  unit: "i" | "j";
}

interface HistoryItem {
  expr: string;
  value: Value;
  /** Atama yapıldıysa değişken adı */
  name?: string;
}

/** Tuş takımı: [etiket, eklenecek metin | özel komut, ek sınıf, ipucu]. Komutlar "@" ile başlar. */
type Key = [string, string, string?, string?];

const KEYS: Key[] = [
  ["sin", "sin(", "fn"], ["cos", "cos(", "fn"], ["tan", "tan(", "fn"], ["ln", "ln(", "fn"], ["log", "log(", "fn"],
  ["√", "√(", "fn"], ["xʸ", "^", "fn"], ["n!", "!", "fn"], ["π", "π", "fn"], ["e", "e", "fn"],
  ["(", "(", "fn"], [")", ")", "fn"], ["Ans", "ans", "fn"], ["C", "@clear", "danger"], ["⌫", "@back", "danger"],
  ["7", "7"], ["8", "8"], ["9", "9"], ["÷", "÷", "op"], ["x²", "^2", "fn"],
  ["4", "4"], ["5", "5"], ["6", "6"], ["×", "×", "op"], ["1/x", "^-1", "fn"],
  ["1", "1"], ["2", "2"], ["3", "3"], ["−", "−", "op"], ["+", "+", "op"],
  ["0", "0"], [",", ","], ["%", "%", "fn"], ["=", "@eval", "eq"],
];

const ADV_KEYS: Record<Exclude<Tab, "var">, Key[]> = {
  cx: [
    ["j", "j", "op", "Sanal birim (i de olur): 3+4j"], ["∠", "∠", "op", "Kutupsal giriş: 5∠30 (klavyede 5<30)"],
    ["°", "°", "fn", "Derece işareti: 30° her kipte derecedir"], ["||", "||", "op", "Paralel bağlama: R1 || R2"],
    [";", ";", "op", "Argüman ayırıcı"],
    ["par", "par(", "fn", "par(a; b; …): paralel direnç/empedans"], ["abs", "abs(", "fn", "Büyüklük |z|"],
    ["arg", "arg(", "fn", "Açı (DEG/RAD kipine göre)"], ["conj", "conj(", "fn", "Eşlenik"], ["polar", "polar(", "fn", "polar(r; açı)"],
    ["re", "re(", "fn", "Gerçek kısım"], ["im", "im(", "fn", "Sanal kısım"], ["exp", "exp(", "fn", "e üssü"],
    ["roots", "roots(", "fn", "roots(a; b; c; …): polinom kökleri, en yüksek dereceden"], ["x", "x", "fn", "Serbest değişken"],
  ],
  fn: [
    [";", ";", "op", "Argüman ayırıcı"], ["nCr", "nCr(", "fn", "Kombinasyon nCr(n; r)"], ["nPr", "nPr(", "fn", "Permütasyon nPr(n; r)"],
    ["mod", "mod(", "fn", "mod(a; b): kalan"], ["obeb", "obeb(", "fn", "obeb(a; b; …) = gcd"],
    ["okek", "okek(", "fn", "okek(a; b; …) = lcm"], ["min", "min(", "fn"], ["max", "max(", "fn"],
    ["logₐ", "log(", "fn", "log(x; taban)"], ["ⁿ√", "root(", "fn", "root(x; n): n. dereceden kök"],
    ["asin", "asin(", "fn"], ["acos", "acos(", "fn"], ["atan", "atan(", "fn"], ["atan2", "atan2(", "fn", "atan2(y; x)"],
    ["hypot", "hypot(", "fn", "hypot(a; b; …) = √(a²+b²+…)"],
    ["sinh", "sinh(", "fn"], ["cosh", "cosh(", "fn"], ["tanh", "tanh(", "fn"], ["→deg", "deg(", "fn", "Radyanı dereceye çevir"],
    ["→rad", "rad(", "fn", "Dereceyi radyana çevir"],
    ["d/dx", "deriv(", "fn", "deriv(ifade; x; nokta): sayısal türev"], ["∫", "integ(", "fn", "integ(ifade; x; a; b): sayısal integral"],
    ["x", "x", "fn", "Serbest değişken"], ["|x|", "abs(", "fn"], ["round", "round(", "fn"],
  ],
  pre: [
    ["T", "T", "fn", "tera 10¹²"], ["G", "G", "fn", "giga 10⁹"], ["M", "M", "fn", "mega 10⁶ (büyük M)"],
    ["k", "k", "fn", "kilo 10³"], ["m", "m", "fn", "mili 10⁻³ (küçük m)"],
    ["µ", "µ", "fn", "mikro 10⁻⁶ (u da olur)"], ["n", "n", "fn", "nano 10⁻⁹"], ["p", "p", "fn", "piko 10⁻¹²"],
    ["f", "f", "fn", "femto 10⁻¹⁵"], ["E", "e", "fn", "Bilimsel gösterim: 1.5e3"],
    ["0x", "0x", "op", "Onaltılık: 0xFF"], ["0b", "0b", "op", "İkilik: 0b1010"], ["0o", "0o", "op", "Sekizlik: 0o17"],
    ["=", "=", "op", "Atama: R1 = 4.7k"], ["ans", "ans", "fn", "Son sonuç"],
  ],
};

/** Sonuçla devam etmek için önüne "ans" konması gereken eklemeler (operatör gibi olanlar) */
const CONTINUES = new Set(["÷", "×", "−", "+", "^", "^2", "^-1", "!", "%", "||", "∠", "°"]);

const ICON = {
  place: "M4 20h4l10-10-4-4L4 16v4zM13 7l4 4M15 19h6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  value: "M5 12h14M12 5v14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
};

function load(): CalcState {
  const def: CalcState = {
    open: false, degrees: true, history: false, x: null, y: null,
    adv: false, tab: "cx", polar: false, eng: false, bases: false, unit: "i",
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        open: s.open === true,
        degrees: s.degrees !== false,
        history: s.history === true,
        x: typeof s.x === "number" ? s.x : null,
        y: typeof s.y === "number" ? s.y : null,
        adv: s.adv === true,
        tab: ["cx", "fn", "pre", "var"].includes(s.tab) ? s.tab : "cx",
        polar: s.polar === true,
        eng: s.eng === true,
        bases: s.bases === true,
        unit: s.unit === "j" ? "j" : "i",
      };
    }
  } catch {
    // bozuk kayıt ya da erişim yok: varsayılanlarla devam
  }
  return def;
}

function loadVars(): Record<string, Complex> {
  const out: Record<string, Complex> = {};
  try {
    const raw = localStorage.getItem(VARS_KEY);
    if (!raw) return out;
    const s = JSON.parse(raw);
    for (const [k, v] of Object.entries(s)) {
      if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") out[k] = { re: v[0], im: v[1] };
    }
  } catch {
    // bozuk kayıt: boş liste
  }
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function icon(d: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  s.append(p);
  return s;
}

function iconBtn(cls: string, d: string, title: string): HTMLButtonElement {
  const b = el("button", "calc-ibtn " + cls);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(icon(d));
  return b;
}

/** main.ts'teki toast ile aynı görünüm (#toasts kabı). */
function toast(text: string, kind: "error" | "info" = "error"): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const t = el("div", "toast " + kind, text);
  host.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 6000 : 3000);
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n: number) => String(n).replace(/\d/g, (d) => SUB[Number(d)]);

export function initCalculator(): { toggle(): void } {
  const stage = document.getElementById("stage")!;
  const state = load();
  const vars = loadVars();
  let ans: Complex = { re: 0, im: 0 };
  let fresh = false; // son işlem "=" ile bitti: sıradaki tuş yeni ifade başlatır ya da sonuçla devam eder
  let last: HistoryItem | null = null; // gösterilen son sonuç
  const history: HistoryItem[] = [];

  function save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // kayıt yazılamadı (dolu ya da kapalı depolama); panel yine çalışır
    }
  }
  function saveVars(): void {
    try {
      const o: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(vars)) o[k] = [v.re, v.im];
      localStorage.setItem(VARS_KEY, JSON.stringify(o));
    } catch {
      toast("Değişkenler kaydedilemedi (depolama dolu ya da kapalı)");
    }
  }

  const fmtOpts = (): FormatOptions => ({ polar: state.polar, eng: state.eng, degrees: state.degrees, unit: state.unit });
  const fmt = (v: Value) => formatValue(v, fmtOpts());

  // ---------------------------------------------------------- Yapı
  const panel = el("div", "calc");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Hesap makinesi");

  const head = el("div", "calc-head");
  const title = el("span", "calc-title", "Hesap makinesi");
  const degBtn = el("button", "calc-mode");
  const histBtn = el("button", "calc-hist-btn", "Geçmiş");
  histBtn.title = "Geçmişi göster/gizle";
  const advBtn = el("button", "calc-adv-btn", "Gelişmiş");
  advBtn.title = "Karmaşık sayılar, fonksiyonlar, önekler, değişkenler";
  const closeBtn = el("button", "calc-close", "×");
  closeBtn.title = "Kapat (Esc)";
  closeBtn.setAttribute("aria-label", "Hesap makinesini kapat");
  head.append(title, degBtn, histBtn, advBtn, closeBtn);

  const body = el("div", "calc-body");
  const input = el("input", "calc-input");
  input.type = "text";
  input.placeholder = "İfade yaz, Enter ile hesapla";
  input.setAttribute("aria-label", "İfade");
  input.autocomplete = "off";
  input.spellcheck = false;

  const resultRow = el("div", "calc-result");
  const out = el("div", "calc-out");
  out.setAttribute("aria-live", "polite");
  const actions = el("div", "calc-actions");
  const polarBtn = el("button", "calc-chip calc-polar-btn");
  polarBtn.type = "button";
  const placeBtn = iconBtn("calc-place", ICON.place, "PDF'e taşı: ifade = sonuç (Shift+tık: yalnızca sonuç)");
  const placeValBtn = iconBtn("calc-place-val", ICON.value, "Yalnızca sonucu PDF'e taşı");
  const copyBtn = iconBtn("calc-copy", ICON.copy, "Sonucu panoya kopyala");
  actions.append(polarBtn, el("span", "calc-spacer"), placeBtn, placeValBtn, copyBtn);
  const basesLine = el("div", "calc-bases");
  resultRow.append(out, basesLine, actions);

  const histBox = el("ul", "calc-history");

  // Gelişmiş bölüm
  const adv = el("div", "calc-adv");
  const opts = el("div", "calc-opts");
  const mkToggle = (label: string, tip: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = el("button", "calc-chip", label);
    b.type = "button";
    b.title = tip;
    b.addEventListener("click", () => {
      set(!get());
      save();
      renderMode();
      refreshOutputs();
    });
    return { b, sync: () => b.classList.toggle("on", get()) };
  };
  const toggles = [
    mkToggle("Kutupsal", "Karmaşık sonucu kutupsal göster (5∠53.13°)", () => state.polar, (v) => (state.polar = v)),
    mkToggle("Müh.", "Mühendislik gösterimi: 4.7k, 22µ (üsler 3'ün katı)", () => state.eng, (v) => (state.eng = v)),
    mkToggle("HEX/BIN", "Tam sayı sonucun onaltılık ve ikilik karşılığını göster", () => state.bases, (v) => (state.bases = v)),
    mkToggle("j", "Sanal birimi j olarak göster (kapalıyken i)", () => state.unit === "j", (v) => (state.unit = v ? "j" : "i")),
  ];
  opts.append(...toggles.map((t) => t.b));

  const tabs = el("div", "calc-tabs");
  tabs.setAttribute("role", "tablist");
  const TAB_LABELS: [Tab, string][] = [["cx", "Karmaşık"], ["fn", "Fonksiyon"], ["pre", "Önek/Taban"], ["var", "Değişken"]];
  const tabBtns = new Map<Tab, HTMLButtonElement>();
  for (const [t, label] of TAB_LABELS) {
    const b = el("button", "calc-tab", label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => {
      state.tab = t;
      save();
      renderMode();
    });
    tabBtns.set(t, b);
    tabs.append(b);
  }
  const advPads = new Map<Tab, HTMLElement>();
  for (const t of ["cx", "fn", "pre"] as const) {
    const p = el("div", "calc-pad calc-adv-pad");
    for (const k of ADV_KEYS[t]) p.append(keyButton(k));
    p.addEventListener("mousedown", (e) => e.preventDefault());
    advPads.set(t, p);
  }
  const varBox = el("div", "calc-vars");
  advPads.set("var", varBox);
  adv.append(opts, tabs, ...advPads.values());

  const pad = el("div", "calc-pad");
  body.append(input, resultRow, histBox, adv, pad);
  panel.append(head, body);
  stage.append(panel);

  function keyButton([label, action, cls, tip]: Key): HTMLButtonElement {
    const b = el("button", "calc-key" + (cls ? " " + cls : ""), label);
    b.type = "button";
    if (tip) b.title = tip;
    if (action === "@eval") b.classList.add("wide");
    b.addEventListener("click", () => press(action));
    return b;
  }
  for (const k of KEYS) pad.append(keyButton(k));
  // Tuşa basınca ifade kutusunun odağı/imleci kaybolmasın
  pad.addEventListener("mousedown", (e) => e.preventDefault());

  // ---------------------------------------------------------- Mantık
  const ctx = () => ({ degrees: state.degrees, ans, vars });

  function setOut(kind: "" | "preview" | "error" | "final"): void {
    out.className = "calc-out" + (kind ? " " + kind : "");
    actions.hidden = kind !== "final";
    if (kind !== "final") basesLine.hidden = true;
  }

  /** Değeri sonuç alanına yazar (listeler satır satır: x₁ = …). */
  function renderValue(v: Value, prefix = ""): void {
    out.replaceChildren();
    if (Array.isArray(v)) {
      v.forEach((z, k) => {
        const row = el("div", "calc-root");
        row.append(el("span", "calc-root-n", `x${subscript(k + 1)} = `), document.createTextNode(fmt(z)));
        out.append(row);
      });
    } else {
      out.textContent = prefix + fmt(v);
    }
    out.classList.toggle("long", out.textContent!.length > 18);
  }

  function renderFinal(): void {
    if (!last) return;
    renderValue(last.value, last.name ? `${last.name} = ` : "");
    setOut("final");
    const isCx = !Array.isArray(last.value) ? last.value.im !== 0 : last.value.some((z) => z.im !== 0);
    polarBtn.hidden = !isCx;
    polarBtn.textContent = state.polar ? "a+bi" : "r∠θ";
    polarBtn.title = state.polar ? "Dikdörtgen gösterime geç" : "Kutupsal gösterime geç";
    const b = state.bases ? formatBases(last.value) : null;
    basesLine.hidden = !b;
    if (b) {
      basesLine.replaceChildren(el("span", "", `HEX ${b.hex}`), el("span", "", `BIN ${b.bin}`));
    }
  }

  function showError(e: unknown, text: string): void {
    out.replaceChildren();
    if (e instanceof CalcError) {
      out.append(el("div", "", e.message));
      if (e.pos !== undefined && text) {
        // Hatanın yeri: ifadede işaretli parça
        const p = Math.min(e.pos, text.length);
        const end = Math.max(p + 1, Math.min(e.end ?? p + 1, text.length + 1));
        const where = el("div", "calc-err-where");
        const mark = el("mark", "", text.slice(p, end) || " ");
        where.append(document.createTextNode(text.slice(0, p)), mark, document.createTextNode(text.slice(end)));
        where.title = `Konum ${p + 1}`;
        out.append(where);
        // Girişte de seç: kullanıcı doğrudan düzeltebilsin (baştaki boşluklar kırpıldığı için kaydır)
        const off = input.value.indexOf(text);
        if (off >= 0) input.setSelectionRange(off + p, off + Math.min(end, text.length));
      }
    } else out.textContent = "Hesaplanamadı";
    setOut("error");
  }

  function preview(): void {
    fresh = false;
    last = null;
    const text = input.value.trim();
    if (!text) {
      out.replaceChildren();
      return setOut("");
    }
    try {
      // Yazarken yalnızca geçerli ifadelerin önizlemesi gösterilir; atama önizlemede yapılmaz
      const r = calc(text, ctx());
      renderValue(r.value, r.assigned ? `${r.assigned} = ` : "= ");
      setOut("preview");
    } catch {
      out.replaceChildren();
      setOut("");
    }
  }

  function calculate(): void {
    const text = input.value.trim();
    try {
      const r = calc(text, ctx());
      if (r.assigned && !Array.isArray(r.value)) {
        if (!(r.assigned in vars) && Object.keys(vars).length >= VARS_MAX) {
          throw new CalcError(`En fazla ${VARS_MAX} değişken; Değişken sekmesinden silin`);
        }
        vars[r.assigned] = r.value;
        saveVars();
        renderVars();
      }
      if (!Array.isArray(r.value)) ans = r.value;
      last = { expr: text, value: r.value, name: r.assigned };
      renderFinal();
      history.unshift(last);
      if (history.length > HISTORY_MAX) history.pop();
      renderHistory();
      fresh = true;
    } catch (e) {
      last = null;
      showError(e, text);
      fresh = false;
    }
  }

  function insert(text: string): void {
    if (fresh) {
      // "=" sonrası: operatör sonuçla devam eder, diğer tuşlar yeni ifade başlatır
      input.value = CONTINUES.has(text) ? "ans" : "";
      fresh = false;
    }
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? a;
    input.setRangeText(text, a, b, "end");
    input.focus();
    preview();
  }

  function press(action: string): void {
    if (action === "@clear") {
      input.value = "";
      out.replaceChildren();
      setOut("");
      last = null;
      fresh = false;
      input.focus();
    } else if (action === "@back") {
      if (fresh) {
        fresh = false;
        input.focus();
        return;
      }
      const a = input.selectionStart ?? input.value.length;
      const b = input.selectionEnd ?? a;
      if (a !== b) input.setRangeText("", a, b, "end");
      else if (a > 0) input.setRangeText("", a - 1, a, "end");
      input.focus();
      preview();
    } else if (action === "@eval") {
      calculate();
      input.focus();
    } else insert(action);
  }

  // ---------------------------------------------------------- PDF'e taşı / kopyala
  const placeText = (h: HistoryItem, valueOnly: boolean) =>
    valueOnly ? fmt(h.value) : `${h.expr} = ${fmt(h.value)}`;

  /**
   * Sayfaya yerleştirme olayını yayar. Kullanıcı ardından sayfaya tıklayacağı için panel,
   * bir sonraki tıklamaya (ya da Esc'e) kadar yarı saydam olur ve tıklamaları geçirir.
   */
  function place(h: HistoryItem, valueOnly: boolean): void {
    const text = placeText(h, valueOnly);
    document.dispatchEvent(new CustomEvent("dersapp:place-text", { detail: { text } }));
    panel.classList.add("placing");
    let timer = 0;
    const done = () => {
      panel.classList.remove("placing");
      window.removeEventListener("pointerdown", done, true);
      document.removeEventListener("keydown", onKey, true);
      clearTimeout(timer);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      escCancels.add(e); // panelin Esc işleyicisi paneli kapatmasın
      done();
    };
    // Düğmenin kendi pointerdown'ı çoktan geçti (olay click'te yayılıyor): hemen dinlemek güvenli
    window.addEventListener("pointerdown", done, true);
    document.addEventListener("keydown", onKey, true);
    timer = window.setTimeout(done, 15000);
  }
  const escCancels = new WeakSet<Event>();

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast("Kopyalandı: " + text, "info");
    } catch {
      toast("Panoya kopyalanamadı");
    }
  }

  placeBtn.addEventListener("click", (e) => last && place(last, e.shiftKey));
  placeValBtn.addEventListener("click", () => last && place(last, true));
  copyBtn.addEventListener("click", () => last && void copy(fmt(last.value)));
  polarBtn.addEventListener("click", () => {
    state.polar = !state.polar;
    save();
    renderMode();
    refreshOutputs();
  });

  function renderHistory(): void {
    histBox.replaceChildren();
    if (!history.length) {
      histBox.append(el("li", "none", "Henüz işlem yok"));
      return;
    }
    for (const h of history) {
      const li = el("li", "");
      const b = el("button", "calc-hist-item");
      b.title = "İfadeyi geri getir";
      b.append(el("span", "h-expr", h.expr), el("span", "h-res", "= " + fmt(h.value)));
      b.addEventListener("click", () => {
        input.value = h.expr;
        input.focus();
        preview();
      });
      const pb = iconBtn("calc-hist-place", ICON.place, "PDF'e taşı (Shift+tık: yalnızca sonuç)");
      pb.addEventListener("click", (e) => place(h, e.shiftKey));
      li.append(b, pb);
      histBox.append(li);
    }
  }

  function renderVars(): void {
    varBox.replaceChildren();
    const names = Object.keys(vars).sort((a, b) => a.localeCompare(b, "tr"));
    if (!names.length) {
      varBox.append(el("div", "none", "Henüz değişken yok. Örn. R1 = 4.7k yazıp Enter'a basın."));
      return;
    }
    const list = el("ul", "calc-var-list");
    for (const n of names) {
      const li = el("li", "");
      const b = el("button", "calc-var-item");
      b.title = "Girişe ekle";
      b.append(el("span", "v-name", n), el("span", "v-val", "= " + fmt(vars[n])));
      b.addEventListener("click", () => insert(n));
      b.addEventListener("mousedown", (e) => e.preventDefault());
      const del = iconBtn("calc-var-del", ICON.trash, `${n} değişkenini sil`);
      del.addEventListener("click", () => {
        delete vars[n];
        saveVars();
        renderVars();
        preview();
      });
      li.append(b, del);
      list.append(li);
    }
    const clear = el("button", "calc-var-clear", "Tümünü sil");
    clear.type = "button";
    clear.addEventListener("click", () => {
      for (const n of Object.keys(vars)) delete vars[n];
      saveVars();
      renderVars();
    });
    varBox.append(list, clear);
  }

  /** Gösterim ayarı değişince sonuç, geçmiş ve değişken listesi yeniden biçimlenir. */
  function refreshOutputs(): void {
    if (last && out.classList.contains("final")) renderFinal();
    else if (!out.classList.contains("error")) preview();
    renderHistory();
    renderVars();
  }

  // ---------------------------------------------------------- Görünüm / konum
  function clamp(): void {
    const maxX = Math.max(0, stage.clientWidth - panel.offsetWidth);
    const maxY = Math.max(0, stage.clientHeight - panel.offsetHeight);
    // Kayıtlı konum yoksa sağ üst köşe
    const x = state.x ?? maxX - 16;
    const y = state.y ?? 16;
    state.x = Math.min(Math.max(0, x), maxX);
    state.y = Math.min(Math.max(0, y), maxY);
    panel.style.left = state.x + "px";
    panel.style.top = state.y + "px";
  }

  function renderMode(): void {
    degBtn.textContent = state.degrees ? "DEG" : "RAD";
    degBtn.title = state.degrees ? "Açı birimi: derece (radyana geç)" : "Açı birimi: radyan (dereceye geç)";
    histBtn.classList.toggle("on", state.history);
    histBox.hidden = !state.history;
    advBtn.classList.toggle("on", state.adv);
    panel.classList.toggle("advanced", state.adv);
    adv.hidden = !state.adv;
    for (const [t, b] of tabBtns) {
      b.classList.toggle("on", t === state.tab);
      b.setAttribute("aria-selected", String(t === state.tab));
    }
    for (const [t, p] of advPads) p.hidden = t !== state.tab;
    for (const t of toggles) t.sync();
  }

  function setOpen(open: boolean): void {
    state.open = open;
    panel.hidden = !open;
    document.getElementById("btn-calc")?.classList.toggle("on", open);
    if (open) {
      clamp();
      input.focus();
      input.select();
    } else if (panel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
    save();
  }

  degBtn.addEventListener("click", () => {
    state.degrees = !state.degrees;
    renderMode();
    save();
    refreshOutputs();
    input.focus();
  });
  histBtn.addEventListener("click", () => {
    state.history = !state.history;
    renderMode();
    clamp(); // yükseklik değişti
    save();
  });
  advBtn.addEventListener("click", () => {
    state.adv = !state.adv;
    renderMode();
    clamp();
    save();
  });
  closeBtn.addEventListener("click", () => setOpen(false));

  input.addEventListener("input", preview);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      calculate();
    }
  });

  // Panel içindeki tuşlar uygulama kısayollarını (P, H, 1-8 ...) tetiklemesin;
  // Ctrl/Cmd kombinasyonları (ör. Ctrl+K ile kapatma) geçsin.
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Yerleştirme sürerken Esc yalnızca onu iptal eder (olay sayfa dinleyicisine de ulaşsın)
      if (escCancels.has(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  });

  // Başlıktan sürükleme
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const dx = e.clientX - (state.x ?? 0);
    const dy = e.clientY - (state.y ?? 0);
    panel.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      state.x = ev.clientX - dx;
      state.y = ev.clientY - dy;
      clamp();
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      panel.classList.remove("dragging");
      save();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });

  new ResizeObserver(() => {
    if (!panel.hidden) clamp();
  }).observe(stage);

  renderMode();
  renderHistory();
  renderVars();
  setOut("");
  panel.hidden = true;
  if (state.open) setOpen(true);

  return { toggle: () => setOpen(!state.open) };
}
