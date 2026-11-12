// Kayıtlı dersin sesi için WAV yardımcıları (DOM'suz; Node testleri: recording.test.ts).
// Seslendiricilerden gelen parçalar (Piper: WAV, bulut: çoğunlukla MP3) tek bir 16 bit mono PCM WAV'da birleşir.
// PCM WAV doğrudan okunur; başka biçimler tarayıcıda çözülür (recording-ui.ts) ve buraya Float32 olarak gelir.

/** Birleşik dosyanın örnekleme hızı (konuşma için yeterli; 10 dakika ≈ 29 MB) */
export const TARGET_RATE = 24000;

export interface Pcm {
  rate: number;
  /** Tek kanal, -1..1 */
  samples: Float32Array;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** PCM (8/16/24/32 bit tamsayı ya da 32 bit kayan nokta) WAV'ı okur, kanalları ortalar. Değilse null. */
export function parseWav(input: ArrayBuffer | Uint8Array): Pcm | null {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 44 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (pos + 8 <= b.length) {
    const id = ascii(b, pos, 4);
    let size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16) return null;
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt || !fmt.channels || !fmt.rate) return null;
      // Akış halinde yazılan WAV'larda boyut 0 ya da 0xFFFFFFFF olabilir: dosya sonuna kadar
      if (size === 0 || size === 0xffffffff || body + size > b.length) size = b.length - body;
      const bytes = fmt.bits / 8;
      const frame = bytes * fmt.channels;
      if (!frame || ![1, 3].includes(fmt.format) || ![8, 16, 24, 32].includes(fmt.bits)) return null;
      if (fmt.format === 3 && fmt.bits !== 32) return null;
      const n = Math.floor(size / frame);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const at = body + i * frame + c * bytes;
          let v: number;
          if (fmt.format === 3) v = dv.getFloat32(at, true);
          else if (fmt.bits === 8) v = (b[at] - 128) / 128;
          else if (fmt.bits === 16) v = dv.getInt16(at, true) / 32768;
          else if (fmt.bits === 24) v = ((b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) << 8 >> 8) / 8388608;
          else v = dv.getInt32(at, true) / 2147483648;
          sum += v;
        }
        out[i] = sum / fmt.channels;
      }
      return { rate: fmt.rate, samples: out };
    }
    pos = body + size + (size & 1);
  }
  return null;
}

/** Doğrusal ara değerlemeyle örnekleme hızı değiştirir (konuşma için yeterli). */
export function resample(src: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !src.length) return src;
  const n = Math.max(1, Math.round((src.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const a = Math.floor(x);
    const f = x - a;
    const s0 = src[Math.min(a, src.length - 1)];
    const s1 = src[Math.min(a + 1, src.length - 1)];
    out[i] = s0 + (s1 - s0) * f;
  }
  return out;
}

/** Float32 -> 16 bit tamsayı */
export function toInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = Math.max(-1, Math.min(1, src[i]));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

/** Parçaları (araya verilen sessizliklerle) tek bir 16 bit mono WAV dosyasında birleştirir. */
export function joinWav(parts: Int16Array[], gaps: number[], rate = TARGET_RATE): Uint8Array {
  const gapLen = gaps.map((g) => Math.max(0, Math.round(g * rate)));
  const total = parts.reduce((s, p, i) => s + p.length + (gapLen[i] ?? 0), 0);
  const out = new Uint8Array(44 + total * 2);
  const dv = new DataView(out.buffer);
  const w = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + total * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, total * 2, true);
  let at = 44;
  parts.forEach((p, i) => {
    at += (gapLen[i] ?? 0) * 2; // sessizlik: sıfır baytlar
    for (let k = 0; k < p.length; k++, at += 2) dv.setInt16(at, p[k], true);
  });
  return out;
}

/** Parçanın süresi (saniye) */
export const seconds = (p: Int16Array, rate = TARGET_RATE) => p.length / rate;
