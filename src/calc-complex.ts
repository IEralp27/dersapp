// Karmaşık sayı aritmetiği ve fonksiyonları (hesap makinesi motoru için). DOM yok.
// Gerçek girişlerde (im = 0) mümkün olduğunca Math.* ile birebir aynı sonuç verilir.

export interface Complex {
  re: number;
  im: number;
}

/** Konumsuz hesap hatası; motor, hatayı ifadedeki yerle (pos/end) zenginleştirir. */
export class CalcError extends Error {
  pos?: number;
  end?: number;
  constructor(message: string, pos?: number, end?: number) {
    super(message);
    this.name = "CalcError";
    this.pos = pos;
    this.end = end;
  }
}

export const C = (re: number, im = 0): Complex => ({ re, im });
export const ZERO = C(0);
export const ONE = C(1);
export const I = C(0, 1);

export const isReal = (z: Complex) => z.im === 0;
export const isZero = (z: Complex) => z.re === 0 && z.im === 0;

export function check(z: Complex): Complex {
  if (Number.isNaN(z.re) || Number.isNaN(z.im)) throw new CalcError("Tanımsız işlem");
  if (!Number.isFinite(z.re) || !Number.isFinite(z.im)) throw new CalcError("Sonuç çok büyük");
  return z;
}

export const add = (a: Complex, b: Complex) => C(a.re + b.re, a.im + b.im);
export const sub = (a: Complex, b: Complex) => C(a.re - b.re, a.im - b.im);
export const neg = (a: Complex) => C(-a.re, -a.im);
export const conj = (a: Complex) => C(a.re, -a.im);
export const scale = (a: Complex, k: number) => C(a.re * k, a.im * k);

export function mul(a: Complex, b: Complex): Complex {
  if (a.im === 0 && b.im === 0) return C(a.re * b.re);
  return C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}

export function div(a: Complex, b: Complex): Complex {
  if (isZero(b)) throw new CalcError("Sıfıra bölme");
  if (a.im === 0 && b.im === 0) return C(a.re / b.re);
  // Smith yöntemi: taşmaya/kayba dayanıklı bölme
  if (Math.abs(b.re) >= Math.abs(b.im)) {
    const r = b.im / b.re;
    const d = b.re + b.im * r;
    return C((a.re + a.im * r) / d, (a.im - a.re * r) / d);
  }
  const r = b.re / b.im;
  const d = b.re * r + b.im;
  return C((a.re * r + a.im) / d, (a.im * r - a.re) / d);
}

export const abs = (a: Complex) => (a.im === 0 ? Math.abs(a.re) : Math.hypot(a.re, a.im));
// "+ 0": -0 sanal kısım esas dalı değiştirmesin (ln(-1) = iπ, -iπ değil)
export const arg = (a: Complex) => Math.atan2(a.im + 0, a.re);
export const fromPolar = (r: number, t: number) => C(r * Math.cos(t), r * Math.sin(t));

export function exp(a: Complex): Complex {
  if (a.im === 0) return C(Math.exp(a.re));
  const m = Math.exp(a.re);
  return C(m * Math.cos(a.im), m * Math.sin(a.im));
}

/** Esas dal doğal logaritma; ln(0) tanımsız. */
export function ln(a: Complex): Complex {
  if (isZero(a)) throw new CalcError("Tanımsız: ln(0)");
  if (a.im === 0 && a.re > 0) return C(Math.log(a.re));
  return C(Math.log(abs(a)), arg(a));
}

/** Esas karekök; negatif gerçek sayılarda tam sonuç: sqrt(-4) = 2i. */
export function sqrt(a: Complex): Complex {
  if (a.im === 0) return a.re >= 0 ? C(Math.sqrt(a.re)) : C(0, Math.sqrt(-a.re));
  const m = abs(a);
  const re = Math.sqrt((m + a.re) / 2);
  const im = Math.sqrt((m - a.re) / 2);
  return C(re, a.im < 0 ? -im : im);
}

function powInt(a: Complex, n: number): Complex {
  let result = ONE;
  let base = a;
  let k = Math.abs(n);
  while (k > 0) {
    if (k & 1) result = mul(result, base);
    base = mul(base, base);
    k = Math.floor(k / 2);
  }
  return n < 0 ? div(ONE, result) : result;
}

