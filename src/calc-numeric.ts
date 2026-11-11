// Sayısal yöntemler: polinom kökleri (Aberth), türev (Ridders), integral (uyarlamalı Gauss–Kronrod 7-15).
import {
  type Complex, C, CalcError, ONE, ZERO, abs, add, clean, div, isZero, mul, sqrt, sub,
} from "./calc-complex.ts";

// ------------------------------------------------------------------ Kökler

/** p(z) ve p'(z) (Horner); katsayılar en yüksek dereceden başlar. */
function horner(cs: Complex[], z: Complex): [Complex, Complex] {
  let p = cs[0];
  let d = ZERO;
  for (let k = 1; k < cs.length; k++) {
    d = add(mul(d, z), p);
    p = add(mul(p, z), cs[k]);
  }
  return [p, d];
}

function quadratic(a: Complex, b: Complex, c: Complex): Complex[] {
  const s = sqrt(sub(mul(b, b), mul(C(4), mul(a, c))));
  // Kayıpsız formül: q = -(b ± s)/2, işaret b ile aynı yönde seçilir
  const sign = b.re * s.re + b.im * s.im >= 0 ? 1 : -1;
  const q = C(-(b.re + sign * s.re) / 2, -(b.im + sign * s.im) / 2);
  if (isZero(q)) return [ZERO, ZERO];
  return [div(q, a), div(c, q)];
}

/** Aberth–Ehrlich yinelemesi ile tüm kökler. */
function aberth(cs: Complex[]): Complex[] {
  const n = cs.length - 1;
  const a0 = abs(cs[0]);
  // Başlangıç: köklerin büyüklüğüne göre bir çember üzerinde eşit aralıklı noktalar
  let r = 0;
  for (let k = 1; k <= n; k++) r = Math.max(r, (abs(cs[k]) / a0) ** (1 / k));
  r = r || 1;
  const z: Complex[] = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n + 0.4;
    z.push(C(r * Math.cos(t), r * Math.sin(t)));
  }
  for (let it = 0; it < 800; it++) {
    let maxStep = 0;
    for (let k = 0; k < n; k++) {
      const [p, d] = horner(cs, z[k]);
      if (isZero(p)) continue;
      let s = ZERO;
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const diff = sub(z[k], z[j]);
        if (!isZero(diff)) s = add(s, div(ONE, diff));
      }
      let w: Complex;
      try {
        const ratio = div(p, d);
        w = div(ratio, sub(ONE, mul(ratio, s)));
      } catch {
        w = C(1e-7 * (1 + abs(z[k])), 1e-7); // türev sıfır: küçük sarsıntı
      }
      z[k] = sub(z[k], w);
      maxStep = Math.max(maxStep, abs(w) / Math.max(1, abs(z[k])));
    }
    if (maxStep < 1e-15) break;
  }
  return z;
}

function derivCoeffs(cs: Complex[]): Complex[] {
  const n = cs.length - 1;
  return cs.slice(0, -1).map((c, k) => C(c.re * (n - k), c.im * (n - k)));
}

/** |p(z)| / Σ|c_k||z|^k : yuvarlama ölçeğine göre artık (kök mü?) */
function residual(cs: Complex[], z: Complex): number {
  const p = horner(cs, z)[0];
  const r = abs(z);
  let s = 0;
  for (const c of cs) s = s * r + abs(c);
  return s === 0 ? 0 : abs(p) / s;
}

function newton(cs: Complex[], z: Complex, steps: number): Complex {
  for (let it = 0; it < steps; it++) {
    const [p, d] = horner(cs, z);
    if (isZero(p) || isZero(d)) break;
    const next = sub(z, div(p, d));
    if (abs(horner(cs, next)[0]) >= abs(p)) break;
    z = next;
  }
  return z;
}

/**
 * Katlı kökler: birbirine çok yakın kökler öbeklenir; m katlı kök p^(m−1)'in basit köküdür,
 * öbeğin ortalamasından o polinomla Newton yapılıp doğrulanır. Doğrulanmayan öbek dağıtılır.
 */
function clusterAndPolish(cs: Complex[], rs: Complex[]): Complex[] {
  const used = new Array(rs.length).fill(false);
  const out: Complex[] = [];
  for (let k = 0; k < rs.length; k++) {
    if (used[k]) continue;
    const group = [k];
    for (let j = k + 1; j < rs.length; j++) {
      if (!used[j] && abs(sub(rs[k], rs[j])) < 2e-3 * Math.max(1, abs(rs[k]))) group.push(j);
    }
    if (group.length > 1) {
      let s = ZERO;
      for (const g of group) s = add(s, rs[g]);
      let mean = C(s.re / group.length, s.im / group.length);
      const ders = [cs];
      for (let m = 1; m < group.length; m++) ders.push(derivCoeffs(ders[m - 1]));
      mean = newton(ders[group.length - 1], mean, 8);
      if (ders.every((d) => residual(d, mean) < 1e-11)) {
        for (const g of group) { used[g] = true; out.push(mean); }
        continue;
      }
    }
    used[k] = true;
    out.push(newton(cs, rs[k], 3));
  }
  return out;
}

