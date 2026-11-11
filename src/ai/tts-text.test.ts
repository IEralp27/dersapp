// Çalıştırma: node src/ai/tts-text.test.ts
import assert from "node:assert/strict";
import { guessLang, numberWords, plainSpeech, suffix, texToSpeech, toSpeech, unitWords } from "./tts-text.ts";

let count = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    count++;
  } catch (e) {
    failed++;
    console.error("FAIL", name, "\n  ", (e as Error).message.split("\n").slice(0, 6).join("\n   "));
  }
};
const RAW = /[\\{}$^_`]/;
const speak = (md: string) => toSpeech(md).map((s) => s.text).join(" | ");

// ---- LaTeX -> Türkçe (tam eşleşme)
const TEX: [string, string][] = [
  [String.raw`\frac{1}{4}^2`, "bir bölü dördün karesi"],
  [String.raw`x^2+3x`, "iks kare artı üç iks"],
  [String.raw`e^{-st}`, "e üzeri eksi se te"],
  [String.raw`\sqrt{2}`, "karekök iki"],
  [String.raw`\sqrt[3]{x}`, "küpkök iks"],
  [String.raw`G(s)=\frac{K}{\tau s+1}`, "ge se eşittir pay ka, bölü payda tau se artı bir"],
  [String.raw`\int_0^\infty f(t)e^{-st}\,dt`, "integral, sıfırdan sonsuza, ef te e üzeri eksi se te, de te"],
  [String.raw`\lim_{x\to 0}\frac{\sin x}{x}`, "limit, iks giderken sıfıra, sinüs iks bölü iks"],
  [String.raw`\sum_{k=1}^{n} a_k`, "toplam, ka eşittir birden ne'ye kadar, a alt ka"],
  [String.raw`\frac{dy}{dx}`, "de ye bölü de iks"],
  [String.raw`\frac{d^2y}{dt^2}`, "de iki ye bölü de te kare"],
  [String.raw`10\angle 30^\circ`, "on, açı otuz derece"],
  [String.raw`\omega_n = 2\,\text{rad/s}`, "omega alt ne eşittir iki radyan bölü saniye"],
  [String.raw`(x+1)^2`, "parantez içinde iks artı bir, parantezin karesi"],
  [String.raw`\begin{bmatrix}1&2\\3&4\end{bmatrix}`, "iki satırlı, iki sütunlu matris: birinci satır: bir, iki; ikinci satır: üç, dört"],
  [String.raw`|x-1|`, "mutlak değer içinde iks eksi bir"],
  [String.raw`2{,}5\times 10^{-3}`, "iki virgül beş çarpı on üzeri eksi üç"],
  [String.raw`63\%`, "yüzde altmış üç"],
  [String.raw`\mathcal{L}\{f(t)\}`, "Laplace dönüşümü, ef te"],
  [String.raw`\binom{n}{k}`, "ne'nin ka'lı kombinasyonu"],
  [String.raw`f'(x)`, "ef üssü iks"],
  [String.raw`\vec{v}`, "ve vektörü"],
  [String.raw`x_1`, "iks bir"],
  [String.raw`a_n`, "a alt ne"],
  [String.raw`\Phi \phi`, "büyük fi fi"],
  [String.raw`j\omega`, "je omega"],
  [String.raw`s+2`, "se artı iki"],
  [String.raw`\frac{K}{\tau s + 1}`, "pay ka, bölü payda tau se artı bir"],
  [String.raw`x \approx 2`, "iks yaklaşık eşittir iki"],
  [String.raw`x \ne 0`, "iks eşit değildir sıfır"],
  [String.raw`x \ll 1`, "iks çok küçüktür bir"],
  [String.raw`f \propto 1/r`, "ef orantılıdır bir bölü re"],
  [String.raw`\frac{1}{2}`, "bir bölü iki"],
  [String.raw`\frac{d}{dt}`, "de bölü de te"],
  [String.raw`\frac{a+b}{c}`, "pay a artı be, bölü payda ce"],
  [String.raw`\frac{\frac{1}{2}}{3}`, "pay bir bölü iki, bölü payda üç"],
  [String.raw`\dfrac{3}{4}`, "üç bölü dört"],
  [String.raw`\tfrac12`, "bir bölü iki"],
  [String.raw`x^3`, "iks küp"],
  [String.raw`x^n`, "iks üzeri ne"],
  [String.raw`x^{n+1}`, "iks üzeri ne artı bir"],
  [String.raw`e^{j\omega t}`, "e üzeri je omega te"],
  [String.raw`\sqrt{x^2+1}`, "karekök içinde iks kare artı bir"],
  [String.raw`\sqrt[n]{x}`, "en'inci dereceden kök iks"],
  [String.raw`\sqrt[4]{16}`, "dördüncü dereceden kök on altı"],
  [String.raw`x_{12}`, "iks on iki"],
  [String.raw`V_{in}`, "ve alt giriş"],
  [String.raw`R_{eq}`, "re alt eşdeğer"],
  [String.raw`\alpha+\beta`, "alfa artı beta"],
  [String.raw`\Delta x`, "delta iks"],
  [String.raw`\theta \approx 0{,}5`, "teta yaklaşık eşittir sıfır virgül beş"],
  [String.raw`a \neq b`, "a eşit değildir be"],
  [String.raw`x \le 3`, "iks küçük eşittir üç"],
  [String.raw`x \geq 3`, "iks büyük eşittir üç"],
  [String.raw`\pm 2`, "artı eksi iki"],
  [String.raw`a \cdot b`, "a çarpı be"],
  [String.raw`a \times b`, "a çarpı be"],
  [String.raw`6 \div 2`, "altı bölü iki"],
  [String.raw`x \to \infty`, "iks, sonsuza gider"],
  [String.raw`\infty`, "sonsuz"],
  [String.raw`x \in \mathbb{R}`, "iks elemanıdır reel sayılar"],
  [String.raw`\prod_{i=1}^{n} i`, "çarpım, i eşittir birden ne'ye kadar, i"],
  [String.raw`\int x\,dx`, "integral, iks de iks"],
  [String.raw`\int_a^b f(x)\,dx`, "integral, a'dan be'ye, ef iks de iks"],
  [String.raw`\lim_{x \to 0^+} \ln x`, "limit, iks giderken sıfıra sağdan, doğal logaritma iks"],
  [String.raw`\frac{\partial f}{\partial x}`, "kısmi ef bölü kısmi iks"],
  [String.raw`y''`, "ye iki üssü"],
  [String.raw`\dot{x}`, "iks nokta"],
  [String.raw`\sin^2 x + \cos^2 x = 1`, "sinüs kare iks artı kosinüs kare iks eşittir bir"],
  [String.raw`\sin(\omega t + \phi)`, "sinüs parantez içinde omega te artı fi, parantez kapa"],
  [String.raw`\ln(s+1)`, "doğal logaritma parantez içinde se artı bir, parantez kapa"],
  [String.raw`\log_{10} x`, "on tabanında logaritma iks"],
  [String.raw`\exp(-t/\tau)`, "e üzeri eksi te bölü tau"],
  [String.raw`\tan\theta`, "tanjant teta"],
  [String.raw`(s+2)(s+3)`, "parantez içinde se artı iki, parantez kapa, parantez içinde se artı üç, parantez kapa"],
  [String.raw`\left( \frac{1}{2} \right)^3`, "parantez içinde bir bölü iki, parantezin küpü"],
  [String.raw`\left| z \right|`, "mutlak değer ze"],
  [String.raw`\hat{x}`, "iks şapka"],
  [String.raw`\bar{x}`, "iks bar"],
  [String.raw`\overline{AB}`, "a be üst çizgi"],
  [String.raw`\begin{pmatrix} a \\ b \end{pmatrix}`, "iki elemanlı sütun vektörü: a, be"],
  [String.raw`\begin{cases} 1 & x > 0 \\ 0 & \text{aksi halde} \end{cases}`, "durumlara göre: bir, iks büyüktür sıfır için; sıfır, aksi halde"],
  [String.raw`50\,\mathrm{Hz}`, "elli hertz"],
  [String.raw`10\,\mathrm{k\Omega}`, "on kiloohm"],
  [String.raw`10\,k\Omega`, "on kiloohm"],
  [String.raw`4{,}7\,\mu\text{F}`, "dört virgül yedi mikrofarad"],
  [String.raw`3\,\text{m/s}^2`, "üç metre bölü saniye kare"],
  [String.raw`9{,}81\,\text{m/s^2}`, "dokuz virgül seksen bir metre bölü saniye kare"],
  [String.raw`1.000`, "bin"],
  [String.raw`0{,}05`, "sıfır virgül sıfır beş"],
  [String.raw`3{,}14159`, "üç virgül bir dört bir beş dokuz"],
  [String.raw`1{,}5 \cdot 10^{3}`, "bir virgül beş çarpı on üzeri üç"],
  [String.raw`25^\circ C`, "yirmi beş santigrat derece"],
  [String.raw`\angle -45^\circ`, "açı eksi kırk beş derece"],
  [String.raw`G(s)H(s)`, "ge se he se"],
  [String.raw`\frac{Y(s)}{U(s)} = \frac{\omega_n^2}{s^2 + 2\zeta\omega_n s + \omega_n^2}`, "ye se bölü u se eşittir pay omega alt ne kare, bölü payda se kare artı iki zeta omega alt ne se artı omega alt ne kare"],
  [String.raw`T = 2\pi\sqrt{\frac{L}{g}}`, "te eşittir iki pi karekök içinde le bölü ge"],
  [String.raw`\tau = RC`, "tau eşittir re ce"],
  [String.raw`V = IR`, "ve eşittir i re"],
  [String.raw`P = VI\cos\phi`, "pe eşittir ve i kosinüs fi"],
  [String.raw`\mathcal{L}^{-1}\{F(s)\}`, "ters Laplace dönüşümü, ef se"],
  [String.raw`x(t) = 1 - e^{-t/\tau}`, "iks te eşittir bir eksi e üzeri eksi te bölü tau"],
  [String.raw`\begin{aligned} a &= b \\ c &= d \end{aligned}`, "a eşittir be; ce eşittir de"],
  [String.raw`\foo{x} + 1`, "iks artı bir"],
  [String.raw`\frac{1}{`, "bir bölü"],
  [String.raw`x^`, "iks üzeri"],
  [String.raw`\sqrt`, "karekök"],
  [String.raw`n!`, "ne faktöriyel"],
  [String.raw`A^T`, "a transpoz"],
  [String.raw`\nabla f`, "nabla ef"],
  [String.raw`a \Rightarrow b`, "a, ise be"],
  [String.raw`\|v\|`, "norm ve"],
];
for (const [tex, want] of TEX) t("tex " + tex, () => assert.equal(texToSpeech(tex), want, tex));

