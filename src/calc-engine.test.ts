// Çalıştırma: node src/calc-engine.test.ts
import assert from "node:assert/strict";
import {
  CalcError, type CalcOptions, type Complex, type FormatOptions, calc, evaluate, formatBases, formatEng,
  formatResult, formatValue, isValidVarName,
} from "./calc-engine.ts";

let count = 0;
const D = { degrees: true, ans: 0 };
const R = { degrees: false, ans: 0 };

function eq(expr: string, want: number, opts = D): void {
  const got = evaluate(expr, opts);
  assert.ok(Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)), `${expr}: ${got} != ${want}`);
  count++;
}
function err(expr: string, re: RegExp, opts = D): void {
  assert.throws(() => evaluate(expr, opts), (e: unknown) => e instanceof CalcError && re.test(e.message), `${expr} hata vermeli`);
  count++;
}
function fmt(n: number, want: string): void {
  assert.equal(formatResult(n), want);
  count++;
}

// Temel işlemler ve öncelik
eq("1+2", 3); eq("5-8", -3); eq("3*4", 12); eq("8/4", 2);
eq("6×7", 42); eq("9÷3", 3); eq("2+3*4", 14); eq("(2+3)*4", 20);
eq("10-2-3", 5); eq("100/10/5", 2);
// Kuvvet
eq("2^10", 1024); eq("2^3^2", 512); eq("-2^2", -4); eq("(-2)^2", 4); eq("2^-1", 0.5);
// Tekli işaret
eq("-5+2", -3); eq("--3", 3); eq("3*-2", -6);
// Yüzde ve faktöriyel
eq("50%", 0.5); eq("200*10%", 20); eq("5!", 120); eq("0!", 1); eq("3!+1", 7); eq("2^3!", 64);
// Ondalık ayırıcılar
eq("3,5+1.5", 5); eq(",5+.5", 1); eq("1,25*4", 5);
// Örtük çarpma
eq("2pi", 2 * Math.PI); eq("3(4+5)", 27); eq("(1+2)(3+4)", 21); eq("2sqrt(9)", 6);
eq("2π", 2 * Math.PI); eq("2sqrt(9)+3,5", 9.5); eq("2e", 2 * Math.E);
// Sabitler
eq("pi", Math.PI); eq("π", Math.PI); eq("e", Math.E); eq("ans*2", 14, { degrees: true, ans: 7 });
eq("ANS+1", 4, { degrees: true, ans: 3 });
// Bilimsel gösterim girdisi
eq("1.5e3", 1500); eq("2e-3", 0.002); eq("1e3+1", 1001); eq("2E+2", 200);
// Fonksiyonlar
eq("sqrt(16)", 4); eq("√16", 4); eq("√(9+16)", 5); eq("cbrt(27)", 3); eq("abs(-4)", 4);
eq("ln(e)", 1); eq("log(1000)", 3); eq("log2(8)", 3); eq("exp(0)", 1);
eq("round(2.5)", 3); eq("floor(-1.2)", -2); eq("ceil(1.2)", 2);
eq("sinh(0)", 0); eq("cosh(0)", 1); eq("tanh(0)", 0);
// Trigonometri: derece / radyan
eq("sin(30)", 0.5); eq("cos(60)", 0.5); eq("tan(45)", 1); eq("sin(180)", 0); eq("cos(90)", 0);
eq("sin(pi/6)", 0.5, R); eq("cos(pi)", -1, R); eq("sin(30)", Math.sin(30), R);
eq("asin(0.5)", 30); eq("acos(0.5)", 60); eq("atan(1)", 45); eq("atan(1)", Math.PI / 4, R);
eq("sin30", 0.5);
// Hatalar
err("1/0", /Sıfıra bölme/); err("0^-1", /Sıfıra bölme/);
err("sqrt(-1)", /Tanımsız/); err("ln(0)", /Tanımsız/); err("log(-5)", /Tanımsız/);
err("asin(2)", /Tanımsız/); err("tan(90)", /Tanımsız/); err("(-8)^0.5", /Tanımsız/);
err("(1+2", /Parantez kapatılmadı/); err("1+2)", /Fazla/);
err("foo+1", /Bilinmeyen ad: foo/); err("", /boş/); err("   ", /boş/);
err("2+", /eksik/); err("2 $ 3", /Geçersiz karakter/); err("(-1)!", /Faktöriyel/);
err("171!", /büyük/); err("10^400", /büyük/); err("2 3", /anlaşılamadı/);
// Hata nesnesi
assert.ok(new CalcError("x") instanceof Error); count++;
// Biçimlendirme
fmt(evaluate("0.1+0.2", D), "0.3"); fmt(1 / 3, "0.333333333333"); fmt(0, "0");
fmt(1e15, "1e15"); fmt(1.5e-9, "1.5e-9"); fmt(123456789012, "123456789012");
fmt(-2.5, "-2.5"); fmt(evaluate("sin(30)", D), "0.5"); fmt(evaluate("1.5e20", D), "1.5e20");
fmt(Infinity, "Tanımsız");


