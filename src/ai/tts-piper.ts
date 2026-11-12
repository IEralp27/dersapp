// Piper motoru: "Piper (ücretsiz, çevrimdışı, doğal)". Ses Rust tarafında üretilir (src-tauri/src/piper.rs:
// metin stdin'den verilir, WAV baytı döner). Program ve Türkçe ses uygulamayla gelmez: ilk kullanımda
// kullanıcıya boyut gösterilip onay alınır, ilerleme çubuğuyla indirilir ve sağlama toplamıyla doğrulanır.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "../backend";
import { BytesSpeaker } from "./tts-audio";
import type { ClipProvider } from "./tts-audio";
import { registerEngine } from "./tts-engine";
import type { Avail } from "./tts-engine";

interface PiperStatus {
  supported: boolean;
  installed: boolean;
  installing: boolean;
  downloadBytes: number;
  voice: string;
}

let status: PiperStatus | null = null;
let installing: Promise<void> | null = null;

async function refresh(): Promise<PiperStatus> {
  status = await invoke<PiperStatus>("piper_status");
  return status;
}

const mb = (n: number) => Math.max(1, Math.round(n / 1_000_000)) + " MB";

// ================================================================ İndirme penceresi

function box(): { root: HTMLElement; inner: HTMLElement } {
  const root = document.createElement("div");
  root.className = "piper-dlg";
  const inner = document.createElement("div");
  inner.className = "piper-box";
  inner.setAttribute("role", "dialog");
  inner.setAttribute("aria-label", "Piper sesini indir");
  root.append(inner);
  document.body.append(root);
  return { root, inner };
}

function button(text: string, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tts-test" + (primary ? " tts-primary" : "");
  b.textContent = text;
  return b;
}

/** Boyutu gösterip onay ister; onaylanırsa indirir ve ilerlemeyi gösterir. */
function confirmAndInstall(bytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const { root, inner } = box();
    const title = document.createElement("b");
    title.textContent = "Piper sesini indir";
    const p = document.createElement("p");
    p.textContent = `Doğal Türkçe okuma için Piper programı ve Türkçe ses bir kez indirilecek (yaklaşık ${mb(bytes)}). `
      + "Sonra internet gerekmez; ses bilgisayarında üretilir.";
    const src = document.createElement("p");
    src.className = "dim";
    src.textContent = "Kaynak: Piper projesi (GitHub) ve Hugging Face. Dosyalar indirildikten sonra doğrulanır. "
      + "İstersen ses ayarlarından başka bir seslendirici seçebilirsin.";
    const acts = document.createElement("div");
    acts.className = "tts-acts";
    const no = button("Vazgeç");
    const yes = button("İndir", true);
    acts.append(no, yes);
    inner.append(title, p, src, acts);
    yes.focus();
    const cancel = () => {
      root.remove();
      reject(new Error("Piper indirilmedi."));
    };
    no.addEventListener("click", cancel);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !yes.disabled) {
        e.stopPropagation();
        cancel();
      }
    });
    yes.addEventListener("click", async () => {
      yes.disabled = no.disabled = true;
      const bar = document.createElement("progress");
      const info = document.createElement("p");
      info.className = "dim";
      info.textContent = "İndirme başlıyor…";
      acts.before(bar, info);
      const un = await listen<{ done: number; total: number }>("piper-progress", (ev) => {
        const { done, total } = ev.payload;
        bar.max = total;
        bar.value = done;
        info.textContent = `${mb(done)} / ${mb(total)}`;
      });
      try {
        await invoke("piper_install");
        await refresh();
        resolve();
      } catch (e) {
        reject(new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "Piper kurulamadı."));
      } finally {
        un();
        root.remove();
      }
    });
  });
}

/** Kurulu değilse (bir kez, eşzamanlı istekler aynı pencereyi bekler) onay alıp kurar. */
function ensureInstalled(): Promise<void> {
  if (status?.installed) return Promise.resolve();
  return (installing ??= (async () => {
    const s = await refresh();
    if (s.installed) return;
    if (!s.supported) throw new Error("Piper bu işletim sistemi için hazır sunulmuyor.");
    await confirmAndInstall(s.downloadBytes);
  })().finally(() => {
    installing = null;
  }));
}

// ================================================================ Motor

const provider: ClipProvider = {
  key: (text) => ["piper", status?.voice ?? "", text].join("\u0001"),
  async fetch(text, signal) {
    await ensureInstalled();
    if (signal.aborted) throw new DOMException("iptal", "AbortError");
    let bytes: ArrayBuffer;
    try {
      bytes = await invoke<ArrayBuffer>("piper_synthesize", { text });
    } catch (e) {
      throw new Error(typeof e === "string" ? e : "Piper ses üretemedi.");
    }
    if (!bytes.byteLength) throw new Error("Piper boş bir ses döndürdü.");
    return { bytes, mime: "audio/wav" };
  },
};

registerEngine({
  id: "piper",
  order: 5,
  name: "Piper (ücretsiz, çevrimdışı, doğal)",
  description: "Bilgisayarında çalışan doğal Türkçe ses. İlk kullanımda bir kez indirilir (yaklaşık 85 MB), sonra internet gerekmez.",
  fields: [],
  available(): Avail | Promise<Avail> {
    if (!inTauri) return { ok: false, reason: "Yalnızca masaüstü uygulamasında çalışır." };
    return refresh().then(
      (s): Avail => (s.supported ? { ok: true } : { ok: false, reason: "Bu işletim sistemi/işlemci için hazır Piper yok." }),
      (): Avail => ({ ok: false, reason: "Piper durumu okunamadı." }),
    );
  },
  notes() {
    if (!status) return [];
    if (status.installed) return [{ text: `Kurulu (Türkçe ses: ${status.voice}). Uygulamanın veri klasöründeki "piper" klasöründe durur.` }];
    return [{ text: `Henüz indirilmedi: ilk okumada onayın istenir (yaklaşık ${mb(status.downloadBytes)}).` }];
  },
  create: () => new BytesSpeaker("piper", () => provider),
});