// ---- Sayılar
const NUMS: [string, string][] = [
  ["0", "sıfır"], ["7", "yedi"], ["10", "on"], ["11", "on bir"], ["100", "yüz"], ["101", "yüz bir"], ["1000", "bin"],
  ["1250", "bin iki yüz elli"], ["2000000", "iki milyon"], ["2,5", "iki virgül beş"], ["0,25", "sıfır virgül yirmi beş"],
  ["3.14", "üç virgül on dört"], ["1.000", "bin"], ["12.500", "on iki bin beş yüz"], ["0.125", "sıfır virgül yüz yirmi beş"],
  ["1,0", "bir virgül sıfır"], ["1.2.3", "bir nokta iki nokta üç"],
];
for (const [n, w] of NUMS) t("sayı " + n, () => assert.equal(numberWords(n, "tr"), w));
t("sayı en", () => {
  assert.equal(numberWords("2.5", "en"), "two point five");
  assert.equal(numberWords("1,000", "en"), "one thousand");
  assert.equal(numberWords("42", "en"), "forty-two");
  assert.equal(numberWords("115", "en"), "one hundred fifteen");
});

// ---- Ekler
const SUF: [string, "gen" | "dat" | "abl" | "ord" | "li", string][] = [
  ["dört", "gen", "dördün"], ["dört", "dat", "dörde"], ["dört", "abl", "dörtten"], ["dört", "ord", "dördüncü"], ["bir", "abl", "birden"],
  ["sıfır", "dat", "sıfıra"], ["iki", "dat", "ikiye"], ["altı", "ord", "altıncı"], ["üç", "abl", "üçten"], ["sonsuz", "dat", "sonsuza"],
  ["iks", "gen", "iks'in"], ["ka", "li", "ka'lı"], ["a", "abl", "a'dan"], ["on", "ord", "onuncu"], ["beş", "gen", "beşin"],
];
for (const [w, k, want] of SUF) t(`ek ${w}+${k}`, () => assert.equal(suffix(w, k), want));

