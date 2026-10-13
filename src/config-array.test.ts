import { describe, expect, test } from "bun:test";
import { ConfigArray } from "./config-array.ts";

const TS = ["**/*.ts"];

describe("ConfigArray.getConfigForFile", () => {
  test("a later config object overrides an earlier one only for the files it matches", () => {
    const configs = new ConfigArray(
      [
        { rules: { "cognitive-complexity": ["error", 10] } },
        { files: ["src/legacy/**"], rules: { "cognitive-complexity": ["warn", 40] } },
      ],
      TS,
    );

    expect(configs.getConfigForFile("src/new.ts")?.rules["cognitive-complexity"]).toEqual({
      severity: "error",
      max: 10,
    });
    expect(configs.getConfigForFile("src/legacy/old.ts")?.rules["cognitive-complexity"]).toEqual({
      severity: "warn",
      max: 40,
    });
  });

  test("a severity without a threshold keeps the threshold of an earlier config object", () => {
    const configs = new ConfigArray(
      [
        { rules: { "cyclomatic-complexity": ["error", 7] } },
        { files: TS, rules: { "cyclomatic-complexity": 1 } },
      ],
      TS,
    );

    expect(configs.getConfigForFile("a.ts")?.rules["cyclomatic-complexity"]).toEqual({
      severity: "warn",
      max: 7,
    });
  });

  test("ignores in a config object with other keys exclude files from that object only", () => {
    const configs = new ConfigArray(
      [{ files: ["**/*.ts"], ignores: ["**/*.test.ts"], rules: { "cognitive-complexity": "off" } }],
      TS,
    );

    expect(configs.getConfigForFile("a.ts")?.rules["cognitive-complexity"].severity).toBe("off");
    expect(configs.getConfigForFile("a.test.ts")?.rules["cognitive-complexity"].severity).toBe(
      "error",
    );
  });

  test("an item in files that is an array matches only when all of its patterns match", () => {
    const configs = new ConfigArray(
      [{ files: [["src/**", "**/*.tsx"]], rules: { "cognitive-complexity": "off" } }],
      ["**/*.ts", "**/*.tsx"],
    );

    expect(configs.getConfigForFile("src/a.tsx")?.rules["cognitive-complexity"].severity).toBe(
      "off",
    );
    expect(configs.getConfigForFile("src/a.ts")?.rules["cognitive-complexity"].severity).toBe(
      "error",
    );
    expect(configs.getConfigForFile("lib/a.tsx")?.rules["cognitive-complexity"].severity).toBe(
      "error",
    );
  });

  test("the last language in the merge wins", () => {
    const configs = new ConfigArray(
      [
        { files: ["**/*.tmpl"], language: "go" },
        { files: ["web/**/*.tmpl"], language: "es" },
      ],
      TS,
    );

    expect(configs.getConfigForFile("api/a.tmpl")?.language).toBe("go");
    expect(configs.getConfigForFile("web/a.tmpl")?.language).toBe("es");
  });
});

describe("ConfigArray file selection", () => {
  test("universal files patterns give config but do not select files", () => {
    const configs = new ConfigArray([{ files: ["src/**"], rules: {} }], TS);

    expect(configs.isFileSelected("src/a.ts")).toBe(true);
    expect(configs.isFileSelected("src/README.md")).toBe(false);
  });

  test("a specific files pattern selects files that the defaults do not select", () => {
    const configs = new ConfigArray([{ files: ["**/*.tmpl"], language: "go" }], TS);

    expect(configs.isFileSelected("views/index.tmpl")).toBe(true);
  });

  test("files outside the base directory are never selected", () => {
    const configs = new ConfigArray([], TS);

    expect(configs.isFileSelected("../other/a.ts")).toBe(false);
  });
});

describe("ConfigArray global ignores", () => {
  test("node_modules and .git are ignored by default", () => {
    const configs = new ConfigArray([], TS);

    expect(configs.isDirectoryIgnored("packages/x/node_modules")).toBe(true);
    expect(configs.isDirectoryIgnored(".git")).toBe(true);
    expect(configs.isFileIgnored("packages/x/node_modules/y/index.ts")).toBe(true);
  });

  test("a directory pattern ignores everything below the directory", () => {
    const configs = new ConfigArray([{ ignores: ["dist/"] }], TS);

    expect(configs.isDirectoryIgnored("dist")).toBe(true);
    expect(configs.isFileIgnored("dist/deep/a.ts")).toBe(true);
    expect(configs.isFileIgnored("src/dist.ts")).toBe(false);
  });

  test("a negated pattern un-ignores a file when its directory is not ignored", () => {
    const configs = new ConfigArray([{ ignores: ["build/**/*", "!build/keep.ts"] }], TS);

    expect(configs.isFileIgnored("build/drop.ts")).toBe(true);
    expect(configs.isFileIgnored("build/keep.ts")).toBe(false);
  });

  test("a negated pattern cannot un-ignore a file in an ignored directory", () => {
    const configs = new ConfigArray([{ ignores: ["build/**", "!build/keep.ts"] }], TS);

    expect(configs.isFileIgnored("build/keep.ts")).toBe(true);
  });

  test("an object with a name and ignores is still a global ignore", () => {
    const configs = new ConfigArray([{ name: "generated", ignores: ["**/*.gen.ts"] }], TS);

    expect(configs.isFileSelected("src/api.gen.ts")).toBe(false);
    expect(configs.isFileSelected("src/api.ts")).toBe(true);
  });
});
