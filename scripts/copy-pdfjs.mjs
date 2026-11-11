// PDF.js'in ihtiyaç duyduğu yardımcı dosyaları (yazı tipleri, karakter
// haritaları, görüntü çözücüler) public/pdfjs altına kopyalar.
// "npm run dev" ve "npm run build" öncesinde kendiliğinden çalışır.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "public", "pdfjs");

if (!existsSync(from)) {
  console.error("pdfjs-dist bulunamadı. Önce `npm install` çalıştırın.");
  process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(from, dir), join(to, dir), { recursive: true });
}
console.log("PDF.js yardımcı dosyaları hazır.");