// ---- Birimler
const UNITS: [string, string | null][] = [
  ["s", "saniye"], ["ms", "milisaniye"], ["Hz", "hertz"], ["kHz", "kilohertz"], ["rad/s", "radyan bölü saniye"], ["kΩ", "kiloohm"],
  ["μF", "mikrofarad"], ["m/s^2", "metre bölü saniye kare"], ["N·m", "nevton metre"], ["mA", "miliamper"], ["dB", "desibel"],
  ["km/h", "kilometre bölü saat"], ["°C", "santigrat derece"], ["ve", null], ["abc", null], ["x", null],
];
for (const [u, w] of UNITS) t("birim " + u, () => assert.equal(unitWords(u, "tr"), w));

// ---- Düz metin
const PLAIN: [string, string][] = [
  ["Verim %63 oldu.", "Verim yüzde altmış üç oldu."], ["Verim 63% oldu.", "Verim yüzde altmış üç oldu."],
  ["Ücret 5 $ ve 10 $ arası.", "Ücret beş dolar ve on dolar arası."], ["Fiyat $20.", "Fiyat yirmi dolar."],
  ["Süre 0,5 s olur.", "Süre sıfır virgül beş saniye olur."], ["Frekans 50 Hz.", "Frekans elli hertz."],
  ["3. adımda bitti.", "üçüncü adımda bitti."], ["Açı 30° oldu.", "Açı otuz derece oldu."],
  ["Sıcaklık 25 °C.", "Sıcaklık yirmi beş santigrat derece."], ["Direnç 10 kΩ.", "Direnç on kiloohm."],
  ["Hız 2 m/s olur.", "Hız iki metre bölü saniye olur."], ["Sonuç ≈ 2", "Sonuç yaklaşık iki"],
  ["ör. kapasitör", "örneğin kapasitör"], ["direnç, bobin vb. elemanlar", "direnç, bobin ve benzeri elemanlar"],
  ["Oran 1/4 olur.", "Oran bir bölü dört olur."], ["Değer -5 çıktı.", "Değer eksi beş çıktı."], ["τ küçükse", "tau küçükse"],
  ["a → b", "a, b"], ["5 ve 6", "beş ve altı"], ["2024 yılında", "iki bin yirmi dört yılında"],
];
for (const [s, w] of PLAIN) t("düz " + s, () => assert.equal(plainSpeech(s, "tr"), w));

