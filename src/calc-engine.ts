// Mühendislik hesap makinesi motoru: saf hesaplama, DOM yok. eval/Function kullanılmaz.
// Değerler baştan sona karmaşıktır (gerçek sayı = sanal kısmı 0 olan karmaşık sayı).
//
// Dilbilgisi (öncelik düşükten yükseğe):
//   girdi  = (ad "=")? ifade                    (R1 = 4.7k)
//   ifade  = paralel (("+"|"-") paralel)*
//   paralel= terim ("||" terim)*               (R1 + R2 || R3 = R1 + (R2 || R3))
//   terim  = kutup (("*"|"/"|örtük) kutup)*
//   kutup  = tekli (("∠"|"<") tekli)?          (5∠30 → 5·e^(i·30°))
//   tekli  = ("-"|"+") tekli | kuvvet          (−2^2 = −4)
//   kuvvet = sonek ("^" tekli)?                (sağdan birleşmeli: 2^3^2 = 512)
//   sonek  = birincil ("!" | "%" | "°")*
//   birincil = sayı | ad | fonksiyon(arg; arg…) | "(" ifade ")"
//
// Sözcük kuralları (çakışmaların çözümü):
//   • Sayıya bitişik tek harf, ardından harf/rakam gelmiyorsa SI önekidir: 4.7k, 10M, 3m, 22u/22µ, 100n, 2p, 1G, 1T, 1f.
//     Büyük/küçük harf önemlidir: m = mili, M = mega. 4k7 = 4.7k (direnç yazımı).
//   • Sayıya bitişik i/j sanal birimdir (2j, 4.5i); j5 / i5 = 5j. Tek başına i, j sanal birimdir (yalnız küçük harf).
//   • e: sayıdan sonra rakam (ya da +/− ve rakam) geliyorsa bilimsel gösterimdir (1.5e3), yoksa sabittir (2e = 2·e).
//   • 0x, 0b, 0o ardından geçerli basamak: onaltılık/ikilik/sekizlik sayı (0xFF).
//   • Fonksiyon ve sabit adları büyük/küçük harf duyarsız (SIN, Pi, ANS); değişkenler duyarlı (R1 ≠ r1).
//   • Ondalık ayırıcı "." ya da ","; argüman ayırıcı ";".

import * as Cx from "./calc-complex.ts";
import { type Complex, C, CalcError } from "./calc-complex.ts";
import { type Value } from "./calc-format.ts";
import { derivative, integral, polyRoots } from "./calc-numeric.ts";

export { CalcError } from "./calc-complex.ts";
export type { Complex } from "./calc-complex.ts";
export { formatResult, formatValue, formatComplex, formatReal, formatEng, formatBases } from "./calc-format.ts";
export type { Value, FormatOptions } from "./calc-format.ts";

export interface CalcOptions {
  degrees: boolean;
  ans: number | Complex;
  /** Kullanıcı değişkenleri (ad → değer) */
  vars?: Record<string, Complex>;
}

export interface CalcResult {
  value: Value;
  /** Atama yapıldıysa değişkenin adı (değer `value`) */
  assigned?: string;
}

type Token =
  | { t: "num"; v: Complex; p: number; e: number }
  | { t: "id"; v: string; p: number; e: number }
  | { t: "op"; v: string; p: number; e: number };

/** Fonksiyonlar: [en az, en çok] argüman sayısı */
const FUNCS: Record<string, [number, number]> = {
  sqrt: [1, 1], cbrt: [1, 1], abs: [1, 1], exp: [1, 1], ln: [1, 1], log2: [1, 1], log: [1, 2],
  sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 1],
  sinh: [1, 1], cosh: [1, 1], tanh: [1, 1], asinh: [1, 1], acosh: [1, 1], atanh: [1, 1],
  round: [1, 1], floor: [1, 1], ceil: [1, 1],
  arg: [1, 1], angle: [1, 1], conj: [1, 1], re: [1, 1], im: [1, 1], polar: [2, 2],
  deg: [1, 1], rad: [1, 1],
  ncr: [2, 2], npr: [2, 2], mod: [2, 2], atan2: [2, 2], root: [2, 2],
  gcd: [1, Infinity], obeb: [1, Infinity], lcm: [1, Infinity], okek: [1, Infinity],
  min: [1, Infinity], max: [1, Infinity], hypot: [1, Infinity], par: [1, Infinity],
  roots: [2, 31], deriv: [3, 3], integ: [4, 4],
};
const CONSTS = new Set(["pi", "π", "e", "ans"]);
const UNITS = new Set(["i", "j"]);

