import { defineConfig } from "vite";

// Tauri için ayarlanmış Vite yapılandırması
export default defineConfig({
  clearScreen: false, // Rust hatalarını ekrandan silmesin
  server: {
    port: 1420, // Tauri bu portu bekler
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "esnext" },
});