// ---- Markdown yapısı
t("başlık ve kalın", () => assert.equal(speak("## Giriş\n\nBu **çok önemli** bir *nokta*."), "Giriş | Bu çok önemli bir nokta."));
t("numaralı liste", () => assert.equal(speak("1. Birinci iş\n2. İkinci iş"), "Bir. Birinci iş | İki. İkinci iş"));
t("liste başlangıcı", () => assert.equal(speak("3. Üçüncü\n4. Dördüncü"), "Üç. Üçüncü | Dört. Dördüncü"));
t("madde imli liste", () => assert.equal(speak("- elma\n- armut"), "elma | armut"));
t("iç içe liste", () => assert.equal(speak("1. Ana\n   - alt madde"), "Bir. Ana | alt madde"));
t("bağlantı", () => assert.equal(speak("Bkz. [kaynak](https://ornek.com/x) sayfası."), "Bkz. kaynak sayfası."));
t("kod bloğu", () => assert.equal(speak("Örnek:\n\n```python\nprint(1)\n```"), "Örnek: | Kod örneği."));
t("json bloğu okunmaz", () => assert.equal(speak("Metin.\n\n```json\n{\"a\": 1}\n```"), "Metin."));
t("bilinmeyen dil okunmaz", () => assert.equal(speak("A.\n\n```dersapp-mark\nx\n```"), "A."));
t("dilsiz JSON okunmaz", () => assert.equal(speak("A.\n\n```\n{\"a\":1}\n```"), "A."));
t("math çiti formül olarak okunur", () => assert.equal(speak("```math\n\\frac{1}{2}\n```"), "bir bölü iki"));
t("satır içi kod", () => assert.equal(speak("`np.roots` fonksiyonu"), "np roots fonksiyonu"));
t("yatay çizgi", () => assert.equal(speak("A.\n\n---\n\nB."), "A. | B."));
t("html", () => assert.equal(speak("Merhaba <b>dünya</b> <script>alert(1)</script>"), "Merhaba dünya"));
t("tablo", () => assert.equal(speak("| Büyüklük | Değer |\n|---|---|\n| $K$ | 2,5 |\n| $\\tau$ | 0,5 s |"),
  "Büyüklük: ka; Değer: iki virgül beş. | Büyüklük: tau; Değer: sıfır virgül beş saniye."));
