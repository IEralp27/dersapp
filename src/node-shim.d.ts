// calc-engine.test.ts yalnızca Node'da çalışır; @types/node eklemeden tsc'nin tanıması için dar tür bildirimi.
declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, check?: (e: unknown) => boolean, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, re: RegExp, message?: string): void;
  };
  export default assert;
}
declare module "node:fs" {
  export function readFileSync(path: string | URL): Uint8Array;
}
