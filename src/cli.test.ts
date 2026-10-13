import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "./cli.ts";

const COMPLEX = `export function complex(a: number, b: number) {
  if (a) {
    for (const x of [a, b]) {
      if (x && b) {
        while (b) {
          if (a || x) return 1;
        }
      }
    }
  }
  return 0;
}
`;

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cccc-cli-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function run(cwd: string, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    isTTY: false,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

describe("cccc-config CLI", () => {
  test("fails with a stylish report when a function is over the limit", async () => {
    const cwd = await project({
      "cccc.config.ts": `export default [{ rules: { "cognitive-complexity": ["error", 5] } }];`,
      "src/complex.ts": COMPLEX,
    });

    const { code, stdout } = await run(cwd);

    expect(code).toBe(1);
    expect(stdout).toContain("src/complex.ts");
    expect(stdout).toMatch(
      /1\s+error\s+Function 'complex' has a cognitive complexity of \d+\. Maximum allowed is 5\.\s+cognitive-complexity/,
    );
    expect(stdout).toContain("1 problem (1 error, 0 warnings)");
  });

  test("an override for a glob turns the error into a warning", async () => {
    const cwd = await project({
      "cccc.config.ts": `export default [
        { rules: { "cognitive-complexity": ["error", 5] } },
        { files: ["src/**"], rules: { "cognitive-complexity": "warn" } },
      ];`,
      "src/complex.ts": COMPLEX,
    });

    expect((await run(cwd)).code).toBe(0);
    expect((await run(cwd, "--max-warnings", "0")).code).toBe(1);
  });

  test("finds the config file in a parent directory", async () => {
    const cwd = await project({
      "cccc.config.ts": `export default [{ rules: { "cognitive-complexity": ["error", 100] } }];`,
      "pkg/src/complex.ts": COMPLEX,
    });

    const { code, stdout } = await run(join(cwd, "pkg"), "-f", "json");

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      configFile: join(cwd, "cccc.config.ts"),
      files: [{ relativePath: "pkg/src/complex.ts", language: "es" }],
    });
  });

  test("the table format ranks functions by cognitive complexity", async () => {
    const cwd = await project({
      "a.ts": "export function simple() { return 1; }\n",
      "b.ts": COMPLEX,
    });

    const { stdout } = await run(cwd, "--no-config-lookup", "-f", "table");
    const rows = stdout.split("\n").slice(1, 3);

    expect(rows[0]).toContain("complex");
    expect(rows[0]).toContain("b.ts:1");
    expect(rows[1]).toContain("simple");
  });

  test("print-config shows the merged rules and the language for a file", async () => {
    const cwd = await project({
      "cccc.config.ts": `export default [
        { rules: { "cyclomatic-complexity": ["warn", 8] } },
        { files: ["**/*.tmpl"], language: "go", rules: { "cyclomatic-complexity": "error" } },
      ];`,
    });

    const { stdout } = await run(cwd, "--print-config", "views/x.tmpl");

    expect(JSON.parse(stdout)).toEqual({
      language: "go",
      rules: {
        "cognitive-complexity": { severity: "error", max: 15 },
        "cyclomatic-complexity": { severity: "error", max: 8 },
      },
    });
  });

  test("exits with 2 for an invalid config", async () => {
    const cwd = await project({
      "cccc.config.ts": `export default [{ rulez: {} }];`,
    });

    const { code, stderr } = await run(cwd);

    expect(code).toBe(2);
    expect(stderr).toContain("rulez");
  });

  test("exits with 2 for an unknown option", async () => {
    const { code, stderr } = await run(tmpdir(), "--bogus");

    expect(code).toBe(2);
    expect(stderr).toContain("--bogus");
  });
});
