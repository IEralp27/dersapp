// calc-engine.test.ts yalnızca Node'da çalışır; @types/node eklemeden tsc'nin tanıması için dar tür bildirimi.
declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, check?: (e: unknown) => boolean, message?: string): void;
  };
  export default assert;
}