// ====================================================================== Yeni motor
const CD: CalcOptions = { degrees: true, ans: 0 };
const CR: CalcOptions = { degrees: false, ans: 0 };
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** Karmaşık sonuç: expr ≈ re + im·i */
function ceq(expr: string, re: number, im: number, opts: CalcOptions = CD, tol = 1e-9): void {
  const { value } = calc(expr, opts);
  assert.ok(!Array.isArray(value), `${expr}: liste değil`);
  const z = value as Complex;
  assert.ok(near(z.re, re, tol) && near(z.im, im, tol), `${expr}: ${z.re}+${z.im}i != ${re}+${im}i`);
  count++;
}
/** Biçimlenmiş sonuç metni */
function show(expr: string, want: string, f: FormatOptions = {}, opts: CalcOptions = CD): void {
  assert.equal(formatValue(calc(expr, opts).value, { degrees: opts.degrees, ...f }), want, expr);
  count++;
}
/** Hata: ileti ve (verilirse) konum [pos, end) */
function cerr(expr: string, re: RegExp, pos?: number, end?: number, opts: CalcOptions = CD): void {
  let caught: unknown;
  try {
    calc(expr, opts);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof CalcError)) throw new Error(`${expr} hata vermeli`);
  assert.ok(re.test(caught.message), `${expr}: "${caught.message}" ${re} ile eşleşmedi`);
  if (pos !== undefined) assert.equal(caught.pos, pos, `${expr}: konum ${caught.pos} != ${pos}`);
  if (end !== undefined) assert.equal(caught.end, end, `${expr}: bitiş ${caught.end} != ${end}`);
  count++;
}