export function pow(a: Complex, b: Complex): Complex {
  if (a.im === 0 && b.im === 0) {
    if (a.re === 0 && b.re < 0) throw new CalcError("Sıfıra bölme");
    if (a.re >= 0 || Number.isInteger(b.re)) return C(Math.pow(a.re, b.re));
  }
  if (isZero(a)) {
    if (b.re > 0) return ZERO;
    throw new CalcError("Tanımsız: 0 üssü");
  }
  // Tam sayı üs: tekrarlı çarpma ((1+i)^2 = 2i tam çıkar)
  if (b.im === 0 && Number.isInteger(b.re) && Math.abs(b.re) <= 1024) return powInt(a, b.re);
  return exp(mul(b, ln(a)));
}

export function sin(a: Complex): Complex {
  if (a.im === 0) return C(Math.sin(a.re));
  return C(Math.sin(a.re) * Math.cosh(a.im), Math.cos(a.re) * Math.sinh(a.im));
}
export function cos(a: Complex): Complex {
  if (a.im === 0) return C(Math.cos(a.re));
  return C(Math.cos(a.re) * Math.cosh(a.im), -Math.sin(a.re) * Math.sinh(a.im));
}
export function tan(a: Complex): Complex {
  if (a.im === 0) return C(Math.tan(a.re));
  return div(sin(a), cos(a));
}
export function sinh(a: Complex): Complex {
  if (a.im === 0) return C(Math.sinh(a.re));
  return C(Math.sinh(a.re) * Math.cos(a.im), Math.cosh(a.re) * Math.sin(a.im));
}
export function cosh(a: Complex): Complex {
  if (a.im === 0) return C(Math.cosh(a.re));
  return C(Math.cosh(a.re) * Math.cos(a.im), Math.sinh(a.re) * Math.sin(a.im));
}
export function tanh(a: Complex): Complex {
  if (a.im === 0) return C(Math.tanh(a.re));
  return div(sinh(a), cosh(a));
}

// Ters fonksiyonlar (esas dal). Gerçek tanım aralığında Math.* kullanılır.
export function asin(a: Complex): Complex {
  if (a.im === 0 && a.re >= -1 && a.re <= 1) return C(Math.asin(a.re));
  // asin z = -i ln(iz + sqrt(1 - z²))
  const w = ln(add(mul(I, a), sqrt(sub(ONE, mul(a, a)))));
  return C(w.im, -w.re);
}
export function acos(a: Complex): Complex {
  if (a.im === 0 && a.re >= -1 && a.re <= 1) return C(Math.acos(a.re));
  return sub(C(Math.PI / 2), asin(a));
}
export function atan(a: Complex): Complex {
  if (a.im === 0) return C(Math.atan(a.re));
  if (a.re === 0 && Math.abs(a.im) === 1) throw new CalcError("Tanımsız: atan(±i)");
  // atan z = (i/2) ln((i + z)/(i - z))
  const w = ln(div(add(I, a), sub(I, a)));
  return C(-w.im / 2, w.re / 2);
}
export function asinh(a: Complex): Complex {
  if (a.im === 0) return C(Math.asinh(a.re));
  return ln(add(a, sqrt(add(mul(a, a), ONE))));
}
export function acosh(a: Complex): Complex {
  if (a.im === 0 && a.re >= 1) return C(Math.acosh(a.re));
  // acosh z = ln(z + sqrt(z+1)·sqrt(z-1))
  return ln(add(a, mul(sqrt(add(a, ONE)), sqrt(sub(a, ONE)))));
}
export function atanh(a: Complex): Complex {
  if (a.im === 0 && a.re > -1 && a.re < 1) return C(Math.atanh(a.re));
  if (a.im === 0 && Math.abs(a.re) === 1) throw new CalcError("Tanımsız: atanh(±1)");
  return scale(ln(div(add(ONE, a), sub(ONE, a))), 0.5);
}

/**
 * Kayan nokta gürültüsünü temizler: büyüklüğe göre ihmal edilebilir bileşeni sıfırlar
 * (e^(iπ) = -1 + 1.2e-16i → -1).
 */
export function clean(z: Complex, rel = 1e-12): Complex {
  const m = abs(z);
  if (m === 0) return ZERO;
  const re = Math.abs(z.re) <= rel * m ? 0 : z.re;
  const im = Math.abs(z.im) <= rel * m ? 0 : z.im;
  return C(re === 0 ? 0 : re, im === 0 ? 0 : im);
}