const PREFIX: Record<string, number> = {
  T: 1e12, G: 1e9, M: 1e6, k: 1e3, m: 1e-3, u: 1e-6, "µ": 1e-6, "μ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c);
const isIdChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isFunc = (w: string) => Object.hasOwn(FUNCS, w.toLowerCase());

// ------------------------------------------------------------------ Sözcükler

/** src[i]'den bir sayı okur (önek, bilimsel gösterim ve sanal birim dahil). */
function readNumber(src: string, i: number): { v: Complex; j: number } {
  const c = src[i];
  // Tabanlı tam sayılar: 0xFF, 0b1010, 0o17
  if (c === "0") {
    const b = src[i + 1]?.toLowerCase();
    const re = b === "x" ? /[0-9a-fA-F]/ : b === "b" ? /[01]/ : b === "o" ? /[0-7]/ : null;
    if (re && re.test(src[i + 2] ?? "")) {
      let j = i + 2;
      while (j < src.length && re.test(src[j])) j++;
      if (isDigit(src[j])) throw new CalcError(`Bu tabanda geçersiz basamak: "${src[j]}"`, j, j + 1);
      return { v: C(parseInt(src.slice(i + 2, j), b === "x" ? 16 : b === "b" ? 2 : 8)), j };
    }
  }
  let j = i;
  let seenDot = false;
  while (j < src.length && (isDigit(src[j]) || ((src[j] === "." || src[j] === ",") && !seenDot))) {
    if (src[j] === "." || src[j] === ",") seenDot = true;
    j++;
  }
  let text = src.slice(i, j).replace(",", ".");
  let plain = !seenDot;
  // Bilimsel gösterim: 1.5e3, 2e-3 (yalnızca e'den sonra rakam geliyorsa; yoksa e sabitidir)
  const m = /^[eE]([+-]?\d+)/.exec(src.slice(j));
  if (m) {
    text += "e" + m[1];
    j += m[0].length;
    plain = false;
  }
  let v = Number(text);
  // SI öneki: sayıya bitişik, ardından ad karakteri gelmeyen tek harf
  const pc = src[j];
  if (pc !== undefined && Object.hasOwn(PREFIX, pc)) {
    const after = src[j + 1];
    if (!isIdChar(after)) {
      v *= PREFIX[pc];
      j++;
    } else if (plain && isDigit(after)) {
      // 4k7 = 4.7k, 2n2 = 2.2n
      let k = j + 1;
      while (isDigit(src[k])) k++;
      if (!isIdChar(src[k]) && src[k] !== "." && src[k] !== ",") {
        v = Number(text + "." + src.slice(j + 1, k)) * PREFIX[pc];
        j = k;
      }
    }
  }
  // Sanal birim: 2j, 4.5i
  if ((src[j] === "i" || src[j] === "j") && !isIdChar(src[j + 1])) return { v: C(0, v), j: j + 1 };
  return { v: C(v), j };
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const op = (v: string, len = 1) => {
    out.push({ t: "op", v, p: i, e: i + len });
    i += len;
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (isDigit(c) || ((c === "." || c === ",") && isDigit(src[i + 1]))) {
      const { v, j } = readNumber(src, i);
      out.push({ t: "num", v, p: i, e: j });
      i = j;
      continue;
    }
    // j5 / i5 = 5j
    if ((c === "i" || c === "j") && (isDigit(src[i + 1]) || ((src[i + 1] === "." || src[i + 1] === ",") && isDigit(src[i + 2])))) {
      const { v, j } = readNumber(src, i + 1);
      out.push({ t: "num", v: Cx.mul(Cx.I, v), p: i, e: j });
      i = j;
      continue;
    }
    if (c === "π") { out.push({ t: "id", v: "pi", p: i, e: i + 1 }); i++; continue; }
    if (c === "√") { out.push({ t: "id", v: "sqrt", p: i, e: i + 1 }); i++; continue; }
    if (isLetter(c) || c === "_") {
      let j = i;
      while (isLetter(src[j])) j++;
      const letters = src.slice(i, j);
      if (isFunc(letters) && isDigit(src[j])) {
        // sin30 = sin(30); log2 gibi sonu rakamlı adlar bütün kalır
        let k = j;
        while (isDigit(src[k])) k++;
        const whole = src.slice(i, k);
        const word = isFunc(whole) ? whole : letters;
        out.push({ t: "id", v: word, p: i, e: i + word.length });
        i += word.length;
        continue;
      }
      while (isIdChar(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j), p: i, e: j });
      i = j;
      continue;
    }
    if (c === "|") {
      if (src[i + 1] === "|") { op("||", 2); continue; }
      throw new CalcError("Tek \"|\" geçersiz; paralel bağlama için || yazın", i, i + 1);
    }
    if ("+-*/^()!%;=°".includes(c)) { op(c); continue; }
    if (c === "∠" || c === "<") { op("∠"); continue; }
    if (c === "×" || c === "·" || c === "⋅") { op("*"); continue; }
    if (c === "÷") { op("/"); continue; }
    if (c === "−" || c === "–") { op("-"); continue; }
    throw new CalcError(`Geçersiz karakter: "${c}"`, i, i + 1);
  }
  return out;
}

