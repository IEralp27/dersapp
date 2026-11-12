// Claude Code CLI sağlayıcısının Tauri köprüsü: görüntüleri geçici dosyaya yazdırır,
// `claude -p` sürecini başlatır, stdout satırlarını CliStream'e verir, durdurmayı bağlar.
// Saf kısımlar (istem, satır çözümleme, hatalar) cli-stream.ts içinde ve test edilir.
import { Channel, invoke } from "@tauri-apps/api/core";
import { inTauri } from "../backend";
import {
  CLI_SYSTEM_NOTE, CliError, CliStream, INSTALL_HELP, PROMPT_MAX_BYTES, byteLength, cliError, flattenPrompt, validModel,
} from "./cli-stream";
import type { ChatImage, ChatMessage } from "./providers";

type CliEvent =
  | { kind: "line"; line: string }
  | { kind: "done"; code: number | null; stderr: string; cancelled: boolean };

export interface CliRunOptions {
  model: string;
  system: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

const abortError = () => new DOMException("İptal", "AbortError");

/** Bir CLI çalışması. Bitince döner; durdurulursa AbortError, hatada CliError fırlatır. */
export async function runClaudeCli(o: CliRunOptions): Promise<void> {
  if (!inTauri) throw new CliError("Claude Code CLI yalnızca masaüstü uygulamasında (Tauri) çalışır.");
  const model = o.model.trim();
  if (model && !validModel(model)) throw new CliError("Model adı geçersiz. sonnet, opus ya da haiku yaz (ya da boş bırak).");
  if (o.signal.aborted) throw abortError();

  const runId = crypto.randomUUID();
  let stopped = false;
  /** Bitiş olayını bekleyen söz; durdurulunca beklemeden çözülür (alt süreç boruyu açık tutabilir). */
  let finish: ((ev: CliEvent & { kind: "done" }) => void) | null = null;
  const stop = () => {
    stopped = true;
    finish?.({ kind: "done", code: null, stderr: "", cancelled: true });
    void invoke("cli_stop", { runId }).catch(() => {});
  };
  o.signal.addEventListener("abort", stop, { once: true });
  try {
    // Görüntüler: her mesajınkini ayrı ayrı dosyaya yaz, yollarını isteme koy
    const all: ChatImage[] = [];
    const counts = o.messages.map((m) => {
      all.push(...(m.images ?? []));
      return m.images?.length ?? 0;
    });
    const paths: string[] = all.length ? await invoke<string[]>("cli_prepare", { runId, images: all }) : [];
    const perMsg: string[][] = [];
    let k = 0;
    for (const n of counts) {
      perMsg.push(paths.slice(k, k + n));
      k += n;
    }
    const prompt = flattenPrompt(o.messages, perMsg);
    if (byteLength(prompt) > PROMPT_MAX_BYTES) {
      throw new CliError("Konuşma Claude Code için çok uzun oldu (10 MB sınırı). Yeni bir konuşma başlat.", "too-big");
    }
    if (stopped) throw abortError();

    const parser = new CliStream(o.onText);
    const done = new Promise<CliEvent & { kind: "done" }>((resolve) => (finish = resolve));
    const ch = new Channel<CliEvent>();
    ch.onmessage = (ev) => {
      if (stopped) return;
      if (ev.kind === "line") parser.line(ev.line);
      else finish?.(ev);
    };
    try {
      await invoke("cli_start", { args: { runId, model, system: o.system + CLI_SYSTEM_NOTE, prompt }, onEvent: ch });
    } catch (e) {
      if (/CLI_NOT_FOUND/.test(String(e))) throw new CliError(INSTALL_HELP, "not-installed");
      throw new CliError("Claude Code başlatılamadı: " + String(e));
    }
    // Başlatma sürerken durdurulduysa süreç ancak şimdi listede: yeniden durdur
    if (stopped) stop();
    const end = await done;
    if (stopped || end.cancelled) throw abortError();
    const r = parser.result;
    if (r && !r.isError && end.code === 0) return;
    if (r && !r.isError && parser.emitted) return; // yanıt geldi; çıkış kodunu dert etme
    throw cliError({ result: r?.text, stderr: end.stderr, code: end.code, retry: parser.retryError });
  } finally {
    o.signal.removeEventListener("abort", stop);
  }
}
