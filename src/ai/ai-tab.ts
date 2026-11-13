// Yapay zeka sekmesi: PDF/web sekmelerinin yanında tam sekme olarak sohbet (Ctrl+Shift+J).
// Sayfaya bağlı değil; bağlam çalışma klasörü ve açık belgeler (Claude Code CLI'da "Dosyalara eriş" ajanı),
// istenirse açık PDF'ler adıyla soruya eklenir. Akış, çizim, durdurma ve hata/yeniden dene panelle ortak
// (panel.ts chatAsk); sesli okuma çubuğu sekmeye taşınır (tts.ts ttsDock). Konuşmalar localStorage'da (sohbet.ts).
import type { PdfView } from "../viewer";
import { chatAsk, chatConv, chatModel, chatIsCli, chatRestore, chatSettingsMissing, chatTurns, openAiSettings, setChatTarget } from "./panel";
import type { ChatSurface, ChatTarget, Conv } from "./panel";
import { ajanReady, ajanRow, bindCitations } from "./ajan-ui";
import { systemWithProfile } from "./learner-ui";
import { SYSTEM_PROMPT } from "./prompts";
import { ttsDock } from "./tts";
import { ConvStore, DEFAULT_TITLE, deriveTitle, docsContext, newConvId, titleOf } from "./sohbet";
import type { DocContext } from "./sohbet";

export interface AiTabHost {
  /** Açık PDF sekmeleri (ek seçici) */
  docs(): { path: string; name: string; view: PdfView | null }[];
  toast(text: string, kind?: "error" | "info"): void;
  /** Sekme başlığı değişti (ilk mesajdan) */
  title(id: string, title: string): void;
  /** Geçmişten aç: sekmesi açıksa öne getirir, değilse yeni sekme olarak açar */
  openConv(id: string): void;
  /** Geçmişten sil: açık sekmesi varsa kapatır, konuşmayı kalıcı siler */
  forgetConv(id: string): void;
}

/** Sistem talimatına eklenen not: bu sohbet bir sayfaya/görüntüye bağlı değil. */
const TAB_NOTE = "\n\n# Bu konuşma\nBu konuşma ayrı bir sohbet sekmesinde; sana PDF görüntüsü gelmez. Yukarıdaki görüntüyle ilgili "
  + "kurallar yalnızca öğrenci bir görüntü ya da sayfa metni gönderdiğinde geçerlidir. Öğrenci genel bir ders sorusu sorabilir, "
  + "çalışma planı isteyebilir ya da \"Ekli belgeler\" bölümüyle PDF ekleyebilir. Yanıtında kurallarına (dil, LaTeX, kısa cümleler) uy.";

const ICONS = {
  ai: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-1-3-2 .3-1.3-1.3L17 5l-3-1-1 2h-2L10 4 7 5l.3 2L6 8.3 4 8l-1 3 2 1v0l-2 1 1 3 2-.3L7.3 17 7 19l3 1 1-2h2l1 2 3-1-.3-2 1.3-1.3 2 .3 1-3z",
  send: "M5 12h13M13 6l6 6-6 6",
  stop: "M7 7h10v10H7z",
  clip: "M8 12l6-6a3 3 0 014 4l-8 8a5 5 0 01-7-7l7-7",
};

let host: AiTabHost;
let store: ConvStore | null = null;
let shownTab: AiTab | null = null;

const svg = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function initAiTabs(h: AiTabHost): void {
  host = h;
  try {
    store = new ConvStore(localStorage);
  } catch {
    store = null; // depolama yok: konuşmalar yalnızca bu oturumda
  }
}

export const newAiTabId = () => newConvId();

/** Kayıtlı konuşmanın başlığı (sekme geri yüklenirken) */
export const savedAiTitle = (id: string) => store?.get(id)?.title ?? DEFAULT_TITLE;

/** Açık sekmesi kalmayan konuşmaları siler (açılışta, sekmeler geri yüklendikten sonra). */
export function pruneAiTabs(keep: string[]): void {
  store?.prune(keep);
}

/** Geçmişten açılan konuşmanın kapalı işaretini kaldırır; konuşma yoksa false. */
export function reopenAiConv(id: string): boolean {
  return store?.reopen(id) ?? false;
}

