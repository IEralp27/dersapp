// Platform bayrağı: telefon (Android/iOS, Tauri mobil) mi masaüstü mü.
// Telefonda masaüstüne özgü özellikler (CLI sağlayıcıları, Piper, web sekmeleri/NotebookLM, MCP, klasör seçme)
// gizlenir; Rust tarafında da aynı komutlar "bu özellik telefonda yok" der (src-tauri/src/mobile/).
// Tarayıcıda denemek için: ?mobil=1 (localStorage'a yazılır, ?mobil=0 ile kapanır).

function detect(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location?.search ?? "").get("mobil");
    if (q === "1" || q === "0") localStorage.setItem("dersapp.mobil", q);
    const forced = localStorage.getItem("dersapp.mobil");
    if (forced === "1") return true;
    if (forced === "0") return false;
  } catch {
    // localStorage yoksa yalnızca tarayıcı kimliğine bak
  }
  return /Android|iPhone|iPad/i.test(navigator.userAgent ?? "");
}

/** Telefon uygulaması mı (Android WebView). */
export const isMobile = detect();