t("alıntı", () => assert.equal(speak("> Not: dikkat."), "Not: dikkat."));
t("cümlelere bölme", () => assert.equal(toSpeech("Birinci cümle. İkinci cümle! Üçüncü mü? Evet.").length, 4));
t("kısaltmada bölme yok", () => assert.equal(toSpeech("Direnç, bobin vb. Elemanlar var.").length, 1));
t("ondalıkta bölme yok", () => assert.equal(toSpeech("Değer 2.5 oldu. Sonra bitti.").length, 2));
t("blok formül ayrı parça", () => assert.equal(speak("Formül şu:\n$$x^2$$\nBu kadar."), "Formül şu: | iks kare | Bu kadar."));
t("ek: 'nin", () => assert.equal(speak("$G(s)$'nin kutbu"), "ge se'nin kutbu"));
t("ek: 'i", () => assert.equal(speak("$x$'i bul"), "iks'i bul"));
t("ek: 'yu", () => assert.equal(speak("$\\tau$'yu hesapla"), "tau'yu hesapla"));
t("tire: s-düzlemi", () => assert.equal(speak("$s$-düzleminde"), "se düzleminde"));
t("para birimi formül değil", () => assert.equal(speak("Ücret 5 $ ve 10 $ arası."), "Ücret beş dolar ve on dolar arası."));
t("\\( \\) ve \\[ \\]", () => assert.equal(speak("Değer \\(x^2\\) olur.\n\n\\[\\frac{1}{4}\\]"), "Değer iks kare olur. | bir bölü dört"));
t("kaçışlı dolar", () => assert.equal(speak("Fiyat \\$5 civarı."), "Fiyat beş dolar civarı."));
t("eşleşme anahtarı", () => {
  const s = toSpeech("Kutup $s=-2$ olur.");
  assert.equal(s[0].match, "Kutup\uFFFColur.");
  assert.ok(s[0].start === 0 && s[0].end > 10);
});
t("uzun cümle bölünür", () => {
  const long = Array.from({ length: 30 }, (_, i) => `madde ${i}`).join(", ") + ".";
  const s = toSpeech(long);
  assert.ok(s.length >= 2 && s.every((x) => x.text.length <= 230));
});
t("dil tahmini", () => {
  assert.equal(guessLang("Bu bir transfer fonksiyonu ve kutbu şurada."), "tr");
  assert.equal(guessLang("This is the transfer function and the pole is at minus two, so the system is stable with a fast response."), "en");
});
t("İngilizce formül", () => {
  assert.equal(texToSpeech("\\frac{1}{4}", "en"), "one over four");
  assert.equal(texToSpeech("x^2", "en"), "x squared");
  assert.equal(texToSpeech("\\sqrt{2}", "en"), "the square root of two");
  assert.equal(texToSpeech("\\int_0^1 x\\,dx", "en"), "the integral from zero to one of, x d x");
  assert.equal(texToSpeech("\\lim_{x\\to 0} f(x)", "en"), "the limit as x approaches zero, of, f x");
});

