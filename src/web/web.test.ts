// Çalıştırma: node src/web/web.test.ts
import assert from "node:assert/strict";
import { GEMINI_URL, NOTEBOOKLM_URL, checkUrl, hostLabel, isNotebookLm, normalizeInput } from "./url.ts";
import { MAX_PER_PDF, MEDIA_KEY, MediaStore, mediaKind, mediaMime } from "./media-store.ts";
import { MIN_TEXT, decodeEntities, htmlToText, pageProblem } from "./html-text.ts";
import { webPagePrompt } from "../ai/prompts.ts";

class Mem {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

let n = 0;
const ok = (r: ReturnType<typeof checkUrl>) => (r.ok ? r.url : "HATA:" + r.error);

// ---------------------------------------------------------------- adresler
{
  assert.equal(ok(normalizeInput("notebooklm")), NOTEBOOKLM_URL);
  assert.equal(ok(normalizeInput("  Gemini Notebook ")), NOTEBOOKLM_URL);
  assert.equal(ok(normalizeInput("Gemini")), GEMINI_URL);
  assert.equal(hostLabel("https://gemini.google.com/app"), "Gemini");
  assert.equal(ok(normalizeInput("ornek.com")), "https://ornek.com/");
  assert.equal(ok(normalizeInput("ornek.com.tr/a?b=1#c")), "https://ornek.com.tr/a?b=1#c");
  assert.equal(ok(normalizeInput("ornek.com:8080/x")), "https://ornek.com:8080/x");
  assert.equal(ok(normalizeInput("http://ornek.com")), "http://ornek.com/");
  assert.equal(ok(normalizeInput("ohm kanunu")), "https://www.google.com/search?q=ohm%20kanunu");
  assert.equal(ok(normalizeInput("thevenin")), "https://www.google.com/search?q=thevenin");
  assert.ok(!normalizeInput("").ok);
  for (const bad of ["file:///C:/x.pdf", "javascript:alert(1)", "tauri://localhost/", "http://tauri.localhost/",
    "http://localhost:1420/", "http://127.0.0.1/", "http://[::1]:80/", "data:text/html,x", "http://LOCALHOST./"]) {
    assert.ok(!normalizeInput(bad).ok, bad);
    assert.ok(!checkUrl(bad).ok, bad);
  }
  assert.ok(!normalizeInput("localhost:1420").ok);
  assert.ok(isNotebookLm("https://notebooklm.google.com/notebook/abc"));
  assert.ok(!isNotebookLm("https://google.com/"));
  assert.equal(hostLabel("https://www.wikipedia.org/wiki/X"), "wikipedia.org");
  assert.equal(hostLabel("https://notebooklm.google.com/"), "NotebookLM");
  assert.equal(hostLabel("yok"), "Web");
  n++;
}

// ---------------------------------------------------------------- medya bağları
{
  assert.equal(mediaKind("C:\\veri\\medya\\Ozet.M4A"), "audio");
  assert.equal(mediaKind("/x/video.mp4"), "video");
  assert.equal(mediaKind("ders.pdf"), null);
  assert.equal(mediaKind("download"), null);
  assert.equal(mediaMime("a.mp3"), "audio/mpeg");
  assert.equal(mediaMime("a.xyz"), "application/octet-stream");

  const kv = new Mem();
  const s = new MediaStore(kv);
  assert.equal(s.lastSent(), null);
  assert.equal(s.linkDownload("/m/a.m4a"), null); // gönderilen PDF yoksa bağlanmaz
  s.markSent("/d/devre.pdf", "devre.pdf", 5);
  assert.equal(s.lastSent()?.path, "/d/devre.pdf");
  assert.equal(s.linkDownload("/m/a.m4a", 10)?.name, "devre.pdf");
  assert.equal(s.linkDownload("/m/a.m4a", 11), null); // aynı dosya ikinci kez eklenmez
  assert.equal(s.add("/d/devre.pdf", "/m/b.pdf", "elle"), null); // medya değil
  assert.ok(s.add("/d/devre.pdf", "/m/v.mp4", "elle", 12));
  const list = s.list("/d/devre.pdf");
  assert.equal(list.map((m) => m.name).join(), "v.mp4,a.m4a"); // en yeni üstte
  assert.equal(list[0].kind, "video");
  assert.equal(list[1].source, "indirme");
  assert.equal(s.list("/baska.pdf").length, 0);
  s.remove("/d/devre.pdf", "/m/v.mp4");
  assert.equal(s.list("/d/devre.pdf").length, 1);
  s.remove("/d/devre.pdf", "/m/a.m4a");
  assert.ok(!JSON.parse(kv.getItem(MEDIA_KEY)!).links["/d/devre.pdf"]);
  for (let i = 0; i < MAX_PER_PDF + 5; i++) s.add("/p.pdf", `/m/${i}.mp3`, "elle", i);
  assert.equal(s.list("/p.pdf").length, MAX_PER_PDF);
  kv.setItem(MEDIA_KEY, "{bozuk");
  assert.equal(new MediaStore(kv).list("/p.pdf").length, 0); // bozuk kayıt çökertmez
  n++;
}

// ---------------------------------------------------------------- HTML → metin
{
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#305;&#x131; &nbsp;&bogus;"), "a & b <c> ıı  &bogus;");
  const para = "Ohm kanunu gerilim, akım ve direnç arasındaki ilişkiyi verir. ".repeat(6);
  const html = `<!doctype html><html><head><title>Ohm &amp; Kirchhoff</title><style>p{color:red}</style>
    <script>var x = "<p>gizli</p>";</script></head><body><nav><a href="/">Ana sayfa</a> | Menü</nav>
    <main><h1>Ohm Kanunu</h1><p>${para}</p><ul><li>V = I·R</li><li>P = V·I</li></ul>
    <table><tr><td>R</td><td>10&nbsp;Ω</td></tr></table><!-- yorum --></main><footer>© 2026</footer></body></html>`;
  const t = htmlToText(html);
  assert.equal(t.title, "Ohm & Kirchhoff");
  assert.ok(t.text.startsWith("# Ohm Kanunu"), t.text.slice(0, 40));
  assert.ok(t.text.includes("• V = I·R\n• P = V·I"), t.text);
  assert.ok(t.text.includes("R 10 Ω"));
  for (const no of ["gizli", "color:red", "Menü", "yorum", "© 2026"]) assert.ok(!t.text.includes(no), no);
  assert.ok(!t.truncated);

  const long = htmlToText(`<p>${"satır metni\n".repeat(5000)}</p>`, 1000);
  assert.ok(long.truncated && long.text.length <= 1000);

  const fine = { url: "https://ornek.com/a", status: 200, contentType: "text/html; charset=utf-8", html };
  assert.equal(pageProblem(fine, t), null);
  const login = pageProblem({ ...fine, url: "https://accounts.google.com/v3/signin/identifier?x=1" }, t);
  assert.ok(login && login.includes("giriş"));
  assert.ok(pageProblem({ ...fine, status: 403 }, t)?.includes("giriş"));
  assert.ok(pageProblem({ ...fine, status: 404 }, t)?.includes("404"));
  assert.ok(pageProblem({ ...fine, contentType: "application/pdf" }, t)?.includes("application/pdf"));
  const empty = htmlToText("<html><body><div id=app></div><script>render()</script></body></html>");
  assert.ok(empty.text.length < MIN_TEXT);
  assert.ok(pageProblem(fine, empty)?.includes("okunabilir metin"));
  n++;
}

// ---------------------------------------------------------------- yapay zeka istemi
{
  const p = webPagePrompt("explainPage", "Ohm", "https://ornek.com/", "METİN", true);
  assert.ok(p.startsWith("Bu, çalıştığım bir web sayfasının metni."), p.slice(0, 60));
  assert.ok(p.includes("METİN") && p.includes("https://ornek.com/") && p.includes("yalnızca başı"));
  const q = webPagePrompt("quiz", "", "https://ornek.com/", "x", false);
  assert.ok(q.startsWith("Bu sayfadaki konudan beni sına") && !/görüntüdeki/i.test(q), q.slice(0, 60));
  assert.ok(!q.includes("yalnızca başı"));
  n++;
}

console.log(`web: ${n} grup geçti`);
