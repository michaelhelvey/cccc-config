import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeEngine, NativeError } from "./native.ts";

const engine = new NativeEngine();
afterAll(() => engine.close());

describe("NativeEngine", () => {
  test("lists TypeScript under the es language", () => {
    const es = engine.languages().find((l) => l.name === "es");

    expect(es?.aliases).toContain("ts");
    for (const ext of ["ts", "tsx", "mts"]) {
      expect(es?.extensions).toContain(ext);
    }
  });

  test("scores nesting in cognitive complexity but not in cyclomatic complexity", () => {
    const source = `
      function nested(a: number[]) {
        for (const x of a) {
          if (x > 0) {
            if (x > 10) return x;
          }
        }
        return 0;
      }`;

    const report = engine.analyzeSource(source, { language: "ts", path: "a.ts" });

    // for: 1, if: 1 + 1 nesting, inner if: 1 + 2 nesting.
    expect(report.functions[0]).toMatchObject({
      name: "nested",
      line: 2,
      cognitive: 6,
      cyclomatic: 4,
    });
  });

  test("uses the path extension as a dialect hint", () => {
    const source = "const C = () => <div>{a && b ? 1 : 2}</div>;";

    const report = engine.analyzeSource(source, { language: "es", path: "c.tsx" });

    expect(report.parseErrors).toEqual([]);
    expect(report.functions[0]?.cognitive).toBe(2);
  });

  test("analyzes other languages through the same engine", () => {
    const source = "fn f(x: i32) -> i32 { if x > 0 && x < 9 { 1 } else { 0 } }";

    const report = engine.analyzeSource(source, { language: "rust", path: "f.rs" });

    expect(report.functions[0]).toMatchObject({ name: "f", cognitive: 3, cyclomatic: 3 });
  });

  test("reads files in parallel and keeps the request order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cccc-native-"));
    const paths = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const path = join(dir, `f${i}.ts`);
        await writeFile(path, `function f${i}() { ${"if (a) {} ".repeat(i)} }`);
        return path;
      }),
    );

    const outcomes = engine.analyzeFiles(paths.map((path) => ({ path, language: "es" })));

    expect(outcomes.map((o) => (o.ok ? o.report.functions[0]?.cognitive : -1))).toEqual(
      paths.map((_, i) => i),
    );
  });

  test("returns an error outcome for a file that it cannot read", () => {
    const [outcome] = engine.analyzeFiles([{ path: "/does/not/exist.ts", language: "es" }]);

    expect(outcome).toMatchObject({ ok: false, path: "/does/not/exist.ts" });
  });

  test("throws for an unknown language", () => {
    expect(() => engine.analyzeSource("", { language: "cobol", path: "a.cbl" })).toThrow(
      NativeError,
    );
  });

  test("throws a helpful error when the library is missing", () => {
    expect(() => new NativeEngine("/nowhere/libcccc_ffi.dylib")).toThrow(/build:native/);
  });
});
