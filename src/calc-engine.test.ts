// Çalıştırma: node src/calc-engine.test.ts
import assert from "node:assert/strict";
import { CalcError, evaluate, formatResult } from "./calc-engine.ts";

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

console.log(`${count} doğrulama geçti`);
