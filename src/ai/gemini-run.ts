// Gemini CLI sağlayıcısının Tauri köprüsü: görüntüleri geçici dosyaya yazdırır, `gemini -p` sürecini
// (Rust cli.rs, cli: "gemini") başlatır, stdout satırlarını GeminiStream'e verir, durdurmayı bağlar.
// Claude'un cli-run.ts'iyle aynı sözleşme (CliRunOptions); saf kısımlar gemini-stream.ts içinde ve test edilir.
import { Channel, invoke } from "@tauri-apps/api/core";
import { inTauri } from "../backend";
import { CliError, byteLength, validModel } from "./cli-stream";
import type { CliRunOptions } from "./cli-run";
import {
  GEMINI_AGENT_NOTE, GEMINI_INSTALL_HELP, GEMINI_PROMPT_MAX_BYTES, GEMINI_SYSTEM_NOTE, GeminiStream, geminiError, geminiPrompt,
} from "./gemini-stream";
import type { ChatImage } from "./providers";

type CliEvent =
  | { kind: "line"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "done"; code: number | null; stderr: string; cancelled: boolean };

const abortError = () => new DOMException("İptal", "AbortError");

/** Bir Gemini CLI çalışması. Bitince döner; durdurulursa AbortError, hatada CliError fırlatır. */
export async function runGeminiCli(o: CliRunOptions): Promise<void> {
  if (!inTauri) throw new CliError("Gemini CLI yalnızca masaüstü uygulamasında (Tauri) çalışır.");
  const model = o.model.trim();
  if (model && !validModel(model)) throw new CliError("Model adı geçersiz. auto, pro, flash ya da tam model adı yaz (ya da boş bırak).");
  if (o.signal.aborted) throw abortError();

  const runId = crypto.randomUUID();
  let stopped = false;
  let finish: ((ev: CliEvent & { kind: "done" }) => void) | null = null;
  const stop = () => {
    stopped = true;
    finish?.({ kind: "done", code: null, stderr: "", cancelled: true });
    void invoke("cli_stop", { runId }).catch(() => {});
  };
  o.signal.addEventListener("abort", stop, { once: true });
  try {
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
    const prompt = geminiPrompt(o.messages, perMsg);
    if (byteLength(prompt) > GEMINI_PROMPT_MAX_BYTES) {
      throw new CliError("Konuşma Gemini CLI için çok uzun oldu (8 MB sınırı). Yeni bir konuşma başlat.", "too-big");
    }
    if (stopped) throw abortError();

    const parser = new GeminiStream(o.onText);
    if (o.agent) parser.onTool = o.agent.onTool;
    // Kota/yoğunlukta CLI kendisi uzun süre yeniden dener: öğrenciye söyle (durum satırı ajan günlüğünde)
    parser.onRetry = (status, attempt) => o.agent?.onTool("__retry", { status, attempt });
    const access = o.agent?.roots.length ? { roots: o.agent.roots, maxTurns: o.agent.maxTurns, restricted: true } : null;
    const note = access ? GEMINI_AGENT_NOTE : GEMINI_SYSTEM_NOTE;
    const done = new Promise<CliEvent & { kind: "done" }>((resolve) => (finish = resolve));
    const ch = new Channel<CliEvent>();
    ch.onmessage = (ev) => {
      if (stopped) return;
      if (ev.kind === "line") parser.line(ev.line);
      else if (ev.kind === "stderr") parser.stderrLine(ev.line);
      else if (ev.kind === "done") finish?.(ev);
    };
    try {
      await invoke("cli_start", { args: { runId, model, system: o.system + note, prompt, access, cli: "gemini" }, onEvent: ch });
    } catch (e) {
      if (/CLI_NOT_FOUND/.test(String(e))) throw new CliError(GEMINI_INSTALL_HELP, "not-installed");
      throw new CliError("Gemini CLI başlatılamadı: " + String(e));
    }
    if (stopped) stop();
    const end = await done;
    if (stopped || end.cancelled) throw abortError();
    const r = parser.result;
    if (r?.ok && (end.code === 0 || parser.emitted)) return;
    if (parser.maxTurns) {
      if (parser.emitted) return o.onText("\n\n_(Adım sınırına ulaşıldı; yanıt eksik olabilir. Soruyu daraltıp yeniden sor.)_");
      throw new CliError("Yapay zeka çok fazla adım attı ve Gemini CLI'ın tur sınırına ulaştı. Soruyu daralt: belirli bir dosya ya da sayfa söyle.");
    }
    throw geminiError({ message: r?.message, errorType: r?.errorType, lastError: parser.lastError, stderr: end.stderr, code: end.code });
  } finally {
    o.signal.removeEventListener("abort", stop);
  }
}
