import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { analyze, summarize, type FileResult } from "./analyze.ts";
import { ConfigError } from "./config.ts";
import { NoFilesError } from "./files.ts";
import type { ComplexityEngine, FileOutcome, FileReport, FunctionReport } from "./native.ts";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cccc-analyze-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function fn(name: string, cognitive: number, cyclomatic: number, line = 1): FunctionReport {
  return { name, kind: "function", line, cognitive, cyclomatic, children: [] };
}

/** An engine that returns the reports in `reports`, keyed by file name. */
function fakeEngine(reports: Record<string, Partial<FileReport>>) {
  const analyzeFiles = mock((files: { path: string; language: string }[]): FileOutcome[] =>
    files.map(({ path, language }) => {
      const report = reports[basename(path)];
      return report === undefined
        ? { ok: false, path, error: "unexpected file" }
        : {
            ok: true,
            language,
            report: {
              path,
              cognitive: 0,
              cyclomatic: 0,
              functions: [],
              parseErrors: [],
              ...report,
            },
          };
    }),
  );
  const engine: ComplexityEngine = {
    languages: () => [
      { name: "es", aliases: ["ts"], extensions: ["ts", "js"] },
      { name: "go", aliases: [], extensions: ["go"] },
    ],
    analyzeFiles,
    analyzeSource: () => {
      throw new Error("not used");
    },
  };
  return { engine, analyzeFiles };
}

function byPath(result: { files: FileResult[] }, path: string): FileResult | undefined {
  return result.files.find((f) => f.relativePath === path);
}

describe("analyze", () => {
  test("applies per-glob thresholds from the config file", async () => {
    const cwd = await project({
      "cccc.config.ts": `export default [
        { rules: { "cognitive-complexity": ["error", 5] } },
        { files: ["legacy/**"], rules: { "cognitive-complexity": ["warn", 20] } },
      ];`,
      "src/a.ts": "",
      "legacy/b.ts": "",
    });
    const { engine } = fakeEngine({
      "a.ts": { functions: [fn("small", 5, 1), fn("big", 6, 1, 9)] },
      "b.ts": { functions: [fn("huge", 25, 1, 3)] },
      "cccc.config.ts": {},
    });

    const result = await analyze({ cwd, engine });

    expect(byPath(result, "src/a.ts")?.problems).toEqual([
      expect.objectContaining({
        ruleId: "cognitive-complexity",
        severity: "error",
        line: 9,
        value: 6,
        max: 5,
      }),
    ]);
    expect(byPath(result, "legacy/b.ts")?.problems).toEqual([
      expect.objectContaining({ severity: "warn", value: 25, max: 20 }),
    ]);
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(1);
  });

  test("checks nested functions on their own", async () => {
    const cwd = await project({ "a.ts": "" });
    const outer = { ...fn("outer", 1, 1), children: [fn("inner", 30, 1, 4)] };
    const { engine } = fakeEngine({ "a.ts": { functions: [outer] } });

    const result = await analyze({ cwd, engine, configFile: false });

    expect(byPath(result, "a.ts")?.problems.map((p) => p.function?.name)).toEqual(["inner"]);
  });

  test("routes files to the language that the config names", async () => {
    const cwd = await project({ "views/page.tmpl": "", "main.go": "", "notes.txt": "" });
    const { engine, analyzeFiles } = fakeEngine({ "page.tmpl": {}, "main.go": {} });

    await analyze({ cwd, engine, config: [{ files: ["**/*.tmpl"], language: "go" }] });

    const requested = analyzeFiles.mock.calls[0]?.[0].map((f) => [basename(f.path), f.language]);
    expect(requested?.toSorted()).toEqual([
      ["main.go", "go"],
      ["page.tmpl", "go"],
    ]);
  });

  test("does not enter globally ignored directories", async () => {
    const cwd = await project({ "src/a.ts": "", "dist/a.ts": "", "node_modules/x/a.ts": "" });
    const { engine, analyzeFiles } = fakeEngine({ "a.ts": {} });

    const result = await analyze({ cwd, engine, config: [{ ignores: ["dist/"] }] });

    expect(result.files.map((f) => f.relativePath)).toEqual(["src/a.ts"]);
    expect(analyzeFiles.mock.calls[0]?.[0]).toHaveLength(1);
  });

  test("warns about an explicit file that the config ignores", async () => {
    const cwd = await project({ "gen/a.ts": "" });
    const { engine } = fakeEngine({});

    const result = await analyze({
      cwd,
      engine,
      patterns: ["gen/a.ts"],
      config: [{ ignores: ["gen/"] }],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      relativePath: "gen/a.ts",
      report: null,
      warningCount: 1,
    });
    expect(result.files[0]?.problems[0]?.message).toContain("ignore pattern");
    expect(result.errorCount).toBe(0);
  });

  test("reports parse errors and read failures as errors", async () => {
    const cwd = await project({ "bad.ts": "", "gone.ts": "" });
    const { engine } = fakeEngine({ "bad.ts": { parseErrors: ["Unexpected token"] } });

    const result = await analyze({ cwd, engine, configFile: false });

    expect(byPath(result, "bad.ts")?.problems[0]?.message).toBe("Parsing error: Unexpected token");
    expect(byPath(result, "gone.ts")?.problems[0]?.message).toBe("unexpected file");
    expect(result.errorCount).toBe(2);
  });

  test("rejects a config that names an unknown language", async () => {
    const cwd = await project({});
    const { engine } = fakeEngine({});

    const error = await analyze({
      cwd,
      engine,
      config: [{ name: "oops", language: "cobol" }],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain('Unknown language "cobol" in config "oops"');
  });

  test("fails when a pattern matches nothing", async () => {
    const cwd = await project({ "a.ts": "" });
    const { engine } = fakeEngine({});

    const error = await analyze({ cwd, engine, patterns: ["missing/**/*.ts"] }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(NoFilesError);
  });
});

describe("summarize", () => {
  test("computes nearest-rank percentiles over functions at all depths", () => {
    const functions = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => fn(`f${n}`, n, 1));
    const nested = { ...fn("outer", 10, 1), children: functions };
    const file: FileResult = {
      path: "/a.ts",
      relativePath: "a.ts",
      language: "es",
      report: { path: "a.ts", cognitive: 0, cyclomatic: 0, functions: [nested], parseErrors: [] },
      problems: [],
      errorCount: 0,
      warningCount: 0,
    };

    const summary = summarize([file]);

    expect(summary.functionCount).toBe(10);
    expect(summary.cognitive).toEqual({ sum: 55, max: 10, median: 5, p90: 9, p95: 10 });
  });
});