// ------------------------------------------------------------------ Ayrıştırma

type Node =
  | { k: "num"; v: Complex; p: number; e: number }
  | { k: "id"; name: string; p: number; e: number }
  | { k: "neg"; a: Node; p: number; e: number }
  | { k: "bin"; op: string; a: Node; b: Node; p: number; e: number } // p/e: işlecin yeri
  | { k: "post"; op: string; a: Node; p: number; e: number }
  | { k: "call"; name: string; args: Node[]; p: number; e: number }; // p/e: fonksiyon adının yeri

interface Program {
  assign?: { name: string; p: number; e: number };
  body: Node;
}

function parse(src: string): Program {
  const toks = tokenize(src);
  if (toks.length === 0) throw new CalcError("İfade boş", 0, 0);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek().v === v;
  const endPos = src.length;
  const fail = (msg: string, tok: Token | undefined): never => {
    throw new CalcError(msg, tok ? tok.p : endPos, tok ? tok.e : endPos);
  };

  /** Sıradaki jeton yeni bir birincil ifade başlatıyor mu (örtük çarpma için)? */
  const startsPrimary = () => {
    const k = peek();
    if (!k) return false;
    if (k.t === "id") return true;
    return k.t === "op" && k.v === "(";
  };

  function expression(): Node {
    let a = parallel();
    for (;;) {
      const k = peek();
      if (isOp("+") || isOp("-")) {
        pos++;
        a = { k: "bin", op: k.v as string, a, b: parallel(), p: k.p, e: k.e };
      } else return a;
    }
  }

  function parallel(): Node {
    let a = term();
    while (isOp("||")) {
      const k = peek();
      pos++;
      a = { k: "bin", op: "||", a, b: term(), p: k.p, e: k.e };
    }
    return a;
  }

  function term(): Node {
    let a = polar();
    for (;;) {
      const k = peek();
      if (isOp("*") || isOp("/")) {
        pos++;
        a = { k: "bin", op: k.v as string, a, b: polar(), p: k.p, e: k.e };
      } else if (startsPrimary()) {
        a = { k: "bin", op: "*", a, b: polar(), p: k.p, e: k.e }; // örtük çarpma
      } else return a;
    }
  }

  function polar(): Node {
    const a = unary();
    if (isOp("∠")) {
      const k = peek();
      pos++;
      return { k: "bin", op: "∠", a, b: unary(), p: k.p, e: k.e };
    }
    return a;
  }

  function unary(): Node {
    const k = peek();
    if (isOp("-")) { pos++; return { k: "neg", a: unary(), p: k.p, e: k.e }; }
    if (isOp("+")) { pos++; return unary(); }
    return power();
  }

  function power(): Node {
    const base = postfix();
    if (isOp("^")) {
      const k = peek();
      pos++;
      return { k: "bin", op: "^", a: base, b: unary(), p: k.p, e: k.e };
    }
    return base;
  }

  function postfix(): Node {
    let a = primary();
    for (;;) {
      const k = peek();
      if (isOp("!") || isOp("%") || isOp("°")) {
        pos++;
        a = { k: "post", op: k.v as string, a, p: k.p, e: k.e };
      } else return a;
    }
  }

  function primary(): Node {
    const k = peek();
    if (!k) return fail("İfade eksik: bir sayı bekleniyordu", undefined);
    if (k.t === "num") { pos++; return { k: "num", v: k.v, p: k.p, e: k.e }; }
    if (k.t === "op") {
      if (k.v === "(") {
        pos++;
        const v = expression();
        if (isOp(";")) fail("\";\" yalnızca fonksiyon argümanlarını ayırır", peek());
        if (!isOp(")")) fail("Parantez kapatılmadı", k);
        pos++;
        return v;
      }
      return fail(`Beklenmeyen işaret: "${k.v}"`, k);
    }
    pos++;
    const lower = k.v.toLowerCase();
    if (isFunc(lower)) {
      const [min, max] = FUNCS[lower];
      let args: Node[];
      if (isOp("(")) {
        const open = peek();
        pos++;
        args = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(expression());
            if (isOp(";")) { pos++; continue; }
            break;
          }
        }
        if (!isOp(")")) fail("Parantez kapatılmadı", open);
        pos++;
      } else {
        if (min > 1) fail(`${k.v}( … ) için parantez gerekli`, k);
        // sin30 / √9 / √-9 gibi parantezsiz tek argüman
        args = [unary()];
      }
      if (args.length < min || args.length > max) {
        const want = min === max ? `${min}` : max === Infinity ? `en az ${min}` : `${min}–${max}`;
        fail(`${k.v}: ${want} argüman bekleniyor (${args.length} verildi; ayırıcı ";")`, k);
      }
      return { k: "call", name: lower, args, p: k.p, e: k.e };
    }
    return { k: "id", name: k.v, p: k.p, e: k.e };
  }

  let assign: Program["assign"];
  if (toks.length >= 2 && toks[0].t === "id" && toks[1].t === "op" && toks[1].v === "=") {
    const t = toks[0];
    checkName(t.v, t.p, t.e);
    assign = { name: t.v, p: t.p, e: t.e };
    pos = 2;
    if (pos >= toks.length) fail("Atanacak değer eksik", undefined);
  }
  const body = expression();
  if (pos < toks.length) {
    const k = toks[pos];
    if (k.t === "op" && k.v === ")") fail("Fazla kapatma parantezi", k);
    if (k.t === "op" && k.v === ";") fail("\";\" yalnızca fonksiyon argümanlarını ayırır", k);
    if (k.t === "op" && k.v === "=") fail("Atama yalnızca başta yapılabilir: ad = ifade", k);
    fail("İfade anlaşılamadı", k);
  }
  return { assign, body };
}