// ---- Gerçekçi paragraflar: ham simge kalmamalı, beklenen ifadeler geçmeli
const PARAS: [string, string[]][] = [
  ["Birinci dereceden sistemin transfer fonksiyonu $G(s) = \\frac{K}{\\tau s + 1}$ şeklindedir. Burada $K$ kazanç, $\\tau$ ise zaman sabitidir.",
    ["ge se eşittir pay ka, bölü payda tau se artı bir", "Burada ka kazanç, tau ise zaman sabitidir."]],
  ["Birim basamak yanıtı $y(t) = K\\left(1 - e^{-t/\\tau}\\right)$ olur. $t = \\tau$ anında çıkış son değerin %63'üne ulaşır.",
    ["ye te eşittir ka parantez içinde bir eksi e üzeri eksi te bölü tau, parantez kapa", "yüzde altmış üç"]],
  ["İkinci dereceden sistemde $\\omega_n$ doğal frekans, $\\zeta$ sönüm oranıdır: $$G(s) = \\frac{\\omega_n^2}{s^2 + 2\\zeta\\omega_n s + \\omega_n^2}$$",
    ["omega alt ne doğal frekans, zeta sönüm oranıdır", "pay omega alt ne kare, bölü payda se kare artı iki zeta omega alt ne se artı omega alt ne kare"]],
  ["Aşım oranı $M_p = e^{-\\zeta\\pi/\\sqrt{1-\\zeta^2}}$ formülüyle bulunur.", ["me alt pe eşittir e üzeri eksi zeta pi bölü karekök içinde bir eksi zeta kare"]],
  ["RC devresinde zaman sabiti $\\tau = RC$ dir. $R = 10\\,\\mathrm{k\\Omega}$ ve $C = 100\\,\\mu\\text{F}$ ise $\\tau = 1\\,\\text{s}$ olur.",
    ["tau eşittir re ce", "re eşittir on kiloohm", "ce eşittir yüz mikrofarad", "tau eşittir bir saniye"]],
  ["Empedans $Z = R + j\\omega L$ olarak yazılır; fazör gösteriminde $V = 10\\angle 30^\\circ\\,\\text{V}$ olur.",
    ["ze eşittir re artı je omega le", "ve eşittir on, açı otuz derece volt"]],
  ["Laplace dönüşümü $F(s) = \\int_0^\\infty f(t)e^{-st}\\,dt$ ile tanımlanır.", ["ef se eşittir integral, sıfırdan sonsuza, ef te e üzeri eksi se te, de te"]],
  ["Türev için $\\frac{d}{dx}x^n = n x^{n-1}$ kuralını kullan. Örneğin $\\frac{d}{dx}x^3 = 3x^2$ olur.",
    ["de bölü de iks iks üzeri ne eşittir ne iks üzeri ne eksi bir", "de bölü de iks iks küp eşittir üç iks kare"]],
  ["Limit $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$ temel bir sonuçtur.", ["limit, iks giderken sıfıra, sinüs iks bölü iks eşittir bir"]],
  ["Son değer teoremi: $\\lim_{t\\to\\infty} y(t) = \\lim_{s\\to 0} sY(s)$. Burada $s$'nin sıfıra gitmesi gerekir.",
    ["limit, te giderken sonsuza, ye te eşittir limit, se giderken sıfıra, se büyük ye se", "se'nin sıfıra"]],
  ["Hata $e_{ss} = \\frac{1}{1 + K_p}$ olur ve $K_p = \\lim_{s \\to 0} G(s)$ tanımlıdır.",
    ["e alt kalıcı durum eşittir pay bir, bölü payda bir artı ka alt pe", "ka alt pe eşittir limit, se giderken sıfıra, ge se"]],
  ["Kesir $\\frac{1}{4}^2$ için: bir bölü dördün karesi $\\frac{1}{16}$ eder.", ["bir bölü dördün karesi için", "bir bölü on altı"]],
  ["Denklem sistemi $\\begin{bmatrix} 2 & 1 \\\\ 1 & 3 \\end{bmatrix}\\begin{bmatrix} x \\\\ y \\end{bmatrix} = \\begin{bmatrix} 5 \\\\ 10 \\end{bmatrix}$ şeklindedir.",
    ["iki satırlı, iki sütunlu matris: birinci satır: iki, bir; ikinci satır: bir, üç", "iki elemanlı sütun vektörü: iks, ye"]],
  ["Integral $\\int_0^2 3x^2\\,dx = \\left[x^3\\right]_0^2 = 8$ olur.", ["integral, sıfırdan ikiye, üç iks kare de iks eşittir", "eşittir sekiz"]],
];
PARAS.forEach(([md, wants], i) => t("paragraf " + i, () => {
  const segs = toSpeech(md);
  const all = segs.map((s) => s.text).join(" ");
  for (const w of wants) assert.ok(all.includes(w), `"${w}" yok:\n${all}`);
  for (const s of segs) assert.ok(!RAW.test(s.text), "ham simge: " + s.text);
}));

