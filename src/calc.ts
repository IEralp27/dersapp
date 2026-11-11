// Hesap makinesi paneli: #stage üzerinde yüzen, sürüklenebilir küçük pencere.
import "./calc.css";
import { CalcError, evaluate, formatResult } from "./calc-engine";

const KEY = "dersapp.calc";
const HISTORY_MAX = 20;

interface CalcState {
  open: boolean;
  degrees: boolean;
  history: boolean;
  x: number | null;
  y: number | null;
}

interface HistoryItem {
  expr: string;
  result: string;
}

/** Tuş takımı: [etiket, eklenecek metin | özel komut, ek sınıf]. Komutlar "@" ile başlar. */
const KEYS: [string, string, string?][] = [
  ["sin", "sin(", "fn"], ["cos", "cos(", "fn"], ["tan", "tan(", "fn"], ["ln", "ln(", "fn"], ["log", "log(", "fn"],
  ["√", "√(", "fn"], ["xʸ", "^", "fn"], ["n!", "!", "fn"], ["π", "π", "fn"], ["e", "e", "fn"],
  ["(", "(", "fn"], [")", ")", "fn"], ["Ans", "ans", "fn"], ["C", "@clear", "danger"], ["⌫", "@back", "danger"],
  ["7", "7"], ["8", "8"], ["9", "9"], ["÷", "÷", "op"], ["x²", "^2", "fn"],
  ["4", "4"], ["5", "5"], ["6", "6"], ["×", "×", "op"], ["1/x", "^-1", "fn"],
  ["1", "1"], ["2", "2"], ["3", "3"], ["−", "−", "op"], ["+", "+", "op"],
  ["0", "0"], [",", ","], ["%", "%", "fn"], ["=", "@eval", "eq"],
];

/** Sonuçla devam etmek için önüne "ans" konması gereken eklemeler (operatör gibi olanlar) */
const CONTINUES = new Set(["÷", "×", "−", "+", "^", "^2", "^-1", "!", "%"]);

function load(): CalcState {
  const def: CalcState = { open: false, degrees: true, history: false, x: null, y: null };
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
      };
    }
  } catch {
    // bozuk kayıt ya da erişim yok: varsayılanlarla devam
  }
  return def;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function initCalculator(): { toggle(): void } {
  const stage = document.getElementById("stage")!;
  const state = load();
  let ans = 0;
  let fresh = false; // son işlem "=" ile bitti: sıradaki tuş yeni ifade başlatır ya da sonuçla devam eder
  const history: HistoryItem[] = [];

  function save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // kayıt yazılamadı (dolu ya da kapalı depolama); panel yine çalışır
    }
  }

  // ---------------------------------------------------------- Yapı
  const panel = el("div", "calc");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Hesap makinesi");

  const head = el("div", "calc-head");
  const title = el("span", "calc-title", "Hesap makinesi");
  const degBtn = el("button", "calc-mode");
  const histBtn = el("button", "calc-hist-btn", "Geçmiş");
  histBtn.title = "Geçmişi göster/gizle";
  const closeBtn = el("button", "calc-close", "×");
  closeBtn.title = "Kapat (Esc)";
  closeBtn.setAttribute("aria-label", "Hesap makinesini kapat");
  head.append(title, degBtn, histBtn, closeBtn);

  const input = el("input", "calc-input");
  input.type = "text";
  input.placeholder = "İfade yaz, Enter ile hesapla";
  input.setAttribute("aria-label", "İfade");
  input.autocomplete = "off";
  input.spellcheck = false;
  const out = el("div", "calc-out");
  out.setAttribute("aria-live", "polite");

  const histBox = el("ul", "calc-history");
  const pad = el("div", "calc-pad");
  panel.append(head, input, out, histBox, pad);
  stage.append(panel);

  for (const [label, action, cls] of KEYS) {
    const b = el("button", "calc-key" + (cls ? " " + cls : ""), label);
    b.type = "button";
    if (action === "@eval") b.classList.add("wide");
    b.addEventListener("click", () => press(action));
    pad.append(b);
  }
  // Tuşa basınca ifade kutusunun odağı/imleci kaybolmasın
  pad.addEventListener("mousedown", (e) => e.preventDefault());

  // ---------------------------------------------------------- Mantık
  function setOut(text: string, kind: "" | "preview" | "error" | "final"): void {
    out.textContent = text || " ";
    out.className = "calc-out" + (kind ? " " + kind : "");
  }

  function preview(): void {
    fresh = false;
    const text = input.value.trim();
    if (!text) return setOut("", "");
    try {
      // Yazarken yalnızca geçerli ifadelerin önizlemesi gösterilir; hata Enter'da bildirilir
      setOut("= " + formatResult(evaluate(text, { degrees: state.degrees, ans })), "preview");
    } catch {
      setOut("", "");
    }
  }

  function calculate(): void {
    const text = input.value.trim();
    try {
      const value = evaluate(text, { degrees: state.degrees, ans });
      const result = formatResult(value);
      ans = value;
      setOut(result, "final");
      history.unshift({ expr: text, result });
      if (history.length > HISTORY_MAX) history.pop();
      renderHistory();
      fresh = true;
    } catch (e) {
      setOut(e instanceof CalcError ? e.message : "Hesaplanamadı", "error");
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
      setOut("", "");
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
      b.append(el("span", "h-expr", h.expr), el("span", "h-res", "= " + h.result));
      b.addEventListener("click", () => {
        input.value = h.expr;
        input.focus();
        preview();
      });
      li.append(b);
      histBox.append(li);
    }
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
    preview();
    input.focus();
  });
  histBtn.addEventListener("click", () => {
    state.history = !state.history;
    renderMode();
    clamp(); // yükseklik değişti
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
  setOut("", "");
  panel.hidden = true;
  if (state.open) setOpen(true);

  return { toggle: () => setOpen(!state.open) };
}