/** Konuşmayı kalıcı siler (geçmişten). */
export function deleteAiConv(id: string): void {
  store?.remove(id);
}

export class AiTab {
  readonly id: string;
  /** Sekmenin içerik alanı (#stage içinde) */
  readonly el: HTMLElement;
  private conv: Conv;
  private main: HTMLElement;
  private compose: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private modelEl: HTMLElement;
  /** Bir sonraki soruya eklenecek PDF yolları */
  private attached: string[] = [];
  private picker: HTMLElement | null = null;
  private preparing = false;
  private surface: ChatSurface;
  private target: ChatTarget;

  constructor(id: string) {
    this.id = id;
    this.conv = chatConv("ai:" + id, DEFAULT_TITLE);
    const saved = store?.get(id);
    if (saved) chatRestore(this.conv, saved.turns);

    this.el = el("div", "ai-tab");
    this.el.hidden = true;
    const head = el("div", "ai-tab-head");
    const title = el("div", "ai-title");
    title.append(el("b", "", "Yapay zeka"));
    this.modelEl = el("span", "ai-model");
    title.append(this.modelEl);
    const gear = el("button", "icon");
    gear.title = "Yapay zeka ayarları (yan panelde açılır)";
    gear.setAttribute("aria-label", gear.title);
    gear.innerHTML = svg(ICONS.gear);
    gear.addEventListener("click", () => openAiSettings());
    const hist = el("button", "ai-chip", "Geçmiş");
    hist.title = "Önceki sohbetler";
    hist.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.picker) this.closePicker();
      else this.openHistory(hist);
    });
    head.append(title, hist, gear);

    this.main = el("div", "ai-main ai-tab-main");
    this.compose = el("div", "ai-compose ai-tab-compose");
    this.input = el("textarea");
    this.input.rows = 1;
    this.input.setAttribute("aria-label", "Soru");
    this.input.addEventListener("input", () => this.autosize());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.sendBtn = el("button", "icon ai-send");
    this.sendBtn.addEventListener("click", () => {
      if (this.conv.busy) this.conv.busy.abort();
      else void this.send();
    });
    // Yanıttaki bağlantılar uygulama penceresini başka sayfaya götürmesin: adresi kopyala (paneldeki gibi)
    this.main.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a || !this.main.contains(a)) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href) navigator.clipboard.writeText(href).then(() => host.toast("Bağlantı adresi panoya kopyalandı.", "info"), () => {});
    });
    bindCitations(this.el); // [dosya.pdf s.12] -> o PDF'i o sayfada aç
    this.el.append(head, this.main, this.compose);

    this.surface = {
      main: () => this.main,
      shows: () => !this.el.hidden,
      render: () => this.render(),
      system: () => systemWithProfile(SYSTEM_PROMPT + TAB_NOTE),
      pdf: false,
      done: () => this.save(),
    };
    this.target = {
      query: (take) => {
        const q = this.input.value;
        if (take) (this.input.value = "", this.autosize());
        return q;
      },
      send: (text, label) => this.ask(text, label),
      notice: (card) => {
        this.conv.thread.append(card);
        this.render();
        this.main.scrollTop = this.main.scrollHeight;
      },
      render: () => this.render(),
    };
    this.render();
  }

  get title(): string {
    return titleOf(chatTurns(this.conv));
  }

  get busy(): boolean {
    return !!this.conv.busy;
  }

  show(): void {
    if (shownTab && shownTab !== this) shownTab.hide();
    shownTab = this;
    this.el.hidden = false;
    ttsDock({ panel: this.el, main: this.main, compose: this.compose }); // sesli okuma çubuğu bu sekmede
    setChatTarget(this.target); // "Dosyalara eriş" satırı bu sekmeye yazar
    this.render();
    this.main.scrollTop = this.main.scrollHeight;
    requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
  }

  hide(): void {
    this.el.hidden = true;
    this.closePicker();
    if (shownTab !== this) return;
    shownTab = null;
    ttsDock(null);
    setChatTarget(null);
  }

  /** Sekme kapandı: konuşma geçmişte kalır (boşsa silinir). */
  dispose(): void {
    this.conv.busy?.abort();
    this.hide();
    this.el.remove();
    store?.close(this.id);
  }

  private save(): void {
    const turns = chatTurns(this.conv);
    if (store && !store.put(this.id, turns)) host.toast("Sohbet kaydedilemedi (depolama dolu olabilir).");
    host.title(this.id, titleOf(turns));
  }

  private ask(text: string, label: string): void {
    if (this.conv.busy) return;
    if (!chatTurns(this.conv).some((t) => t.role === "user")) host.title(this.id, deriveTitle(label.split("\n")[0]));
    void chatAsk(this.conv, text, label, this.surface);
  }

  private async send(): Promise<void> {
    const q = this.input.value.trim();
    if (!q || this.conv.busy || this.preparing) return;
    const why = chatSettingsMissing();
    if (why) {
      host.toast("Önce yapay zeka ayarlarını tamamla: " + why);
      openAiSettings();
      return;
    }
    const open = host.docs();
    const docs = this.attached.map((p) => open.find((d) => d.path === p)).filter((d) => !!d);
    const agent = ajanReady() && chatIsCli();
    let extra = "";
    if (docs.length) {
      this.preparing = true;
      this.render();
      try {
        const ctx: DocContext[] = [];
        for (const d of docs) {
          const v = d.view?.docView; // beyaz tahtadayken de PDF'in kendisi
          const pdf = !!v?.isPdf;
          const text = !agent && pdf ? await v!.pageText(v!.page).catch(() => "") : undefined;
          ctx.push({ name: d.name, path: d.path, page: pdf ? v!.page : undefined, pages: pdf ? v!.pageCount : undefined, text });
        }
        extra = docsContext(ctx, agent);
      } finally {
        this.preparing = false;
      }
    }
    this.input.value = "";
    this.autosize();
    this.attached = [];
    const label = docs.length ? `${q}\n📎 ${docs.map((d) => d.name).join(", ")}` : q;
    this.ask(q + extra, label);
  }

  private autosize(): void {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(200, this.input.scrollHeight + 2) + "px";
  }

  // ------------------------------------------------------------ Çizim

  render(): void {
    const model = chatModel();
    this.modelEl.textContent = model ?? "";
    this.modelEl.title = model ?? "";
    const why = chatSettingsMissing();
    const col = this.main.querySelector(":scope > .ai-tab-col") ?? this.main.appendChild(el("div", "ai-tab-col"));
    if (!col.contains(this.conv.thread)) col.replaceChildren(this.conv.thread);
    col.querySelector(":scope > .ai-empty, :scope > .ai-tab-setup")?.remove();
    if (why) {
      const box = el("div", "ai-tab-setup ai-error");
      box.append(el("p", "", "Yapay zeka ayarları eksik: " + why));
      const b = el("button", "ai-btn", "Ayarları aç");
      b.addEventListener("click", () => openAiSettings());
      box.append(b);
      col.prepend(box);
    } else if (!this.conv.thread.childElementCount) {
      const box = el("div", "ai-empty");
      box.innerHTML = svg(ICONS.ai);
      box.append(el("p", "", "Herhangi bir ders sorusu sor, çalışma planı iste ya da açık PDF'lerini \"PDF ekle\" ile soruya ekle. "
        + "Claude Code CLI ve \"Dosyalara eriş\" açıkken çalışma klasöründeki dosyaları kendisi okur; [dosya.pdf s.12] etiketine tıklayınca o sayfa açılır."));
      col.prepend(box);
    }
    this.renderCompose();
  }

  private renderCompose(): void {
    const busy = !!this.conv.busy;
    const inner = el("div", "ai-tab-col");
    const open = host.docs();
    this.attached = this.attached.filter((p) => open.some((d) => d.path === p)); // kapanan sekmeler düşer

    const row = el("div", "ai-page-actions");
    const pick = el("button", "ai-chip ai-tab-pick", this.preparing ? "Sayfalar okunuyor…" : "PDF ekle");
    pick.innerHTML = svg(ICONS.clip) + pick.innerHTML;
    pick.title = "Açık PDF'leri bu soruya ekle (yapay zeka açık sayfayı ya da CLI'da dosyanın kendisini görür)";
    pick.disabled = busy || this.preparing || !open.length;
    pick.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.picker) this.closePicker();
      else this.openPicker(pick);
    });
    row.append(pick);
    for (const p of this.attached) {
      const d = open.find((x) => x.path === p)!;
      const chip = el("button", "ai-chip on", d.name + " ×");
      chip.title = "Eki kaldır";
      chip.addEventListener("click", () => {
        this.attached = this.attached.filter((x) => x !== p);
        this.render();
      });
      row.append(chip);
    }
    inner.append(row, ajanRow(busy)); // Dosyalara eriş / Klasörde ara (ajan-ui.ts)

    const bar = el("div", "ai-input");
    this.input.placeholder = this.conv.turns.length ? "Takip sorusu sor…" : "Bir soru yaz…";
    this.sendBtn.innerHTML = svg(busy ? ICONS.stop : ICONS.send);
    this.sendBtn.title = busy ? "Durdur" : "Gönder (Enter)";
    this.sendBtn.setAttribute("aria-label", this.sendBtn.title);
    this.sendBtn.classList.toggle("stop", busy);
    bar.append(this.input, this.sendBtn);
    inner.append(bar);
    this.compose.replaceChildren(inner);
  }

  private openPicker(anchor: HTMLElement): void {
    const box = el("div", "ai-tab-picker");
    box.setAttribute("role", "menu");
    for (const d of host.docs()) {
      const on = this.attached.includes(d.path);
      const b = el("button", on ? "on" : "", (on ? "✓ " : "") + d.name);
      b.title = d.path;
      b.setAttribute("role", "menuitemcheckbox");
      b.setAttribute("aria-checked", String(on));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.attached = on ? this.attached.filter((p) => p !== d.path) : [...this.attached, d.path];
        this.closePicker();
        this.render();
      });
      box.append(b);
    }
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.closePicker();
      }
    });
    const r = anchor.getBoundingClientRect();
    const pr = this.el.getBoundingClientRect();
    box.style.left = r.left - pr.left + "px";
    box.style.bottom = pr.bottom - r.top + 4 + "px";
    this.el.append(box);
    this.picker = box;
    (box.firstElementChild as HTMLElement | null)?.focus();
    setTimeout(() => document.addEventListener("click", this.outside), 0);
  }

  private openHistory(anchor: HTMLElement): void {
    const box = el("div", "ai-tab-picker ai-tab-history");
    const fill = () => {
      const items = store?.history() ?? [];
      box.replaceChildren();
      if (!items.length) box.append(el("p", "ai-hist-empty", "Henüz sohbet geçmişi yok."));
      for (const h of items) {
        const row = el("div", "ai-hist-row");
        const b = el("button", "ai-hist-open");
        b.append(el("span", "ai-hist-title", h.title), el("small", "", `${new Date(h.updated).toLocaleDateString("tr-TR")} · ${h.count} mesaj${h.open ? " · açık" : ""}`));
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closePicker();
          host.openConv(h.id);
        });
        const del = el("button", "ai-hist-del", "Sil");
        del.title = "Bu sohbeti kalıcı olarak sil";
        let armed = false;
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!armed) {
            armed = true;
            del.textContent = "Emin misin?";
            del.classList.add("on");
            setTimeout(() => {
              armed = false;
              del.textContent = "Sil";
              del.classList.remove("on");
            }, 3000);
            return;
          }
          if (h.id === this.id) this.closePicker();
          host.forgetConv(h.id);
          if (h.id !== this.id) fill();
        });
        row.append(b, del);
        box.append(row);
      }
    };
    fill();
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.closePicker();
      }
    });
    const r = anchor.getBoundingClientRect();
    const pr = this.el.getBoundingClientRect();
    box.style.right = pr.right - r.right + "px";
    box.style.top = r.bottom - pr.top + 4 + "px";
    this.el.append(box);
    this.picker = box;
    setTimeout(() => document.addEventListener("click", this.outside), 0);
  }

  private outside = (e: MouseEvent) => {
    if (this.picker && !this.picker.contains(e.target as Node)) this.closePicker();
  };

  private closePicker(): void {
    this.picker?.remove();
    this.picker = null;
    document.removeEventListener("click", this.outside);
  }
}
