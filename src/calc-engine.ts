// Bilimsel hesap makinesi motoru: saf hesaplama, DOM yok. eval/Function kullanılmaz.
// Dilbilgisi (öncelik düşükten yükseğe):
//   ifade  = terim (("+"|"-") terim)*
//   terim  = tekli (("*"|"/"|örtük) tekli)*
//   tekli  = ("-"|"+") tekli | kuvvet          (−2^2 = −4)
//   kuvvet = sonek ("^" tekli)?                (sağdan birleşmeli: 2^3^2 = 512)
//   sonek  = birincil ("!" | "%")*
//   birincil = sayı | sabit | fonksiyon(...) | "(" ifade ")"

export class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalcError";
  }
}

export interface CalcOptions {
  degrees: boolean;
  ans: number;
}

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const FUNCS = new Set([
  "sqrt", "cbrt", "abs", "sin", "cos", "tan", "asin", "acos", "atan",
  "sinh", "cosh", "tanh", "ln", "log", "log2", "exp", "round", "floor", "ceil",
]);

const isDigit = (c: string) => c >= "0" && c <= "9";
const isLetter = (c: string) => /\p{L}/u.test(c);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (isDigit(c) || ((c === "." || c === ",") && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      let seenDot = false;
      while (j < src.length && (isDigit(src[j]) || ((src[j] === "." || src[j] === ",") && !seenDot))) {
        if (src[j] === "." || src[j] === ",") seenDot = true;
        j++;
      }
      let text = src.slice(i, j).replace(",", ".");
      // Bilimsel gösterim: 1.5e3, 2e-3 (yalnızca e'den sonra rakam geliyorsa; yoksa e sabitidir)
      const m = /^[eE]([+-]?\d+)/.exec(src.slice(j));
      if (m) {
        text += "e" + m[1];
        j += m[0].length;
      }
      out.push({ t: "num", v: Number(text) });
      i = j;
      continue;
    }
    if (c === "π") { out.push({ t: "id", v: "pi" }); i++; continue; }
    if (c === "√") { out.push({ t: "id", v: "sqrt" }); i++; continue; }
    if (isLetter(c)) {
      let j = i;
      while (j < src.length && isLetter(src[j])) j++;
      let word = src.slice(i, j).toLowerCase();
      // log2 gibi sonu rakamlı fonksiyon adları
      let k = j;
      while (k < src.length && isDigit(src[k])) k++;
      if (k > j && FUNCS.has(word + src.slice(j, k))) { word += src.slice(j, k); j = k; }
      out.push({ t: "id", v: word });
      i = j;
      continue;
    }
    if ("+-*/^()!%".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (c === "×" || c === "·") { out.push({ t: "op", v: "*" }); i++; continue; }
    if (c === "÷") { out.push({ t: "op", v: "/" }); i++; continue; }
    if (c === "−" || c === "–") { out.push({ t: "op", v: "-" }); i++; continue; }
    throw new CalcError(`Geçersiz karakter: "${c}"`);
  }
  return out;
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new CalcError("Faktöriyel yalnızca 0 ve pozitif tam sayılar için");
  if (n > 170) throw new CalcError("Sonuç çok büyük");
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function checkFinite(v: number): number {
  if (Number.isNaN(v)) throw new CalcError("Tanımsız işlem");
  if (!Number.isFinite(v)) throw new CalcError("Sonuç çok büyük");
  return v;
}

/** Çok küçük kayan nokta kalıntısını sıfırlar (sin(180°) gibi). */
const snap = (v: number) => (Math.abs(v) < 1e-15 ? 0 : v);

function callFunc(name: string, x: number, deg: boolean): number {
  const toRad = (v: number) => (deg ? (v * Math.PI) / 180 : v);
  const fromRad = (v: number) => (deg ? (v * 180) / Math.PI : v);
  switch (name) {
    case "sqrt":
      if (x < 0) throw new CalcError("Tanımsız: negatif sayının karekökü");
      return Math.sqrt(x);
    case "cbrt": return Math.cbrt(x);
    case "abs": return Math.abs(x);
    case "sin": return snap(Math.sin(toRad(x)));
    case "cos": return snap(Math.cos(toRad(x)));
    case "tan": {
      const r = toRad(x);
      if (Math.abs(Math.cos(r)) < 1e-15) throw new CalcError("Tanımsız: tan bu açıda tanımlı değil");
      return snap(Math.tan(r));
    }
    case "asin":
    case "acos":
      if (x < -1 || x > 1) throw new CalcError(`Tanımsız: ${name} için değer −1 ile 1 arasında olmalı`);
      return name === "asin" ? fromRad(Math.asin(x)) : fromRad(Math.acos(x));
    case "atan": return fromRad(Math.atan(x));
    case "sinh": return Math.sinh(x);
    case "cosh": return Math.cosh(x);
    case "tanh": return Math.tanh(x);
    case "ln":
      if (x <= 0) throw new CalcError("Tanımsız: ln yalnızca pozitif sayılar için");
      return Math.log(x);
    case "log":
      if (x <= 0) throw new CalcError("Tanımsız: log yalnızca pozitif sayılar için");
      return Math.log10(x);
    case "log2":
      if (x <= 0) throw new CalcError("Tanımsız: log2 yalnızca pozitif sayılar için");
      return Math.log2(x);
    case "exp": return Math.exp(x);
    case "round": return Math.round(x);
    case "floor": return Math.floor(x);
    case "ceil": return Math.ceil(x);
  }
  throw new CalcError(`Bilinmeyen fonksiyon: ${name}`);
}

export function evaluate(expr: string, opts: { degrees: boolean; ans: number }): number {
  const toks = tokenize(expr);
  if (toks.length === 0) throw new CalcError("İfade boş");
  let pos = 0;

  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;

  /** Sıradaki jeton yeni bir birincil ifade başlatıyor mu (örtük çarpma için)? */
  const startsPrimary = () => {
    const k = peek();
    if (!k) return false;
    if (k.t === "id") return true;
    return k.t === "op" && k.v === "(";
  };

  function expression(): number {
    let v = term();
    for (;;) {
      if (isOp("+")) { pos++; v = checkFinite(v + term()); }
      else if (isOp("-")) { pos++; v = checkFinite(v - term()); }
      else return v;
    }
  }

  function term(): number {
    let v = unary();
    for (;;) {
      if (isOp("*")) { pos++; v = checkFinite(v * unary()); }
      else if (isOp("/")) {
        pos++;
        const d = unary();
        if (d === 0) throw new CalcError("Sıfıra bölme");
        v = checkFinite(v / d);
      } else if (startsPrimary()) v = checkFinite(v * unary()); // örtük çarpma
      else return v;
    }
  }

  function unary(): number {
    if (isOp("-")) { pos++; return -unary(); }
    if (isOp("+")) { pos++; return unary(); }
    return power();
  }

  function power(): number {
    const base = postfix();
    if (isOp("^")) {
      pos++;
      const exp = unary();
      if (base === 0 && exp < 0) throw new CalcError("Sıfıra bölme");
      return checkFinite(Math.pow(base, exp));
    }
    return base;
  }

  function postfix(): number {
    let v = primary();
    for (;;) {
      if (isOp("!")) { pos++; v = factorial(v); }
      else if (isOp("%")) { pos++; v = v / 100; }
      else return v;
    }
  }

  function primary(): number {
    const k = peek();
    if (!k) throw new CalcError("İfade eksik: bir sayı bekleniyordu");
    if (k.t === "num") { pos++; return k.v; }
    if (k.t === "op") {
      if (k.v === "(") {
        pos++;
        const v = expression();
        if (!isOp(")")) throw new CalcError("Parantez kapatılmadı");
        pos++;
        return v;
      }
      throw new CalcError(`Beklenmeyen işaret: "${k.v}"`);
    }
    pos++;
    if (k.v === "pi") return Math.PI;
    if (k.v === "e") return Math.E;
    if (k.v === "ans") return opts.ans;
    if (FUNCS.has(k.v)) {
      // sin(30) ya da parantezsiz sin30 / √9
      const arg = isOp("(") ? primary() : power();
      return checkFinite(callFunc(k.v, arg, opts.degrees));
    }
    throw new CalcError(`Bilinmeyen ad: ${k.v}`);
  }

  const result = expression();
  if (pos < toks.length) {
    const k = toks[pos];
    if (k.t === "op" && k.v === ")") throw new CalcError("Fazla kapatma parantezi");
    throw new CalcError("İfade anlaşılamadı");
  }
  return checkFinite(result);
}

/** Sonucu gösterim için biçimlendirir: 12 anlamlı basamak, çok büyük/küçükte bilimsel gösterim. */
export function formatResult(n: number): string {
  if (!Number.isFinite(n)) return "Tanımsız";
  if (n === 0) return "0";
  const rounded = Number(n.toPrecision(12));
  const abs = Math.abs(rounded);
  if (abs >= 1e12 || abs < 1e-6) {
    const [m, e] = rounded.toExponential(11).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    return `${mant}e${Number(e)}`;
  }
  return String(rounded);
}