// --- Karmaşık sayı girişi: i / j, j5, bitişik birim
ceq("3+4j", 3, 4); ceq("3+4i", 3, 4); ceq("2i", 0, 2); ceq("j5", 0, 5); ceq("i2.5", 0, 2.5);
ceq("j", 0, 1); ceq("i", 0, 1); ceq("-j", 0, -1); ceq("2.5j", 0, 2.5); ceq("2j*2", 0, 4);
ceq("1/2j", 0, -0.5); ceq("j*j", -1, 0); ceq("j^2", -1, 0); ceq("i^3", 0, -1); ceq("i^4", 1, 0);
ceq("(3+4j)*(1-2j)", 11, -2); ceq("(3+4j)/(1-2j)", -1, 2); ceq("(1+j)^2", 0, 2); ceq("(1+j)^-1", 0.5, -0.5);
ceq("(3+4j)-(1+1j)", 2, 3); ceq("2(3+j)", 6, 2); ceq("(2+j)(2-j)", 5, 0); ceq("j(2)", 0, 2);
ceq("1e3j", 0, 1000); ceq("2,5j", 0, 2.5); ceq("j2j", -2, 0);
// --- Kökler, üsler, logaritma
ceq("sqrt(-4)", 0, 2); ceq("sqrt(-1)", 0, 1); ceq("√-9", 0, 3); ceq("sqrt(2j)", 1, 1); ceq("sqrt(3+4j)", 2, 1);
ceq("sqrt(-3-4j)", 1, -2); ceq("e^(i*pi)", -1, 0); ceq("e^(j·π)", -1, 0); ceq("exp(j*pi/2)", 0, 1);
ceq("exp(1+j*pi)", -Math.E, 0); ceq("ln(-1)", 0, Math.PI); ceq("ln(j)", 0, Math.PI / 2); ceq("ln(-e)", 1, Math.PI);
ceq("log(-100)", 2, Math.PI / Math.LN10); ceq("i^i", Math.exp(-Math.PI / 2), 0); ceq("2^j", Math.cos(Math.LN2), Math.sin(Math.LN2));
ceq("(-8)^(1/3)", 1, Math.sqrt(3)); ceq("(-1)^0.5", 0, 1); ceq("(-2)^2", 4, 0); ceq("cbrt(-8)", -2, 0);
// --- Karmaşık trigonometri / hiperbolik (radyan)
ceq("sin(j)", 0, Math.sinh(1), CR); ceq("cos(j)", Math.cosh(1), 0, CR); ceq("sin(1+j)", Math.sin(1) * Math.cosh(1), Math.cos(1) * Math.sinh(1), CR);
ceq("cos(1+j)", Math.cos(1) * Math.cosh(1), -Math.sin(1) * Math.sinh(1), CR); ceq("tan(j)", 0, Math.tanh(1), CR);
ceq("sinh(j*pi/2)", 0, 1, CR); ceq("cosh(j*pi)", -1, 0, CR); ceq("tanh(j*pi/4)", 0, 1, CR);
ceq("asin(2)", Math.PI / 2, -Math.log(2 + Math.sqrt(3)), CR, 1e-9); ceq("sin(asin(2))", 2, 0, CR);
ceq("acos(2)", 0, Math.log(2 + Math.sqrt(3)), CR); ceq("cos(acos(3+j))", 3, 1, CR); ceq("tan(atan(1+2j))", 1, 2, CR);
ceq("asinh(1)", Math.asinh(1), 0); ceq("acosh(0.5)", 0, Math.acos(0.5)); ceq("atanh(2)", 0.5 * Math.log(3), Math.PI / 2, CR);
ceq("sinh(asinh(2+j))", 2, 1); ceq("cosh(acosh(-3))", -3, 0);
// --- Karmaşık yardımcı fonksiyonlar
ceq("abs(3+4j)", 5, 0); ceq("abs(-7)", 7, 0); ceq("arg(j)", 90, 0); ceq("arg(j)", Math.PI / 2, 0, CR); ceq("angle(-1)", 180, 0);
ceq("arg(1-j)", -45, 0); ceq("arg(0)", 0, 0); ceq("conj(3+4j)", 3, -4); ceq("re(3+4j)", 3, 0); ceq("im(3+4j)", 4, 0);
ceq("polar(2; 90)", 0, 2); ceq("polar(2; pi/2)", 0, 2, CR); ceq("polar(1; 180)", -1, 0); ceq("(3+4j)*conj(3+4j)", 25, 0);
ceq("round(2.4+3.6j)", 2, 4); ceq("floor(1.5-1.5j)", 1, -2);
// --- Kutupsal giriş (∠ ve <), DEG / RAD, °
ceq("5∠30", 5 * Math.cos(Math.PI / 6), 2.5); ceq("5<30", 5 * Math.cos(Math.PI / 6), 2.5); ceq("2∠90", 0, 2); ceq("1∠180", -1, 0);
ceq("10∠-45", 10 * Math.SQRT1_2, -10 * Math.SQRT1_2); ceq("5∠53.13010235415598", 3, 4); ceq("2∠(pi/2)", 0, 2, CR); ceq("2∠pi/2", -1, 0, CR); // ∠ çarpmadan sıkı bağlar
ceq("2∠90°", 0, 2, CR); ceq("1∠30°", Math.cos(Math.PI / 6), 0.5, CR); ceq("1∠30°", Math.cos(Math.PI / 6), 0.5);
ceq("10∠0 + 10∠90", 10, 10); ceq("2*5∠30", 10 * Math.cos(Math.PI / 6), 5); ceq("(10∠30)/(2∠-60)", 0, 5); ceq("-5∠0", -5, 0);
ceq("sin(90°)", 1, 0, CR); ceq("30°", Math.PI / 6, 0, CR); ceq("30°", 30, 0);
// --- Sonuç gösterimi: dikdörtgen / kutupsal / gürültü temizliği
show("3+4j", "3 + 4i"); show("3-4j", "3 - 4i"); show("3+4j", "3 + 4j", { unit: "j" }); show("2j", "2i"); show("-j", "-i");
show("j", "i"); show("sqrt(-4)", "2i"); show("e^(i*pi)", "-1"); show("exp(j*pi/2)", "i"); show("(1+j)^2", "2i");
show("3+4j", "5∠53.1301023542°", { polar: true }); show("3+4j", "5∠0.927295218002", { polar: true }, CR);
show("-1-j", "1.41421356237∠-135°", { polar: true }); show("5∠30", "5∠30°", { polar: true }); show("2", "2", { polar: true });
show("1/3+j/3", "0.333333333333 + 0.333333333333i"); show("1e-9j+1", "1 + 1e-9·i"); show("4.7k+2.2k*j", "4.7k + 2.2k·i", { eng: true }); show("4.7k + 2.2k·i", "4.7k + 2.2k·i", { eng: true });
show("0.5j", "0.5i"); show("1+1e-20j", "1");
// --- Paralel bağlama: par() ve ||
ceq("par(10; 10)", 5, 0); ceq("par(6; 3)", 2, 0); ceq("par(10; 5+5j)", 4, 2); ceq("10 || 10", 5, 0); ceq("6||3||2", 1, 0);
ceq("par(1k; 1k; 1k)", 1000 / 3, 0); ceq("2 + 6||3", 4, 0); ceq("(2+6)||8", 4, 0); ceq("par(0; 5)", 0, 0);
ceq("par(-10j; 10)", 5, -5); ceq("2*3||6", 3, 0); show("par(10; 5+5j)", "4 + 2i"); show("par(10; 5+5j)", "4.472135955∠26.5650511771°", { polar: true });
cerr("par(10j; -10j)", /rezonans/); cerr("10j || -10j", /rezonans/, 4, 6);
// --- Çok argümanlı fonksiyonlar
eq("nCr(5; 2)", 10); eq("ncr(10;3)", 120); eq("nCr(52; 5)", 2598960); eq("nCr(3; 5)", 0); eq("nPr(5; 2)", 20); eq("nPr(10; 0)", 1);
eq("mod(7; 3)", 1); eq("mod(-7; 3)", 2); eq("mod(7; -3)", -2); eq("mod(5,5; 2)", 1.5);
eq("gcd(12; 18)", 6); eq("obeb(12; 18; 8)", 2); eq("lcm(4; 6)", 12); eq("okek(2; 3; 4)", 12); eq("gcd(0; 5)", 5);
eq("min(3; -1; 2)", -1); eq("max(3; -1; 2)", 3); eq("min(4)", 4);
eq("log(8; 2)", 3); eq("log(81; 3)", 4); eq("log(100)", 2); eq("root(27; 3)", 3); eq("root(-8; 3)", -2); eq("root(16; 4)", 2);
eq("atan2(1; 1)", 45); eq("atan2(1; -1)", 135); eq("atan2(-1; 0)", -Math.PI / 2, R);
eq("hypot(3; 4)", 5); eq("hypot(1; 2; 2)", 3); ceq("hypot(3+4j; 0)", 5, 0);
eq("deg(pi)", 180); eq("rad(180)", Math.PI); eq("deg(rad(37))", 37);
eq("max(1;2)+min(3;4)*2", 8); eq("2nCr(4;2)", 12);
ceq("root(-4; 2)", 0, 2); ceq("log(-1; e)", 0, Math.PI);
cerr("nCr(2.5; 1)", /tam sayı/); cerr("nCr(-1; 1)", /negatif/); cerr("mod(1; 0)", /Sıfıra bölme/); cerr("min(1; j)", /karmaşık/);
cerr("log(5; 1)", /tabanı 1/); cerr("root(4; 0)", /Tanımsız/); cerr("nCr(5)", /2 argüman/, 0, 3); cerr("sin(30; 2)", /1 argüman/, 0, 3);
cerr("nCr 5", /parantez gerekli/); cerr("max()", /en az 1/); cerr("(1; 2)", /fonksiyon argüman/, 2, 3); cerr("1; 2", /fonksiyon argüman/, 1, 2);
// --- Polinom kökleri
function roots(expr: string, want: [number, number][], opts: CalcOptions = CD): void {
  const { value } = calc(expr, opts);
  if (!Array.isArray(value)) throw new Error(`${expr}: liste olmalı`);
  assert.equal(value.length, want.length, `${expr}: kök sayısı`);
  want.forEach(([re, im], k) => assert.ok(near(value[k].re, re, 1e-9) && near(value[k].im, im, 1e-9), `${expr}[${k}]: ${value[k].re}+${value[k].im}i`));
  count++;
}
roots("roots(1; 2; 5)", [[-1, 2], [-1, -2]]); roots("roots(1; -6; 11; -6)", [[1, 0], [2, 0], [3, 0]]);
roots("roots(1; -3; 2)", [[1, 0], [2, 0]]); roots("roots(2; -4)", [[2, 0]]); roots("roots(1; 0; 1)", [[0, 1], [0, -1]]);
roots("roots(1; 0; -4)", [[-2, 0], [2, 0]]); roots("roots(1; -2; 1)", [[1, 0], [1, 0]]); roots("roots(1; 0; 0)", [[0, 0], [0, 0]]);
roots("roots(1; -3; 3; -1)", [[1, 0], [1, 0], [1, 0]]); roots("roots(1; -4; 6; -4; 1)", [[1, 0], [1, 0], [1, 0], [1, 0]]);
roots("roots(1; -5; 8; -4)", [[1, 0], [2, 0], [2, 0]]); roots("roots(1; 0; 0; 0; -1)", [[-1, 0], [1, 0], [0, 1], [0, -1]]);
roots("roots(1; 0; 0; -8)", [[2, 0], [-1, Math.sqrt(3)], [-1, -Math.sqrt(3)]]); roots("roots(0; 1; -1)", [[1, 0]]);
roots("roots(1; -10; 35; -50; 24)", [[1, 0], [2, 0], [3, 0], [4, 0]]); roots("roots(1; 0; -1; 0)", [[-1, 0], [0, 0], [1, 0]]);
roots("roots(1; -2.0005; 1.0005)", [[1, 0], [1.0005, 0]]); roots("roots(1; -5.0005; 7.002; -3.0015)", [[1, 0], [1.0005, 0], [3, 0]]);
roots("roots(1; -2j; -1)", [[0, 1], [0, 1]]); roots("roots(1; -(3+j); 2+2j)", [[2, 0], [1, 1]]);
roots("roots(1; -21; 175; -735; 1624; -1764; 720)", [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]]);
show("roots(1; 2; 5)", "-1 + 2i; -1 - 2i"); show("roots(1; -6; 11; -6)", "1; 2; 3");
cerr("roots(0; 0; 0)", /Tüm katsayılar sıfır/); cerr("roots(0; 5)", /sabit/); cerr("2*roots(1; 2)", /tek başına/, 2, 7);
cerr("r = roots(1; 2)", /atanamaz/, 0, 1); cerr("roots(1)", /en az 2|2–31/);
// --- Değişkenler ve atama
const vars: Record<string, Complex> = { R1: { re: 4700, im: 0 }, R2: { re: 2200, im: 0 }, Z: { re: 3, im: 4 }, x: { re: 2, im: 0 } };
const V: CalcOptions = { degrees: true, ans: 0, vars };
ceq("R1 + R2", 6900, 0, V); ceq("R1 || R2", (4700 * 2200) / 6900, 0, V); ceq("abs(Z)", 5, 0, V); ceq("2R1", 9400, 0, V);
ceq("x^2", 4, 0, V); ceq("2x", 4, 0, V); ceq("Z*j", -4, 3, V);
{
  const r = calc("R3 = 4.7k", V);
  assert.equal(r.assigned, "R3"); count++;
  assert.equal((r.value as Complex).re, 4700); count++;
  const r2 = calc("Zl = 2+3j", V);
  assert.equal(r2.assigned, "Zl"); assert.ok(JSON.stringify(r2.value) === JSON.stringify({ re: 2, im: 3 })); count++;
  assert.equal(calc("R1", V).assigned, undefined); count++;
}
ceq("V_out = R1/1k", 4.7, 0, V); ceq("ans*2", 0, 4, { degrees: true, ans: { re: 0, im: 2 } });
cerr("r1 + 1", /Bilinmeyen ad: r1/, 0, 2, V); cerr("sin = 3", /fonksiyon adı/, 0, 3); cerr("pi = 3", /sabit/, 0, 2);
cerr("PI = 3", /sabit/); cerr("e = 1", /sabit/); cerr("j = 1", /sabit/); cerr("ans = 1", /sabit/); cerr("nCr = 2", /fonksiyon adı/);
cerr("x =", /eksik/); cerr("1 + x = 3", /Atama yalnızca başta/, 6, 7, V); cerr("j5 = 3", /Beklenmeyen|anlaşılamadı|Atama/);
assert.ok(isValidVarName("R1") && isValidVarName("Vout") && isValidVarName("x_1") && isValidVarName("I1")); count++;
assert.ok(!isValidVarName("sin") && !isValidVarName("i") && !isValidVarName("1a") && !isValidVarName("sin1") && !isValidVarName("a b")); count++;
ceq("I1 = 2", 2, 0); ceq("I", 7, 0, { degrees: true, ans: 0, vars: { I: { re: 7, im: 0 } } }); // büyük I değişkendir
// --- SI önekleri
eq("4.7k", 4700); eq("10M", 1e7); eq("100n", 1e-7); eq("22u", 22e-6); eq("22µ", 22e-6); eq("22μ", 22e-6);
eq("3m", 0.003); eq("2p", 2e-12); eq("1G", 1e9); eq("1T", 1e12); eq("5f", 5e-15); eq("4k7", 4700); eq("2n2", 2.2e-9);
eq("1M5", 1.5e6); eq("2,2k", 2200); eq("1k+1", 1001); eq("2k(3)", 6000); eq("1/(2*pi*1k*100n)", 1 / (2 * Math.PI * 1e-4));
eq("1.5e3k", 1.5e6); eq("10m*10M", 1e5);
ceq("3m", 0.003, 0, { degrees: true, ans: 0, vars: { m: { re: 5, im: 0 } } }); // önek, m değişkenine üstün gelir
ceq("3*m", 15, 0, { degrees: true, ans: 0, vars: { m: { re: 5, im: 0 } } }); ceq("3 m", 15, 0, { degrees: true, ans: 0, vars: { m: { re: 5, im: 0 } } });
ceq("2kpi", 0, 0, { degrees: true, ans: 0, vars: { kpi: { re: 0, im: 0 } } }); cerr("2mA", /Bilinmeyen ad: mA/, 1, 3);
eq("2pi", 2 * Math.PI); eq("2e", 2 * Math.E); // p ve e burada önek/üs değil
// --- Mühendislik gösterimi
const engShow = (n: number, want: string) => { assert.equal(formatEng(n), want); count++; };
engShow(4700, "4.7k"); engShow(1500, "1.5k"); engShow(0.0047, "4.7m"); engShow(22e-6, "22µ"); engShow(1e-7, "100n");
engShow(1e7, "10M"); engShow(999.9999999999999, "1k"); engShow(1, "1"); engShow(0, "0"); engShow(-2.2e-9, "-2.2n");
engShow(1e18, "1e18"); engShow(3.3e-18, "3.3e-18"); engShow(123456, "123.456k"); engShow(0.1, "100m"); engShow(1e3, "1k");
show("4.7k*2", "9.4k", { eng: true }); show("1/(2*pi*1k*100n)", "1.59154943092k", { eng: true });
// --- Taban dönüşümleri
eq("0xFF", 255); eq("0xff", 255); eq("0b1010", 10); eq("0o17", 15); eq("0x10+0b11", 19); eq("2*0x0A", 20);
eq("0B11", 3); eq("0X1f", 31);
cerr("0b102", /geçersiz basamak/, 4, 5); cerr("0o9", /Bilinmeyen ad|anlaşılamadı/);
const bases = (expr: string, hex: string | null, bin?: string) => {
  const b = formatBases(calc(expr, CD).value);
  if (hex === null) assert.equal(b, null, expr);
  else { assert.equal(b?.hex, hex, expr); if (bin) assert.equal(b?.bin, bin, expr); }
  count++;
};
bases("255", "0xFF", "0b1111 1111"); bases("10", "0xA", "0b1010"); bases("-10", "-0xA", "-0b1010"); bases("0", "0x0", "0b0");
bases("2.5", null); bases("3+4j", null); bases("roots(1;-3;2)", null); bases("0.1+0.2+0.7", "0x1"); bases("4096", "0x1000", "0b1 0000 0000 0000");
// --- Sayısal türev ve integral
ceq("deriv(x^2; x; 3)", 6, 0, CD, 1e-7); ceq("deriv(x^3; x; 2)", 12, 0, CD, 1e-7); ceq("deriv(sin(x); x; 0)", 1, 0, CR, 1e-7);
ceq("deriv(sin(x); x; 0)", 1, 0, CD, 1e-7); ceq("integ(sin(x); x; 0; pi)", 2, 0, CD); ceq("sin(90)", 1, 0, CD); ceq("sin(90)", Math.sin(90), 0, CR);
ceq("integ(deriv(sin(t); t; x); x; 0; pi/2)", 1, 0, CD, 1e-6); ceq("deriv(sin(x); x; 0)+sin(90)", 2, 0, CD, 1e-7); ceq("deriv(exp(x); x; 1)", Math.E, 0, CR, 1e-7);
ceq("deriv(ln(x); x; 0.01)", 100, 0, CR, 1e-6); ceq("deriv(1/x; x; 2)", -0.25, 0, CR, 1e-7); ceq("deriv(t^2+3t; t; 1)", 5, 0, CR, 1e-7);
ceq("deriv(abs(x); x; 2)", 1, 0, CR, 1e-7); ceq("deriv(R1*x; x; 5)", 4700, 0, V, 1e-7); ceq("deriv(x^2; x; 1)", 2, 0, V, 1e-7);
ceq("deriv(exp(j*x); x; 0)", 0, 1, CR, 1e-7);
ceq("integ(x^2; x; 0; 3)", 9, 0); ceq("integ(sin(x); x; 0; pi)", 2, 0, CR); ceq("integ(1/x; x; 1; e)", 1, 0);
ceq("integ(exp(-x^2); x; -10; 10)", Math.sqrt(Math.PI), 0); ceq("integ(1/sqrt(x); x; 0; 1)", 2, 0, CD, 1e-8);
ceq("integ(abs(x-0.3); x; 0; 1)", 0.29, 0); ceq("integ(x; x; 3; 1)", -4, 0); ceq("integ(5; x; 0; 2)", 10, 0); ceq("integ(x; x; 2; 2)", 0, 0);
ceq("integ(sqrt(1-x^2); x; -1; 1)", Math.PI / 2, 0, CD, 1e-8); ceq("integ(deriv(t^2; t; x); x; 0; 1)", 1, 0, CD, 1e-6);
ceq("integ(exp(j*x); x; 0; pi)", 0, 2, CR);
cerr("integ(1/x; x; -1; 1)", /x = 0 noktasında tanımsız/, 0, 5); cerr("integ(1/x; x; 0; 1)", /ıraksak/, 0, 5);
cerr("deriv(abs(x); x; 0)", /Türev yok/, 0, 5); cerr("deriv(ln(x); x; 0)", /Türev tanımsız.*x = 0/); cerr("deriv(1/x; x; 0)", /Türev tanımsız/);
cerr("deriv(x^2; 3; 1)", /değişken adı/, 11, 12); cerr("deriv(x^2; pi; 1)", /sabittir/); cerr("integ(x; x; 0; j)", /karmaşık/);
cerr("deriv(y^2; x; 1)", /Bilinmeyen ad: y/, 6, 7); cerr("deriv(x; x)", /3 argüman/);
// --- Çakışma durumları
eq("1.5e3", 1500); eq("2e3", 2000); eq("2e-3", 0.002); eq("2E3", 2000); eq("e^2", Math.E ** 2); eq("2e^2", 2 * Math.E ** 2);
eq("e2e", 0, { degrees: true, ans: 0, vars: { e2e: { re: 0, im: 0 } } } as never);
ceq("2pi j", 0, 2 * Math.PI); ceq("2j pi", 0, 2 * Math.PI); ceq("4.7kj", 0, 0, { degrees: true, ans: 0, vars: { kj: { re: 0, im: 0 } } });
ceq("2(3)j", 0, 6); ceq("j(1+j)", -1, 1); ceq("3i+4j", 0, 7); ceq("sin30", 0.5, 0); ceq("log2(8)", 3, 0); ceq("log100", 2, 0);
ceq("x2 = 4", 4, 0); ceq("xj", 0, 6, { degrees: true, ans: 0, vars: { xj: { re: 0, im: 6 } } }); cerr("xj", /Bilinmeyen ad: xj/);
ceq("SIN(30)", 0.5, 0); ceq("Pi", Math.PI, 0); ceq("ANS", 3, 0, { degrees: true, ans: 3 }); cerr("J", /Bilinmeyen ad: J/);
ceq("0x1e3", 0x1e3, 0); ceq("0xA+0xB", 21, 0); ceq("2x", 6, 0, { degrees: true, ans: 0, vars: { x: { re: 3, im: 0 } } });
ceq("1,5+2,5j", 1.5, 2.5); ceq("2||2+1", 2, 0); ceq("5∠30+5∠-30", 10 * Math.cos(Math.PI / 6), 0);
// --- Hata konumları
cerr("1+foo", /Bilinmeyen ad: foo/, 2, 5); cerr("1/0", /Sıfıra bölme/, 1, 2); cerr("(1+2", /Parantez kapatılmadı/, 0, 1);
cerr("1+2)", /Fazla/, 3, 4); cerr("2+", /eksik/, 2, 2); cerr("2 $ 3", /Geçersiz karakter/, 2, 3); cerr("2 3", /anlaşılamadı/, 2, 3);
cerr("sqrt(1/(2-2))", /Sıfıra bölme/, 6, 7); cerr("ln(0)", /Tanımsız/, 0, 2); cerr("tan(90)+1", /Tanımsız/, 0, 3);
cerr("5!+(-1)!", /Faktöriyel/, 7, 8); cerr("(1+j)!", /karmaşık/); cerr("2*)", /Beklenmeyen/, 2, 3); cerr("1 | 2", /\|\|/, 2, 3);
cerr("sin(1;2", /argüman|Parantez/); cerr("max(1; 2", /Parantez kapatılmadı/, 3, 4); cerr("10^400", /büyük/, 2, 3);
cerr("0^-1", /Sıfıra bölme/, 1, 2); cerr("0^j", /Tanımsız/);
// --- Eski arayüz (yalnız gerçek): karmaşık sonuçta "Tanımsız"
err("sqrt(-4)", /karmaşık/); err("roots(1;2)", /liste/);
assert.equal(evaluate("R1/2", { degrees: true, ans: 0, vars }), 2350); count++;

console.log(`${count} doğrulama geçti`);
