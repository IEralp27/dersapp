// Hesap makinesi sonuç biçimlendirme: gerçek, karmaşık (dikdörtgen/kutupsal), mühendislik, tabanlar.
import { type Complex, abs, arg, clean } from "./calc-complex.ts";

export type Value = Complex | Complex[];

export interface FormatOptions {
  /** Karmaşık sonuçları kutupsal göster (5∠53.13°) */
  polar?: boolean;
  /** Mühendislik gösterimi: üsler 3'ün katı, SI önekiyle (4.7k) */
  eng?: boolean;
  /** Kutupsal açı birimi derece mi */
  degrees?: boolean;
  /** Sanal birim harfi */
  unit?: "i" | "j";
}

const PREFIX_OUT: Record<number, string> = {
  [-15]: "f", [-12]: "p", [-9]: "n", [-6]: "µ", [-3]: "m", 0: "", 3: "k", 6: "M", 9: "G", 12: "T",
};

const sig = (n: number) => Number(n.toPrecision(12));

/** Sonucu gösterim için biçimlendirir: 12 anlamlı basamak, çok büyük/küçükte bilimsel gösterim. */
export function formatResult(n: number): string {
  if (!Number.isFinite(n)) return "Tanımsız";
  if (n === 0) return "0";
  const rounded = sig(n);
  const a = Math.abs(rounded);
  if (a >= 1e12 || a < 1e-6) {
    const [m, e] = rounded.toExponential(11).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    return `${mant}e${Number(e)}`;
  }
  return String(rounded);
}

/** Mühendislik gösterimi: mantis [1, 1000), üs 3'ün katı; f…T aralığında SI öneki. */
export function formatEng(n: number): string {
  if (!Number.isFinite(n)) return "Tanımsız";
  if (n === 0) return "0";
  const r = sig(n);
  let e3 = Math.floor(Math.log10(Math.abs(r)) / 3) * 3;
  const mant = (e: number) => sig(e >= 0 ? r / 10 ** e : r * 10 ** -e);
  let m = mant(e3);
  // log10 yuvarlama hataları ve 999.9999999999 → 1000 taşması için düzeltme
  if (Math.abs(m) >= 1000) m = mant((e3 += 3));
  else if (Math.abs(m) < 1) m = mant((e3 -= 3));
  const p = PREFIX_OUT[e3];
  return p !== undefined ? `${m}${p}` : `${m}e${e3}`;
}

export function formatReal(n: number, eng = false): string {
  if (Object.is(n, -0)) n = 0;
  return eng ? formatEng(n) : formatResult(n);
}

export function formatComplex(z0: Complex, o: FormatOptions = {}): string {
  const z = clean(z0);
  const eng = !!o.eng;
  if (z.im === 0) return formatReal(z.re, eng);
  const u = o.unit ?? "i";
  if (o.polar) {
    const t = arg(z);
    const ang = o.degrees === false ? formatReal(t) : formatReal((t * 180) / Math.PI) + "°";
    return `${formatReal(abs(z), eng)}∠${ang}`;
  }
  const imAbs = formatReal(Math.abs(z.im), eng);
  // "2.2k·i" gibi: önek/üs içeren sayının yanına birim bitiştirilirse yeniden okunamaz
  const imPart = imAbs === "1" ? u : /^[\d.]+$/.test(imAbs) ? imAbs + u : imAbs + "·" + u;
  const reStr = formatReal(z.re, eng);
  if (reStr === "0") return (z.im < 0 ? "-" : "") + imPart;
  return `${reStr} ${z.im < 0 ? "-" : "+"} ${imPart}`;
}

export function formatValue(v: Value, o: FormatOptions = {}): string {
  if (Array.isArray(v)) return v.map((z) => formatComplex(z, o)).join("; ");
  return formatComplex(v, o);
}

/** Tam sayı sonucun HEX/BIN gösterimi; tam sayı değilse null. */
export function formatBases(v: Value): { hex: string; bin: string } | null {
  if (Array.isArray(v)) return null;
  const z = clean(v);
  if (z.im !== 0) return null;
  const n = sig(z.re);
  if (!Number.isInteger(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  const bin = a.toString(2);
  // Okunabilirlik için 4'lü gruplar
  const grouped = bin.replace(/\B(?=(\d{4})+(?!\d))/g, " ");
  return { hex: `${sign}0x${a.toString(16).toUpperCase()}`, bin: `${sign}0b${grouped}` };
}