// ---- Sağlamlık: hiçbir girdi istisna fırlatmaz, ham simge kalmaz
const FUZZ = ["", "$", "$$", "$$$", "\\", "{", "}", "^_", "$\\frac{$", "$\\frac{1}{2", "$x^$", "$\\sqrt[$", "$\\begin{matrix}$",
  "$\\left($", "$\\right)$", "$|||$", "$a_{b_{c_{d}}}$", "$" + "{".repeat(200) + "x" + "}".repeat(200) + "$", "```", "| a |\n|-|\n| $|x|$ |",
  "$\\text{$}$", "\\(\\)", "\\[", "$\\unknown{a}{b}$", "$\\color{red}{x}$", "$x^{2^{3^{4}}}$", "$\\\\\\\\$", "<script>$x$</script>",
  "$\\mathbb{}$", "$\\mathcal{}$", "$\\operatorname{}$", "$\\sum_{}^{}$", "$\\lim_{}$", "$\\int_{}^{}$"];
for (const f of FUZZ) t("fuzz " + JSON.stringify(f).slice(0, 30), () => {
  const segs = toSpeech(f);
  for (const s of segs) assert.ok(!RAW.test(s.text), JSON.stringify(f) + " -> " + s.text);
});
t("rastgele girdi", () => {
  const chars = "\\{}^_$&|()[]abxyz0123+-=,.' \nfrac sqrt text left right begin end".split("");
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; k < 400; k++) {
    let s = "";
    const len = Math.floor(rnd() * 60);
    for (let i = 0; i < len; i++) s += chars[Math.floor(rnd() * chars.length)];
    for (const seg of toSpeech("$" + s + "$ ve " + s)) assert.ok(!RAW.test(seg.text), s + " -> " + seg.text);
    assert.equal(typeof texToSpeech(s), "string");
  }
});

if (failed) {
  console.error(`tts-text: ${failed} doğrulama BAŞARISIZ (${count} geçti)`);
  throw new Error("tts-text testleri başarısız");
}
console.log(`tts-text: ${count} doğrulama geçti`);