/**
 * Polinom kökleri: katsayılar en yüksek dereceden (roots(1; -6; 11; -6) → 1, 2, 3).
 * Katlı kökler öbeklenip ortalamaları alınır (ortalama, tek tek köklerden çok daha doğrudur).
 */
export function polyRoots(coeffs: Complex[]): Complex[] {
  let cs = coeffs.slice();
  while (cs.length && isZero(cs[0])) cs.shift();
  if (!cs.length) throw new CalcError("Tüm katsayılar sıfır: her sayı köktür");
  if (cs.length === 1) throw new CalcError("Kök yok: polinom sabit");
  if (cs.length > 31) throw new CalcError("En fazla 30. derece desteklenir");
  // Sıfır kökleri ayır (sondaki sıfır katsayılar)
  const zeros: Complex[] = [];
  while (cs.length > 1 && isZero(cs[cs.length - 1])) {
    cs.pop();
    zeros.push(ZERO);
  }
  const realCoeffs = coeffs.every((c) => c.im === 0);
  let rs: Complex[];
  if (cs.length === 1) rs = [];
  else if (cs.length === 2) rs = [div(sub(ZERO, cs[1]), cs[0])];
  else if (cs.length === 3) rs = quadratic(cs[0], cs[1], cs[2]);
  else {
    rs = clusterAndPolish(cs, aberth(cs));
  }
  rs = rs.concat(zeros).map((z) => {
    let w = clean(z);
    // Gerçek katsayılı polinomda ihmal edilebilir sanal kısım gürültüdür
    if (realCoeffs && Math.abs(w.im) <= 1e-9 * Math.max(1, abs(w))) w = C(w.re);
    return w;
  });
  // Sıralama: önce gerçek kökler (artan), sonra karmaşıklar (gerçek kısım, sonra sanal kısım azalan)
  return rs.sort((a, b) => {
    const ar = a.im === 0 ? 0 : 1;
    const br = b.im === 0 ? 0 : 1;
    if (ar !== br) return ar - br;
    if (Math.abs(a.re - b.re) > 1e-12 * Math.max(1, Math.abs(a.re))) return a.re - b.re;
    return b.im - a.im;
  });
}

// ------------------------------------------------------------------ Türev

type Fn = (x: number) => Complex;

/** Noktaya değil ifadeye ait hata (yazım/ad): olduğu gibi, konumuyla iletilir. */
const isStructural = (e: unknown) => e instanceof CalcError && /^Bilinmeyen|argüman|kabul etmez/.test(e.message);

const fmtX = (x: number) => String(Number(x.toPrecision(10)));

/** f'(x): Ridders yöntemi (merkezi fark + Richardson); köşe noktalarında hata. */
export function derivative(f: Fn, x: number, name: string): Complex {
  const at = `${name} = ${fmtX(x)}`;
  const safe = (t: number): Complex => {
    try {
      return f(t);
    } catch {
      throw new CalcError(`Türev hesaplanamadı: fonksiyon ${at} civarında tanımsız`);
    }
  };
  let f0: Complex;
  try {
    f0 = f(x);
  } catch (e) {
    if (isStructural(e)) throw e;
    const why = e instanceof CalcError ? ` (${e.message})` : "";
    throw new CalcError(`Türev tanımsız: fonksiyon ${at} noktasında tanımsız${why}`);
  }
  // Köşe denetimi: sol ve sağ fark oranları h küçülünce yaklaşmıyorsa türev yoktur
  const scaleX = Math.max(1, Math.abs(x));
  const gap = (h: number) => {
    const L = scaleC(sub(f0, safe(x - h)), 1 / h);
    const R = scaleC(sub(safe(x + h), f0), 1 / h);
    return { d: abs(sub(L, R)), m: Math.max(1, abs(L), abs(R)) };
  };
  const g1 = gap(1e-3 * scaleX);
  const g2 = gap(1e-4 * scaleX);
  if (g1.d > 1e-6 * g1.m && g2.d > 0.5 * g1.d) {
    throw new CalcError(`Türev yok: ${at} noktasında sol ve sağ türev farklı`);
  }

  let h = 0.01 * scaleX;
  if (x !== 0 && h > Math.abs(x) / 4) h = Math.abs(x) / 4;
  const CON = 1.4, CON2 = CON * CON, NTAB = 12, SAFE = 2;
  const a: Complex[][] = Array.from({ length: NTAB }, () => new Array<Complex>(NTAB));
  const cd = (hh: number) => scaleC(sub(safe(x + hh), safe(x - hh)), 1 / (2 * hh));
  a[0][0] = cd(h);
  let err = Infinity;
  let ans = a[0][0];
  for (let i = 1; i < NTAB; i++) {
    h /= CON;
    a[0][i] = cd(h);
    let fac = CON2;
    for (let j = 1; j <= i; j++) {
      a[j][i] = scaleC(sub(scaleC(a[j - 1][i], fac), a[j - 1][i - 1]), 1 / (fac - 1));
      fac *= CON2;
      const errt = Math.max(abs(sub(a[j][i], a[j - 1][i])), abs(sub(a[j][i], a[j - 1][i - 1])));
      if (errt <= err) {
        err = errt;
        ans = a[j][i];
      }
    }
    if (abs(sub(a[i][i], a[i - 1][i - 1])) >= SAFE * err) break;
  }
  if (!Number.isFinite(ans.re) || !Number.isFinite(ans.im)) {
    throw new CalcError(`Türev tanımsız: ${at} noktasında sonsuz`);
  }
  return ans;
}