/** Değişken adı geçerli ve korunan bir adla çakışmıyor mu? */
function checkName(name: string, p = 0, e = name.length): void {
  const lower = name.toLowerCase();
  if (isFunc(lower)) throw new CalcError(`"${name}" bir fonksiyon adı; değişken adı olamaz`, p, e);
  if (CONSTS.has(lower) || UNITS.has(name)) throw new CalcError(`"${name}" bir sabit; değişken adı olamaz`, p, e);
  let toks: Token[] = [];
  try {
    toks = tokenize(name);
  } catch {
    // aşağıda geçersiz ad hatası
  }
  if (toks.length !== 1 || toks[0].t !== "id" || toks[0].v !== name) {
    throw new CalcError(`Geçersiz değişken adı: "${name}" (harfle başlamalı; ör. R1, Vout)`, p, e);
  }
}

/** Kullanıcının atayabileceği bir değişken adı mı? (arayüz için) */
export function isValidVarName(name: string): boolean {
  try {
    checkName(name);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ Hesaplama

interface Env {
  degrees: boolean;
  ans: Complex;
  vars: Record<string, Complex>;
  locals: Map<string, Complex>;
}

/** Çok küçük kayan nokta kalıntısını sıfırlar (sin(180°) gibi). */
const snap = (v: number) => (Math.abs(v) < 1e-15 ? 0 : v);
const snapC = (z: Complex) => C(snap(z.re), snap(z.im));

function real(z: Complex, fn: string): number {
  if (z.im !== 0) throw new CalcError(`${fn}: karmaşık sayı kabul etmez`);
  return z.re;
}
function integer(z: Complex, fn: string): number {
  const x = real(z, fn);
  if (!Number.isInteger(x)) throw new CalcError(`${fn}: tam sayı bekleniyor`);
  return x;
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new CalcError("Faktöriyel yalnızca 0 ve pozitif tam sayılar için");
  if (n > 170) throw new CalcError("Sonuç çok büyük");
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function gcd2(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

function toRad(z: Complex, env: Env): Complex {
  return env.degrees ? Cx.scale(z, Math.PI / 180) : z;
}
function fromRad(z: Complex, env: Env): Complex {
  return env.degrees ? Cx.scale(z, 180 / Math.PI) : z;
}

function ev(n: Node, env: Env): Complex {
  try {
    return Cx.check(evInner(n, env));
  } catch (e) {
    // Konumsuz hatayı en içteki düğümün yeriyle işaretle
    if (e instanceof CalcError && e.pos === undefined) {
      e.pos = n.p;
      e.end = n.e;
    }
    throw e;
  }
}

function evInner(n: Node, env: Env): Complex {
  switch (n.k) {
    case "num":
      return n.v;
    case "id":
      return lookup(n.name, env);
    case "neg":
      return Cx.neg(ev(n.a, env));
    case "post": {
      const a = ev(n.a, env);
      if (n.op === "!") return C(factorial(real(a, "Faktöriyel")));
      if (n.op === "%") return Cx.scale(a, 0.01);
      return env.degrees ? a : Cx.scale(a, Math.PI / 180); // °: dereceyi geçerli birime çevir
    }
    case "bin": {
      const a = ev(n.a, env);
      const b = ev(n.b, env);
      switch (n.op) {
        case "+": return Cx.add(a, b);
        case "-": return Cx.sub(a, b);
        case "*": return Cx.mul(a, b);
        case "/": return Cx.div(a, b);
        case "^": return Cx.pow(a, b);
        case "||": return parallel([a, b]);
        case "∠": {
          const r = real(a, "Kutupsal giriş (büyüklük)");
          const t = real(toRad(b, env), "Kutupsal giriş (açı)");
          return polarC(r, t);
        }
      }
      throw new CalcError(`Bilinmeyen işleç: ${n.op}`);
    }
    case "call":
      return call(n, env);
  }
}

/** r∠θ; 90°, 180° gibi açılarda tam sonuç için gürültü temizlenir. */
function polarC(r: number, t: number): Complex {
  return Cx.clean(Cx.fromPolar(r, t), 1e-15);
}

function lookup(name: string, env: Env): Complex {
  const local = env.locals.get(name);
  if (local) return local;
  if (name === "i" || name === "j") return Cx.I;
  const lower = name.toLowerCase();
  if (lower === "pi") return C(Math.PI);
  if (lower === "e") return C(Math.E);
  if (lower === "ans") return env.ans;
  if (Object.hasOwn(env.vars, name)) return env.vars[name];
  throw new CalcError(`Bilinmeyen ad: ${name}`);
}

function parallel(zs: Complex[]): Complex {
  if (zs.some(Cx.isZero)) return Cx.ZERO; // kısa devre
  let s = Cx.ZERO;
  let ymax = 0;
  for (const z of zs) {
    const y = Cx.div(Cx.ONE, z);
    ymax = Math.max(ymax, Cx.abs(y));
    s = Cx.add(s, y);
  }
  if (Cx.abs(s) <= 1e-12 * ymax) {
    throw new CalcError("Paralel bağlama sonsuz: admitanslar toplamı sıfır (rezonans)");
  }
  return Cx.div(Cx.ONE, s);
}

function bindName(arg: Node, fn: string): string {
  if (arg.k !== "id") throw new CalcError(`${fn}: ikinci argüman bir değişken adı olmalı (ör. x)`, arg.p, arg.e);
  const lower = arg.name.toLowerCase();
  if (CONSTS.has(lower) || UNITS.has(arg.name)) {
    throw new CalcError(`${fn}: "${arg.name}" sabittir, değişken olarak kullanılamaz`, arg.p, arg.e);
  }
  return arg.name;
}

function call(n: Extract<Node, { k: "call" }>, env: Env): Complex {
  const name = n.name;
  if (name === "roots") throw new CalcError("roots(…) yalnızca tek başına kullanılabilir (sonucu bir liste)");
  if (name === "deriv" || name === "integ") {
    const v = bindName(n.args[1], name);
    // Analiz radyan ister: iç ifade DERECE modunda bile radyanla hesaplanır (iç içe türev/integral dahil).
    const f = (x: number) => ev(n.args[0], { ...env, degrees: false, locals: new Map(env.locals).set(v, C(x)) });
    if (name === "deriv") {
      const x0 = real(ev(n.args[2], env), "deriv (nokta)");
      return derivative(f, x0, v);
    }
    const a = real(ev(n.args[2], env), "integ (alt sınır)");
    const b = real(ev(n.args[3], env), "integ (üst sınır)");
    return integral(f, a, b, v);
  }

  const args = n.args.map((a) => ev(a, env));
  const x = args[0];
  switch (name) {
    case "sqrt": return Cx.sqrt(x);
    case "cbrt": return x.im === 0 ? C(Math.cbrt(x.re)) : Cx.pow(x, C(1 / 3));
    case "abs": return C(Cx.abs(x));
    case "exp": return Cx.exp(x);
    case "ln": return Cx.ln(x);
    case "log": {
      if (args.length === 2) {
        const b = args[1];
        if (b.im === 0 && b.re === 1) throw new CalcError("Tanımsız: logaritma tabanı 1 olamaz");
        if (Cx.isZero(b)) throw new CalcError("Tanımsız: logaritma tabanı 0 olamaz");
        if (x.im === 0 && b.im === 0 && x.re > 0 && b.re > 0) return C(Math.log(x.re) / Math.log(b.re));
        return Cx.div(Cx.ln(x), Cx.ln(b));
      }
      if (x.im === 0 && x.re > 0) return C(Math.log10(x.re));
      return Cx.scale(Cx.ln(x), 1 / Math.LN10);
    }
    case "log2":
      if (x.im === 0 && x.re > 0) return C(Math.log2(x.re));
      return Cx.scale(Cx.ln(x), 1 / Math.LN2);
    case "sin": return snapC(Cx.sin(toRad(x, env)));
    case "cos": return snapC(Cx.cos(toRad(x, env)));
    case "tan": {
      const r = toRad(x, env);
      if (r.im === 0 && Math.abs(Math.cos(r.re)) < 1e-15) throw new CalcError("Tanımsız: tan bu açıda tanımlı değil");
      return snapC(Cx.tan(r));
    }
    case "asin": return fromRad(Cx.asin(x), env);
    case "acos": return fromRad(Cx.acos(x), env);
    case "atan": return fromRad(Cx.atan(x), env);
    case "sinh": return Cx.sinh(x);
    case "cosh": return Cx.cosh(x);
    case "tanh": return Cx.tanh(x);
    case "asinh": return Cx.asinh(x);
    case "acosh": return Cx.acosh(x);
    case "atanh": return Cx.atanh(x);
    case "round": return C(Math.round(x.re), Math.round(x.im));
    case "floor": return C(Math.floor(x.re), Math.floor(x.im));
    case "ceil": return C(Math.ceil(x.re), Math.ceil(x.im));
    case "arg":
    case "angle":
      if (Cx.isZero(x)) return Cx.ZERO;
      return fromRad(C(Cx.arg(Cx.clean(x))), env);
    case "conj": return Cx.conj(x);
    case "re": return C(x.re);
    case "im": return C(x.im);
    case "polar": return polarC(real(x, "polar (büyüklük)"), real(toRad(args[1], env), "polar (açı)"));
    case "deg": return Cx.scale(x, 180 / Math.PI);
    case "rad": return Cx.scale(x, Math.PI / 180);
    case "ncr":
    case "npr": {
      const nn = integer(x, name === "ncr" ? "nCr" : "nPr");
      const r = integer(args[1], name === "ncr" ? "nCr" : "nPr");
      if (nn < 0 || r < 0) throw new CalcError(`${name === "ncr" ? "nCr" : "nPr"}: negatif olamaz`);
      if (r > nn) return Cx.ZERO;
      let v = 1;
      if (name === "npr") for (let k = 0; k < r; k++) v *= nn - k;
      else {
        const rr = Math.min(r, nn - r);
        for (let k = 1; k <= rr; k++) v = (v * (nn - rr + k)) / k;
        v = Math.round(v);
      }
      return C(v);
    }
    case "mod": {
      const a = real(x, "mod");
      const b = real(args[1], "mod");
      if (b === 0) throw new CalcError("Sıfıra bölme (mod 0)");
      // Excel MOD gibi: sonuç bölenin işaretini taşır
      return C(a - b * Math.floor(a / b));
    }
    case "gcd":
    case "obeb":
      return C(args.reduce((g, z) => gcd2(g, integer(z, "obeb")), 0));
    case "lcm":
    case "okek":
      return C(args.reduce((l, z) => {
        const v = Math.abs(integer(z, "okek"));
        return l === 0 || v === 0 ? 0 : (l / gcd2(l, v)) * v;
      }, Math.abs(integer(x, "okek"))));
    case "min": return C(Math.min(...args.map((z) => real(z, "min"))));
    case "max": return C(Math.max(...args.map((z) => real(z, "max"))));
    case "hypot": return C(Math.hypot(...args.map(Cx.abs)));
    case "par": return parallel(args);
    case "atan2": {
      const y = real(x, "atan2");
      const xx = real(args[1], "atan2");
      return fromRad(C(Math.atan2(y, xx)), env);
    }
    case "root": {
      const nn = args[1];
      if (Cx.isZero(nn)) throw new CalcError("Tanımsız: 0. dereceden kök");
      // Tek dereceli kökte negatif sayının gerçek kökü: root(-8; 3) = -2
      if (x.im === 0 && nn.im === 0 && x.re < 0 && Number.isInteger(nn.re) && Math.abs(nn.re) % 2 === 1) {
        return C(-Math.pow(-x.re, 1 / nn.re));
      }
      return Cx.pow(x, Cx.div(Cx.ONE, nn));
    }
  }
  throw new CalcError(`Bilinmeyen fonksiyon: ${name}`);
}

// ------------------------------------------------------------------ Dış arayüz

/** İfadeyi hesaplar. Sonuç karmaşık sayı ya da (roots için) liste olabilir. */
export function calc(expr: string, opts: CalcOptions): CalcResult {
  const prog = parse(expr);
  const ans = typeof opts.ans === "number" ? C(opts.ans) : opts.ans;
  const env: Env = { degrees: opts.degrees, ans, vars: opts.vars ?? {}, locals: new Map() };
  const body = prog.body;
  if (body.k === "call" && body.name === "roots") {
    if (prog.assign) throw new CalcError("roots sonucu bir liste; değişkene atanamaz", prog.assign.p, prog.assign.e);
    const cs = body.args.map((a) => ev(a, env));
    try {
      return { value: polyRoots(cs) };
    } catch (e) {
      if (e instanceof CalcError && e.pos === undefined) {
        e.pos = body.p;
        e.end = body.e;
      }
      throw e;
    }
  }
  const value = Cx.clean(ev(body, env));
  return prog.assign ? { value, assigned: prog.assign.name } : { value };
}

/**
 * Yalnızca gerçek sonuç veren eski arayüz: sonuç karmaşıksa "Tanımsız" hatası verir
 * (sqrt(-1), log(-5) gibi; karmaşık sonuç için calc() kullanılır).
 */
export function evaluate(expr: string, opts: { degrees: boolean; ans: number; vars?: Record<string, Complex> }): number {
  const { value } = calc(expr, opts);
  if (Array.isArray(value)) throw new CalcError("Sonuç bir liste");
  if (value.im !== 0) throw new CalcError("Tanımsız: sonuç karmaşık sayı");
  return value.re;
}