const scaleC = (z: Complex, k: number) => C(z.re * k, z.im * k);

// ------------------------------------------------------------------ İntegral

const XGK = [
  0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
  0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
  0.586087235467691130294144845693013, 0.405845151377397166906606412076961,
  0.207784955007898467600689403773245, 0,
];
const WGK = [
  0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
  0.104790010322250183839876322541518, 0.140653259715525918745189590510238,
  0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
  0.204432940075298892414161999234649, 0.209482141084727828012999174891714,
];
// 7 noktalı Gauss ağırlıkları (XGK[1], XGK[3], XGK[5], XGK[7] düğümlerinde)
const WG = [
  0.129484966168869693270611432679082, 0.279705391489276667901467771423780,
  0.381830050505118944950369775488975, 0.417959183673469387755102040816327,
];

interface Piece { a: number; b: number; I: Complex; err: number }

function gk15(f: Fn, a: number, b: number): Piece {
  const c = (a + b) / 2;
  const h = (b - a) / 2;
  const fc = f(c);
  let k = scaleC(fc, WGK[7]);
  let g = scaleC(fc, WG[3]);
  for (let j = 0; j < 7; j++) {
    const dx = h * XGK[j];
    const s = add(f(c - dx), f(c + dx));
    k = add(k, scaleC(s, WGK[j]));
    if (j % 2 === 1) g = add(g, scaleC(s, WG[(j - 1) / 2]));
  }
  const I = scaleC(k, h);
  return { a, b, I, err: abs(sub(I, scaleC(g, h))) };
}

/** ∫ f dx, a'dan b'ye: genel uyarlamalı Gauss–Kronrod (en büyük hatalı parça ikiye bölünür). */
export function integral(f: Fn, a: number, b: number, name: string): Complex {
  if (a === b) return ZERO;
  const span = Math.max(1, Math.abs(a), Math.abs(b));
  // Tekillik yeri: 3e-309 gibi değerler 0 olarak gösterilir
  const where = (x: number) => `${name} = ${fmtX(Math.abs(x) < 1e-9 * span ? 0 : x)}`;
  const guarded: Fn = (x) => {
    let v: Complex;
    try {
      v = f(x);
    } catch (e) {
      if (isStructural(e)) throw e;
      const msg = e instanceof CalcError ? e.message : "";
      if (msg === "Sonuç çok büyük") throw new CalcError(`İntegral ıraksak: fonksiyon ${where(x)} civarında sınırsız`);
      throw new CalcError(`İntegral hesaplanamadı: fonksiyon ${where(x)} noktasında tanımsız${msg ? ` (${msg})` : ""}`);
    }
    if (!Number.isFinite(v.re) || !Number.isFinite(v.im)) {
      throw new CalcError(`İntegral ıraksak: fonksiyon ${where(x)} civarında sınırsız`);
    }
    return v;
  };
  const pieces = [gk15(guarded, a, b)];
  const total = () => pieces.reduce((s, p) => add(s, p.I), ZERO);
  const totalErr = () => pieces.reduce((s, p) => s + p.err, 0);
  for (let it = 0; it < 3000; it++) {
    const I = total();
    const E = totalErr();
    if (E <= Math.max(1e-14, 1e-13 * abs(I))) return I;
    let worst = 0;
    for (let k = 1; k < pieces.length; k++) if (pieces[k].err > pieces[worst].err) worst = k;
    const p = pieces[worst];
    const m = (p.a + p.b) / 2;
    if (m === p.a || m === p.b) break; // daha fazla bölünemez
    pieces.splice(worst, 1, gk15(guarded, p.a, m), gk15(guarded, m, p.b));
  }
  const I = total();
  // Uç noktada integrallenebilir tekillik (1/√x gibi) yavaş yakınsar: makul hatayı kabul et
  if (totalErr() <= 1e-7 * Math.max(1, abs(I))) return I;
  throw new CalcError("İntegral yakınsamadı: fonksiyon aralıkta sınırsız (ıraksak) olabilir");
}
